import { getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "./lib/http";
import { isAdminEmail, isProduction, randomToken, sha256Hex } from "./lib/http";
import { displayName } from "./lib/coach-session";
import { isRole, isTier, type RoleId, type Tier } from "./lib/policy";

export interface UserRow {
  id: string;
  email: string;
  target_role: RoleId | null;
  tier: Tier;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  first_pick: number;
  headline: string | null;
  resume_text: string | null;
  makeover_json: string | null;
  streak_count: number;
  streak_last_date: string | null;
  display_name: string | null;
  target_company: string | null;
  interview_date: string | null;
  last_weak_spot: string | null;
  created_at: string;
  updated_at: string;
}

const USER_COLUMNS = `id, email, target_role, tier, stripe_customer_id, stripe_subscription_id, first_pick,
  headline, resume_text, makeover_json, streak_count, streak_last_date,
  display_name, target_company, interview_date, last_weak_spot, created_at, updated_at`;

export async function getUser(c: AppContext): Promise<UserRow | null> {
  const sessionId = getCookie(c, "hireme_session");
  if (!sessionId) return null;
  const now = new Date().toISOString();
  const row = await c.env.DB.prepare(
    `SELECT ${USER_COLUMNS}
     FROM users
     WHERE id = (SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?)`,
  )
    .bind(sessionId, now)
    .first<UserRow>();
  if (!row || !isTier(row.tier)) return null;
  if (row.target_role && !isRole(row.target_role)) row.target_role = null;
  return row;
}

export async function requireUser(c: AppContext): Promise<UserRow | Response> {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Sign in with the magic link first." }, 401);
  return user;
}

export function isResponse(value: UserRow | Response): value is Response {
  return value instanceof Response;
}

export async function createSession(c: AppContext, userId: string): Promise<void> {
  const sessionId = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  await c.env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).bind(sessionId, userId, expires, now.toISOString()).run();
  setCookie(c, "hireme_session", sessionId, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: isProduction(c.env),
    maxAge: 14 * 24 * 60 * 60,
  });
}

export async function issueMagicLink(c: AppContext, email: string): Promise<{ delivery: "dev" | "webhook"; magicLink?: string }> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + 20 * 60 * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO magic_links (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(tokenHash, email, expires, now.toISOString())
    .run();
  const link = `${new URL(c.req.url).origin}/api/auth/verify?token=${token}`;
  if (c.env.EMAIL_WEBHOOK_URL) {
    await fetch(c.env.EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, magicLink: link }),
    }).catch((error: unknown) => {
      console.log(JSON.stringify({ event: "email_webhook_failed", message: error instanceof Error ? error.message : "failed" }));
    });
  }
  if (!isProduction(c.env)) return { delivery: "dev", magicLink: link };
  return { delivery: "webhook" };
}

export function publicUser(user: UserRow, adminEmails: string | undefined) {
  return {
    id: user.id,
    email: user.email,
    targetRole: user.target_role,
    tier: user.tier,
    firstPick: user.first_pick === 1,
    streak: user.streak_count,
    streakLastDate: user.streak_last_date,
    headline: user.headline,
    displayName: user.display_name,
    name: displayName(user),
    targetCompany: user.target_company,
    interviewDate: user.interview_date,
    lastWeakSpot: user.last_weak_spot,
    isAdmin: isAdminEmail(adminEmails, user.email),
  };
}
