import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildCoachContext, resolveOpeningWeakSpot, saveSessionScore } from "../src/lib/coach-session";
import { previousDate, utcDate } from "../src/lib/policy";
import {
  daysUntil,
  parseCoachTurn,
  parseSessionScore,
  renderVoiceCoachPrompt,
  VOICE_COACH_SCRIPT,
} from "../src/lib/voice-coach";

const today = utcDate();

function email(label: string): string {
  return `${label}.${crypto.randomUUID()}@hireme.test`;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
  const match = (verify.headers.get("set-cookie") ?? "").match(/hireme_session=([^;]+)/);
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

describe("voice coach prompt", () => {
  it("keeps the script verbatim and fills live context", () => {
    const prompt = renderVoiceCoachPrompt({
      name: "Demo Live",
      targetRole: "AI Engineer",
      targetCompany: "Example Analytics",
      streakDays: 9,
      lastSessionWeakSpot: "explaining a failure without jargon",
      interviewDate: "2026-10-30",
      today: "2026-10-24",
      tier: "live",
      streakAlreadyCounted: false,
    }, "live");
    expect(prompt.startsWith(VOICE_COACH_SCRIPT)).toBe(true);
    expect(prompt).toContain('You are "Coach from Hire Me,"');
    expect(prompt).toContain("Hard stop at 10 minutes.");
    expect(prompt).toContain("Never promise a job, an interview or an outcome.");
    expect(prompt).toContain("{avg}");
    expect(prompt).toContain("{single fix}");
    expect(prompt).toContain("name: Demo Live");
    expect(prompt).toContain("target_role: AI Engineer");
    expect(prompt).toContain("target_company: Example Analytics");
    expect(prompt).toContain("streak_days: 9");
    expect(prompt).toContain("last_session_weak_spot: explaining a failure without jargon");
    expect(prompt).toContain("interview_date: 2026-10-30");
    expect(prompt).toContain("days_until_interview: 6");
    expect(prompt).toContain("tier: live ($100)");
    expect(prompt).toContain("upgrade_moments: no");
    expect(prompt).toContain("pacing only");
    expect(prompt).toContain("record_session_score");
    expect(daysUntil("2026-10-30", "2026-10-24")).toBe(6);
    expect(daysUntil(null, "2026-10-24")).toBeNull();
  });

  it("marks the $20 plan so the script's upgrade lines can fire", () => {
    const prompt = renderVoiceCoachPrompt({
      name: "Demo Voice",
      targetRole: "Solutions Architect",
      targetCompany: null,
      streakDays: 4,
      lastSessionWeakSpot: "a concrete result",
      interviewDate: null,
      today: "2026-10-24",
      tier: "voice",
      streakAlreadyCounted: true,
    }, "pipeline");
    expect(prompt).toContain("tier: voice ($20)");
    expect(prompt).toContain("upgrade_moments: yes");
    expect(prompt).toContain("target_company: none");
    expect(prompt).toContain("interview_date: none");
    expect(prompt).toContain('"spoken"');
    expect(prompt).toContain("Pro");
    expect(prompt).toContain("Done-for-You");
  });
});

describe("coach scores", () => {
  it("parses a pipeline turn and a live tool payload", () => {
    const open = parseCoachTurn('{"spoken":"Hey Demo Voice, day 4 — let\'s go.","structure":null,"clarity":null,"impact":null,"weak_spot":null}');
    expect(open?.spoken).toContain("Hey Demo Voice");
    expect(open?.structure).toBeNull();
    const scored = parseCoachTurn('Note {"spoken":"Structure 3. Clarity 4. Impact 2.","structure":3,"clarity":4,"impact":2,"weak_spot":"land the result"}');
    expect(scored).toMatchObject({ structure: 3, clarity: 4, impact: 2, weakSpot: "land the result" });
    expect(parseSessionScore({ structure: 3, clarity: 4, impact: 2, weak_spot: "land the result" })?.weakSpot).toBe("land the result");
    expect(parseSessionScore({ structure: 9, clarity: 4, impact: 2, weak_spot: "land the result" })).toBeNull();
    expect(parseCoachTurn("not json")).toBeNull();
  });

  it("keeps today's drill and stores the weak spot for the next day", async () => {
    const address = email("coach-score");
    await signIn(address);
    const id = await userId(address);
    const yesterday = previousDate(today);
    await env.DB.prepare(
      `INSERT INTO coach_sessions (
         id, user_id, usage_date, channel, structure, clarity, impact, weak_spot, opening_weak_spot, created_at, updated_at
       ) VALUES (?, ?, ?, 'voice', 3, 3, 2, ?, 'a concrete result', ?, ?)`,
    )
      .bind(crypto.randomUUID(), id, yesterday, "asking a discovery question before the pitch", `${yesterday}T18:00:00.000Z`, `${yesterday}T18:10:00.000Z`)
      .run();

    const opening = await resolveOpeningWeakSpot(env.DB, id, today, "fallback phrase");
    expect(opening).toBe("asking a discovery question before the pitch");

    await saveSessionScore(env.DB, {
      userId: id,
      usageDate: today,
      channel: "voice",
      openingWeakSpot: opening,
      structure: 3,
      clarity: 4,
      impact: 2,
      weakSpot: "land the result line",
    });

    const stillToday = await resolveOpeningWeakSpot(env.DB, id, today, "fallback phrase");
    expect(stillToday).toBe("asking a discovery question before the pitch");

    const tomorrow = addDays(today, 1);
    const next = await resolveOpeningWeakSpot(env.DB, id, tomorrow, "fallback phrase");
    expect(next).toBe("land the result line");

    const stored = await env.DB.prepare(
      `SELECT structure, clarity, impact, weak_spot, opening_weak_spot FROM coach_sessions
       WHERE user_id = ? AND usage_date = ? AND channel = 'voice'`,
    )
      .bind(id, today)
      .first<{ structure: number; clarity: number; impact: number; weak_spot: string; opening_weak_spot: string }>();
    expect(stored).toMatchObject({
      structure: 3,
      clarity: 4,
      impact: 2,
      weak_spot: "land the result line",
      opening_weak_spot: "asking a discovery question before the pitch",
    });

    const user = await env.DB.prepare(`SELECT last_weak_spot, streak_count, streak_last_date FROM users WHERE id = ?`)
      .bind(id)
      .first<{ last_weak_spot: string; streak_count: number; streak_last_date: string }>();
    expect(user?.last_weak_spot).toBe("land the result line");
    expect(user?.streak_last_date).toBe(today);
    expect(user?.streak_count).toBe(1);

    const context = await buildCoachContext(env.DB, {
      id,
      email: address,
      display_name: "Demo Voice",
      target_company: "Example Grid",
      interview_date: addDays(today, 4),
      last_weak_spot: user?.last_weak_spot ?? null,
      streak_count: user?.streak_count ?? 0,
      streak_last_date: user?.streak_last_date ?? null,
      tier: "voice",
      targetRoleLabel: "Solutions Architect",
    }, today);
    expect(context.lastSessionWeakSpot).toBe("asking a discovery question before the pitch");
    expect(context.streakAlreadyCounted).toBe(true);
    const prompt = renderVoiceCoachPrompt(context, "pipeline");
    expect(prompt).toContain("name: Demo Voice");
    expect(prompt).toContain("target_company: Example Grid");
    expect(prompt).toContain("last_session_weak_spot: asking a discovery question before the pitch");
  });

  it("saves the profile fields the coach fills in", async () => {
    const address = email("coach-profile");
    const cookie = await signIn(address);
    await env.DB.prepare(`UPDATE users SET tier = 'voice', target_role = 'fde' WHERE email = ?`).bind(address).run();
    const interview = addDays(today, 6);
    const patched = await authed(cookie, "/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Demo Live",
        targetCompany: "Example Analytics",
        interviewDate: interview,
      }),
    });
    expect(patched.status).toBe(200);
    const me = (await patched.json()) as { user: { name: string; targetCompany: string; interviewDate: string; displayName: string } };
    expect(me.user.name).toBe("Demo Live");
    expect(me.user.displayName).toBe("Demo Live");
    expect(me.user.targetCompany).toBe("Example Analytics");
    expect(me.user.interviewDate).toBe(interview);

    const renamed = await authed(cookie, "/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Mei" }),
    });
    expect(renamed.status).toBe(200);
    const after = (await renamed.json()) as { user: { name: string; targetCompany: string; interviewDate: string } };
    expect(after.user.name).toBe("Mei");
    expect(after.user.targetCompany).toBe("Example Analytics");
    expect(after.user.interviewDate).toBe(interview);

    const brief = await authed(cookie, "/api/today");
    expect(brief.status).toBe(200);
    const todayBody = (await brief.json()) as { coach: { drill: string; daysUntilInterview: number | null } };
    expect(todayBody.coach.drill).toBe("a concrete result");
    expect(todayBody.coach.daysUntilInterview).toBe(6);

    const bad = await authed(cookie, "/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interviewDate: "2026-13-40" }),
    });
    expect(bad.status).toBe(400);
  });
});
