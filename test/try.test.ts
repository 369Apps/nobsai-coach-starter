import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseModelJson } from "../src/lib/feedback";
import { defaultTryRole, LEAD_DAILY_LIMIT, linkedinUrl, rotateIndex, TRY_ANSWER_LIMIT, TRY_DAILY_LIMIT, TRY_MAX_OUTPUT_TOKENS, TRY_RETRY_OUTPUT_TOKENS, TRY_ROLES, TRY_SESSION_LENGTH } from "../src/lib/try";
import { utcDate } from "../src/lib/policy";

const sample = "Last quarter the Monday dashboard was off by 12 percent. I traced it to a late Stripe payout, snapshotted the old revenue table, and republished after finance signed off.";

function tryFetch(path: string, ip: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", ip);
  return exports.default.fetch(`https://hireme.test${path}`, { ...init, headers });
}

async function signIn(address: string): Promise<string> {
  const request = await exports.default.fetch("https://hireme.test/api/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: address }),
  });
  const body = (await request.json()) as { magicLink: string };
  const verify = await exports.default.fetch(body.magicLink, { redirect: "manual" });
  const cookie = verify.headers.get("set-cookie") ?? "";
  const match = cookie.match(/hireme_session=([^;]+)/);
  return `hireme_session=${match?.[1]}`;
}

