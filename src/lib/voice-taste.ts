import type { AppEnv } from "./http";
import { logEvent } from "./http";
import { clientSecretsUrl } from "./provider";
import { utcDate } from "./policy";
import { TRY_ROLES, type TryRoleId } from "./try";

export const TASTE_SECONDS = 180;
export const DEFAULT_FREE_VOICE_DAILY_SESSIONS = 200;
const MIN_CONNECT_SECONDS = 15;

type DB = AppEnv["DB"];

export interface TasteStatus {
  available: boolean;
  reason: "ready" | "used" | "full" | "offline";
  seconds: number;
}

export interface TasteScore {
  overall: number;
  bestMoment: string;
  fix: string;
}

export interface TasteSummary {
  overall: number | null;
  bestMoment: string;
  fix: string;
  streak: "Day 1";
  short: boolean;
  note: string;
}

export const TASTE_SHORT_NOTE = "Talk a bit longer to get a score";
export const TASTE_SCORE_MISSED = "The score didn't come back.";
export const TASTE_MIN_USER_WORDS = 6;

export interface VoiceTasteRow {
  id: string;
  ip_hash: string;
  usage_date: string;
  role: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  overall: number | null;
  best_moment: string | null;
  fix: string | null;
  status: string;
  client_secret: string | null;
}

export type ReserveResult =
  | { ok: true; id: string }
  | { ok: false; reason: "used" | "full" };

export function freeVoiceDailyCap(env: { FREE_VOICE_DAILY_SESSIONS?: string }): number {
  const raw = env.FREE_VOICE_DAILY_SESSIONS;
  if (raw === undefined || raw === "") return DEFAULT_FREE_VOICE_DAILY_SESSIONS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FREE_VOICE_DAILY_SESSIONS;
  return Math.floor(parsed);
}

export function tasteInstructions(roleLabel: string, opening: string): string {
  return `You are Coach from Hire Me. Your only name is Coach from Hire Me. This is a 3-minute taste of a mock interview for ${roleLabel}. Ask one short question: ${opening} Listen. Then give a score out of 5 and one tip, in two short sentences. Ask one follow-up. Keep turns under 20 seconds. When you score, call record_taste_score with overall from 1 to 5, best_moment as one sentence, and fix as one change. Do not name a model or a vendor. Do not pitch a price. Do not promise a job, an interview, or a placement.`;
}

export const RECORD_TASTE_SCORE_TOOL = {
  type: "function",
  name: "record_taste_score",
  description: "Store the overall score, the best moment, and the one thing to fix for this 3-minute taste. Call it when you score the visitor.",
  parameters: {
    type: "object",
    properties: {
      overall: { type: "integer", minimum: 1, maximum: 5, description: "Overall score from 1 to 5." },
      best_moment: { type: "string", description: "The best moment of the answer, in one sentence." },
      fix: { type: "string", description: "The one change they should make, in one sentence." },
    },
    required: ["overall", "best_moment", "fix"],
  },
} as const;

export function parseTasteScore(raw: unknown): TasteScore | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const overall = typeof record.overall === "number" ? record.overall : Number(record.overall);
  if (!Number.isInteger(overall) || overall < 1 || overall > 5) return null;
  const bestMoment = clipPhrase(record.best_moment);
  const fix = clipPhrase(record.fix);
  if (!bestMoment || !fix) return null;
  return { overall, bestMoment, fix };
}

export function tasteSummary(row: {
  overall?: number | null;
  best_moment?: string | null;
  bestMoment?: string | null;
  fix?: string | null;
} | null, note = TASTE_SHORT_NOTE): TasteSummary {
  const best = row?.best_moment?.trim() || row?.bestMoment?.trim() || "";
  const fix = row?.fix?.trim() || "";
  const overall = row?.overall;
  if (typeof overall === "number" && best && fix) {
    return { overall, bestMoment: best, fix, streak: "Day 1", short: false, note: "" };
  }
  return { overall: null, bestMoment: "", fix: "", streak: "Day 1", short: note === TASTE_SHORT_NOTE, note };
}

