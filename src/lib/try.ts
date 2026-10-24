import type { AppEnv } from "./http";
import { sha256Hex } from "./http";
import { utcDate } from "./policy";

export const TRY_ROLES = {
  ai_engineer: "AI Engineer",
  fde: "Forward Deployed Engineer",
  data_engineer: "Data Engineer",
} as const;

export type TryRoleId = keyof typeof TRY_ROLES;

export const TRY_ANSWER_LIMIT = 1200;
export const TRY_SESSION_LENGTH = 3;
export const TRY_DAILY_LIMIT = TRY_SESSION_LENGTH * 3;
/** Room for the score JSON. max_output_tokens also counts reasoning tokens, and 320 was cutting the object off. */
export const TRY_MAX_OUTPUT_TOKENS = 1200;
export const TRY_RETRY_OUTPUT_TOKENS = 2400;
export const LEAD_DAILY_LIMIT = 5;

const TRY_ROLE_IDS = Object.keys(TRY_ROLES) as TryRoleId[];

export interface TryQuestion {
  role: TryRoleId;
  roleLabel: string;
  taskId: string;
  title: string;
  prompt: string;
}

type DB = AppEnv["DB"];

export function isTryRole(value: unknown): value is TryRoleId {
  return typeof value === "string" && value in TRY_ROLES;
}

export function rotateIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 33) + char.charCodeAt(0)) >>> 0;
  return hash % length;
}

export function defaultTryRole(today = utcDate()): TryRoleId {
  return TRY_ROLE_IDS[rotateIndex(today, TRY_ROLE_IDS.length)];
}

export async function clientIpHash(request: Request): Promise<string> {
  const header = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  const ip = header.split(",")[0]?.trim() || "unknown";
  return sha256Hex(ip);
}

export async function questionsFor(
  db: DB,
  role: TryRoleId,
  today = utcDate(),
  count = TRY_SESSION_LENGTH,
): Promise<TryQuestion[]> {
  const rows = await db
    .prepare(`SELECT id, title, prompt FROM tasks WHERE role = ? AND kind = 'interview' ORDER BY id`)
    .bind(role)
    .all<{ id: string; title: string; prompt: string }>();
  const tasks = rows.results ?? [];
  if (tasks.length === 0) return [];
  const start = rotateIndex(`${today}:${role}`, tasks.length);
  const take = Math.min(count, tasks.length);
  return Array.from({ length: take }, (_, offset) => {
    const task = tasks[(start + offset) % tasks.length];
    return {
      role,
      roleLabel: TRY_ROLES[role],
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
    };
  });
}

export async function questionById(db: DB, role: TryRoleId, taskId: string): Promise<TryQuestion | null> {
  const row = await db
    .prepare(`SELECT id, title, prompt FROM tasks WHERE id = ? AND role = ? AND kind = 'interview'`)
    .bind(taskId, role)
    .first<{ id: string; title: string; prompt: string }>();
  if (!row) return null;
  return { role, roleLabel: TRY_ROLES[role], taskId: row.id, title: row.title, prompt: row.prompt };
}

export async function triesUsed(db: DB, ipHash: string, today = utcDate()): Promise<number> {
  const row = await db
    .prepare(`SELECT tries FROM try_usage WHERE ip_hash = ? AND usage_date = ?`)
    .bind(ipHash, today)
    .first<{ tries: number }>();
  return row?.tries ?? 0;
}

export type LeadSource = "try-coach" | "voice-taste";

export interface LeadInput {
  firstName: string;
  email: string;
  role: TryRoleId;
  linkedin: string | null;
  consent: boolean;
  sessionAvg: number | null;
  source: LeadSource;
}

export interface LeadRow {
  id: string;
  first_name: string;
  email: string;
  role: string;
  linkedin: string | null;
  consent: number;
  session_avg: number | null;
  source: string;
  created_at: string;
  ip_hash: string;
}

