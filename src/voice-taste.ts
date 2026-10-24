import { hasApiKey, ModelCallError, modelsFromEnv, realtimeUrl, scoreTasteTranscript } from "./lib/provider";
import { bytesToBase64, logEvent, type AppEnv } from "./lib/http";
import { questionsFor, type TryRoleId } from "./lib/try";
import {
  claimVoiceSecret,
  connectAllowed,
  deleteVoiceTaste,
  endVoiceTaste,
  parseTasteScore,
  RECORD_TASTE_SCORE_TOOL,
  roleLabel,
  saveTasteScore,
  scrubVendor,
  secondsLeft,
  TASTE_SCORE_MISSED,
  tasteInstructions,
  TasteTranscript,
  tasteSummary,
  type TasteSummary,
  type VoiceTasteRow,
} from "./lib/voice-taste";

const PLAYBACK_FALLBACK_MS = 15000;

export async function proxyVoiceTaste(request: Request, env: AppEnv, sessionId: string): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return Response.json({ error: "upgrade_required", message: "Talk to Coach uses a WebSocket." }, { status: 426 });
  }
  const claimed = await claimVoiceSecret(env.DB, sessionId);
  if (!claimed) {
    const existing = await env.DB.prepare(`SELECT id, ended_at, expires_at FROM voice_taste_sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ id: string; ended_at: string | null; expires_at: string }>();
    if (!existing) return Response.json({ error: "not_found", message: "Start a voice session first." }, { status: 404 });
    if (existing.ended_at || !connectAllowed(existing.expires_at)) {
      return Response.json({ error: "closed", message: "That 3-minute taste already ended." }, { status: 409 });
    }
    return Response.json({ error: "voice_offline", message: "Voice isn't available right now. Type your answers instead." }, { status: 503 });
  }
  if (!connectAllowed(claimed.expires_at)) {
    await endVoiceTaste(env.DB, claimed.id, "expired");
    return Response.json({ error: "expired", message: "That 3-minute taste already ended. Type the three questions instead." }, { status: 409 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const secret = claimed.client_secret;
  claimed.client_secret = null;
  if (!secret) {
    server.close(1011, "unavailable");
    return new Response(null, { status: 101, webSocket: client });
  }

  let upstream: WebSocket | null = null;
  let closed = false;
  let finishing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let toolBatch = 0;
  let outputsSent = 0;
  let batchClosed = false;
  let playbackDone = false;
  let followupSent = false;
  let turnFinished = false;
  let playbackRequested = false;
  let ending = false;
  const transcript = new TasteTranscript();

  const send = (payload: unknown) => {
    if (closed) return;
    try {
      server.send(JSON.stringify(payload));
    } catch {
      // The browser may already be gone.
    }
  };

  const stop = (reason: "time" | "ended" | "upstream" | "failed") => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    if (hardStop) clearTimeout(hardStop);
    if (playbackTimer) clearTimeout(playbackTimer);
    try {
      upstream?.close(1000, reason);
    } catch {
      // already closed
    }
    try {
      server.close(1000, reason);
    } catch {
      // already closed
    }
  };

  const finish = async (reason: "time" | "ended") => {
    if (closed || finishing) return;
    ending = true;
    finishing = true;
    if (!transcript.isShort() && hasApiKey(env.LLM_API_KEY)) send({ type: "hireme.status", text: "Scoring…" });
    const summary = await summarizeTaste(env, claimed, transcript);
    if (summary.overall != null) {
      await saveTasteScore(env.DB, claimed.id, {
        overall: summary.overall,
        bestMoment: summary.bestMoment,
        fix: summary.fix,
      });
    }
    await endVoiceTaste(env.DB, claimed.id, reason === "time" ? "expired" : "ended");
    send({ type: "hireme.done", reason, ...summary });
    stop(reason);
  };

  const armHardStop = (expiresAt: string) => {
    const ms = Math.max(0, Date.parse(expiresAt) - Date.now());
    hardStop = setTimeout(() => {
      void finish("time");
    }, ms);
    timer = setInterval(() => {
      const left = secondsLeft(expiresAt);
      send({ type: "hireme.remaining", seconds: left });
      if (left <= 0) void finish("time");
    }, 1000);
    send({ type: "hireme.remaining", seconds: secondsLeft(expiresAt) });
  };

  try {
    const models = modelsFromEnv(env);
    const upstreamResponse = await fetch(`${realtimeUrl(models.apiBase)}?model=${encodeURIComponent(models.voiceModel)}`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Authorization: `Bearer ${secret}`,
      },
    });
    upstream = upstreamResponse.webSocket ?? null;
    if (!upstream) {
      await deleteVoiceTaste(env.DB, claimed.id);
      send({ type: "hireme.error", message: "Voice didn't connect. Type the three questions instead." });
      stop("failed");
      return new Response(null, { status: 101, webSocket: client });
    }
    upstream.accept();
  } catch (error) {
    logEvent("voice_taste_upstream_error", { message: error instanceof Error ? error.message : "failed" });
    await deleteVoiceTaste(env.DB, claimed.id);
    send({ type: "hireme.error", message: "Voice didn't connect. Type the three questions instead." });
    stop("failed");
    return new Response(null, { status: 101, webSocket: client });
  }

  if (!upstream || closed) return new Response(null, { status: 101, webSocket: client });

  const opening = await openingPrompt(env, claimed);
  upstream.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: modelsFromEnv(env).ttsVoice,
      instructions: tasteInstructions(roleLabel(claimed.role), opening),
      tools: [RECORD_TASTE_SCORE_TOOL],
      turn_detection: { type: "server_vad" },
      reasoning: { effort: "none" },
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transport: "binary",
          transcription: { model: modelsFromEnv(env).realtimeTranscribeModel, language_hint: "en" },
        },
        output: { format: { type: "audio/pcm", rate: 24000 } },
      },
    },
  }));
  upstream.send(JSON.stringify({ type: "response.create" }));
  send({ type: "hireme.ready" });
  armHardStop(claimed.expires_at);
  logEvent("voice_taste_open", { sessionId: claimed.id });

  const markBatchClosed = () => {
    batchClosed = true;
    if (!playbackRequested) {
      playbackRequested = true;
      send({ type: "hireme.await_playback" });
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
      void finish("ended");
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
        if (event.name !== "record_taste_score") {
          output = JSON.stringify({ ok: false, error: "Unknown tool." });
        } else {
          const score = parseTasteScore(parsed);
          if (!score) {
            output = JSON.stringify({ ok: false, error: "overall must be an integer from 1 to 5, with best_moment and fix." });
          } else {
            await saveTasteScore(env.DB, claimed.id, score);
            output = JSON.stringify({ ok: true, overall: score.overall });
            send({ type: "hireme.score", overall: score.overall, bestMoment: score.bestMoment, fix: score.fix });
          }
        }
      } catch (error) {
        logEvent("voice_taste_score_failed", { message: error instanceof Error ? error.message : "failed" });
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
        void finish("ended");
        return;
      }
      continueAfterTools();
    })();
  };

  upstream.addEventListener("message", (event) => {
    if (closed) return;
    if (typeof event.data !== "string") {
      send({ type: "hireme.audio", delta: bytesToBase64(event.data) });
      return;
    }
    let parsed: {
      type?: string;
      delta?: string;
      transcript?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
      item_id?: string;
      response_id?: string;
      code?: string;
      error?: { code?: string; type?: string };
    };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch {
      return;
    }
    const type = parsed.type ?? "";
    if (type === "response.created") {
      toolBatch = 0;
      outputsSent = 0;
      batchClosed = false;
      playbackDone = false;
      followupSent = false;
      turnFinished = false;
      playbackRequested = false;
    } else if (type === "response.function_call_arguments.done") {
      onToolCall(parsed);
      if (turnFinished) markBatchClosed();
    } else if (type === "response.done") {
      turnFinished = true;
      if (toolBatch > 0) markBatchClosed();
    } else if (type === "error") {
      // A clean End closes this socket, and the provider answers with an error frame.
      // The session stays up for ordinary error frames, so the banner is only for a real drop.
      logEvent("voice_taste_upstream_error", { sessionId: claimed.id, code: upstreamErrorCode(parsed), ending });
    } else if (type.includes("transcript") || type.includes("transcription")) {
      transcript.add(parsed);
      const text = scrubVendor(parsed.delta || ((type.endsWith("completed") || type.endsWith("done")) ? parsed.transcript ?? "" : ""));
      const speaker = type.includes("input") ? "you" : "coach";
      if (text && speaker === "coach" && type.endsWith("delta")) {
        send({ type: "hireme.caption", text, speaker, final: false });
      }
    } else if (type.includes("audio") && type.endsWith("delta") && parsed.delta) {
      send({ type: "hireme.audio", delta: parsed.delta });
    }
  });
  const dropped = () => {
    if (!ending && !finishing && !closed) {
      send({ type: "hireme.error", message: "Coach lost the line. You can keep talking, or type the three questions." });
    }
    void finish("ended");
  };
  upstream.addEventListener("close", dropped);
  upstream.addEventListener("error", dropped);

  server.addEventListener("message", (event) => {
    if (closed || !upstream) return;
    if (typeof event.data === "string") {
      try {
        const parsed = JSON.parse(event.data) as { type?: string };
        if (parsed.type === "hireme.end") {
          ending = true;
          void finish("ended");
          return;
        }
        if (parsed.type === "hireme.playback_done") {
          playbackDone = true;
          if (playbackTimer) clearTimeout(playbackTimer);
          continueAfterTools();
        }
      } catch {
        return;
      }
      return;
    }
    try {
      upstream.send(event.data);
    } catch {
      void finish("ended");
    }
  });
  server.addEventListener("close", () => {
    ending = true;
    void finish("ended");
  });
  server.addEventListener("error", () => {
    ending = true;
    void finish("ended");
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function openingPrompt(env: AppEnv, row: VoiceTasteRow): Promise<string> {
  const role = row.role as TryRoleId;
  const questions = await questionsFor(env.DB, role, row.usage_date, 1);
  return questions[0]?.prompt ?? "Tell me about a time you shipped something that did not work the first time, and what you changed.";
}

async function summarizeTaste(env: AppEnv, row: VoiceTasteRow, transcript: TasteTranscript): Promise<TasteSummary> {
  if (transcript.isShort()) return tasteSummary(null);
  if (!hasApiKey(env.LLM_API_KEY)) return tasteSummary(null, TASTE_SCORE_MISSED);
  try {
    const models = modelsFromEnv(env);
    const score = await scoreTasteTranscript({
      apiBase: models.apiBase,
      apiKey: env.LLM_API_KEY,
      model: models.textModel,
      roleLabel: roleLabel(row.role),
      transcript: transcript.render(),
    });
    return tasteSummary({ overall: score.overall, bestMoment: score.bestMoment, fix: score.fix });
  } catch (error) {
    const reason = error instanceof ModelCallError ? error.reason : "parse";
    const status = error instanceof ModelCallError ? error.status ?? null : null;
    logEvent("voice_taste_score_failed", { reason, status });
    const saved = await env.DB.prepare(`SELECT overall, best_moment, fix FROM voice_taste_sessions WHERE id = ?`)
      .bind(row.id)
      .first<{ overall: number | null; best_moment: string | null; fix: string | null }>();
    if (saved?.overall != null && saved.best_moment && saved.fix) return tasteSummary(saved);
    return tasteSummary(null, TASTE_SCORE_MISSED);
  }
}

function upstreamErrorCode(parsed: { error?: { code?: string; type?: string }; code?: string }): string {
  const code = parsed.error?.code || parsed.error?.type || parsed.code || "error";
  return String(code).slice(0, 80);
}