describe("try coach", () => {
  it("parses a fenced or trailing-comma score without keeping the model text in the error", () => {
    expect(TRY_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(1200);
    expect(TRY_RETRY_OUTPUT_TOKENS).toBeGreaterThan(TRY_MAX_OUTPUT_TOKENS);
    expect(parseModelJson("```json\n{\"overall\":4,\"summary\":\"Clear.\"}\n```")).toMatchObject({ overall: 4 });
    expect(parseModelJson("Here you go {\"overall\": 3, \"summary\": \"Fine\",}")).toMatchObject({ overall: 3 });
    expect(parseModelJson("{\"summary\": \"a } brace\", \"overall\": 2}")).toMatchObject({ overall: 2, summary: "a } brace" });
    expect(() => parseModelJson("not json at all")).toThrow("parse");
  });

  it("rotates three interview questions for each role chip", async () => {
    expect(defaultTryRole(utcDate()) in TRY_ROLES).toBe(true);
    expect(TRY_DAILY_LIMIT).toBe(9);
    expect(rotateIndex("2026-10-24:fde", 6)).toBe(rotateIndex("2026-10-24:fde", 6));
    for (const role of ["ai_engineer", "fde", "data_engineer"] as const) {
      const response = await tryFetch(`/api/try?role=${role}`, `get-${role}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        role: string;
        questions: Array<{ taskId: string; prompt: string; title: string }>;
        sessionLength: number;
        remaining: number;
      };
      expect(body.role).toBe(role);
      expect(body.sessionLength).toBe(TRY_SESSION_LENGTH);
      expect(body.questions).toHaveLength(TRY_SESSION_LENGTH);
      expect(new Set(body.questions.map((item) => item.taskId)).size).toBe(TRY_SESSION_LENGTH);
      expect(body.remaining).toBe(TRY_DAILY_LIMIT);
      for (const question of body.questions) {
        expect(question.prompt.length).toBeGreaterThan(20);
        const row = await env.DB.prepare(`SELECT role, kind FROM tasks WHERE id = ?`).bind(question.taskId).first<{ role: string; kind: string }>();
        expect(row).toEqual({ role, kind: "interview" });
      }
      const again = (await (await tryFetch(`/api/try?role=${role}`, `get-${role}`)).json()) as { questions: Array<{ taskId: string }> };
      expect(again.questions.map((item) => item.taskId)).toEqual(body.questions.map((item) => item.taskId));
    }
    const unknown = await tryFetch("/api/try?role=recruiter", "get-bad");
    expect(unknown.status).toBe(400);
  });

  it("scores a session and stops at nine answers per IP", async () => {
    const ip = `score-${crypto.randomUUID()}`;
    const session = (await (await tryFetch("/api/try?role=data_engineer", ip)).json()) as {
      questions: Array<{ taskId: string; prompt: string }>;
    };
    const tooLong = await tryFetch("/api/try", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "data_engineer", taskId: session.questions[0].taskId, answer: "x".repeat(TRY_ANSWER_LIMIT + 1) }),
    });
    expect(tooLong.status).toBe(400);
    const empty = await tryFetch("/api/try", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "data_engineer", taskId: session.questions[0].taskId, answer: " " }),
    });
    expect(empty.status).toBe(400);

    for (let n = 0; n < TRY_DAILY_LIMIT; n += 1) {
      const question = session.questions[n % session.questions.length];
      const response = await tryFetch("/api/try", ip, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "data_engineer", taskId: question.taskId, answer: sample }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { score: number; strength: string; fix: string; remaining: number; prompt: string };
      expect(body.score).toBeGreaterThanOrEqual(1);
      expect(body.score).toBeLessThanOrEqual(5);
      expect(body.strength.length).toBeGreaterThan(0);
      expect(body.fix.length).toBeGreaterThan(0);
      expect(body.prompt).toBe(question.prompt);
      expect(body.remaining).toBe(TRY_DAILY_LIMIT - 1 - n);
      expect(JSON.stringify(body).toLowerCase()).not.toMatch(/grok|xai/);
    }

    const blocked = await tryFetch("/api/try", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "fde", answer: sample }),
    });
    expect(blocked.status).toBe(429);
    const blockedBody = (await blocked.json()) as { remaining: number; message: string };
    expect(blockedBody.remaining).toBe(0);
    expect(blockedBody.message.toLowerCase()).not.toMatch(/grok|xai/);

    const other = await tryFetch("/api/try", `other-${crypto.randomUUID()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "ai_engineer", answer: sample }),
    });
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { remaining: number; role: string };
    expect(otherBody.remaining).toBe(TRY_DAILY_LIMIT - 1);
    expect(otherBody.role).toBe("ai_engineer");
  });

  it("stores a blank LinkedIn for the prefilled prefix and one canonical profile URL", async () => {
    expect(linkedinUrl("")).toBeNull();
    expect(linkedinUrl("https://linkedin.com/in/")).toBeNull();
    expect(linkedinUrl("https://linkedin.com/in")).toBeNull();
    expect(linkedinUrl("https://www.linkedin.com/in/ada")).toBe("https://linkedin.com/in/ada");
    expect(linkedinUrl("www.linkedin.com/in/ada")).toBe("https://linkedin.com/in/ada");
    expect(linkedinUrl("linkedin.com/in/ada")).toBe("https://linkedin.com/in/ada");
    expect(linkedinUrl("http://linkedin.com/in/ada/")).toBe("https://linkedin.com/in/ada");
    expect(linkedinUrl("https://linkedin.com/in/https://www.linkedin.com/in/ada")).toBe("https://linkedin.com/in/ada");
    expect(linkedinUrl("https://linkedin.com/in/www.linkedin.com/in/ada-lovelace")).toBe("https://linkedin.com/in/ada-lovelace");
    expect(linkedinUrl("https://linkedin.com/in/https://linkedin.com/in/ada")).toBe("https://linkedin.com/in/ada");
    expect(linkedinUrl("not a url")).toBe("invalid");

    const ip = `linkedin-${crypto.randomUUID()}`;
    const email = `lin.${crypto.randomUUID()}@hireme.test`;
    const prefix = await tryFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Lin",
        email,
        role: "fde",
        linkedin: "https://linkedin.com/in/",
        consent: true,
        sessionAvg: 3,
      }),
    });
    expect(prefix.status).toBe(200);
    const blank = await env.DB.prepare(`SELECT linkedin FROM leads WHERE email = ?`).bind(email).first<{ linkedin: string | null }>();
    expect(blank?.linkedin).toBeNull();

    const pasted = await tryFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Lin",
        email,
        role: "fde",
        linkedin: "https://linkedin.com/in/https://www.linkedin.com/in/lin",
        consent: true,
        sessionAvg: 4,
      }),
    });
    expect(pasted.status).toBe(200);
    const row = await env.DB.prepare(`SELECT linkedin FROM leads WHERE email = ?`).bind(email).first<{ linkedin: string | null }>();
    expect(row?.linkedin).toBe("https://linkedin.com/in/lin");
  });

  it("stores a try-coach lead, refreshes the same email, and rate-limits an IP", async () => {
    const ip = `lead-${crypto.randomUUID()}`;
    const email = `ada.${crypto.randomUUID()}@hireme.test`;
    const missing = await tryFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Ada", email: "not-an-email", role: "fde", consent: true, sessionAvg: 3.5 }),
    });
    expect(missing.status).toBe(400);
    const noConsent = await tryFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Ada", email, role: "fde", consent: false, sessionAvg: 3.5 }),
    });
    expect(noConsent.status).toBe(400);

    const saved = await tryFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Ada",
        email,
        role: "data_engineer",
        linkedin: "https://www.linkedin.com/in/ada",
        consent: true,
        sessionAvg: 3.4,
      }),
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { message: string; email: string };
    expect(savedBody.email).toBe(email);
    expect(savedBody.message).toContain("Start free");
    expect(JSON.stringify(savedBody).toLowerCase()).not.toMatch(/grok|xai/);

    const again = await tryFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Ada", email, role: "fde", consent: true, sessionAvg: 4.2 }),
    });
    expect(again.status).toBe(200);
    const row = await env.DB.prepare(`SELECT first_name, role, session_avg, source, consent FROM leads WHERE email = ?`).bind(email).first<{
      first_name: string;
      role: string;
      session_avg: number;
      source: string;
      consent: number;
    }>();
    expect(row).toMatchObject({ first_name: "Ada", role: "fde", session_avg: 4.2, source: "try-coach", consent: 1 });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE email = ?`).bind(email).first<{ n: number }>();
    expect(count?.n).toBe(1);

    for (let n = 0; n < LEAD_DAILY_LIMIT - 1; n += 1) {
      const response = await tryFetch("/api/lead", ip, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: "Ada",
          email: `extra.${n}.${crypto.randomUUID()}@hireme.test`,
          role: "ai_engineer",
          consent: true,
          sessionAvg: 3,
        }),
      });
      expect(response.status).toBe(200);
    }
    const limited = await tryFetch("/api/lead", ip, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Ada",
        email: `blocked.${crypto.randomUUID()}@hireme.test`,
        role: "ai_engineer",
        consent: true,
        sessionAvg: 3,
      }),
    });
    expect(limited.status).toBe(429);

    const stranger = await signIn(`stranger.${crypto.randomUUID()}@hireme.test`);
    const denied = await exports.default.fetch("https://hireme.test/api/admin/leads.csv", { headers: { cookie: stranger } });
    expect(denied.status).toBe(403);
    env.ADMIN_EMAILS = "coach@example.com";
    const admin = await signIn("coach@example.com");
    const summary = await exports.default.fetch("https://hireme.test/api/admin/summary", { headers: { cookie: admin } });
    expect(summary.status).toBe(200);
    const summaryBody = (await summary.json()) as { leads: Array<{ email: string; sessionAvg: number }> };
    expect(summaryBody.leads.some((lead) => lead.email === email && lead.sessionAvg === 4.2)).toBe(true);
    const csv = await exports.default.fetch("https://hireme.test/api/admin/leads.csv", { headers: { cookie: admin } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toBe("first_name,email,role,linkedin,consent,session_avg,source,created_at");
    expect(text).toContain(email);
    expect(text.toLowerCase()).not.toMatch(/grok|xai/);
  });
});
