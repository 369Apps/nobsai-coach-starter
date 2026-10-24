import type { Channel } from "./policy";

export interface Usage {
  text: number;
  voice: number;
  live: number;
}

export type ReserveResult =
  | { ok: true; charged: number; used: number; remaining: number; cap: number }
  | { ok: false; used: number; remaining: number; cap: number };

const COLUMNS: Record<Channel, "text_seconds" | "voice_seconds" | "live_seconds"> = {
  text: "text_seconds",
  voice: "voice_seconds",
  live: "live_seconds",
};

export async function getUsage(db: D1Database, userId: string, date: string): Promise<Usage> {
  const row = await db
    .prepare(
      `SELECT text_seconds, voice_seconds, live_seconds
       FROM daily_usage WHERE user_id = ? AND usage_date = ?`,
    )
    .bind(userId, date)
    .first<{ text_seconds: number; voice_seconds: number; live_seconds: number }>();
  return {
    text: row?.text_seconds ?? 0,
    voice: row?.voice_seconds ?? 0,
    live: row?.live_seconds ?? 0,
  };
}

async function ensureRow(db: D1Database, userId: string, date: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_usage (user_id, usage_date, text_seconds, voice_seconds, live_seconds)
       VALUES (?, ?, 0, 0, 0)
       ON CONFLICT (user_id, usage_date) DO NOTHING`,
    )
    .bind(userId, date)
    .run();
}

export async function reserve(
  db: D1Database,
  userId: string,
  date: string,
  channel: Channel,
  seconds: number,
  cap: number,
): Promise<ReserveResult> {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("seconds must be a positive integer");
  }
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error("cap must be a non-negative integer");
  }
  const column = COLUMNS[channel];
  await ensureRow(db, userId, date);
  const updated = await db
    .prepare(
      `UPDATE daily_usage
       SET ${column} = ${column} + ?
       WHERE user_id = ? AND usage_date = ? AND ${column} + ? <= ?`,
    )
    .bind(seconds, userId, date, seconds, cap)
    .run();
  const usage = await getUsage(db, userId, date);
  const used = usage[channel];
  if ((updated.meta.changes ?? 0) < 1) {
    return { ok: false, used, remaining: Math.max(0, cap - used), cap };
  }
  return { ok: true, charged: seconds, used, remaining: Math.max(0, cap - used), cap };
}

export async function release(
  db: D1Database,
  userId: string,
  date: string,
  channel: Channel,
  seconds: number,
): Promise<void> {
  if (!Number.isInteger(seconds) || seconds <= 0) return;
  const column = COLUMNS[channel];
  await db
    .prepare(
      `UPDATE daily_usage
       SET ${column} = MAX(0, ${column} - ?)
       WHERE user_id = ? AND usage_date = ?`,
    )
    .bind(seconds, userId, date)
    .run();
}

export async function touchActivity(db: D1Database, userId: string, date: string): Promise<void> {
  await db
    .prepare(`INSERT INTO activity (user_id, usage_date) VALUES (?, ?) ON CONFLICT (user_id, usage_date) DO NOTHING`)
    .bind(userId, date)
    .run();
}
