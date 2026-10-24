import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skipDirs = new Set([".git", "node_modules", ".wrangler", "tmp", "dist", "coverage"]);
const failures = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function textOf(path) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

const files = walk(root);
const joined = new Map();
for (const path of files) {
  const text = textOf(path);
  if (text != null) joined.set(relative(root, path), text);
}

function fail(message) {
  failures.push(message);
}

const wrangler = joined.get("wrangler.jsonc") ?? "";
if (!wrangler.includes('"database_id": "00000000-0000-0000-0000-000000000000"')) {
  fail("wrangler.jsonc must keep the placeholder D1 id");
}
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const placeholder = "00000000-0000-0000-0000-000000000000";
if (/"account_id"\s*:/.test(wrangler)) fail("wrangler.jsonc must not set an account id");
if (/"routes"\s*:/.test(wrangler)) fail("wrangler.jsonc must not pin a custom domain");

const example = joined.get(".dev.vars.example") ?? "";
for (const key of ["LLM_API_KEY=", "STRIPE_SECRET_KEY=", "STRIPE_WEBHOOK_SECRET="]) {
  if (!example.includes(key)) fail(`.dev.vars.example is missing an empty ${key}`);
}
for (const line of example.split("\n")) {
  if (/^[A-Z0-9_]+=\s*\S/.test(line)) fail(`.dev.vars.example must keep ${line.split("=")[0]} empty`);
}

const html = joined.get("public/index.html") ?? "";
const app = joined.get("public/app.js") ?? "";
for (const phrase of [
  "Get hired as a Forward Deployed Engineer.",
  "Built by No BS AI. Placement through DeployedX.",
  "Coach from Hire Me",
  "No BS AI",
]) {
  if (!html.includes(phrase) && !app.includes(phrase)) fail(`missing public copy: ${phrase}`);
}

const bobbyAllowed = new Set(["README.md", "package.json", "CONTRIBUTING.md"]);
const maintainerName = "Bob" + "by";
const scanSkip = new Set(["pnpm-lock.yaml"]);
const maintainerInbox = "bobby" + "@";
const forbidden = [
  [new RegExp(maintainerInbox, "i"), "maintainer inbox"],
  [/@deployedx\.com/i, "internal email domain"],
  [/sk_live_[A-Za-z0-9]{20,}/, "live Stripe key"],
  [/sk_test_[A-Za-z0-9]{16,}/, "long Stripe test key"],
  [/whsec_[A-Za-z0-9]{16,}/, "long webhook secret"],
  [/xai-[A-Za-z0-9]{12,}/, "model API key"],
  [/\+\d{10,15}\b/, "phone number"],
  [/\(\d{3}\)\s*\d{3}[-.\s]\d{4}/, "phone number"],
  [/\b\d{3}[-.]\d{3}[-.]\d{4}\b/, "phone number"],
];

for (const [path, text] of joined) {
  if (scanSkip.has(path) || path === "worker-configuration.d.ts") continue;
  if (new RegExp(`\\b${maintainerName}\\b`).test(text) && !bobbyAllowed.has(path)) {
    fail(`maintainer name appears outside maintainer files: ${path}`);
  }
  for (const [pattern, label] of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) fail(`${label} in ${path}`);
  }
  uuid.lastIndex = 0;
  const ids = text.match(uuid) ?? [];
  for (const id of ids) {
    if (id.toLowerCase() !== placeholder) fail(`unexpected id ${id} in ${path}`);
  }
}

const ui = `${html}\n${app}`;
if (/grok|x\.ai|\bxai\b/i.test(ui)) fail("the public UI names the model vendor");
if (/get placed when you/i.test(ui)) fail("the UI promises placement");

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`smoke ok (${joined.size} text files)`);
