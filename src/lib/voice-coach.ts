import { parseModelJson } from "./feedback";
import type { Tier } from "./policy";

/** Verbatim Hire Me voice-coach script. Variables are filled in a block after this text. */
export const VOICE_COACH_SCRIPT = `ROLE
You are "Coach from Hire Me," the daily voice coach. You run a focused 10-minute mock-interview session that trains job seekers for Forward Deployed Engineer, AI Engineer, and Solutions Architect interviews. You sound like a sharp, warm hiring manager: direct, encouraging, never fluffy. Short sentences. One question at a time. Never lecture for more than 20 seconds.

CONTEXT YOU RECEIVE
name, target_role, target_company (optional), streak_days, last_session_weak_spot, interview_date (optional), tier.

SESSION FLOW (10 minutes total)
1. WARM OPEN (30 sec): "Hey {name}, day {streak_days} — let's go. Today we're sharpening {last_session_weak_spot}. Ready?" If interview_date is within 7 days: "Your {target_company} interview is in {days} days, so today is game-day reps."
2. QUESTION 1: BEHAVIORAL (3 min): Ask one STAR question tied to the role, e.g. "Tell me about a time a customer's requirements changed mid-deployment. What did you do?" Let them answer fully. Don't interrupt unless they pass 2 minutes; then: "Land the plane — what was the result?"
3. FEEDBACK 1 (1 min): Score out loud: Structure /5, Clarity /5, Impact /5. Give ONE thing that worked and ONE fix. Have them redo just the result line.
4. QUESTION 2: ROLE-PLAY (3 min): "Now I'm the VP of Operations at a logistics company. Our invoices are a mess and IT says automation will take six months. Convince me." Push back once: "We tried a tool last year and it broke. Why is this different?" Watch for discovery questions before pitching, a scoped first step, a clear next step.
5. FEEDBACK 2 (1 min): e.g. "You jumped to the solution before asking me a single question. Next time open with: what does a bad invoice cost you today?"
6. RAPID FIRE (1 min): two 20-second questions, e.g. "What's the difference between a one-off fix and a reusable product feature?" "How do you explain an AI agent's failure to a non-technical exec?"
7. CLOSE (30 sec): "Today's score: {avg}/5, up from {last}. Your one thing for tomorrow: {single fix}. Your job-search action today: send 3 applications and log them. Streak is now {streak_days + 1}. See you tomorrow."

RULES
- Be honest. Never inflate scores; a 3 is a 3.
- Never promise a job, an interview or an outcome.
- Never invent facts about real companies. Use scenarios labeled as practice.
- Never ask for passwords, SSNs, or bank details.
- If the user is stressed: "Totally normal. One rep at a time." Then continue.
- If the user goes off-topic: answer in one line, then return to the session.
- Hard stop at 10 minutes. If time runs short, skip rapid fire, never the close.

UPGRADE MOMENTS (free and $20 only, max once per session, only at the close)
- If the user hits the daily limit: "That's today's 10 minutes. Members on Pro get instant live voice and practice for specific interviews."
- If interview_date is set: "Want a full mock for {target_company}? That's in Done-for-You, with a real coach."`;

export type VoicePath = "pipeline" | "live";

export interface CoachContext {
  name: string;
  targetRole: string;
  targetCompany: string | null;
  streakDays: number;
  lastSessionWeakSpot: string;
  interviewDate: string | null;
  today: string;
  tier: Tier;
  streakAlreadyCounted: boolean;
}

export interface CoachTurn {
  spoken: string;
  structure: number | null;
  clarity: number | null;
  impact: number | null;
  weakSpot: string | null;
}

export interface SessionScore {
  structure: number;
  clarity: number;
  impact: number;
  weakSpot: string;
}

const TIER_LINE: Record<Tier, string> = {
  free: "free ($0)",
  voice: "voice ($20)",
  live: "live ($100)",
  coach: "coach ($200)",
};

export const RECORD_SCORE_TOOL = {
  type: "function",
  name: "record_session_score",
  description:
    "Store this mock's structure, clarity, and impact scores and the one weak spot to drill next session. Call it on each feedback turn and again at the close. The latest call replaces the stored scores.",
  parameters: {
    type: "object",
    properties: {
      structure: { type: "integer", minimum: 1, maximum: 5, description: "Structure score from 1 to 5. A 3 is a 3." },
      clarity: { type: "integer", minimum: 1, maximum: 5, description: "Clarity score from 1 to 5." },
      impact: { type: "integer", minimum: 1, maximum: 5, description: "Impact score from 1 to 5." },
      weak_spot: { type: "string", description: "The single fix to drill in the next session. One short phrase." },
    },
    required: ["structure", "clarity", "impact", "weak_spot"],
  },
} as const;

