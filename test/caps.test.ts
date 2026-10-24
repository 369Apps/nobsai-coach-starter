import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { offlineFeedback } from "../src/lib/feedback";
import {
  allows,
  nextStreak,
  parseCaps,
  planLiveCharge,
  previousDate,
  textTurnSeconds,
  utcDate,
  voicePipelineSeconds,
} from "../src/lib/policy";
import { assertStripeTestKey, signStripeHeader, StripeConfigError, verifyStripeSignature } from "../src/lib/stripe";
import { getUsage, reserve } from "../src/lib/usage";

const today = utcDate();

function email(label: string): string {
  return `${label}.${crypto.randomUUID()}@hireme.test`;
}

async function signIn(address: string): Promise<string> {
  const request = await exports.default.fetch("https://hireme.test/api/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: address }),
  });
  expect(request.status).toBe(200);
  const body = (await request.json()) as { magicLink: string };
  const verify = await exports.default.fetch(body.magicLink, { redirect: "manual" });
  expect(verify.status).toBe(302);
  const cookie = verify.headers.get("set-cookie") ?? "";
  const match = cookie.match(/hireme_session=([^;]+)/);
  expect(match).toBeTruthy();
  return `hireme_session=${match?.[1]}`;
}

async function authed(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return exports.default.fetch(`https://hireme.test${path}`, { ...init, headers });
}

async function userId(address: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(address).first<{ id: string }>();
  if (!row) throw new Error(`missing user ${address}`);
  return row.id;
}

async function setTier(address: string, tier: string, firstPick = 0): Promise<void> {
  await env.DB.prepare(`UPDATE users SET tier = ?, first_pick = ?, target_role = 'fde' WHERE email = ?`)
    .bind(tier, firstPick, address)
    .run();
}

async function setChannel(address: string, column: "text_seconds" | "voice_seconds" | "live_seconds", seconds: number): Promise<void> {
  const id = await userId(address);
  await env.DB.prepare(
    `INSERT INTO daily_usage (user_id, usage_date, text_seconds, voice_seconds, live_seconds)
     VALUES (?, ?, 0, 0, 0)
     ON CONFLICT (user_id, usage_date) DO NOTHING`,
  )
    .bind(id, today)
    .run();
  await env.DB.prepare(`UPDATE daily_usage SET ${column} = ? WHERE user_id = ? AND usage_date = ?`)
    .bind(seconds, id, today)
    .run();
}

describe("policy", () => {
  it("keeps paid voice and live caps at least 10 minutes", () => {
    const caps = parseCaps({ VOICE_DAILY_CAP_SECONDS: "30", LIVE_DAILY_CAP_SECONDS: "60" });
    expect(caps.voice).toBe(600);
    expect(caps.live).toBe(600);
    expect(parseCaps({}).freeText).toBe(600);
    expect(parseCaps({}).voice).toBeGreaterThanOrEqual(600);
  });

  it("charges a minimum text turn and includes the voice pause", () => {
    expect(textTurnSeconds(5, 20)).toBe(20);
    expect(textTurnSeconds(90, 20)).toBe(90);
    expect(textTurnSeconds(99999, 20)).toBe(15 * 60);
    expect(voicePipelineSeconds({ sttDuration: 10.2, spokenChars: 28, pauseSeconds: 2 })).toBe(15);
  });

  it("stops a live session when the remaining room is gone", () => {
    expect(planLiveCharge(10, 8, 5)).toEqual({ take: 2, stop: false });
    expect(planLiveCharge(20, 8, 5)).toEqual({ take: 5, stop: true });
    expect(planLiveCharge(12, 12, 0)).toEqual({ take: 0, stop: false });
    expect(planLiveCharge(13, 12, 0)).toEqual({ take: 0, stop: true });
  });

  it("gates features by tier", () => {
    expect(allows("free", "text")).toBe(true);
    expect(allows("free", "voice")).toBe(false);
    expect(allows("free", "tracker")).toBe(false);
    expect(allows("voice", "voice")).toBe(true);
    expect(allows("voice", "live")).toBe(false);
    expect(allows("live", "voice")).toBe(true);
    expect(allows("live", "tracker")).toBe(true);
    expect(allows("live", "coach")).toBe(false);
    expect(allows("coach", "first_pick")).toBe(true);
  });

  it("continues a streak only from yesterday", () => {
    expect(nextStreak(4, previousDate(today), today)).toBe(5);
    expect(nextStreak(4, today, today)).toBe(4);
    expect(nextStreak(4, "2020-01-01", today)).toBe(1);
  });
});

