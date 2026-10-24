import { chromium, devices } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const LOCAL = process.env.FUNNEL_LOCAL || "http://127.0.0.1:44521";
const LIVE = process.env.FUNNEL_LIVE || "";
const scope = process.argv[2] || "all";
const outDir = process.env.FUNNEL_OUT || "tmp/funnel";
const chrome = "/usr/bin/google-chrome";
const answer = "Last quarter the Monday dashboard was off by 12 percent. I traced it to a late payout, snapshotted the old table, and republished after finance signed off.";

const phones = [
  ["se", "iPhone SE (3rd gen)", { width: 375, height: 667 }],
  ["14", "iPhone 14 Pro", { width: 393, height: 852 }],
  ["pixel", "Pixel 7", { width: 412, height: 915 }],
];

const results = [];
const created = [];

function record(scopeName, step, pass, detail) {
  results.push({ scope: scopeName, step, pass: pass ? "pass" : "fail", detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${scopeName}  ${step}  ${detail}`);
}

async function shot(page, name) {
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}

function contextOptions(deviceName, viewport) {
  return {
    ...devices[deviceName],
    viewport,
    locale: "en-US",
    serviceWorkers: "block",
  };
}

async function launch(kind) {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (kind === "fake" || kind === "deny") args.push("--use-fake-device-for-media-stream");
  if (kind === "fake") args.push("--use-fake-ui-for-media-stream");
  return chromium.launch({ executablePath: chrome, headless: true, args });
}

async function metrics(page) {
  return page.evaluate(() => {
    const header = document.querySelector(".topbar")?.getBoundingClientRect();
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const targets = [...document.querySelectorAll("a, button, input, select, textarea")].filter((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    });
    const small = targets
      .map((el) => {
        const box = el.getBoundingClientRect();
        return { tag: el.tagName, text: (el.getAttribute("aria-label") || el.textContent || el.name || "").trim().slice(0, 40), w: Math.round(box.width), h: Math.round(box.height) };
      })
      .filter((box) => box.w < 44 || box.h < 44);
    const inputs = [...document.querySelectorAll("input, textarea, select")].map((el) => ({
      name: el.name,
      type: el.type,
      mode: el.getAttribute("inputmode"),
      auto: el.getAttribute("autocomplete"),
      size: Number.parseFloat(getComputedStyle(el).fontSize),
    }));
    const mic = document.querySelector("#talk")?.getBoundingClientRect();
    const clock = document.querySelector("#voice-clock")?.getBoundingClientRect();
    const h1 = document.querySelector("h1")?.getBoundingClientRect();
    return {
      overflow,
      small,
      inputs,
      headerBottom: header ? Math.round(header.bottom) : 0,
      h1Top: h1 ? Math.round(h1.top) : null,
      mic: mic ? { top: Math.round(mic.top), bottom: Math.round(mic.bottom), h: Math.round(mic.height) } : null,
      clock: clock ? { top: Math.round(clock.top), bottom: Math.round(clock.bottom) } : null,
      vh: window.innerHeight,
      vendor: /grok|xai/i.test(document.body.innerText),
    };
  });
}

function layoutPass(name, data) {
  const problems = [];
  if (data.overflow > 1) problems.push(`horizontal overflow ${data.overflow}px`);
  if (data.small.length) problems.push(`small targets ${data.small.map((item) => `${item.tag}:${item.text} ${item.w}x${item.h}`).join("; ")}`);
  for (const field of data.inputs) {
    if (field.size < 16) problems.push(`${field.name || field.type} font ${field.size}px`);
    if (field.type === "email" && field.mode !== "email") problems.push(`${field.name} missing inputmode=email`);
    if (field.type === "email" && field.auto !== "email") problems.push(`${field.name} missing autocomplete=email`);
  }
  if (data.vendor) problems.push("vendor name visible");
  if (data.h1Top != null && data.headerBottom && data.h1Top < data.headerBottom - 1) problems.push("header covers the heading");
  if (data.mic && (data.mic.bottom > data.vh || data.mic.top < data.headerBottom)) problems.push("mic not above the fold");
  if (data.clock && (data.clock.bottom > data.vh || data.clock.top < data.headerBottom)) problems.push("countdown not above the fold");
  record(name, "layout", problems.length === 0, problems.join(" | ") || "no overflow, 44px targets, 16px inputs");
  return problems;
}

async function audit(page, scopeName) {
  await page.evaluate(() => document.fonts.ready);
  const data = await metrics(page);
  layoutPass(scopeName, data);
  return data;
}

async function openHome(page, base) {
  await page.goto(`${base}/#/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#talk") || document.querySelector("#try-coach"));
}

async function textSession(page) {
  if (!(await page.locator("#try-answer").count())) {
    const typeInstead = page.locator("#type-instead");
    if (await typeInstead.count()) await typeInstead.click();
    else if (await page.locator("#talk").count()) await page.locator("#talk").click();
  }
  await page.waitForSelector("#try-answer");
  for (let n = 0; n < 3; n += 1) {
    await page.locator("#try-answer").fill(answer);
    await page.locator("#try button[type=submit]").click();
    await page.waitForFunction(() => {
      const card = document.querySelector("#try-coach");
      return Boolean(card && (card.innerText.includes("out of 5") || card.querySelector(".banner.bad")));
    }, null, { timeout: 45000 });
    const cardText = await page.locator("#try-coach").innerText();
    if (!cardText.includes("out of 5")) throw new Error(cardText.slice(0, 300));
    if (n < 2) {
      await page.locator("#try-next").click();
      await page.waitForSelector("#try-answer");
    }
  }
  await page.waitForFunction(() => document.body.innerText.includes("Your streak: Day 1"));
}

async function saveLead(page, email, sourceExpect) {
  await page.locator("#lead input[name=firstName]").fill("Funnel");
  await page.locator("#lead input[name=email]").fill(email);
  await page.locator("#lead input[name=consent]").check();
  const field = page.locator("#lead input[name=email]");
  await field.focus();
  await page.waitForTimeout(400);
  const placed = await field.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const header = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    return { top: box.top, bottom: box.bottom, header, vh: window.innerHeight };
  });
  const visible = placed.top >= placed.header - 1 && placed.bottom <= placed.vh * 0.72;
  record("keyboard", email, visible, `email field top ${Math.round(placed.top)} header ${Math.round(placed.header)} bottom ${Math.round(placed.bottom)} of ${placed.vh}`);
  await page.locator("#lead button[type=submit]").click();
  await page.waitForFunction(() => document.body.innerText.includes("You're in. Start free to keep your streak"));
  const href = await page.locator("a.btn.accent.full").getAttribute("href");
  created.push({ kind: "lead", email, source: sourceExpect, href });
  return href;
}