/** Canonical profile URL, null when blank or only the prefilled prefix, or "invalid". */
export function linkedinUrl(value: unknown): string | null | "invalid" {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > 300) return "invalid";
  const slug = linkedInSlug(text);
  if (slug) return `https://linkedin.com/in/${slug}`;
  if (isLinkedInPrefix(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return "invalid";
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "" || path === "/in") return null;
    return `https://linkedin.com${path}${url.search}`;
  } catch {
    return "invalid";
  }
}

function isLinkedInPrefix(text: string): boolean {
  const bare = text.replace(/\/+$/, "").toLowerCase();
  return (
    bare === "https://linkedin.com/in" ||
    bare === "http://linkedin.com/in" ||
    bare === "https://www.linkedin.com/in" ||
    bare === "http://www.linkedin.com/in" ||
    bare === "www.linkedin.com/in" ||
    bare === "linkedin.com/in"
  );
}

/** Uses the last linkedin.com/in/ so a pasted URL does not keep the prefilled prefix. */
function linkedInSlug(text: string): string | null {
  const marker = /linkedin\.com\/in\//gi;
  let start = -1;
  for (const match of text.matchAll(marker)) {
    if (match.index != null) start = match.index + match[0].length;
  }
  if (start < 0) return null;
  let slug = text.slice(start).split(/[/?#\s]/)[0] ?? "";
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  slug = slug.replace(/\/+$/, "");
  if (!slug || /^(https?:?|www\.linkedin\.com|linkedin\.com)$/i.test(slug)) return null;
  return slug;
}

export async function leadsFromIpToday(db: DB, ipHash: string, today = utcDate()): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM leads WHERE ip_hash = ? AND created_at >= ?`)
    .bind(ipHash, `${today}T00:00:00.000Z`)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Inserts a lead, or refreshes the row when that email already exists. */
export async function saveLead(db: DB, ipHash: string, input: LeadInput, now = new Date().toISOString()): Promise<LeadRow> {
  const existing = await db.prepare(`SELECT id, created_at FROM leads WHERE email = ?`).bind(input.email).first<{ id: string; created_at: string }>();
  if (!existing && (await leadsFromIpToday(db, ipHash, now.slice(0, 10))) >= LEAD_DAILY_LIMIT) {
    throw new LeadLimitError();
  }
  if (existing) {
    await db
      .prepare(
        `UPDATE leads
         SET first_name = ?, role = ?, linkedin = ?, consent = ?, session_avg = ?, source = ?, created_at = ?, ip_hash = ?
         WHERE id = ?`,
      )
      .bind(input.firstName, input.role, input.linkedin, input.consent ? 1 : 0, input.sessionAvg, input.source, now, ipHash, existing.id)
      .run();
    return (await db.prepare(`SELECT * FROM leads WHERE id = ?`).bind(existing.id).first<LeadRow>()) as LeadRow;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO leads (id, first_name, email, role, linkedin, consent, session_avg, source, created_at, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.firstName, input.email, input.role, input.linkedin, input.consent ? 1 : 0, input.sessionAvg, input.source, now, ipHash)
    .run();
  return (await db.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first<LeadRow>()) as LeadRow;
}

export async function listLeads(db: DB, limit = 200): Promise<LeadRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, first_name, email, role, linkedin, consent, session_avg, source, created_at, ip_hash
       FROM leads ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<LeadRow>();
  return rows.results ?? [];
}

export class LeadLimitError extends Error {
  constructor() {
    super("lead limit");
    this.name = "LeadLimitError";
  }
}

/** Returns the new try count, or null when the daily cap is already spent. */
export async function consumeTry(db: DB, ipHash: string, today = utcDate()): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO try_usage (ip_hash, usage_date, tries) VALUES (?, ?, 1)
       ON CONFLICT (ip_hash, usage_date) DO UPDATE SET tries = tries + 1
       WHERE tries < ?
       RETURNING tries`,
    )
    .bind(ipHash, today, TRY_DAILY_LIMIT)
    .first<{ tries: number }>();
  return row?.tries ?? null;
}