export class TasteTranscript {
  private coachParts: string[] = [];
  private responseDeltas = new Map<string, string>();
  private responseDone = new Set<string>();
  private userItems = new Map<string, string>();
  private userOrder: string[] = [];

  add(event: { type?: string; delta?: string; transcript?: string; item_id?: string; response_id?: string }): void {
    const type = event.type ?? "";
    const transcript = scrubVendor(event.transcript ?? "");
    const delta = scrubVendor(event.delta ?? "");
    if (type.includes("input_audio_transcription")) {
      const id = event.item_id || "you";
      const next = type.endsWith("delta") ? `${this.userItems.get(id) ?? ""}${delta || transcript}` : transcript || delta;
      if (!next) return;
      if (!this.userItems.has(id)) this.userOrder.push(id);
      this.userItems.set(id, next);
      return;
    }
    if (!type.includes("transcript")) return;
    const id = event.response_id || "coach";
    if (type.endsWith("delta")) {
      if (!delta) return;
      this.responseDeltas.set(id, `${this.responseDeltas.get(id) ?? ""}${delta}`);
      return;
    }
    if (type.endsWith("done") || type.endsWith("completed")) {
      if (this.responseDone.has(id)) return;
      this.responseDone.add(id);
      const full = transcript || this.responseDeltas.get(id) || "";
      if (full) this.coachParts.push(full);
      this.responseDeltas.delete(id);
    }
  }

  userText(): string {
    return this.userOrder.map((id) => this.userItems.get(id) ?? "").join(" ").replace(/\s+/g, " ").trim();
  }

  coachText(): string {
    const pending = [...this.responseDeltas.values()];
    return [...this.coachParts, ...pending].join(" ").replace(/\s+/g, " ").trim();
  }

  userWords(): number {
    const text = this.userText();
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }

  isShort(): boolean {
    return this.userWords() < TASTE_MIN_USER_WORDS;
  }

  render(): string {
    const lines = [];
    const coach = this.coachText();
    const you = this.userText();
    if (coach) lines.push(`Coach: ${coach}`);
    if (you) lines.push(`Visitor: ${you}`);
    return lines.join("\n");
  }
}

export function scrubVendor(text: string): string {
  return text.replace(/grok/gi, "Coach").replace(/x\.?ai/gi, "");
}

export function secondsLeft(expiresAt: string, now = Date.now()): number {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / 1000));
}

export function connectAllowed(expiresAt: string, now = Date.now()): boolean {
  return secondsLeft(expiresAt, now) >= MIN_CONNECT_SECONDS;
}