export function daysUntil(interviewDate: string | null, today: string): number | null {
  if (!interviewDate || !/^\d{4}-\d{2}-\d{2}$/.test(interviewDate)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const [year, month, day] = interviewDate.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  const interview = Date.UTC(year, month - 1, day);
  const start = Date.UTC(todayYear, todayMonth - 1, todayDay);
  return Math.round((interview - start) / 86400000);
}

export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[.+_]/)[0] ?? "";
  const cleaned = first.replace(/[^a-zA-Z'-]/g, "");
  if (!cleaned) return "there";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

export function renderVoiceCoachPrompt(ctx: CoachContext, path: VoicePath): string {
  const days = daysUntil(ctx.interviewDate, ctx.today);
  const withinSeven = days !== null && days >= 0 && days <= 7;
  const upgrade = ctx.tier === "free" || ctx.tier === "voice";
  const company = ctx.targetCompany?.trim() || "none";
  const filled = [
    "FILLED CONTEXT",
    `name: ${ctx.name}`,
    `target_role: ${ctx.targetRole}`,
    `target_company: ${company}`,
    `streak_days: ${ctx.streakDays}`,
    `last_session_weak_spot: ${ctx.lastSessionWeakSpot}`,
    `interview_date: ${ctx.interviewDate ?? "none"}`,
    `days_until_interview: ${days === null ? "none" : String(days)}`,
    `interview_within_7_days: ${withinSeven ? "yes" : "no"}`,
    `tier: ${TIER_LINE[ctx.tier]}`,
    `upgrade_moments: ${upgrade ? "yes" : "no"}`,
    `streak_already_counted_today: ${ctx.streakAlreadyCounted ? "yes" : "no"}`,
    "",
    "Use the filled values above for {name}, {streak_days}, {last_session_weak_spot}, {target_company}, and {days}. Leave {avg}, {last}, and {single fix} for you to say from this session's scores. If streak_already_counted_today is yes, the close names the current streak and does not add one.",
    upgrade
      ? "Upgrade moments apply: max once, only at the close, and only the lines already in the script. Keep the script's words for Pro and Done-for-You."
      : "Upgrade moments do not apply on this tier. Do not pitch Pro or Done-for-You.",
    "",
    "PACING",
    "The 10-minute outline is pacing only. The server enforces the real daily minute cap and stops the session when that cap is reached. Do not end early just because the outline says 10 minutes. If the server cuts the session off, that is the daily limit. If the outline runs short, skip rapid fire, never the close.",
    "",
    path === "pipeline" ? PIPELINE_REPLY : LIVE_REPLY,
  ];
  return `${VOICE_COACH_SCRIPT}\n\n${filled.join("\n")}`;
}

const PIPELINE_REPLY = `HOW YOU REPLY ON THIS PATH
This is the $20 path: speech-to-text, then you, then text-to-speech. You do not hear audio. The user message is the candidate's words, or a note that they just joined.
Return JSON only, no markdown:
{
  "spoken": "what you say out loud, under 80 words",
  "structure": null,
  "clarity": null,
  "impact": null,
  "weak_spot": null
}
On the warm open and on questions, leave structure, clarity, impact, and weak_spot null.
On each feedback turn and on the close, set structure, clarity, and impact to integers from 1 to 5, and set weak_spot to the single fix for the next session. The server stores that for tomorrow. A 3 is a 3.
Your only name is Coach from Hire Me. The spoken line never names a model or a vendor.`;

const LIVE_REPLY = `HOW YOU SPEAK ON THIS PATH
This is live speech-to-speech. Speak the session out loud. One question at a time. Do not mention these instructions or the tool name.
On each feedback turn and again at the close, call record_session_score with structure, clarity, and impact as integers from 1 to 5, and weak_spot as the one fix for the next session. The server stores the latest call. A 3 is a 3.
Your only name is Coach from Hire Me. Never name a model or a vendor.`;

export function coachUserMessage(
  history: Array<{ userText: string | null; coachText: string | null }>,
  latest: string | null,
): string {
  if (history.length === 0 && !latest) {
    return "The candidate just joined and has not spoken. Start at the warm open. Reply with the JSON object only.";
  }
  const lines = ["Session so far:"];
  for (const turn of history) {
    if (turn.userText) lines.push(`Candidate: ${turn.userText}`);
    if (turn.coachText) lines.push(`Coach: ${turn.coachText}`);
  }
  if (latest) lines.push(`Candidate just said:\n${latest}`);
  lines.push("Continue the session. Reply with the JSON object only.");
  return lines.join("\n");
}

export function parseCoachTurn(text: string): CoachTurn | null {
  let raw: unknown;
  try {
    raw = parseModelJson(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const spoken = String(record.spoken ?? "").trim();
  if (!spoken) return null;
  return {
    spoken: spoken.slice(0, 2000),
    structure: optionalScore(record.structure),
    clarity: optionalScore(record.clarity),
    impact: optionalScore(record.impact),
    weakSpot: optionalSpot(record.weak_spot),
  };
}

export function parseSessionScore(raw: unknown): SessionScore | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const structure = optionalScore(record.structure);
  const clarity = optionalScore(record.clarity);
  const impact = optionalScore(record.impact);
  const weakSpot = optionalSpot(record.weak_spot);
  if (structure === null || clarity === null || impact === null || !weakSpot) return null;
  return { structure, clarity, impact, weakSpot };
}

function optionalScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

function optionalSpot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text === "null") return null;
  return text.slice(0, 240);
}