async function signIn(page, base, email) {
  if (!page.url().includes("#/signin")) await page.locator("a.btn.accent.full").click();
  await page.waitForSelector("#signin input[name=email]");
  const value = await page.locator("#signin input[name=email]").inputValue();
  record("signin", "prefilled", value === email, value);
  await page.locator("#signin button[type=submit]").click();
  await page.waitForSelector("#magic a");
  const link = await page.locator("#magic a").getAttribute("href");
  const host = new URL(link, base).host;
  const expected = new URL(base).host;
  record("signin", "magic link host", host === expected, host);
  if (host !== expected) throw new Error(`magic link host ${host} did not match ${expected}`);
  await page.locator("#magic a").click();
  await page.waitForFunction(() => document.querySelector("[data-role]") || /Opening today's brief|Day \d|Start the streak/.test(document.body.innerText));
  if (await page.locator("[data-role=ai_engineer]").count()) {
    await page.locator("[data-role=ai_engineer]").click();
  }
  await page.waitForFunction(() => /Day \d|Start the streak/.test(document.querySelector("h1")?.textContent || ""), null, { timeout: 20000 });
  created.push({ kind: "user", email });
}

async function localFunnel(browser) {
  const primary = await browser.newContext(contextOptions("iPhone 14 Pro", { width: 393, height: 852 }));
  await primary.grantPermissions(["microphone"]);
  const page = await primary.newPage();
  await openHome(page, LOCAL);
  await shot(page, "funnel-local-home");
  await audit(page, "local home 14");
  const talk = page.locator("#talk");
  if (await talk.count()) await talk.click();
  await page.waitForFunction(() => document.body.innerText.includes("Type") || document.querySelector("#try-coach") || document.querySelector("[data-voice-role]"));
  await shot(page, "funnel-local-talk");
  const body = await page.locator("body").innerText();
  const offline = /isn't available|denied|No microphone|Type the three questions/i.test(body);
  record("local", "talk without a voice key", offline && !(await page.locator("#voice-clock").count()), body.split("\n").slice(2, 6).join(" "));
  await textSession(page);
  await shot(page, "funnel-local-text");
  record("local", "text fallback summary", true, "Your streak: Day 1");
  const email = "funnel-test+local@example.com";
  await saveLead(page, email, "try-coach");
  await shot(page, "funnel-local-lead");
  await signIn(page, LOCAL, email);
  await shot(page, "funnel-local-dashboard");
  record("local", "dashboard", /Day|Start the streak/.test(await page.locator("body").innerText()), "today");
  await page.goto(`${LOCAL}/#/path`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.innerText.includes("$200"));
  await shot(page, "funnel-local-tiers");
  const tiers = await page.locator("body").innerText();
  record("local", "tiers", tiers.includes("$0") && tiers.includes("$20") && tiers.includes("$100") && tiers.includes("$200"), "ladder");
  await audit(page, "local tiers 14");
  await primary.close();

  for (const [id, deviceName, viewport] of phones) {
    const context = await browser.newContext(contextOptions(deviceName, viewport));
    const phone = await context.newPage();
    await openHome(phone, LOCAL);
    await shot(phone, `funnel-${id}-home`);
    await audit(phone, `${id} home`);
    await phone.goto(`${LOCAL}/#/signin`, { waitUntil: "networkidle" });
    await phone.waitForSelector("#signin input[name=email]");
    await audit(phone, `${id} signin`);
    const emailBox = phone.locator("#signin input[name=email]");
    await emailBox.focus();
    await phone.waitForTimeout(400);
    const placed = await emailBox.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const header = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      return box.top >= header - 1 && box.bottom < window.innerHeight;
    });
    record(id, "signin field below header", placed, "focused email");
    await phone.goto(`${LOCAL}/#/path`, { waitUntil: "networkidle" });
    await phone.waitForFunction(() => document.body.innerText.includes("Climb"));
    await audit(phone, `${id} tiers`);
    await context.close();
  }
}

