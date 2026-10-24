import { nextStreak, type Tier } from "./policy";
import { daysUntil, nameFromEmail, type CoachContext } from "./voice-coach";

export type CoachChannel = "voice" | "live";

export const DEFAULT_WEAK_SPOT = "a concrete result";

export interface CoachUser {
  id: string;
  email: string;
  display_name: string | null;
  target_company: string | null;
  interview_date: string | null;
  last_weak_spot: string | null;
  streak_count: number;
  streak_last_date: string | null;
  tier: Tier;
  targetRoleLabel: string;
}

export interface StoredSession {
  channel: CoachChannel;
  usageDate: string;
  structure: number | null;
  clarity: number | null;
  impact: number | null;
  weakSpot: string | null;
  openingWeakSpot: string | null;
}

interface SessionRow {
  channel: CoachChannel;
  usage_date: string;
  structure: number | null;
  clarity: number | null;
  impact: number | null;
  weak_spot: string | null;
  opening_weak_spot: string | null;
}

export function displayName(user: { display_name: string | null; email: string }): string {
  const named = user.display_name?.trim();
  if (named) return named;
  return nameFromEmail(user.email);
}

export async function resolveOpeningWeakSpot(db: D1Database, userId: string, today: string, fallback: string | null): Promise<string> {
  const todayRow = await db
    .prepare(
      `SELECT opening_weak_spot FROM coach_sessions
       WHERE user_id = ? AND usage_date = ? AND opening_weak_spot IS NOT NULL AND opening_weak_spot != ''
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(userId, today)
    .first<{ opening_weak_spot: string }>();
  if (todayRow?.opening_weak_spot) return todayRow.opening_weak_spot;
  const previous = await db
    .prepare(
      `SELECT weak_spot FROM coach_sessions
       WHERE user_id = ? AND usage_date < ? AND weak_spot IS NOT NULL AND weak_spot != ''
       ORDER BY usage_date DESC, updated_at DESC LIMIT 1`,
    )
    .bind(userId, today)
    .first<{ weak_spot: string }>();
  if (previous?.weak_spot) return previous.weak_spot;
  const stored = fallback?.trim();
  return stored || DEFAULT_WEAK_SPOT;
}

export async function ensureCoachSession(
  db: D1Database,
  input: { userId: string; usageDate: string; channel: CoachChannel; openingWeakSpot: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO coach_sessions (
         id, user_id, usage_date, channel, opening_weak_spot, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, usage_date, channel) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), input.userId, input.usageDate, input.channel, input.openingWeakSpot, now, now)
    .run();
}

export async function buildCoachContext(db: D1Database, user: CoachUser, today: string): Promise<CoachContext> {
  const lastSessionWeakSpot = await resolveOpeningWeakSpot(db, user.id, today, user.last_weak_spot);
  return {
    name: displayName(user),
    targetRole: user.targetRoleLabel,
    targetCompany: user.target_company?.trim() || null,
    streakDays: user.streak_count,
    lastSessionWeakSpot,
    interviewDate: user.interview_date,
    today,
    tier: user.tier,
    streakAlreadyCounted: user.streak_last_date === today,
  };
}

export async function saveSessionScore(
  db: D1Database,
  input: {
    userId: string;
    usageDate: string;
    channel: CoachChannel;
    openingWeakSpot: string;
    structure?: number | null;
    clarity?: number | null;
    impact?: number | null;
    weakSpot?: string | null;
  },
): Promise<StoredSession> {
  await ensureCoachSession(db, input);
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (input.structure != null) {
    sets.push("structure = ?");
    values.push(input.structure);
  }
  if (input.clarity != null) {
    sets.push("clarity = ?");
    values.push(input.clarity);
  }
  if (input.impact != null) {
    sets.push("impact = ?");
    values.push(input.impact);
  }
  if (input.weakSpot) {
    sets.push("weak_spot = ?");
    values.push(input.weakSpot);
  }
  const now = new Date().toISOString();
  if (sets.length > 0) {
    await db
      .prepare(
        `UPDATE coach_sessions SET ${sets.join(", ")}, updated_at = ?
         WHERE user_id = ? AND usage_date = ? AND channel = ?`,
      )
      .bind(...values, now, input.userId, input.usageDate, input.channel)
      .run();
  }
  if (input.weakSpot) {
    await db
      .prepare(`UPDATE users SET last_weak_spot = ?, updated_at = ? WHERE id = ?`)
      .bind(input.weakSpot, now, input.userId)
      .run();
  }
  if (input.structure != null || input.clarity != null || input.impact != null) {
    await bumpStreakOnce(db, input.userId, input.usageDate, now);
  }
  const row = await loadChannel(db, input.userId, input.usageDate, input.channel);
  if (!row) throw new Error("coach session missing after save");
  return toStored(row);
}

async function bumpStreakOnce(db: D1Database, userId: string, today: string, now: string): Promise<void> {
  const user = await db
    .prepare(`SELECT streak_count, streak_last_date FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ streak_count: number; streak_last_date: string | null }>();
  if (!user || user.streak_last_date === today) return;
  const next = nextStreak(user.streak_count, user.streak_last_date, today);
  await db
    .prepare(
      `UPDATE users SET streak_count = ?, streak_last_date = ?, updated_at = ?
       WHERE id = ? AND (streak_last_date IS NULL OR streak_last_date != ?)`,
    )
    .bind(next, today, now, userId, today)
    .run();
}

export async function listTodaySessions(db: D1Database, userId: string, today: string): Promise<StoredSession[]> {
  const rows = await db
    .prepare(
      `SELECT channel, usage_date, structure, clarity, impact, weak_spot, opening_weak_spot
       FROM coach_sessions WHERE user_id = ? AND usage_date = ? ORDER BY updated_at ASC`,
    )
    .bind(userId, today)
    .all<SessionRow>();
  return (rows.results ?? []).map(toStored);
}

async function loadChannel(db: D1Database, userId: string, today: string, channel: CoachChannel): Promise<SessionRow | null> {
  return db
    .prepare(
      `SELECT channel, usage_date, structure, clarity, impact, weak_spot, opening_weak_spot
       FROM coach_sessions WHERE user_id = ? AND usage_date = ? AND channel = ?`,
    )
    .bind(userId, today, channel)
    .first<SessionRow>();
}

function toStored(row: SessionRow): StoredSession {
  return {
    channel: row.channel,
    usageDate: row.usage_date,
    structure: row.structure,
    clarity: row.clarity,
    impact: row.impact,
    weakSpot: row.weak_spot,
    openingWeakSpot: row.opening_weak_spot,
  };
}

export function coachSummary(opening: string, sessions: StoredSession[], interviewDate: string | null, today: string) {
  const scored = [...sessions].reverse().find((session) => session.structure != null || session.clarity != null || session.impact != null);
  const tomorrow = [...sessions].reverse().find((session) => session.weakSpot)?.weakSpot ?? null;
  return {
    drill: opening,
    interviewDate,
    daysUntilInterview: daysUntil(interviewDate, today),
    tomorrowWeakSpot: tomorrow,
    scores: scored
      ? { structure: scored.structure, clarity: scored.clarity, impact: scored.impact, weakSpot: scored.weakSpot, channel: scored.channel }
      : null,
    sessions,
  };
}
