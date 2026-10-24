import { extractResponseText, normalizeFeedback, parseModelJson, type Feedback } from "./feedback";

/** Default host for the voice and text API. Forks replace this in wrangler vars. */
export const DEFAULT_API_BASE = "https://api.x.ai/v1";

export interface ModelConfig {
  apiBase: string;
  textModel: string;
  voiceModel: string;
  sttModel: string;
  ttsVoice: string;
  realtimeTranscribeModel: string;
}

export function apiBaseOf(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_API_BASE;
}

export function realtimeUrl(apiBase: string): string {
  return `${apiBaseOf(apiBase)}/realtime`;
}

export function clientSecretsUrl(apiBase: string): string {
  return `${apiBaseOf(apiBase)}/realtime/client_secrets`;
}

export function modelsFromEnv(env: {
  LLM_API_BASE?: string;
  LLM_TEXT_MODEL?: string;
  LLM_VOICE_MODEL?: string;
  LLM_STT_MODEL?: string;
  LLM_TTS_VOICE?: string;
  LLM_REALTIME_TRANSCRIBE_MODEL?: string;
}): ModelConfig {
  return {
    apiBase: apiBaseOf(env.LLM_API_BASE),
    textModel: env.LLM_TEXT_MODEL || "grok-4.7",
    voiceModel: env.LLM_VOICE_MODEL || "grok-voice-latest",
    sttModel: env.LLM_STT_MODEL || "grok-voice-transcribe-2.0",
    ttsVoice: env.LLM_TTS_VOICE || "eve",
    realtimeTranscribeModel: env.LLM_REALTIME_TRANSCRIBE_MODEL || "grok-transcribe",
  };
}

export function hasApiKey(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const COACH_INSTRUCTIONS = `You are Coach from Hire Me. Your only name is Coach from Hire Me. Score a job-seeker's answer to one interview question or job-search action.

Return JSON only, with this shape:
{
  "star": {"situation": 1-5, "task": 1-5, "action": 1-5, "result": 1-5},
  "clarity": 1-5,
  "impact": 1-5,
  "overall": 1-5,
  "summary": "two sentences a candidate can use",
  "strengths": ["...", "..."],
  "improvements": ["...", "..."],
  "rewrite": "a tighter version of their answer in their voice, under 120 words",
  "spoken": "one or two sentences to say out loud, under 40 words, no markdown"
}

Be direct. Reward a concrete result. Do not invent employers, metrics, or dates they did not say. If the result is missing, say so. In summary and spoken, call yourself Coach from Hire Me. Do not name a model or a vendor. Do not promise a job, an interview, or a placement.`;

export class ModelCallError extends Error {
  readonly reason: "http" | "parse" | "truncated" | "empty";
  readonly status?: number;

  constructor(reason: ModelCallError["reason"], status?: number) {
    super(reason);
    this.name = "ModelCallError";
    this.reason = reason;
    this.status = status;
  }
}

const FEEDBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    star: {
      type: "object",
      additionalProperties: false,
      properties: {
        situation: { type: "integer" },
        task: { type: "integer" },
        action: { type: "integer" },
        result: { type: "integer" },
      },
      required: ["situation", "task", "action", "result"],
    },
    clarity: { type: "integer" },
    impact: { type: "integer" },
    overall: { type: "integer" },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
    rewrite: { type: "string" },
    spoken: { type: "string" },
  },
  required: ["star", "clarity", "impact", "overall", "summary", "strengths", "improvements", "rewrite", "spoken"],
} as const;

const TASTE_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall: { type: "integer" },
    best_moment: { type: "string" },
    fix: { type: "string" },
  },
  required: ["overall", "best_moment", "fix"],
} as const;

export async function modelText(
  apiBase: string,
  apiKey: string,
  model: string,
  instructions: string,
  user: string,
  maxOutputTokens = 900,
): Promise<string> {
  return completeText({ apiBase, apiKey, model, instructions, user, maxOutputTokens });
}

async function completeText(input: {
  apiBase: string;
  apiKey: string;
  model: string;
  instructions: string;
  user: string;
  maxOutputTokens: number;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}): Promise<string> {
  let body: Record<string, unknown> = {
    model: input.model,
    instructions: input.instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: input.user }] }],
    max_output_tokens: input.maxOutputTokens,
    reasoning: { effort: "low" },
  };
  if (input.jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: input.jsonSchema.name,
        schema: input.jsonSchema.schema,
        strict: true,
      },
    };
  }
  let response = await postResponses(input.apiBase, input.apiKey, body);
  if (response.status === 400 && body.text) {
    await response.arrayBuffer();
    const { text: _format, ...rest } = body;
    body = rest;
    response = await postResponses(input.apiBase, input.apiKey, body);
  }
  if (response.status === 400 && body.reasoning) {
    await response.arrayBuffer();
    const { reasoning: _reasoning, ...rest } = body;
    body = rest;
    response = await postResponses(input.apiBase, input.apiKey, body);
  }
  if (!response.ok) {
    await response.arrayBuffer();
    throw new ModelCallError("http", response.status);
  }
  const payload = (await response.json()) as {
    status?: string;
    incomplete_details?: { reason?: string } | null;
  };
  if (payload.status === "incomplete" && payload.incomplete_details?.reason === "max_output_tokens") {
    throw new ModelCallError("truncated", response.status);
  }
  const text = extractResponseText(payload);
  if (!text) throw new ModelCallError("empty", response.status);
  return text;
}