describe("models", () => {
  it("exposes the configured text, voice, and transcription models", async () => {
    const response = await exports.default.fetch("https://hireme.test/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { textModel: string; voiceModel: string; sttModel: string; stripeMode: string; modelConfigured: boolean };
    expect(body.textModel).toBe("grok-4.7");
    expect(body.voiceModel).toBe("grok-voice-latest");
    expect(body.sttModel).toBe("grok-voice-transcribe-2.0");
    expect(body.modelConfigured).toBe(false);
    expect(body.stripeMode).toBe("test");
    const brand = await exports.default.fetch("https://hireme.test/api/brand");
    expect(brand.status).toBe(200);
    const copy = (await brand.json()) as { name: string; headline: string; trust: string; coach: string };
    expect(copy).toMatchObject({
      name: "No BS AI",
      headline: "Get hired as a Forward Deployed Engineer.",
      trust: "Built by No BS AI. Placement through DeployedX.",
      coach: "Coach from Hire Me",
    });
    expect(JSON.stringify(copy).toLowerCase()).not.toMatch(/grok|xai/);
    expect(JSON.stringify(copy).toLowerCase()).not.toContain("bobby" + "@");
  });
});

describe("minute caps", () => {
  it("refuses a reserve that would pass the cap and leaves the row unchanged", async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (id, email, tier, first_pick, streak_count, created_at, updated_at) VALUES (?, ?, 'free', 0, 0, ?, ?)`,
    )
      .bind(id, email("reserve"), now, now)
      .run();
    const first = await reserve(env.DB, id, today, "text", 590, 600);
    expect(first.ok).toBe(true);
    const blocked = await reserve(env.DB, id, today, "text", 20, 600);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.used).toBe(590);
    const exact = await reserve(env.DB, id, today, "text", 10, 600);
    expect(exact.ok).toBe(true);
    expect((await getUsage(env.DB, id, today)).text).toBe(600);
    const over = await reserve(env.DB, id, today, "text", 1, 600);
    expect(over.ok).toBe(false);
  });

  it("hard-caps free text at 10 minutes on the answer route", async () => {
    const address = email("free-text");
    const cookie = await signIn(address);
    await setTier(address, "free");
    await setChannel(address, "text_seconds", 580);
    const ok = await authed(cookie, "/api/today/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "I shipped the fix in a day and the queue dropped by 30 percent.", elapsedSeconds: 20 }),
    });
    expect(ok.status).toBe(200);
    const scored = (await ok.json()) as { feedback: { source: string; clarity: number } };
    expect(scored.feedback.source).toBe("offline-rubric");
    expect(scored.feedback.clarity).toBeGreaterThan(0);
    expect((await getUsage(env.DB, await userId(address), today)).text).toBe(600);

    const blocked = await authed(cookie, "/api/today/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Another pass that should not be stored.", elapsedSeconds: 20 }),
    });
    expect(blocked.status).toBe(402);
    const body = (await blocked.json()) as { error: string; capSeconds: number };
    expect(body.error).toBe("daily_cap");
    expect(body.capSeconds).toBe(600);
    expect((await getUsage(env.DB, await userId(address), today)).text).toBe(600);
    const assignment = await env.DB.prepare(
      `SELECT status FROM daily_assignments WHERE user_id = ? AND usage_date = ?`,
    )
      .bind(await userId(address), today)
      .first<{ status: string }>();
    expect(assignment?.status).toBe("completed");
  });

  it("lets a paid plan past 10 minutes of text and still enforces the safety ceiling", async () => {
    const address = email("paid-text");
    const cookie = await signIn(address);
    await setTier(address, "voice");
    const ok = await authed(cookie, "/api/today/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "I led the cutover and error rate fell from 4% to 0.5%.", elapsedSeconds: 700 }),
    });
    expect(ok.status).toBe(200);
    expect((await getUsage(env.DB, await userId(address), today)).text).toBe(700);

    await setChannel(address, "text_seconds", 14390);
    const blocked = await authed(cookie, "/api/today/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "This should hit the safety ceiling.", elapsedSeconds: 20 }),
    });
    expect(blocked.status).toBe(402);
    expect((await getUsage(env.DB, await userId(address), today)).text).toBe(14390);
  });

  it("counts the free makeover against the text cap", async () => {
    const address = email("makeover");
    const cookie = await signIn(address);
    await setTier(address, "free");
    await setChannel(address, "text_seconds", 550);
    const blocked = await authed(cookie, "/api/makeover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headline: "Engineer", resume: "Shipped the onboarding integration for one enterprise tenant." }),
    });
    expect(blocked.status).toBe(402);
    expect((await getUsage(env.DB, await userId(address), today)).text).toBe(550);
  });
});

describe("tier gating", () => {
  it("blocks voice, live, tracker, and coach below their plans", async () => {
    const freeAddress = email("gate-free");
    const freeCookie = await signIn(freeAddress);
    await setTier(freeAddress, "free");
    expect((await authed(freeCookie, "/api/interview/voice", { method: "POST" })).status).toBe(403);
    expect((await authed(freeCookie, "/api/interview/voice/open", { method: "POST" })).status).toBe(403);
    expect((await authed(freeCookie, "/api/interview/live/session", { method: "POST" })).status).toBe(403);
    expect((await authed(freeCookie, "/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await authed(freeCookie, "/api/coach/requests", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);

    const voiceAddress = email("gate-voice");
    const voiceCookie = await signIn(voiceAddress);
    await setTier(voiceAddress, "voice");
    await setChannel(voiceAddress, "voice_seconds", 900);
    const atCap = await authed(voiceCookie, "/api/interview/voice", { method: "POST" });
    expect(atCap.status).toBe(402);
    expect((await authed(voiceCookie, "/api/interview/voice/open", { method: "POST" })).status).toBe(402);
    await setChannel(voiceAddress, "voice_seconds", 0);
    const needsKey = await authed(voiceCookie, "/api/interview/voice", { method: "POST" });
    expect(needsKey.status).toBe(503);
    expect((await authed(voiceCookie, "/api/interview/voice/open", { method: "POST" })).status).toBe(503);
    expect((await authed(voiceCookie, "/api/interview/live/session", { method: "POST" })).status).toBe(403);
    expect((await authed(voiceCookie, "/api/applications")).status).toBe(403);

    const liveAddress = email("gate-live");
    const liveCookie = await signIn(liveAddress);
    await setTier(liveAddress, "live");
    await setChannel(liveAddress, "live_seconds", 900);
    expect((await authed(liveCookie, "/api/interview/live/session", { method: "POST" })).status).toBe(402);
    await setChannel(liveAddress, "live_seconds", 0);
    expect((await authed(liveCookie, "/api/interview/live/session", { method: "POST" })).status).toBe(503);
    const created = await authed(liveCookie, "/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "Example Analytics", roleTitle: "AI Engineer", status: "sent" }),
    });
    expect(created.status).toBe(201);
    const autoApply = await authed(liveCookie, "/api/applications/auto-apply", { method: "POST" });
    expect(autoApply.status).toBe(501);
    const stub = (await autoApply.json()) as { message: string };
    expect(stub.message).toMatch(/Google OAuth/);
    expect(stub.message).toMatch(/LinkedIn/);
    expect((await authed(liveCookie, "/api/coach/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferredTimes: "Thursday morning" }),
    })).status).toBe(403);
    const me = (await (await authed(liveCookie, "/api/me")).json()) as { user: { firstPick: boolean } };
    expect(me.user.firstPick).toBe(false);

    const coachAddress = email("gate-coach");
    const coachCookie = await signIn(coachAddress);
    await setTier(coachAddress, "coach", 1);
    const booked = await authed(coachCookie, "/api/coach/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferredTimes: "Thursday morning", focus: "Production story" }),
    });
    expect(booked.status).toBe(201);
    const coachMe = (await (await authed(coachCookie, "/api/me")).json()) as { user: { firstPick: boolean; tier: string } };
    expect(coachMe.user.tier).toBe("coach");
    expect(coachMe.user.firstPick).toBe(true);
  });

  it("updates the streak once per day", async () => {
    const address = email("streak");
    const cookie = await signIn(address);
    await setTier(address, "free");
    await env.DB.prepare(`UPDATE users SET streak_count = 4, streak_last_date = ? WHERE email = ?`)
      .bind(previousDate(today), address)
      .run();
    const first = await authed(cookie, "/api/today/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Yesterday I closed the loop. Today I continued it with a 12% drop.", elapsedSeconds: 20 }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { streak: number }).streak).toBe(5);
    const second = await authed(cookie, "/api/today/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Same day, second pass, still one streak.", elapsedSeconds: 20 }),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { streak: number }).streak).toBe(5);
  });

  it("shows the admin desk only to the admin list", async () => {
    env.ADMIN_EMAILS = "coach@example.com";
    const address = email("not-admin");
    const cookie = await signIn(address);
    expect((await authed(cookie, "/api/admin/summary")).status).toBe(403);

    const adminId = await userId("coach@example.com");
    await env.DB.prepare(`INSERT INTO activity (user_id, usage_date) VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(adminId, today).run();
    const adminCookie = await signIn("coach@example.com");
    const summary = await authed(adminCookie, "/api/admin/summary");
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as { dau: number; minutesByTier: unknown[]; liveCostEstimateUsd: number };
    expect(body.dau).toBeGreaterThan(0);
    expect(Array.isArray(body.minutesByTier)).toBe(true);
    const hire = await authed(adminCookie, "/api/admin/hires", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateName: "Demo Candidate", company: "Example Grid", roleTitle: "Forward Deployed Engineer" }),
    });
    expect(hire.status).toBe(201);
  });
});

