import { saveSessionScore } from "./lib/coach-session";
import { modelsFromEnv, realtimeUrl } from "./lib/provider";
import { logEvent, type AppEnv } from "./lib/http";
import { capsForTier, parseCaps, planLiveCharge, type Tier } from "./lib/policy";
import { getUsage, reserve } from "./lib/usage";
import { parseSessionScore, RECORD_SCORE_TOOL } from "./lib/voice-coach";

interface LiveRow {
  id: string;
  user_id: string;
  usage_date: string;
  task_prompt: string;
  role_label: string;
  instructions: string | null;
  started_at: string | null;
  charged_seconds: number;
  finished_at: string | null;
  tier: Tier;
}

const FORWARDED = new Set([
  "input_audio_buffer.append",
  "input_audio_buffer.commit",
  "input_audio_buffer.clear",
  "response.create",
]);

const PLAYBACK_FALLBACK_MS = 15000;

export async function proxyLiveSession(request: Request, env: AppEnv, sessionId: string, userId: string): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return Response.json({ error: "upgrade_required", message: "Live voice uses a WebSocket." }, { status: 426 });
  }
  const row = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.usage_date, s.task_prompt, s.role_label, s.instructions, s.started_at,
            s.charged_seconds, s.finished_at, u.tier AS tier
     FROM live_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.user_id = ?`,
  )
    .bind(sessionId, userId)
    .first<LiveRow>();
  if (!row) return Response.json({ error: "not_found", message: "Start a live session first." }, { status: 404 });
  if (row.finished_at) return Response.json({ error: "closed", message: "That live session is already closed." }, { status: 409 });
  if (!env.LLM_API_KEY) {
    return Response.json({ error: "model_not_configured", message: "Live voice is not configured yet." }, { status: 503 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const caps = capsForTier(row.tier, parseCaps(env));
  const models = modelsFromEnv(env);
  let upstream: WebSocket | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let toolBatch = 0;
  let outputsSent = 0;
  let batchClosed = false;
  let playbackDone = false;
  let followupSent = false;
  let turnFinished = false;
  let playbackRequested = false;

  const stop = (reason: string) => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    if (playbackTimer) clearTimeout(playbackTimer);
    try {
      server.send(JSON.stringify({ type: "hireme.cap", reason }));
    } catch {
      // The client may already be gone.
    }
    try {
      server.close(1000, reason);
    } catch {
      // already closed
    }
    try {
      upstream?.close(1000, reason);
    } catch {
      // already closed
    }
  };

  const meter = async (forceStop: boolean) => {
    if (closed && !forceStop) return;
    const current = await env.DB.prepare(
      `SELECT started_at, charged_seconds, finished_at FROM live_sessions WHERE id = ?`,
    )
      .bind(row.id)
      .first<{ started_at: string | null; charged_seconds: number; finished_at: string | null }>();
    if (!current || current.finished_at) {
      stop("closed");
      return;
    }
    if (!current.started_at) return;
    const elapsed = Math.floor((Date.now() - Date.parse(current.started_at)) / 1000);
    const usage = await getUsage(env.DB, row.user_id, row.usage_date);
    const room = Math.max(0, caps.live - usage.live);
    const plan = planLiveCharge(elapsed, current.charged_seconds, room);
    if (plan.take > 0) {
      const reserved = await reserve(env.DB, row.user_id, row.usage_date, "live", plan.take, caps.live);
      if (!reserved.ok) {
        logEvent("live_cap", { userId: row.user_id, used: reserved.used, cap: reserved.cap });
        await finish(current.charged_seconds);
        stop("daily live cap");
        return;
      }
      await env.DB.prepare(`UPDATE live_sessions SET charged_seconds = charged_seconds + ? WHERE id = ?`)
        .bind(plan.take, row.id)
        .run();
    }
    if (plan.stop || forceStop) {
      const latest = await env.DB.prepare(`SELECT charged_seconds FROM live_sessions WHERE id = ?`)
        .bind(row.id)
        .first<{ charged_seconds: number }>();
      await finish(latest?.charged_seconds ?? current.charged_seconds + plan.take);
      if (plan.stop) stop("daily live cap");
    }
  };

  const finish = async (charged: number) => {
    await env.DB.prepare(
      `UPDATE live_sessions SET finished_at = ?, charged_seconds = ? WHERE id = ? AND finished_at IS NULL`,
    )
      .bind(new Date().toISOString(), charged, row.id)
      .run();
  };

  const queue = (forceStop = false) => {
    chain = chain.then(() => meter(forceStop)).catch((error: unknown) => {
      logEvent("live_meter_error", { message: error instanceof Error ? error.message : "failed" });
      stop("meter error");
    });
  };

  try {
    const upstreamResponse = await fetch(`${realtimeUrl(models.apiBase)}?model=${encodeURIComponent(models.voiceModel)}`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
    });
    upstream = upstreamResponse.webSocket ?? null;
    if (!upstream) {
      server.send(JSON.stringify({ type: "hireme.error", message: "Live voice did not open a socket." }));
      server.close(1011, "upstream");
      return new Response(null, { status: 101, webSocket: client });
    }
    upstream.accept();
  } catch (error) {
    logEvent("live_upstream_error", { message: error instanceof Error ? error.message : "failed" });
    server.send(JSON.stringify({ type: "hireme.error", message: "Could not reach live voice." }));
    server.close(1011, "upstream");
    return new Response(null, { status: 101, webSocket: client });
  }

  const startedAt = new Date().toISOString();
  await env.DB.prepare(`UPDATE live_sessions SET started_at = COALESCE(started_at, ?) WHERE id = ?`)
    .bind(startedAt, row.id)
    .run();

  upstream.send(
    JSON.stringify({
      type: "session.update",
      session: {
        voice: models.ttsVoice,
        instructions: row.instructions || fallbackInstructions(row.role_label, row.task_prompt),
        tools: [RECORD_SCORE_TOOL],
        turn_detection: { type: "server_vad" },
        reasoning: { effort: "none" },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transport: "binary",
            transcription: { model: models.realtimeTranscribeModel, language_hint: "en" },
          },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
      },
    }),
  );
  upstream.send(JSON.stringify({ type: "response.create" }));

  const markBatchClosed = () => {
    batchClosed = true;
    if (!playbackRequested) {
      playbackRequested = true;
      try {
        server.send(JSON.stringify({ type: "hireme.await_playback" }));
      } catch {
        playbackDone = true;
      }
      armPlaybackFallback();
    }
    continueAfterTools();
  };

  const continueAfterTools = () => {
    if (followupSent || closed || !upstream) return;
    if (!batchClosed || toolBatch === 0 || outputsSent < toolBatch || !playbackDone) return;
    followupSent = true;
    try {
      upstream.send(JSON.stringify({ type: "response.create" }));
    } catch {
      stop("upstream closed");
    }
  };

  const armPlaybackFallback = () => {
    if (playbackTimer) clearTimeout(playbackTimer);
    playbackTimer = setTimeout(() => {
      playbackDone = true;
      continueAfterTools();
    }, PLAYBACK_FALLBACK_MS);
  };

  const onToolCall = (event: { name?: string; call_id?: string; arguments?: string }) => {
    toolBatch += 1;
    const callId = event.call_id ?? "";
    void (async () => {
      let output: string;
      try {
        const parsed = JSON.parse(event.arguments || "{}") as unknown;
        if (event.name !== "record_session_score") {
          output = JSON.stringify({ ok: false, error: "Unknown tool." });
        } else {
          const score = parseSessionScore(parsed);
          if (!score) {
            output = JSON.stringify({
              ok: false,
              error: "structure, clarity, and impact must be integers from 1 to 5, and weak_spot must be a short phrase.",
            });
          } else {
            const saved = await saveSessionScore(env.DB, {
              userId: row.user_id,
              usageDate: row.usage_date,
              channel: "live",
              openingWeakSpot: "a concrete result",
              structure: score.structure,
              clarity: score.clarity,
              impact: score.impact,
              weakSpot: score.weakSpot,
            });
            output = JSON.stringify({
              ok: true,
              structure: saved.structure,
              clarity: saved.clarity,
              impact: saved.impact,
              weak_spot: saved.weakSpot,
            });
            try {
              server.send(JSON.stringify({
                type: "hireme.score",
                structure: saved.structure,
                clarity: saved.clarity,
                impact: saved.impact,
                weakSpot: saved.weakSpot,
              }));
            } catch {
              // The client may already be gone. The score is stored either way.
            }
          }
        }
      } catch (error) {
        logEvent("live_score_failed", { message: error instanceof Error ? error.message : "failed" });
        output = JSON.stringify({ ok: false, error: "Could not store that score." });
      }
      outputsSent += 1;
      if (turnFinished) markBatchClosed();
      if (closed || !upstream) return;
      try {
        upstream.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        }));
      } catch {
        stop("upstream closed");
        return;
      }
      continueAfterTools();
    })();
  };

  upstream.addEventListener("message", (event) => {
    if (closed) return;
    if (typeof event.data === "string") {
      try {
        const parsed = JSON.parse(event.data) as { type?: string; name?: string; call_id?: string; arguments?: string };
        if (parsed.type === "response.created") {
          toolBatch = 0;
          outputsSent = 0;
          batchClosed = false;
          playbackDone = false;
          followupSent = false;
          turnFinished = false;
          playbackRequested = false;
        } else if (parsed.type === "response.function_call_arguments.done") {
          onToolCall(parsed);
          if (turnFinished) markBatchClosed();
        } else if (parsed.type === "response.done") {
          turnFinished = true;
          if (toolBatch > 0) markBatchClosed();
        }
      } catch {
        // Non-JSON text still goes to the client.
      }
    }
    try {
      server.send(event.data);
    } catch {
      stop("client closed");
    }
  });
  upstream.addEventListener("close", () => {
    queue(true);
    stop("upstream closed");
  });
  upstream.addEventListener("error", () => stop("upstream error"));

  server.addEventListener("message", (event) => {
    if (closed || !upstream) return;
    if (typeof event.data === "string") {
      try {
        const parsed = JSON.parse(event.data) as { type?: string };
        if (parsed.type === "hireme.playback_done") {
          playbackDone = true;
          if (playbackTimer) clearTimeout(playbackTimer);
          continueAfterTools();
          return;
        }
        if (!parsed.type || !FORWARDED.has(parsed.type)) return;
        upstream.send(event.data);
      } catch {
        return;
      }
    } else {
      upstream.send(event.data);
    }
    queue(false);
  });
  server.addEventListener("close", () => {
    queue(true);
    stop("client closed");
  });
  server.addEventListener("error", () => stop("client error"));

  timer = setInterval(() => queue(false), 5000);
  logEvent("live_open", { userId: row.user_id, sessionId: row.id });
  return new Response(null, { status: 101, webSocket: client });
}

function fallbackInstructions(roleLabel: string, prompt: string): string {
  return `You are Coach from Hire Me, interviewing for ${roleLabel}. Speak in short turns. Your only name is Coach from Hire Me. The brief: ${prompt}. Call record_session_score when you score structure, clarity, and impact. Do not name a model or a vendor. Do not promise a job, an interview, or a placement.`;
}