export async function voiceTasteStatus(
  db: DB,
  ipHash: string,
  cap: number,
  hasKey: boolean,
  today = utcDate(),
): Promise<TasteStatus> {
  if (!hasKey) return { available: false, reason: "offline", seconds: TASTE_SECONDS };
  if (cap <= 0) return { available: false, reason: "full", seconds: TASTE_SECONDS };
  const mine = await db
    .prepare(`SELECT id FROM voice_taste_sessions WHERE ip_hash = ? AND usage_date = ?`)
    .bind(ipHash, today)
    .first();
  if (mine) return { available: false, reason: "used", seconds: TASTE_SECONDS };
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM voice_taste_sessions WHERE usage_date = ?`)
    .bind(today)
    .first<{ n: number }>();
  if (Number(count?.n ?? 0) >= cap) return { available: false, reason: "full", seconds: TASTE_SECONDS };
  return { available: true, reason: "ready", seconds: TASTE_SECONDS };
}

/** Reserves one row per IP per day, and refuses once today's global cap is full. */
export async function reserveVoiceTaste(
  db: DB,
  input: { ipHash: string; role: TryRoleId; cap: number; today?: string; now?: Date },
): Promise<ReserveResult> {
  const now = input.now ?? new Date();
  const today = input.today ?? utcDate(now);
  if (input.cap <= 0) return { ok: false, reason: "full" };
  const id = crypto.randomUUID();
  const stamp = now.toISOString();
  try {
    const result = await db
      .prepare(
        `INSERT INTO voice_taste_sessions (id, ip_hash, usage_date, role, started_at, expires_at, status)
         SELECT ?, ?, ?, ?, ?, ?, 'open'
         WHERE (SELECT COUNT(*) FROM voice_taste_sessions WHERE usage_date = ?) < ?
           AND NOT EXISTS (SELECT 1 FROM voice_taste_sessions WHERE ip_hash = ? AND usage_date = ?)`,
      )
      .bind(id, input.ipHash, today, input.role, stamp, stamp, today, input.cap, input.ipHash, today)
      .run();
    if (!result.meta.changes) {
      const mine = await db
        .prepare(`SELECT id FROM voice_taste_sessions WHERE ip_hash = ? AND usage_date = ?`)
        .bind(input.ipHash, today)
        .first();
      return { ok: false, reason: mine ? "used" : "full" };
    }
    return { ok: true, id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique/i.test(message)) return { ok: false, reason: "used" };
    throw error;
  }
}

export async function deleteVoiceTaste(db: DB, id: string): Promise<void> {
  await db.prepare(`DELETE FROM voice_taste_sessions WHERE id = ? AND ended_at IS NULL`).bind(id).run();
}

export async function storeVoiceSecret(
  db: DB,
  id: string,
  secret: string,
  now = new Date(),
): Promise<{ startedAt: string; expiresAt: string }> {
  const startedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TASTE_SECONDS * 1000).toISOString();
  await db
    .prepare(`UPDATE voice_taste_sessions SET client_secret = ?, started_at = ?, expires_at = ? WHERE id = ?`)
    .bind(secret, startedAt, expiresAt, id)
    .run();
  return { startedAt, expiresAt };
}

export async function claimVoiceSecret(db: DB, id: string): Promise<VoiceTasteRow | null> {
  const row = await db
    .prepare(`SELECT * FROM voice_taste_sessions WHERE id = ?`)
    .bind(id)
    .first<VoiceTasteRow>();
  if (!row?.client_secret || row.ended_at) return null;
  const cleared = await db
    .prepare(`UPDATE voice_taste_sessions SET client_secret = NULL WHERE id = ? AND client_secret = ? AND ended_at IS NULL`)
    .bind(id, row.client_secret)
    .run();
  if (!cleared.meta.changes) return null;
  return row;
}

export async function saveTasteScore(db: DB, id: string, score: TasteScore): Promise<void> {
  await db
    .prepare(`UPDATE voice_taste_sessions SET overall = ?, best_moment = ?, fix = ? WHERE id = ?`)
    .bind(score.overall, score.bestMoment, score.fix, id)
    .run();
}

export async function endVoiceTaste(db: DB, id: string, status: "ended" | "expired"): Promise<VoiceTasteRow | null> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE voice_taste_sessions
       SET ended_at = COALESCE(ended_at, ?), status = ?, client_secret = NULL
       WHERE id = ?`,
    )
    .bind(now, status, id)
    .run();
  return db.prepare(`SELECT * FROM voice_taste_sessions WHERE id = ?`).bind(id).first<VoiceTasteRow>();
}

export async function mintClientSecret(apiBase: string, apiKey: string, seconds = TASTE_SECONDS): Promise<string> {
  const clamped = Math.max(30, Math.min(TASTE_SECONDS, Math.floor(seconds)));
  const response = await fetch(clientSecretsUrl(apiBase), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expires_after: { seconds: clamped } }),
  });
  if (!response.ok) {
    await response.text();
    logEvent("voice_taste_mint_failed", { status: response.status });
    throw new Error("mint failed");
  }
  const payload = (await response.json()) as { value?: unknown; client_secret?: unknown };
  const value = typeof payload.value === "string" ? payload.value : typeof payload.client_secret === "string" ? payload.client_secret : "";
  if (!value) {
    logEvent("voice_taste_mint_failed", { status: response.status });
    throw new Error("mint failed");
  }
  return value;
}

export function roleLabel(role: string): string {
  if (role in TRY_ROLES) return TRY_ROLES[role as TryRoleId];
  return "the role";
}

function clipPhrase(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text === "null") return "";
  return text.slice(0, 240).replace(/grok/gi, "Coach").replace(/x\.?ai/gi, "Coach");
}
