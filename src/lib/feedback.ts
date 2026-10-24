export interface StarScores {
  situation: number;
  task: number;
  action: number;
  result: number;
}

export interface Feedback {
  source: "model" | "offline-rubric";
  star: StarScores;
  clarity: number;
  impact: number;
  overall: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  rewrite: string;
  spoken: string;
}

function clampScore(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function lines(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, max);
}

export function normalizeFeedback(raw: unknown, source: Feedback["source"]): Feedback | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const starRaw = record.star;
  if (!starRaw || typeof starRaw !== "object") return null;
  const starRecord = starRaw as Record<string, unknown>;
  const situation = clampScore(starRecord.situation);
  const task = clampScore(starRecord.task);
  const action = clampScore(starRecord.action);
  const result = clampScore(starRecord.result);
  const clarity = clampScore(record.clarity);
  const impact = clampScore(record.impact);
  if (situation === null || task === null || action === null || result === null || clarity === null || impact === null) {
    return null;
  }
  const overall = clampScore(record.overall) ?? clampScore((situation + task + action + result + clarity + impact) / 6);
  if (overall === null) return null;
  const summary = String(record.summary ?? "").trim();
  const spoken = String(record.spoken ?? "").trim();
  if (!summary || !spoken) return null;
  return {
    source,
    star: { situation, task, action, result },
    clarity,
    impact,
    overall,
    summary,
    strengths: lines(record.strengths, 4),
    improvements: lines(record.improvements, 4),
    rewrite: String(record.rewrite ?? "").trim(),
    spoken: spoken.slice(0, 500),
  };
}

export function offlineFeedback(answer: string, prompt: string): Feedback {
  const text = answer.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const count = words.length;
  const hasNumber = /\d|%|\$/.test(text);
  const situation = /(when|while|during|customer|team|at the time|last year|last quarter)/i.test(text) ? 4 : count > 25 ? 3 : 2;
  const task = /(asked|needed|goal|job was|had to|responsible)/i.test(text) ? 4 : 3;
  const action = /\bI\b/.test(text) && /(built|shipped|led|wrote|debugged|cut|designed|asked|called|measured)/i.test(text) ? 4 : 3;
  const result = hasNumber || /(result|so that|reduced|increased|saved|landed|unblocked)/i.test(text) ? 4 : 2;
  const clarity = count < 12 ? 2 : count > 220 ? 3 : 4;
  const impact = hasNumber ? 4 : 2;
  const overall = clampScore((situation + task + action + result + clarity + impact) / 6) ?? 3;
  const missingResult = result < 4;
  return {
    source: "offline-rubric",
    star: { situation, task, action, result },
    clarity,
    impact,
    overall,
    summary: missingResult
      ? "The shape is there. The result is still soft. End on what changed, with a number."
      : "This has a result a hiring manager can repeat. Tighten the first sentence so the situation is obvious.",
    strengths: [
      count >= 40 ? "Long enough to be a story, not a slogan." : "Short enough to say out loud.",
      hasNumber ? "A number gives the result weight." : "You stayed on the question.",
    ],
    improvements: [
      missingResult ? "Add the result in the last sentence, with a count, a percent, or a date." : "Cut one adjective and name the constraint instead.",
      "Say what you did, not what the team generally did.",
    ],
    rewrite: `Keep the question in view: ${prompt.slice(0, 140)}. Open with the situation, name the action you took, and close with the result.`,
    spoken: missingResult
      ? "I can follow the story. Close it with the result, and put a number on it."
      : "That lands. Next time, make the first sentence the situation, then the result.",
  };
}

export function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  const chunks: string[] = [];
  for (const item of record.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const object = extractJsonObject(trimmed);
  if (object) candidates.push(object);
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate) ?? tryParseJson(candidate.replace(/,\s*([}\]])/g, "$1"));
    if (parsed !== undefined) return parsed;
  }
  throw new Error("parse");
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Takes the first balanced object so a trailing sentence or a brace inside a string does not win. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quote = false;
      continue;
    }
    if (char === "\"") {
      quote = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