async function liveFunnel(fakeBrowser, plainBrowser) {
  const status = await (await fetch(`${LIVE}/api/voice-taste/status`)).json();
  record("live", "status before voice", status.reason === "ready", JSON.stringify(status));
  if (status.reason !== "ready") {
    record("live", "voice session", false, "did not start a second session");
    return;
  }

  const deniedContext = await plainBrowser.newContext(contextOptions("iPhone SE (3rd gen)", { width: 375, height: 667 }));
  const denied = await deniedContext.newPage();
  await openHome(denied, LIVE);
  await denied.locator("#talk:not([disabled])").click();
  await denied.waitForFunction(() => /denied|No microphone|Type the three questions/i.test(document.body.innerText), null, { timeout: 15000 });
  await shot(denied, "funnel-live-denied");
  const deniedText = await denied.locator("body").innerText();
  record("live", "mic denied", /Microphone access was denied/.test(deniedText), deniedText.split("\n").find((line) => /denied|microphone/i.test(line)) || "missing");
  await deniedContext.close();
  const afterDeny = await (await fetch(`${LIVE}/api/voice-taste/status`)).json();
  record("live", "denial did not burn the slot", afterDeny.reason === "ready", afterDeny.reason);
  if (afterDeny.reason !== "ready") return;

  const context = await fakeBrowser.newContext(contextOptions("iPhone 14 Pro", { width: 393, height: 852 }));
  await context.grantPermissions(["microphone"]);
  const page = await context.newPage();
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/voice-taste/session")) {
      created.push({ kind: "voice-session", at: new Date().toISOString() });
      console.log("POST /api/voice-taste/session");
    }
  });
  await openHome(page, LIVE);
  await shot(page, "funnel-live-home");
  await audit(page, "live home 14");
  await page.locator("#talk").click();
  await page.waitForSelector("[data-voice-role=fde]");
  await shot(page, "funnel-live-roles");
  record("live", "mic granted shows roles", true, "role chips");
  await page.locator("[data-voice-role=fde]").click();
  await page.waitForSelector("#voice-status", { timeout: 20000 });
  await shot(page, "funnel-live-connecting");
  await page.waitForSelector("#voice-clock", { timeout: 30000 });
  const connecting = await page.locator("#voice-status").innerText().catch(() => "");
  await page.waitForFunction(() => {
    const clock = document.querySelector("#voice-clock")?.textContent?.trim();
    return clock && clock !== "3:00";
  }, null, { timeout: 20000 });
  const clock = await page.locator("#voice-clock").innerText();
  await shot(page, "funnel-live-countdown");
  const liveMetrics = await metrics(page);
  layoutPass("live countdown 14", liveMetrics);
  record("live", "countdown running", clock !== "3:00" && /^\d:\d\d$/.test(clock.trim()), `${connecting} -> ${clock.trim()}`);
  await page.locator("#voice-end").click();
  await page.waitForFunction(() => document.body.innerText.includes("Streak: Day 1"), null, { timeout: 20000 });
  await shot(page, "funnel-live-summary");
  const summary = await page.locator("body").innerText();
  record("live", "end summary", summary.includes("Streak: Day 1") && summary.includes("Best moment") && summary.includes("One thing to fix"), "summary");
  const email = "funnel-test+1@example.com";
  await saveLead(page, email, "voice-taste");
  await shot(page, "funnel-live-lead");
  await signIn(page, LIVE, email);
  await shot(page, "funnel-live-dashboard");
  record("live", "dashboard", /Day|Start the streak/.test(await page.locator("body").innerText()), "today");
  await page.goto(`${LIVE}/#/path`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.innerText.includes("$100"));
  await shot(page, "funnel-live-tiers");
  record("live", "tiers", (await page.locator("body").innerText()).includes("$200"), "ladder");
  await context.close();

  const textContext = await fakeBrowser.newContext(contextOptions("Pixel 7", { width: 412, height: 915 }));
  const text = await textContext.newPage();
  await openHome(text, LIVE);
  await text.waitForFunction(() => document.body.innerText.includes("already talked") || document.querySelector("#try-answer") || document.querySelector("#type-instead"));
  if (await text.locator("#type-instead").count()) await text.locator("#type-instead").click();
  await text.waitForSelector("#try-answer");
  await textSession(text);
  await shot(text, "funnel-live-text");
  record("live", "text fallback after the voice slot", (await text.locator("body").innerText()).includes("Your streak: Day 1"), "three questions");
  const textEmail = "funnel-test+2@example.com";
  await saveLead(text, textEmail, "try-coach");
  const href = await text.locator("a.btn.accent.full").getAttribute("href");
  record("live", "text start free prefilled", href?.includes(encodeURIComponent(textEmail)) === true, href || "");
  await textContext.close();

  const again = await (await fetch(`${LIVE}/api/voice-taste/status`)).json();
  record("live", "slot used once", again.reason === "used", again.reason);
}

const fakeBrowser = await launch("fake");
const plainBrowser = scope === "local" || !LIVE ? null : await launch("deny");
await mkdir(outDir, { recursive: true });
try {
  if (scope === "all" || scope === "local") await localFunnel(fakeBrowser);
  if ((scope === "all" || scope === "live") && LIVE) await liveFunnel(fakeBrowser, plainBrowser);
  if ((scope === "all" || scope === "live") && !LIVE) console.log("Skip live funnel. Set FUNNEL_LIVE to a deployment you own.");
} catch (error) {
  record(scope, "crashed", false, error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await fakeBrowser.close();
  await plainBrowser?.close();
  await writeFile(`${outDir}/funnel-results.json`, JSON.stringify({ results, created }, null, 2));
  const failed = results.filter((item) => item.pass === "fail").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  console.log(JSON.stringify(created, null, 2));
  process.exitCode = failed ? 1 : 0;
}
