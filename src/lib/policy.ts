export const ROLES = {
  fde: "Forward Deployed Engineer",
  ai_engineer: "AI Engineer",
  solutions_architect: "Solutions Architect",
} as const;

export type RoleId = keyof typeof ROLES;
export type Tier = "free" | "voice" | "live" | "coach";
export type Channel = "text" | "voice" | "live";
export type Feature = "text" | "voice" | "live" | "tracker" | "coach" | "first_pick";

export const TIER_RANK: Record<Tier, number> = {
  free: 0,
  voice: 1,
  live: 2,
  coach: 3,
};

export const TIER_PRICE_USD: Record<Tier, number> = {
  free: 0,
  voice: 20,
  live: 100,
  coach: 200,
};

export const SPEECH_CHARS_PER_SECOND = 14;

/** Per-minute live-voice cost the operator sets. Zero hides the admin estimate. */
export function liveRateUsd(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}
export const MAX_TURN_SECONDS = 15 * 60;
const MIN_PAID_VOICE_SECONDS = 10 * 60;

export interface Caps {
  freeText: number;
  voice: number;
  live: number;
  paidTextSafety: number;
  minTextTurn: number;
  voicePause: number;
  makeover: number;
}

export interface CapEnv {
  FREE_TEXT_CAP_SECONDS?: string;
  VOICE_DAILY_CAP_SECONDS?: string;
  LIVE_DAILY_CAP_SECONDS?: string;
  PAID_TEXT_SAFETY_CAP_SECONDS?: string;
  MIN_TEXT_TURN_SECONDS?: string;
  VOICE_TURN_PAUSE_SECONDS?: string;
  MAKEOVER_SECONDS?: string;
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function parseCaps(env: CapEnv = {}): Caps {
  const voice = Math.max(MIN_PAID_VOICE_SECONDS, intEnv(env.VOICE_DAILY_CAP_SECONDS, 900));
  const live = Math.max(MIN_PAID_VOICE_SECONDS, intEnv(env.LIVE_DAILY_CAP_SECONDS, 900));
  return {
    freeText: intEnv(env.FREE_TEXT_CAP_SECONDS, 600),
    voice,
    live,
    paidTextSafety: intEnv(env.PAID_TEXT_SAFETY_CAP_SECONDS, 14400),
    minTextTurn: Math.max(1, intEnv(env.MIN_TEXT_TURN_SECONDS, 20)),
    voicePause: Math.max(1, intEnv(env.VOICE_TURN_PAUSE_SECONDS, 2)),
    makeover: Math.max(1, intEnv(env.MAKEOVER_SECONDS, 60)),
  };
}

export function capsForTier(tier: Tier, caps: Caps): { text: number; voice: number; live: number } {
  if (tier === "free") return { text: caps.freeText, voice: 0, live: 0 };
  if (tier === "voice") return { text: caps.paidTextSafety, voice: caps.voice, live: 0 };
  return { text: caps.paidTextSafety, voice: caps.voice, live: caps.live };
}

export function allows(tier: Tier, feature: Feature): boolean {
  const rank = TIER_RANK[tier];
  switch (feature) {
    case "text":
      return true;
    case "voice":
      return rank >= TIER_RANK.voice;
    case "live":
    case "tracker":
      return rank >= TIER_RANK.live;
    case "coach":
    case "first_pick":
      return rank >= TIER_RANK.coach;
    default:
      return false;
  }
}

export function isTier(value: unknown): value is Tier {
  return value === "free" || value === "voice" || value === "live" || value === "coach";
}

export function isRole(value: unknown): value is RoleId {
  return value === "fde" || value === "ai_engineer" || value === "solutions_architect";
}

export function textTurnSeconds(clientElapsed: unknown, minTurn: number): number {
  const elapsed = typeof clientElapsed === "number" && Number.isFinite(clientElapsed) ? Math.floor(clientElapsed) : 0;
  const clamped = Math.min(Math.max(elapsed, 0), MAX_TURN_SECONDS);
  return Math.max(minTurn, clamped);
}

export function voicePipelineSeconds(input: {
  sttDuration: number;
  spokenChars: number;
  pauseSeconds: number;
}): number {
  const stt = Number.isFinite(input.sttDuration) ? Math.max(0, input.sttDuration) : 0;
  const spoken = Math.max(0, Math.ceil(input.spokenChars / SPEECH_CHARS_PER_SECOND));
  return Math.max(1, Math.ceil(stt) + input.pauseSeconds + spoken);
}

export function planLiveCharge(
  elapsedSeconds: number,
  chargedSeconds: number,
  roomSeconds: number,
): { take: number; stop: boolean } {
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  const charged = Math.max(0, Math.floor(chargedSeconds));
  const room = Math.max(0, Math.floor(roomSeconds));
  const want = Math.max(0, elapsed - charged);
  if (want === 0) return { take: 0, stop: false };
  if (room <= 0) return { take: 0, stop: true };
  const take = Math.min(want, room);
  return { take, stop: take < want };
}

export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function weekStart(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

export function previousDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function nextStreak(prevCount: number, lastDate: string | null, today: string): number {
  if (lastDate === today) return Math.max(1, prevCount);
  if (lastDate && previousDate(today) === lastDate) return Math.max(1, prevCount) + 1;
  return 1;
}

export function tierLabel(tier: Tier): string {
  switch (tier) {
    case "free":
      return "Free";
    case "voice":
      return "Voice · $20";
    case "live":
      return "Live · $100";
    case "coach":
      return "Coach · $200";
  }
}
