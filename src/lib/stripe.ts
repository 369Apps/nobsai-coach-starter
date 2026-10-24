import type { Tier } from "./policy";

export class StripeConfigError extends Error {
  constructor(readonly code: "missing" | "live" | "not_test") {
    super(
      code === "live"
        ? "Stripe live keys are refused. Checkout is test mode only."
        : code === "missing"
          ? "Stripe is not configured. Set STRIPE_SECRET_KEY to a test key."
          : "Stripe secret must be a test key (sk_test_ or rk_test_).",
    );
    this.name = "StripeConfigError";
  }
}

export function assertStripeTestKey(key: string | undefined): asserts key is string {
  if (!key || !key.trim()) throw new StripeConfigError("missing");
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) throw new StripeConfigError("live");
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) throw new StripeConfigError("not_test");
}

export function tierForPrice(
  priceId: string,
  prices: { voice?: string; live?: string; coach?: string },
): Tier | null {
  if (priceId && priceId === prices.voice) return "voice";
  if (priceId && priceId === prices.live) return "live";
  if (priceId && priceId === prices.coach) return "coach";
  return null;
}

export function priceForTier(
  tier: Exclude<Tier, "free">,
  prices: { voice?: string; live?: string; coach?: string },
): string | undefined {
  if (tier === "voice") return prices.voice;
  if (tier === "live") return prices.live;
  return prices.coach;
}

export async function signStripeHeader(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const signature = await hmacHex(secret, `${timestamp}.${payload}`);
  return `t=${timestamp},v1=${signature}`;
}

export async function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function stripeForm(
  secret: string,
  path: string,
  fields: Record<string, string>,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; detail: string }> {
  assertStripeTestKey(secret);
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, detail: text.slice(0, 500) };
  return { ok: true, body: JSON.parse(text) as Record<string, unknown> };
}
