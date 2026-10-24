import type { Context } from "hono";

export type AppEnv = Env & {
  LLM_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  EMAIL_WEBHOOK_URL?: string;
};

export type AppContext = Context<{ Bindings: AppEnv }>;

export function isProduction(env: { ENVIRONMENT?: string }): boolean {
  return env.ENVIRONMENT === "production";
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export async function readJson<T>(c: AppContext): Promise<T | Response> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return c.json({ error: "bad_json", message: "Send a JSON body." }, 400);
  }
}

export function originOf(c: AppContext): string {
  return c.env.APP_ORIGIN || new URL(c.req.url).origin;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function isAdminEmail(adminEmails: string | undefined, email: string): boolean {
  const list = (adminEmails ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export function clip(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}
