import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { clientIpHash } from "../src/lib/try";
import {
  claimVoiceSecret,
  connectAllowed,
  deleteVoiceTaste,
  freeVoiceDailyCap,
  parseTasteScore,
  reserveVoiceTaste,
  secondsLeft,
  storeVoiceSecret,
  TASTE_SECONDS,
  TASTE_MIN_USER_WORDS,
  TASTE_SCORE_MISSED,
  TASTE_SHORT_NOTE,
  TasteTranscript,
  tasteSummary,
  voiceTasteStatus,
} from "../src/lib/voice-taste";

function tasteFetch(path: string, ip: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", ip);
  return exports.default.fetch(`https://hireme.test${path}`, { ...init, headers });
}

describe("voice taste", () => {
  it("parses the daily cap and a taste score without vendor names", () => {
    expect(TASTE_SECONDS).toBe(180);
    expect(freeVoiceDailyCap({})).toBe(200);
    expect(freeVoiceDailyCap({ FREE_VOICE_DAILY_SESSIONS: "0" })).toBe(0);
    expect(freeVoiceDailyCap({ FREE_VOICE_DAILY_SESSIONS: "12.9" })).toBe(12);
    expect(freeVoiceDailyCap({ FREE_VOICE_DAILY_SESSIONS: "nope" })).toBe(200);
    expect(parseTasteScore({ overall: 4, best_moment: "Named the outage", fix: "Add the revenue number." })).toEqual({
      overall: 4,
      bestMoment: "Named the outage",
      fix: "Add the revenue number.",
    });
    expect(parseTasteScore({ overall: 4, best_moment: "Used grok well", fix: "Skip the x.ai mention" })?.bestMoment).toBe("Used Coach well");
    expect(parseTasteScore({ overall: 4, best_moment: "Used grok well", fix: "Skip the x.ai mention" })?.fix).not.toMatch(/grok|xai/i);
    expect(parseTasteScore({ overall: 6, best_moment: "Hi", fix: "There" })).toBeNull();
    expect(tasteSummary(null)).toEqual({
      overall: null,
      bestMoment: "",
      fix: "",
      streak: "Day 1",
      short: true,
      note: TASTE_SHORT_NOTE,
    });
    expect(tasteSummary(null, TASTE_SCORE_MISSED).note).toBe(TASTE_SCORE_MISSED);
    expect(tasteSummary(null, TASTE_SCORE_MISSED).short).toBe(false);
    expect(tasteSummary({ overall: 4, bestMoment: "Named the outage", fix: "Add the number." })).toMatchObject({
      overall: 4,
      short: false,
      note: "",
    });
    const soon = new Date(Date.now() + 20_000).toISOString();
    const almost = new Date(Date.now() + 10_000).toISOString();
    expect(connectAllowed(soon)).toBe(true);
    expect(connectAllowed(almost)).toBe(false);
    expect(secondsLeft(new Date(Date.now() + 180_000).toISOString())).toBeGreaterThan(170);
  });

  it("reserves one session per IP and stops at the global cap", async () => {
    const today = `2099-${crypto.randomUUID()}`;
    const first = await reserveVoiceTaste(env.DB, { ipHash: "ip-a", role: "fde", cap: 2, today });
    expect(first.ok).toBe(true);
    const again = await reserveVoiceTaste(env.DB, { ipHash: "ip-a", role: "ai_engineer", cap: 2, today });
    expect(again).toEqual({ ok: false, reason: "used" });
    const second = await reserveVoiceTaste(env.DB, { ipHash: "ip-b", role: "data_engineer", cap: 2, today });
    expect(second.ok).toBe(true);
    const third = await reserveVoiceTaste(env.DB, { ipHash: "ip-c", role: "fde", cap: 2, today });
    expect(third).toEqual({ ok: false, reason: "full" });

    const ready = await voiceTasteStatus(env.DB, "ip-new", 2, true, today);
    expect(ready).toEqual({ available: false, reason: "full", seconds: 180 });
    const offline = await voiceTasteStatus(env.DB, "ip-new", 2, false, today);
    expect(offline.reason).toBe("offline");
    const used = await voiceTasteStatus(env.DB, "ip-a", 5, true, today);
    expect(used).toEqual({ available: false, reason: "used", seconds: 180 });

    if (!first.ok) throw new Error("expected a reservation");
    await deleteVoiceTaste(env.DB, first.id);
    const freed = await voiceTasteStatus(env.DB, "ip-a", 5, true, today);
    expect(freed.reason).toBe("ready");
  });

  it("keeps the client secret on the server and clears it when the socket claims it", async () => {
    const today = `2098-${crypto.randomUUID()}`;
    const reserved = await reserveVoiceTaste(env.DB, { ipHash: "secret-ip", role: "ai_engineer", cap: 1, today });
    if (!reserved.ok) throw new Error("expected a reservation");
    const clock = await storeVoiceSecret(env.DB, reserved.id, "taste-secret-value");
    expect(Date.parse(clock.expiresAt) - Date.parse(clock.startedAt)).toBe(TASTE_SECONDS * 1000);
    const claimed = await claimVoiceSecret(env.DB, reserved.id);
    expect(claimed?.client_secret).toBe("taste-secret-value");
    expect(await claimVoiceSecret(env.DB, reserved.id)).toBeNull();
    const stored = await env.DB.prepare(`SELECT client_secret FROM voice_taste_sessions WHERE id = ?`)
      .bind(reserved.id)
      .first<{ client_secret: string | null }>();
    expect(stored?.client_secret).toBeNull();
  });

  it("does not open a free voice session or burn a slot when voice is offline", async () => {
    const ip = `voice-${crypto.randomUUID()}`;
    const status = await tasteFetch("/api/voice-taste/status", ip);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { available: boolean; reason: string; seconds: number };
    expect(statusBody).toEqual({ available: false, reason: "offline", seconds: 180 });
    expect(JSON.stringify(statusBody).toLowerCase()).not.toMatch(/grok|xai/);

    const badRole = await tasteFetch("/api/voice-taste/session", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "recruiter" }),
    });
    expect(badRole.status).toBe(400);

    const session = await tasteFetch("/api/voice-taste/session", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "fde" }),
    });
    expect(session.status).toBe(503);
    const sessionBody = (await session.json()) as { message: string; sessionId?: string; value?: string };
    expect(sessionBody.message.toLowerCase()).toContain("type");
    expect(sessionBody.sessionId).toBeUndefined();
    expect(sessionBody.value).toBeUndefined();
    expect(JSON.stringify(sessionBody).toLowerCase()).not.toMatch(/grok|xai|client_secret|api\.x\.ai/);

    const ipHash = await clientIpHash(new Request("https://hireme.test/", { headers: { "cf-connecting-ip": ip } }));
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM voice_taste_sessions WHERE ip_hash = ?`)
      .bind(ipHash)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);

    const missing = await tasteFetch("/api/voice-taste/socket", ip);
    expect(missing.status).toBe(400);
    const closed = await tasteFetch("/api/voice-taste/socket?sessionId=missing", ip);
    expect(closed.status).toBe(426);
    const closedBody = await closed.json();
    expect(JSON.stringify(closedBody).toLowerCase()).not.toMatch(/grok|xai/);
  });

  it("saves a voice-taste lead with a nullable score and ignores any other source", async () => {
    const ip = `voice-lead-${crypto.randomUUID()}`;
    const email = `voice.${crypto.randomUUID()}@hireme.test`;
    const saved = await tasteFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Nia",
        email,
        role: "fde",
        consent: true,
        sessionAvg: null,
        source: "voice-taste",
      }),
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { message: string; email: string };
    expect(body.message).toBe("You're in. Start free to keep your streak.");
    expect(JSON.stringify(body).toLowerCase()).not.toMatch(/grok|xai/);
    const row = await env.DB.prepare(`SELECT source, session_avg, role FROM leads WHERE email = ?`)
      .bind(email)
      .first<{ source: string; session_avg: number | null; role: string }>();
    expect(row).toEqual({ source: "voice-taste", session_avg: null, role: "fde" });

    const ignored = await tasteFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Nia",
        email,
        role: "ai_engineer",
        consent: true,
        sessionAvg: 4,
        source: "grok",
      }),
    });
    expect(ignored.status).toBe(200);
    const updated = await env.DB.prepare(`SELECT source, session_avg, role FROM leads WHERE email = ?`)
      .bind(email)
      .first<{ source: string; session_avg: number; role: string }>();
    expect(updated).toEqual({ source: "try-coach", session_avg: 4, role: "ai_engineer" });
  });

  it("scores from coach captions plus the visitor's speech, and treats a short answer honestly", () => {
    const transcript = new TasteTranscript();
    transcript.add({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Tell me about a launch." });
    transcript.add({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "Tell me about a launch." });
    transcript.add({ type: "conversation.item.input_audio_transcription.updated", item_id: "u1", transcript: "I fixed" });
    transcript.add({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "I fixed the Monday dashboard. It was off by 12 percent after a late payout, so I snapshotted the old table and republished it.",
    });
    expect(transcript.coachText()).toBe("Tell me about a launch.");
    expect(transcript.userWords()).toBeGreaterThan(TASTE_MIN_USER_WORDS);
    expect(transcript.isShort()).toBe(false);
    expect(transcript.render()).toContain("Visitor: I fixed the Monday dashboard.");
    expect(transcript.render()).not.toContain("Tell me about a launch. Tell me");

    const short = new TasteTranscript();
    short.add({ type: "response.audio_transcript.done", transcript: "Which seat are you hiring for?" });
    short.add({ type: "conversation.item.input_audio_transcription.updated", transcript: "Hello there" });
    expect(short.isShort()).toBe(true);
    expect(short.userText()).toBe("Hello there");
  });

  it("serves the homepage without vendor names", async () => {
    for (const path of ["/", "/app.js", "/voice-taste.js", "/styles.css"]) {
      const response = await exports.default.fetch(`https://hireme.test${path}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.toLowerCase()).not.toMatch(/grok|xai/);
      if (path === "/" || path === "/app.js") expect(text).toContain("Talk to Coach");
      if (path === "/app.js") {
        expect(text).toContain("Streak: Day 1");
        expect(text).toContain("Your streak: Day 1");
        expect(text).toContain("voice-taste");
      }
    }
  });
});