describe("stripe test mode", () => {
  it("refuses live keys and accepts a signed test webhook", async () => {
    expect(() => assertStripeTestKey("sk_live_nope")).toThrow(StripeConfigError);
    expect(() => assertStripeTestKey("sk_test_ok")).not.toThrow();
    const bad = await verifyStripeSignature("{}", "t=1,v1=deadbeef", "whsec_test_hireme", 300, 1);
    expect(bad).toBe(false);

    const address = email("stripe");
    const cookie = await signIn(address);
    env.STRIPE_SECRET_KEY = "sk_live_refused";
    const refused = await authed(cookie, "/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "voice" }),
    });
    expect(refused.status).toBe(400);
    env.STRIPE_SECRET_KEY = "sk_test_hireme";
    const unpriced = await authed(cookie, "/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "coach" }),
    });
    expect(unpriced.status).toBe(503);

    const id = await userId(address);
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { metadata: { user_id: id, tier: "coach" }, customer: "cus_test_hireme", subscription: "sub_test_hireme" } },
    });
    const header = await signStripeHeader(payload, "whsec_test_hireme");
    const webhook = await exports.default.fetch("https://hireme.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body: payload,
    });
    expect(webhook.status).toBe(200);
    const row = await env.DB.prepare(`SELECT tier, first_pick FROM users WHERE id = ?`).bind(id).first<{ tier: string; first_pick: number }>();
    expect(row).toEqual({ tier: "coach", first_pick: 1 });

    const tampered = await exports.default.fetch("https://hireme.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body: payload.replace("coach", "voice"),
    });
    expect(tampered.status).toBe(400);

    const deleted = JSON.stringify({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test_hireme", customer: "cus_test_hireme", status: "canceled" } },
    });
    const deletedHeader = await signStripeHeader(deleted, "whsec_test_hireme");
    const downgrade = await exports.default.fetch("https://hireme.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": deletedHeader, "content-type": "application/json" },
      body: deleted,
    });
    expect(downgrade.status).toBe(200);
    const after = await env.DB.prepare(`SELECT tier, first_pick FROM users WHERE id = ?`).bind(id).first<{ tier: string; first_pick: number }>();
    expect(after).toEqual({ tier: "free", first_pick: 0 });
  });
});

describe("offline rubric", () => {
  it("scores a thin answer lower on impact than one with a number", () => {
    const thin = offlineFeedback("We worked hard and it went well.", "Tell me about a launch.");
    const solid = offlineFeedback(
      "When the tenant cutover slipped, I owned the rollback plan and error rate fell 4 percent.",
      "Tell me about a launch.",
    );
    expect(solid.impact).toBeGreaterThan(thin.impact);
    expect(thin.source).toBe("offline-rubric");
  });
});