async function postResponses(apiBase: string, apiKey: string, body: unknown): Promise<Response> {
  return fetch(`${apiBaseOf(apiBase)}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function scoreWithModel(input: {
  apiBase: string;
  apiKey: string;
  model: string;
  roleLabel: string;
  prompt: string;
  answer: string;
  history: string;
  maxOutputTokens?: number;
  json?: boolean;
}): Promise<Feedback> {
  const user = [
    `Target role: ${input.roleLabel}`,
    `Question: ${input.prompt}`,
    input.history ? `Earlier today:\n${input.history}` : "",
    `Answer:\n${input.answer}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const text = await completeText({
    apiBase: input.apiBase,
    apiKey: input.apiKey,
    model: input.model,
    instructions: COACH_INSTRUCTIONS,
    user,
    maxOutputTokens: input.maxOutputTokens ?? 900,
    jsonSchema: input.json ? { name: "coach_feedback", schema: FEEDBACK_SCHEMA as unknown as Record<string, unknown> } : undefined,
  });
  let parsed: unknown;
  try {
    parsed = parseModelJson(text);
  } catch {
    throw new ModelCallError("parse");
  }
  const feedback = normalizeFeedback(parsed, "model");
  if (!feedback) throw new ModelCallError("parse");
  return feedback;
}

export async function scoreTasteTranscript(input: {
  apiBase: string;
  apiKey: string;
  model: string;
  roleLabel: string;
  transcript: string;
}): Promise<{ overall: number; bestMoment: string; fix: string }> {
  const instructions = `You are Coach from Hire Me. Your only name is Coach from Hire Me. Score the visitor's spoken answer in this short mock interview. Return JSON only with overall from 1 to 5, best_moment as one sentence, and fix as one change. Use only what they said. Do not invent employers, metrics, or dates. Do not name a model or a vendor. Do not promise a job, an interview, or a placement.`;
  const user = `Target role: ${input.roleLabel}\n\nTranscript:\n${input.transcript}`;
  let tokens = 500;
  let last: ModelCallError = new ModelCallError("empty");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await completeText({
        apiBase: input.apiBase,
        apiKey: input.apiKey,
        model: input.model,
        instructions,
        user,
        maxOutputTokens: tokens,
        jsonSchema: { name: "taste_score", schema: TASTE_SCORE_SCHEMA as unknown as Record<string, unknown> },
      });
      const raw = parseModelJson(text) as { overall?: unknown; best_moment?: unknown; fix?: unknown };
      const overall = Number(raw.overall);
      const bestMoment = String(raw.best_moment ?? "").trim().replace(/grok/gi, "Coach").replace(/x\.?ai/gi, "Coach");
      const fix = String(raw.fix ?? "").trim().replace(/grok/gi, "Coach").replace(/x\.?ai/gi, "Coach");
      if (!Number.isInteger(overall) || overall < 1 || overall > 5 || !bestMoment || !fix) throw new ModelCallError("parse");
      return { overall, bestMoment: bestMoment.slice(0, 240), fix: fix.slice(0, 240) };
    } catch (error) {
      last = error instanceof ModelCallError ? error : new ModelCallError("parse");
      if (last.reason === "truncated") tokens = 1000;
    }
  }
  throw last;
}

export async function makeoverWithModel(input: {
  apiBase: string;
  apiKey: string;
  model: string;
  roleLabel: string;
  headline: string;
  resume: string;
}): Promise<Record<string, unknown>> {
  const instructions = `You are Coach from Hire Me. Your only name is Coach from Hire Me. You rewrite a LinkedIn headline and resume bullets for a job seeker. Return JSON only:
{
  "headlines": ["option", "option", "option"],
  "bullets": ["bullet", "bullet", "bullet", "bullet"],
  "notes": "two sentences on what you changed"
}
Keep their facts. Do not invent employers, titles, or metrics. Headlines under 120 characters. Bullets start with a verb. In notes, call yourself Coach from Hire Me. Do not name a model or a vendor. Do not promise a job, an interview, or a placement.`;
  const user = `Target role: ${input.roleLabel}\nCurrent headline: ${input.headline || "(none)"}\nResume:\n${input.resume}`;
  const text = await modelText(input.apiBase, input.apiKey, input.model, instructions, user);
  const parsed = parseModelJson(text);
  if (!parsed || typeof parsed !== "object") throw new Error("model makeover was not json");
  return parsed as Record<string, unknown>;
}

export async function transcribeAudio(input: {
  apiBase: string;
  apiKey: string;
  model: string;
  audio: Blob;
  filename: string;
}): Promise<{ text: string; duration: number }> {
  const form = new FormData();
  form.append("model", input.model);
  form.append("language", "en");
  form.append("format", "true");
  form.append("keyterm", "STAR");
  form.append("keyterm", "DeployedX");
  form.append("file", input.audio, input.filename);
  const response = await fetch(`${apiBaseOf(input.apiBase)}/stt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`stt ${response.status}: ${detail.slice(0, 400)}`);
  }
  const payload = (await response.json()) as { text?: string; duration?: number };
  return {
    text: String(payload.text ?? "").trim(),
    duration: Number(payload.duration ?? 0),
  };
}

export async function synthesizeSpeech(input: { apiBase: string; apiKey: string; voice: string; text: string }): Promise<ArrayBuffer> {
  const response = await fetch(`${apiBaseOf(input.apiBase)}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: input.text,
      voice_id: input.voice,
      language: "en",
      output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`tts ${response.status}: ${detail.slice(0, 400)}`);
  }
  return response.arrayBuffer();
}
