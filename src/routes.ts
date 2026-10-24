import { deleteCookie } from "hono/cookie";
import { Hono } from "hono";
import { createSession, getUser, isResponse, issueMagicLink, publicUser, requireUser, type UserRow } from "./auth";
import { brandFromEnv } from "./lib/brand";
import { proxyLiveSession } from "./live";
import { proxyVoiceTaste } from "./voice-taste";
import {
  buildCoachContext,
  coachSummary,
  ensureCoachSession,
  listTodaySessions,
  resolveOpeningWeakSpot,
  saveSessionScore,
  type CoachUser,
} from "./lib/coach-session";
import { normalizeFeedback, offlineFeedback, type Feedback } from "./lib/feedback";
import {
  modelText,
  hasApiKey,
  makeoverWithModel,
  ModelCallError,
  modelsFromEnv,
  scoreWithModel,
  synthesizeSpeech,
  transcribeAudio,
} from "./lib/provider";
import { bytesToBase64, clip, isAdminEmail, isProduction, logEvent, originOf, readJson, sha256Hex, type AppContext, type AppEnv } from "./lib/http";
import {
  allows,
  capsForTier,
  isRole,
  isTier,
  liveRateUsd,
  nextStreak,
  parseCaps,
  ROLES,
  textTurnSeconds,
  tierLabel,
  utcDate,
  voicePipelineSeconds,
  weekStart,
  type Caps,
  type RoleId,
  type Tier,
} from "./lib/policy";
import { coachUserMessage, parseCoachTurn, renderVoiceCoachPrompt } from "./lib/voice-coach";
import { assertStripeTestKey, priceForTier, StripeConfigError, stripeForm, tierForPrice, verifyStripeSignature } from "./lib/stripe";
import {
  LEAD_DAILY_LIMIT,
  TRY_ANSWER_LIMIT,
  TRY_DAILY_LIMIT,
  TRY_MAX_OUTPUT_TOKENS,
  TRY_RETRY_OUTPUT_TOKENS,
  LeadLimitError,
  clientIpHash,
  consumeTry,
  defaultTryRole,
  isTryRole,
  linkedinUrl,
  listLeads,
  questionById,
  questionsFor,
  saveLead,
  triesUsed,
  type LeadSource,
  type TryQuestion,
} from "./lib/try";
import {
  deleteVoiceTaste,
  freeVoiceDailyCap,
  mintClientSecret,
  reserveVoiceTaste,
  storeVoiceSecret,
  TASTE_SECONDS,
  voiceTasteStatus,
} from "./lib/voice-taste";
import { getUsage, release, reserve, touchActivity } from "./lib/usage";

const api = new Hono<{ Bindings: AppEnv }>();

api.get("/brand", (c) => {
  const brand = brandFromEnv(c.env);
  const demo = isProduction(c.env)
    ? []
    : ["free@example.com", "voice@example.com", "live@example.com", "coach@example.com"];
  return c.json({ ...brand, demoInboxes: demo });
});

api.get("/health", (c) => {
  const models = modelsFromEnv(c.env);
  const stripeKey = c.env.STRIPE_SECRET_KEY ?? "";
  const stripeMode = stripeKey.startsWith("sk_test_") || stripeKey.startsWith("rk_test_")
    ? "test"
    : stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")
      ? "refused"
      : "missing";
  return c.json({
    ok: true,
    service: brandFromEnv(c.env).product,
    textModel: models.textModel,
    voiceModel: models.voiceModel,
    sttModel: models.sttModel,
    ttsVoice: models.ttsVoice,
    modelConfigured: hasApiKey(c.env.LLM_API_KEY),
    stripeMode,
  });
});

api.get("/try", async (c) => {
  const requested = c.req.query("role");
  const role = requested ? (isTryRole(requested) ? requested : null) : defaultTryRole();
  if (!role) return c.json({ error: "bad_role", message: "Pick AI Engineer, FDE, or Data Engineer." }, 400);
  const questions = await questionsFor(c.env.DB, role);
  if (questions.length === 0) return c.json({ error: "no_question", message: "No interview question is on file for that role." }, 404);
  const used = await triesUsed(c.env.DB, await clientIpHash(c.req.raw));
  return c.json({
    role,
    roleLabel: questions[0].roleLabel,
    questions: questions.map(publicQuestion),
    sessionLength: questions.length,
    remaining: Math.max(0, TRY_DAILY_LIMIT - used),
  });
});

api.post("/try", async (c) => {
  const body = await readJson<{ role?: string; taskId?: string; answer?: string }>(c);
  if (body instanceof Response) return body;
  if (!isTryRole(body.role)) {
    return c.json({ error: "bad_role", message: "Pick AI Engineer, FDE, or Data Engineer." }, 400);
  }
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (answer.length < 2) return c.json({ error: "empty_answer", message: "Write the answer you would actually say." }, 400);
  if (answer.length > TRY_ANSWER_LIMIT) {
    return c.json({ error: "answer_too_long", message: "Keep the answer under 1,200 characters." }, 400);
  }
  const question = body.taskId
    ? await questionById(c.env.DB, body.role, clip(body.taskId, 80))
    : (await questionsFor(c.env.DB, body.role))[0] ?? null;
  if (!question) return c.json({ error: "no_question", message: "That question is not on this role." }, 400);
  const ipHash = await clientIpHash(c.req.raw);
  const tries = await consumeTry(c.env.DB, ipHash);
  if (tries === null) {
    return c.json({
      error: "try_limit",
      remaining: 0,
      message: "Three free sessions today. Start free for ten minutes every day.",
    }, 429);
  }
  const feedback = await scoreTry(c, question, answer);
  return c.json({
    score: feedback.overall,
    strength: feedback.strengths[0] || feedback.summary,
    fix: feedback.improvements[0] || "Close with the result, and put a number on it.",
    offline: feedback.source !== "model",
    remaining: Math.max(0, TRY_DAILY_LIMIT - tries),
    ...publicQuestion(question),
  });
});

api.get("/voice-taste/status", async (c) => {
  const status = await voiceTasteStatus(
    c.env.DB,
    await clientIpHash(c.req.raw),
    freeVoiceDailyCap(c.env),
    hasApiKey(c.env.LLM_API_KEY),
  );
  return c.json(status);
});

api.post("/voice-taste/session", async (c) => {
  const body = await readJson<{ role?: string }>(c);
  if (body instanceof Response) return body;
  if (!isTryRole(body.role)) {
    return c.json({ error: "bad_role", message: "Pick AI Engineer, FDE, or Data Engineer." }, 400);
  }
  if (!hasApiKey(c.env.LLM_API_KEY)) {
    return c.json({ error: "voice_offline", message: "Voice isn't available right now. Type your answers instead." }, 503);
  }
  const reserved = await reserveVoiceTaste(c.env.DB, {
    ipHash: await clientIpHash(c.req.raw),
    role: body.role,
    cap: freeVoiceDailyCap(c.env),
  });
  if (!reserved.ok) {
    const used = reserved.reason === "used";
    return c.json({
      error: used ? "voice_used" : "voice_full",
      reason: reserved.reason,
      message: used
        ? "You've already talked with Coach today. Type the three questions, or start free."
        : "Today's free voice spots are full. Type the three questions instead.",
    }, 429);
  }
  try {
    const secret = await mintClientSecret(modelsFromEnv(c.env).apiBase, c.env.LLM_API_KEY, TASTE_SECONDS);
    const clock = await storeVoiceSecret(c.env.DB, reserved.id, secret);
    return c.json({
      sessionId: reserved.id,
      expiresAt: clock.expiresAt,
      seconds: TASTE_SECONDS,
    });
  } catch (error) {
    logEvent("voice_taste_session_failed", { message: error instanceof Error ? error.message : "failed" });
    await deleteVoiceTaste(c.env.DB, reserved.id);
    return c.json({ error: "voice_offline", message: "Voice isn't available right now. Type your answers instead." }, 503);
  }
});

api.get("/voice-taste/socket", async (c) => {
  const sessionId = c.req.query("sessionId") ?? "";
  if (!sessionId) return c.json({ error: "missing_session", message: "Missing session id." }, 400);
  return proxyVoiceTaste(c.req.raw, c.env, sessionId);
});

api.post("/lead", async (c) => {
  const body = await readJson<{
    firstName?: string;
    email?: string;
    role?: string;
    linkedin?: string;
    consent?: boolean;
    sessionAvg?: number | null;
    source?: string;
  }>(c);
  if (body instanceof Response) return body;
  const firstName = clip(body.firstName, 80);
  if (firstName.length < 1) return c.json({ error: "bad_name", message: "Add your first name." }, 400);
  const email = clip(body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "bad_email", message: "Enter a real email address." }, 400);
  }
  if (!isTryRole(body.role)) {
    return c.json({ error: "bad_role", message: "Pick AI Engineer, FDE, or Data Engineer." }, 400);
  }
  const linkedin = linkedinUrl(body.linkedin);
  if (linkedin === "invalid") return c.json({ error: "bad_linkedin", message: "Use a linkedin.com URL, or leave it blank." }, 400);
  if (body.consent !== true) {
    return c.json({ error: "consent_required", message: "Check the box to get one practice question a day." }, 400);
  }
  const source: LeadSource = body.source === "voice-taste" ? "voice-taste" : "try-coach";
  const sessionAvg = leadScore(body.sessionAvg, source);
  if (sessionAvg instanceof Response) return sessionAvg;
  const ipHash = await clientIpHash(c.req.raw);
  try {
    const lead = await saveLead(c.env.DB, ipHash, {
      firstName,
      email,
      role: body.role,
      linkedin,
      consent: true,
      sessionAvg,
      source,
    });
    return c.json({
      ok: true,
      email: lead.email,
      message: "You're in. Start free to keep your streak.",
    });
  } catch (error) {
    if (error instanceof LeadLimitError) {
      return c.json({
        error: "lead_limit",
        message: `That's ${LEAD_DAILY_LIMIT} saved scores from this network today. Start free to keep going.`,
      }, 429);
    }
    throw error;
  }
});

api.post("/auth/request", async (c) => {
  const body = await readJson<{ email?: string }>(c);
  if (body instanceof Response) return body;
  const email = clip(body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "bad_email", message: "Enter a real email address." }, 400);
  }
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND created_at > ?`,
  )
    .bind(email, since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 5) {
    return c.json({ error: "rate_limited", message: "Too many links for that inbox. Wait an hour." }, 429);
  }
  if (isProduction(c.env) && !c.env.EMAIL_WEBHOOK_URL) {
    return c.json({
      error: "email_not_configured",
      message: "Set EMAIL_WEBHOOK_URL before production sign-in. Development shows the link on this screen.",
    }, 503);
  }
  const issued = await issueMagicLink(c, email);
  return c.json({
    ok: true,
    delivery: issued.delivery,
    magicLink: issued.magicLink ?? null,
    message: issued.magicLink
      ? "Development mode. Open the link on this screen. Nothing was emailed."
      : "Check your inbox for the sign-in link.",
  });
});

api.get("/auth/verify", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!token) return c.json({ error: "bad_token", message: "That link is missing its token." }, 400);
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const link = await c.env.DB.prepare(
    `SELECT email, expires_at, used_at FROM magic_links WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ email: string; expires_at: string; used_at: string | null }>();
  if (!link || link.used_at || link.expires_at < now) {
    return c.json({ error: "bad_token", message: "That link is used or expired. Request another." }, 400);
  }
  await c.env.DB.prepare(`UPDATE magic_links SET used_at = ? WHERE token_hash = ?`).bind(now, tokenHash).run();
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(link.email).first<{ id: string }>();
  let userId = existing?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, tier, first_pick, streak_count, created_at, updated_at)
       VALUES (?, ?, 'free', 0, 0, ?, ?)`,
    )
      .bind(userId, link.email, now, now)
      .run();
  }
  await createSession(c, userId);
  return c.redirect("/#/today", 302);
});

api.post("/auth/logout", async (c) => {
  const user = await getUser(c);
  if (user) {
    const session = c.req.header("cookie") ?? "";
    const match = session.match(/(?:^|;\s*)hireme_session=([^;]+)/);
    if (match) await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(decodeURIComponent(match[1])).run();
  }
  deleteCookie(c, "hireme_session", { path: "/" });
  return c.json({ ok: true });
});

api.get("/me", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const today = utcDate();
  await touchActivity(c.env.DB, user.id, today);
  return c.json(await mePayload(c, user));
});

api.patch("/me", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const body = await readJson<ProfilePatch>(c);
  if (body instanceof Response) return body;
  const patch = readProfilePatch(body);
  if (!patch.ok) return c.json({ error: patch.error, message: patch.message }, 400);
  const now = new Date().toISOString();
  if (patch.role) {
    await c.env.DB.prepare(`UPDATE users SET target_role = ?, updated_at = ? WHERE id = ?`)
      .bind(patch.role, now, user.id)
      .run();
    await c.env.DB.prepare(
      `DELETE FROM daily_assignments WHERE user_id = ? AND usage_date = ? AND status = 'pending'`,
    )
      .bind(user.id, utcDate())
      .run();
    user.target_role = patch.role;
  }
  if (patch.displayName !== undefined || patch.targetCompany !== undefined || patch.interviewDate !== undefined) {
    await c.env.DB.prepare(
      `UPDATE users SET
         display_name = CASE WHEN ? THEN ? ELSE display_name END,
         target_company = CASE WHEN ? THEN ? ELSE target_company END,
         interview_date = CASE WHEN ? THEN ? ELSE interview_date END,
         updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        patch.displayName !== undefined ? 1 : 0,
        patch.displayName ?? null,
        patch.targetCompany !== undefined ? 1 : 0,
        patch.targetCompany ?? null,
        patch.interviewDate !== undefined ? 1 : 0,
        patch.interviewDate ?? null,
        now,
        user.id,
      )
      .run();
    if (patch.displayName !== undefined) user.display_name = patch.displayName;
    if (patch.targetCompany !== undefined) user.target_company = patch.targetCompany;
    if (patch.interviewDate !== undefined) user.interview_date = patch.interviewDate;
  }
  return c.json(await mePayload(c, user));
});

api.get("/today", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  if (!user.target_role) return c.json({ needsRole: true });
  const today = utcDate();
  await touchActivity(c.env.DB, user.id, today);
  const assignment = await ensureAssignment(c, user, today);
  const sent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND applied_at >= ?`,
  )
    .bind(user.id, `${today}T00:00:00.000Z`)
    .first<{ n: number }>();
  return c.json({
    date: today,
    role: user.target_role,
    roleLabel: ROLES[user.target_role],
    streak: user.streak_count,
    assignment,
    applicationsSentToday: sent?.n ?? 0,
    tracker: allows(user.tier, "tracker"),
    coach: await coachState(c, user, today),
  });
});

api.post("/today/answer", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const body = await readJson<{ answer?: string; elapsedSeconds?: number }>(c);
  if (body instanceof Response) return body;
  const answer = clip(body.answer, 8000);
  if (answer.length < 2) return c.json({ error: "empty_answer", message: "Write the answer you would actually say." }, 400);
  if (!user.target_role) return c.json({ error: "needs_role", message: "Pick a target role first." }, 400);
  const today = utcDate();
  const assignment = await ensureAssignment(c, user, today);
  const caps = parseCaps(c.env);
  const limits = capsForTier(user.tier, caps);
  const seconds = textTurnSeconds(body.elapsedSeconds, caps.minTextTurn);
  const reserved = await reserve(c.env.DB, user.id, today, "text", seconds, limits.text);
  if (!reserved.ok) {
    logEvent("text_cap", { userId: user.id, tier: user.tier, used: reserved.used, cap: reserved.cap });
    return c.json(capBody("text", reserved.used, reserved.cap, user.tier), 402);
  }
  try {
    const feedback = await scoreAnswer(c, user, assignment.prompt, answer, today);
    const now = new Date().toISOString();
    const wasPending = assignment.status === "pending";
    await c.env.DB.prepare(
      `UPDATE daily_assignments
       SET status = 'completed', answer_text = ?, score_json = ?, completed_at = COALESCE(completed_at, ?)
       WHERE id = ?`,
    )
      .bind(answer, JSON.stringify(feedback), now, assignment.id)
      .run();
    await c.env.DB.prepare(
      `INSERT INTO coaching_turns (id, user_id, usage_date, channel, user_text, assistant_text, score_json, seconds_charged, created_at)
       VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), user.id, today, answer, feedback.spoken, JSON.stringify(feedback), seconds, now)
      .run();
    let streak = user.streak_count;
    if (wasPending) {
      streak = nextStreak(user.streak_count, user.streak_last_date, today);
      await c.env.DB.prepare(`UPDATE users SET streak_count = ?, streak_last_date = ?, updated_at = ? WHERE id = ?`)
        .bind(streak, today, now, user.id)
        .run();
    }
    await touchActivity(c.env.DB, user.id, today);
    return c.json({
      feedback,
      streak,
      chargedSeconds: seconds,
      usage: await usagePayload(c, { ...user, streak_count: streak }),
    });
  } catch (error) {
    await release(c.env.DB, user.id, today, "text", seconds);
    logEvent("text_score_failed", { message: error instanceof Error ? error.message : "failed" });
    return c.json({ error: "score_failed", message: "Coach did not return a score. This turn was not charged." }, 502);
  }
});

api.post("/makeover", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const body = await readJson<{ headline?: string; resume?: string }>(c);
  if (body instanceof Response) return body;
  const headline = clip(body.headline, 220);
  const resume = clip(body.resume, 8000);
  if (resume.length < 20) {
    return c.json({ error: "short_resume", message: "Paste at least a few lines of the resume." }, 400);
  }
  const today = utcDate();
  const caps = parseCaps(c.env);
  const limits = capsForTier(user.tier, caps);
  const reserved = await reserve(c.env.DB, user.id, today, "text", caps.makeover, limits.text);
  if (!reserved.ok) return c.json(capBody("text", reserved.used, reserved.cap, user.tier), 402);
  const roleLabel = user.target_role ? ROLES[user.target_role] : "the role you want";
  try {
    const result = hasApiKey(c.env.LLM_API_KEY)
      ? {
          source: "model" as const,
          ...(await makeoverWithModel({
            apiBase: modelsFromEnv(c.env).apiBase,
            apiKey: c.env.LLM_API_KEY,
            model: modelsFromEnv(c.env).textModel,
            roleLabel,
            headline,
            resume,
          })),
        }
      : { source: "offline-rubric" as const, ...offlineMakeover(headline, resume, roleLabel) };
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE users SET headline = ?, resume_text = ?, makeover_json = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(headline || user.headline, resume, JSON.stringify(result), now, user.id)
      .run();
    await touchActivity(c.env.DB, user.id, today);
    return c.json({ result, chargedSeconds: caps.makeover, usage: await usagePayload(c, user) });
  } catch (error) {
    await release(c.env.DB, user.id, today, "text", caps.makeover);
    logEvent("makeover_failed", { message: error instanceof Error ? error.message : "failed" });
    return c.json({ error: "makeover_failed", message: "Coach did not finish the makeover. This was not charged." }, 502);
  }
});

api.post("/interview/voice/open", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const ready = await beginVoice(c, user);
  if (ready instanceof Response) return ready;
  const existing = await c.env.DB.prepare(
    `SELECT assistant_text FROM coaching_turns
     WHERE user_id = ? AND usage_date = ? AND channel = 'voice' AND (user_text IS NULL OR user_text = '')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user.id, ready.today)
    .first<{ assistant_text: string | null }>();
  if (existing?.assistant_text) {
    return c.json({
      spoken: existing.assistant_text,
      replayed: true,
      transcript: null,
      audioBase64: null,
      contentType: "audio/mpeg",
      pauseMs: ready.caps.voicePause * 1000,
      chargedSeconds: 0,
      truncated: false,
      coach: await coachState(c, user, ready.today),
      usage: await usagePayload(c, user),
    });
  }
  return speakCoach(c, user, ready, null, 0);
});

api.post("/interview/voice", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const ready = await beginVoice(c, user);
  if (ready instanceof Response) return ready;
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) {
    return c.json({ error: "missing_audio", message: "Record an answer and send it as audio." }, 400);
  }
  if (!hasApiKey(c.env.LLM_API_KEY)) {
    return c.json({ error: "model_not_configured", message: "Voice coaching is not configured yet. Text coaching is still open." }, 503);
  }
  const models = modelsFromEnv(c.env);
  let transcript: { text: string; duration: number };
  try {
    transcript = await transcribeAudio({
      apiBase: models.apiBase,
      apiKey: c.env.LLM_API_KEY,
      model: models.sttModel,
      audio: file,
      filename: file.name || "answer.webm",
    });
  } catch (error) {
    logEvent("stt_failed", { message: error instanceof Error ? error.message : "failed" });
    return c.json({ error: "stt_failed", message: "Speech-to-text failed. This turn was not charged." }, 502);
  }
  if (!transcript.text) {
    return c.json({ error: "empty_transcript", message: "I could not hear an answer in that recording." }, 400);
  }
  return speakCoach(c, user, ready, transcript.text, transcript.duration);
});

api.post("/interview/live/session", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  if (!allows(user.tier, "live")) {
    return c.json({
      error: "tier_required",
      feature: "live",
      message: "Live voice interviews start at the $100 plan.",
    }, 403);
  }
  if (!user.target_role) return c.json({ error: "needs_role", message: "Pick a target role first." }, 400);
  const today = utcDate();
  const limits = capsForTier(user.tier, parseCaps(c.env));
  const usage = await getUsage(c.env.DB, user.id, today);
  if (usage.live >= limits.live) return c.json(capBody("live", usage.live, limits.live, user.tier), 402);
  if (!hasApiKey(c.env.LLM_API_KEY)) {
    return c.json({
      error: "model_not_configured",
      message: "Live voice is not configured yet.",
    }, 503);
  }
  const assignment = await ensureAssignment(c, user, today);
  const context = await buildCoachContext(c.env.DB, coachUser(user), today);
  await ensureCoachSession(c.env.DB, {
    userId: user.id,
    usageDate: today,
    channel: "live",
    openingWeakSpot: context.lastSessionWeakSpot,
  });
  const instructions = renderVoiceCoachPrompt(context, "live");
  const id = crypto.randomUUID();
  const roleLabel = ROLES[user.target_role];
  await c.env.DB.prepare(
    `INSERT INTO live_sessions (id, user_id, usage_date, task_prompt, role_label, instructions, charged_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, user.id, today, assignment.prompt, roleLabel, instructions, new Date().toISOString())
    .run();
  const models = modelsFromEnv(c.env);
  return c.json({
    sessionId: id,
    remainingSeconds: limits.live - usage.live,
    voice: models.ttsVoice,
    sampleRate: 24000,
    coach: await coachState(c, user, today),
  });
});

api.get("/interview/live/socket", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  if (!allows(user.tier, "live")) {
    return c.json({ error: "tier_required", feature: "live", message: "Live voice interviews start at the $100 plan." }, 403);
  }
  const sessionId = c.req.query("sessionId") ?? "";
  if (!sessionId) return c.json({ error: "missing_session", message: "Missing session id." }, 400);
  return proxyLiveSession(c.req.raw, c.env, sessionId, user.id);
});

api.get("/applications", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const denied = gate(c, user, "tracker");
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT id, company, role_title, url, status, notes, applied_at
     FROM applications WHERE user_id = ? ORDER BY applied_at DESC`,
  )
    .bind(user.id)
    .all();
  return c.json({
    applications: rows.results ?? [],
    autoApply: autoApplyStub(),
  });
});

api.post("/applications", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const denied = gate(c, user, "tracker");
  if (denied) return denied;
  const body = await readJson<{ company?: string; roleTitle?: string; url?: string; status?: string; notes?: string }>(c);
  if (body instanceof Response) return body;
  const company = clip(body.company, 120);
  const roleTitle = clip(body.roleTitle, 160);
  if (!company || !roleTitle) return c.json({ error: "missing_fields", message: "Company and role are required." }, 400);
  const status = applicationStatus(body.status);
  const id = crypto.randomUUID();
  const appliedAt = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO applications (id, user_id, company, role_title, url, status, notes, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, company, roleTitle, clip(body.url, 400) || null, status, clip(body.notes, 2000) || null, appliedAt)
    .run();
  await touchActivity(c.env.DB, user.id, utcDate());
  return c.json({ id, company, roleTitle, url: clip(body.url, 400) || null, status, notes: clip(body.notes, 2000) || null, appliedAt }, 201);
});

api.patch("/applications/:id", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const denied = gate(c, user, "tracker");
  if (denied) return denied;
  const body = await readJson<{ status?: string; notes?: string }>(c);
  if (body instanceof Response) return body;
  const status = applicationStatus(body.status);
  const result = await c.env.DB.prepare(
    `UPDATE applications SET status = ?, notes = COALESCE(?, notes) WHERE id = ? AND user_id = ?`,
  )
    .bind(status, body.notes === undefined ? null : clip(body.notes, 2000), c.req.param("id"), user.id)
    .run();
  if ((result.meta.changes ?? 0) < 1) return c.json({ error: "not_found", message: "That application is not on your list." }, 404);
  return c.json({ ok: true, status });
});

api.delete("/applications/:id", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const denied = gate(c, user, "tracker");
  if (denied) return denied;
  await c.env.DB.prepare(`DELETE FROM applications WHERE id = ? AND user_id = ?`).bind(c.req.param("id"), user.id).run();
  return c.json({ ok: true });
});

// TODO: Auto-apply needs Google OAuth verification before it can send mail or book calendar holds.
// It must never touch LinkedIn or any job board that bans automation.
api.post("/applications/auto-apply", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const denied = gate(c, user, "tracker");
  if (denied) return denied;
  return c.json(autoApplyStub(), 501);
});

api.get("/coach/requests", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const denied = gate(c, user, "coach");
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT id, focus, preferred_times, notes, status, created_at FROM coach_requests WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all();
  return c.json({ requests: rows.results ?? [] });
});

api.post("/coach/requests", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const denied = gate(c, user, "coach");
  if (denied) return denied;
  const body = await readJson<{ focus?: string; preferredTimes?: string; notes?: string }>(c);
  if (body instanceof Response) return body;
  const preferred = clip(body.preferredTimes, 500);
  if (preferred.length < 3) return c.json({ error: "missing_times", message: "Say when you can take the weekly slot." }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO coach_requests (id, user_id, focus, preferred_times, notes, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
  )
    .bind(id, user.id, clip(body.focus, 120) || null, preferred, clip(body.notes, 2000) || null, now)
    .run();
  return c.json({ id, status: "requested", createdAt: now }, 201);
});

api.get("/roles", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const rows = await c.env.DB.prepare(`SELECT id, title, track, location, summary FROM deployedx_roles ORDER BY title`).all();
  return c.json({
    firstPick: user.first_pick === 1,
    placement: brandFromEnv(c.env).placement,
    roles: rows.results ?? [],
  });
});

api.post("/billing/checkout", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  const body = await readJson<{ tier?: string }>(c);
  if (body instanceof Response) return body;
  if (body.tier !== "voice" && body.tier !== "live" && body.tier !== "coach") {
    return c.json({ error: "bad_tier", message: "Choose the $20, $100, or $200 plan." }, 400);
  }
  const price = priceForTier(body.tier, {
    voice: c.env.STRIPE_PRICE_VOICE,
    live: c.env.STRIPE_PRICE_LIVE,
    coach: c.env.STRIPE_PRICE_COACH,
  });
  try {
    assertStripeTestKey(c.env.STRIPE_SECRET_KEY);
  } catch (error) {
    if (error instanceof StripeConfigError) {
      return c.json(
        { error: error.code === "live" ? "stripe_live_refused" : "stripe_not_configured", message: error.message },
        error.code === "live" ? 400 : 503,
      );
    }
    throw error;
  }
  if (!price || price.startsWith("price_test_")) {
    return c.json({
      error: "price_not_configured",
      message: `Set STRIPE_PRICE_${body.tier.toUpperCase()} to a Stripe test-mode price id before checkout.`,
    }, 503);
  }
  try {
    const origin = originOf(c);
    const fields: Record<string, string> = {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      client_reference_id: user.id,
      "metadata[user_id]": user.id,
      "metadata[tier]": body.tier,
    };
    if (user.stripe_customer_id) fields.customer = user.stripe_customer_id;
    else fields.customer_email = user.email;
    const session = await stripeForm(c.env.STRIPE_SECRET_KEY ?? "", "checkout/sessions", fields);
    if (!session.ok) {
      logEvent("stripe_checkout_failed", { status: session.status });
      return c.json({ error: "stripe_error", message: "Stripe did not open checkout. Check the test key and price id." }, 502);
    }
    return c.json({ url: session.body.url });
  } catch (error) {
    if (error instanceof StripeConfigError) {
      return c.json({ error: error.code === "live" ? "stripe_live_refused" : "stripe_not_configured", message: error.message }, error.code === "live" ? 400 : 503);
    }
    throw error;
  }
});

api.post("/billing/portal", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  if (!user.stripe_customer_id) {
    return c.json({ error: "no_customer", message: "Subscribe on a test checkout before opening the billing portal." }, 400);
  }
  try {
    const session = await stripeForm(c.env.STRIPE_SECRET_KEY ?? "", "billing_portal/sessions", {
      customer: user.stripe_customer_id,
      return_url: `${originOf(c)}/#/account`,
    });
    if (!session.ok) return c.json({ error: "stripe_error", message: "Stripe did not open the billing portal." }, 502);
    return c.json({ url: session.body.url });
  } catch (error) {
    if (error instanceof StripeConfigError) {
      return c.json({ error: error.code === "live" ? "stripe_live_refused" : "stripe_not_configured", message: error.message }, error.code === "live" ? 400 : 503);
    }
    throw error;
  }
});

api.post("/stripe/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "stripe_not_configured", message: "Set STRIPE_WEBHOOK_SECRET." }, 503);
  const payload = await c.req.text();
  const valid = await verifyStripeSignature(payload, c.req.header("stripe-signature"), secret);
  if (!valid) return c.json({ error: "bad_signature", message: "Stripe signature did not match." }, 400);
  const event = JSON.parse(payload) as { type?: string; data?: { object?: Record<string, unknown> } };
  const object = event.data?.object ?? {};
  if (event.type === "checkout.session.completed") {
    const tier = object.metadata && typeof object.metadata === "object" ? (object.metadata as { tier?: string; user_id?: string }).tier : undefined;
    const userId = object.metadata && typeof object.metadata === "object" ? (object.metadata as { user_id?: string }).user_id : undefined;
    const customer = typeof object.customer === "string" ? object.customer : null;
    const subscription = typeof object.subscription === "string" ? object.subscription : null;
    if (userId && isTier(tier) && tier !== "free") await setTier(c, userId, tier, customer, subscription);
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const status = String(object.status ?? "");
    const customer = typeof object.customer === "string" ? object.customer : null;
    const subscription = typeof object.id === "string" ? object.id : null;
    const priceId = priceIdFromSubscription(object);
    const mapped = priceId
      ? tierForPrice(priceId, { voice: c.env.STRIPE_PRICE_VOICE, live: c.env.STRIPE_PRICE_LIVE, coach: c.env.STRIPE_PRICE_COACH })
      : null;
    const owner = customer
      ? await c.env.DB.prepare(`SELECT id FROM users WHERE stripe_customer_id = ?`).bind(customer).first<{ id: string }>()
      : null;
    if (owner && (event.type === "customer.subscription.deleted" || status === "canceled" || status === "unpaid" || status === "incomplete_expired")) {
      await setTier(c, owner.id, "free", customer, null);
    } else if (owner && mapped && (status === "active" || status === "trialing")) {
      await setTier(c, owner.id, mapped, customer, subscription);
    }
  }
  return c.json({ received: true });
});

api.get("/admin/summary", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  if (!isAdminEmail(c.env.ADMIN_EMAILS, user.email)) {
    return c.json({ error: "forbidden", message: "This desk is for the admin list." }, 403);
  }
  const today = utcDate();
  const start = weekStart();
  const dau = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM activity WHERE usage_date = ?`).bind(today).first<{ n: number }>();
  const minutes = await c.env.DB.prepare(
    `SELECT u.tier AS tier,
            SUM(d.text_seconds) AS text_seconds,
            SUM(d.voice_seconds) AS voice_seconds,
            SUM(d.live_seconds) AS live_seconds,
            COUNT(DISTINCT d.user_id) AS users
     FROM daily_usage d JOIN users u ON u.id = d.user_id
     WHERE d.usage_date = ?
     GROUP BY u.tier`,
  )
    .bind(today)
    .all<{ tier: Tier; text_seconds: number; voice_seconds: number; live_seconds: number; users: number }>();
  const recent = await c.env.DB.prepare(
    `SELECT d.usage_date AS usage_date, u.tier AS tier,
            SUM(d.text_seconds) AS text_seconds,
            SUM(d.voice_seconds) AS voice_seconds,
            SUM(d.live_seconds) AS live_seconds
     FROM daily_usage d JOIN users u ON u.id = d.user_id
     GROUP BY d.usage_date, u.tier
     ORDER BY d.usage_date DESC
     LIMIT 40`,
  ).all();
  const hires = await c.env.DB.prepare(
    `SELECT id, candidate_name, company, role_title, week_start, notes, created_at
     FROM hires ORDER BY created_at DESC LIMIT 20`,
  ).all();
  const leads = await listLeads(c.env.DB, 100);
  const liveSeconds = (minutes.results ?? []).reduce((sum, row) => sum + Number(row.live_seconds ?? 0), 0);
  const rate = liveRateUsd(c.env.LIVE_RATE_USD_PER_MINUTE);
  return c.json({
    date: today,
    weekStart: start,
    dau: dau?.n ?? 0,
    minutesByTier: (minutes.results ?? []).map((row) => ({
      tier: row.tier,
      label: tierLabel(row.tier),
      textMinutes: round1(Number(row.text_seconds) / 60),
      voiceMinutes: round1(Number(row.voice_seconds) / 60),
      liveMinutes: round1(Number(row.live_seconds) / 60),
      users: row.users,
    })),
    recentDays: recent.results ?? [],
    liveCostEstimateUsd: rate > 0 ? round2((liveSeconds / 60) * rate) : 0,
    rateNote: rate > 0
      ? `Live minutes are estimated at $${rate} per minute. Text and speech synthesis are outside this meter.`
      : "Set LIVE_RATE_USD_PER_MINUTE to your provider's per-minute rate to estimate live-voice cost.",
    hires: hires.results ?? [],
    leads: leads.map(publicLead),
  });
});

api.get("/admin/leads.csv", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  if (!isAdminEmail(c.env.ADMIN_EMAILS, user.email)) {
    return c.json({ error: "forbidden", message: "This desk is for the admin list." }, 403);
  }
  const leads = await listLeads(c.env.DB, 5000);
  const header = ["first_name", "email", "role", "linkedin", "consent", "session_avg", "source", "created_at"];
  const lines = [
    header.join(","),
    ...leads.map((lead) =>
      [lead.first_name, lead.email, lead.role, lead.linkedin ?? "", lead.consent ? "yes" : "no", lead.session_avg ?? "", lead.source, lead.created_at]
        .map(csvCell)
        .join(","),
    ),
  ];
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"hire-me-leads.csv\"",
    },
  });
});

api.post("/admin/hires", async (c) => {
  const user = await requireUser(c);
  if (isResponse(user)) return user;
  if (!isAdminEmail(c.env.ADMIN_EMAILS, user.email)) {
    return c.json({ error: "forbidden", message: "This desk is for the admin list." }, 403);
  }
  const body = await readJson<{ candidateName?: string; company?: string; roleTitle?: string; weekStart?: string; notes?: string }>(c);
  if (body instanceof Response) return body;
  const candidateName = clip(body.candidateName, 120);
  const company = clip(body.company, 120);
  const roleTitle = clip(body.roleTitle, 160);
  if (!candidateName || !company || !roleTitle) {
    return c.json({ error: "missing_fields", message: "Name, company, and role are required." }, 400);
  }
  const week = /^\d{4}-\d{2}-\d{2}$/.test(body.weekStart ?? "") ? String(body.weekStart) : weekStart();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO hires (id, candidate_name, company, role_title, week_start, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, candidateName, company, roleTitle, week, clip(body.notes, 500) || null, now)
    .run();
  return c.json({ id, candidateName, company, roleTitle, weekStart: week, createdAt: now }, 201);
});

interface ProfilePatch {
  targetRole?: string;
  displayName?: string | null;
  targetCompany?: string | null;
  interviewDate?: string | null;
}

interface VoiceReady {
  today: string;
  caps: Caps;
  limits: { text: number; voice: number; live: number };
}

function readProfilePatch(body: ProfilePatch):
  | { ok: true; role?: RoleId; displayName?: string | null; targetCompany?: string | null; interviewDate?: string | null }
  | { ok: false; error: string; message: string } {
  const hasRole = body.targetRole !== undefined;
  const hasName = body.displayName !== undefined;
  const hasCompany = body.targetCompany !== undefined;
  const hasDate = body.interviewDate !== undefined;
  if (!hasRole && !hasName && !hasCompany && !hasDate) {
    return { ok: false, error: "empty_patch", message: "Send a role, a name, a company, or an interview date." };
  }
  let role: RoleId | undefined;
  if (hasRole) {
    if (!isRole(body.targetRole)) {
      return { ok: false, error: "bad_role", message: "Pick Forward Deployed Engineer, AI Engineer, or Solutions Architect." };
    }
    role = body.targetRole;
  }
  const displayName = optionalProfileText(body.displayName, 80);
  if (displayName === "invalid") return { ok: false, error: "bad_name", message: "The name has to be text." };
  const targetCompany = optionalProfileText(body.targetCompany, 120);
  if (targetCompany === "invalid") return { ok: false, error: "bad_company", message: "The company has to be text." };
  let interviewDate: string | null | undefined;
  if (hasDate) {
    const parsed = parseInterviewDate(body.interviewDate);
    if (parsed === "invalid") return { ok: false, error: "bad_date", message: "Interview date has to be YYYY-MM-DD, or blank to clear it." };
    interviewDate = parsed;
  }
  return {
    ok: true,
    role,
    displayName: hasName ? displayName : undefined,
    targetCompany: hasCompany ? targetCompany : undefined,
    interviewDate,
  };
}

function optionalProfileText(value: string | null | undefined, max: number): string | null | "invalid" {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function parseInterviewDate(value: string | null | undefined): string | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "invalid";
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "invalid";
  return value;
}

async function beginVoice(c: AppContext, user: UserRow): Promise<VoiceReady | Response> {
  if (!allows(user.tier, "voice")) {
    return c.json({
      error: "tier_required",
      feature: "voice",
      message: "Voice mock interviews start at the $20 plan. Text coaching is open on Free.",
    }, 403);
  }
  const today = utcDate();
  const caps = parseCaps(c.env);
  const limits = capsForTier(user.tier, caps);
  const usage = await getUsage(c.env.DB, user.id, today);
  if (usage.voice >= limits.voice) return c.json(capBody("voice", usage.voice, limits.voice, user.tier), 402);
  if (!hasApiKey(c.env.LLM_API_KEY)) {
    return c.json({
      error: "model_not_configured",
      message: "Voice coaching is not configured yet. Text coaching is still open.",
    }, 503);
  }
  if (!user.target_role) return c.json({ error: "needs_role", message: "Pick a target role first." }, 400);
  return { today, caps, limits };
}

async function speakCoach(
  c: AppContext,
  user: UserRow,
  ready: VoiceReady,
  candidateText: string | null,
  sttDuration: number,
): Promise<Response> {
  if (!hasApiKey(c.env.LLM_API_KEY)) {
    return c.json({ error: "model_not_configured", message: "Voice coaching is not configured yet." }, 503);
  }
  const profile = coachUser(user);
  const context = await buildCoachContext(c.env.DB, profile, ready.today);
  await ensureCoachSession(c.env.DB, {
    userId: user.id,
    usageDate: ready.today,
    channel: "voice",
    openingWeakSpot: context.lastSessionWeakSpot,
  });
  const historyRows = await c.env.DB.prepare(
    `SELECT user_text, assistant_text FROM (
       SELECT user_text, assistant_text, created_at FROM coaching_turns
       WHERE user_id = ? AND usage_date = ? AND channel = 'voice'
       ORDER BY created_at DESC LIMIT 16
     ) ORDER BY created_at ASC`,
  )
    .bind(user.id, ready.today)
    .all<{ user_text: string | null; assistant_text: string | null }>();
  const history = (historyRows.results ?? []).map((row) => ({ userText: row.user_text, coachText: row.assistant_text }));
  const models = modelsFromEnv(c.env);
  let raw: string;
  try {
    raw = await modelText(
      models.apiBase,
      c.env.LLM_API_KEY,
      models.textModel,
      renderVoiceCoachPrompt(context, "pipeline"),
      coachUserMessage(history, candidateText),
    );
  } catch (error) {
    logEvent("voice_coach_failed", { message: error instanceof Error ? error.message : "failed" });
    return c.json({ error: "coach_failed", message: "Coach did not answer. This turn was not charged." }, 502);
  }
  const turn = parseCoachTurn(raw);
  if (!turn) {
    logEvent("voice_coach_unparsed", {});
    return c.json({ error: "coach_failed", message: "Coach did not return a line. This turn was not charged." }, 502);
  }
  const seconds = voicePipelineSeconds({
    sttDuration,
    spokenChars: turn.spoken.length,
    pauseSeconds: ready.caps.voicePause,
  });
  const room = ready.limits.voice - (await getUsage(c.env.DB, user.id, ready.today)).voice;
  const charge = Math.min(seconds, room);
  if (charge <= 0) return c.json(capBody("voice", ready.limits.voice, ready.limits.voice, user.tier), 402);
  const reserved = await reserve(c.env.DB, user.id, ready.today, "voice", charge, ready.limits.voice);
  if (!reserved.ok) return c.json(capBody("voice", reserved.used, reserved.cap, user.tier), 402);
  let audioBase64: string | null = null;
  if (charge >= seconds) {
    try {
      const audio = await synthesizeSpeech({
        apiBase: models.apiBase,
        apiKey: c.env.LLM_API_KEY,
        voice: models.ttsVoice,
        text: turn.spoken,
      });
      audioBase64 = bytesToBase64(audio);
    } catch (error) {
      logEvent("tts_failed", { message: error instanceof Error ? error.message : "failed" });
    }
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO coaching_turns (id, user_id, usage_date, channel, user_text, assistant_text, score_json, seconds_charged, created_at)
     VALUES (?, ?, ?, 'voice', ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), user.id, ready.today, candidateText, turn.spoken, JSON.stringify(turn), charge, now)
    .run();
  if (turn.structure != null || turn.clarity != null || turn.impact != null || turn.weakSpot) {
    await saveSessionScore(c.env.DB, {
      userId: user.id,
      usageDate: ready.today,
      channel: "voice",
      openingWeakSpot: context.lastSessionWeakSpot,
      structure: turn.structure,
      clarity: turn.clarity,
      impact: turn.impact,
      weakSpot: turn.weakSpot,
    });
    const fresh = await c.env.DB.prepare(
      `SELECT streak_count, streak_last_date, last_weak_spot FROM users WHERE id = ?`,
    )
      .bind(user.id)
      .first<{ streak_count: number; streak_last_date: string | null; last_weak_spot: string | null }>();
    if (fresh) {
      user.streak_count = fresh.streak_count;
      user.streak_last_date = fresh.streak_last_date;
      user.last_weak_spot = fresh.last_weak_spot;
    }
  }
  await touchActivity(c.env.DB, user.id, ready.today);
  return c.json({
    spoken: turn.spoken,
    replayed: false,
    transcript: candidateText,
    structure: turn.structure,
    clarity: turn.clarity,
    impact: turn.impact,
    weakSpot: turn.weakSpot,
    audioBase64,
    contentType: "audio/mpeg",
    pauseMs: ready.caps.voicePause * 1000,
    chargedSeconds: charge,
    truncated: charge < seconds,
    streak: user.streak_count,
    coach: await coachState(c, user, ready.today),
    usage: await usagePayload(c, user),
  });
}

function coachUser(user: UserRow): CoachUser {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    target_company: user.target_company,
    interview_date: user.interview_date,
    last_weak_spot: user.last_weak_spot,
    streak_count: user.streak_count,
    streak_last_date: user.streak_last_date,
    tier: user.tier,
    targetRoleLabel: user.target_role ? ROLES[user.target_role] : "the target role",
  };
}

async function coachState(c: { env: AppEnv }, user: UserRow, today: string) {
  const opening = await resolveOpeningWeakSpot(c.env.DB, user.id, today, user.last_weak_spot);
  const sessions = await listTodaySessions(c.env.DB, user.id, today);
  return coachSummary(opening, sessions, user.interview_date, today);
}

function gate(c: { json: (body: unknown, status: 403) => Response }, user: UserRow, feature: "tracker" | "coach"): Response | null {
  if (allows(user.tier, feature)) return null;
  const message = feature === "tracker"
    ? "The application tracker starts at the $100 plan."
    : "Weekly human coach booking is the $200 plan.";
  return c.json({ error: "tier_required", feature, message }, 403);
}

function capBody(channel: "text" | "voice" | "live", used: number, cap: number, tier: Tier) {
  const label = channel === "text" ? "text coaching" : channel === "voice" ? "voice interviews" : "live voice";
  return {
    error: "daily_cap",
    channel,
    usedSeconds: used,
    capSeconds: cap,
    message: tier === "free" && channel === "text"
      ? "Today's 10 minutes of text coaching are used. The meter resets at midnight UTC."
      : `Today's ${label} cap is used. The meter resets at midnight UTC.`,
  };
}

function applicationStatus(value: unknown): string {
  const allowed = ["drafted", "sent", "replied", "interview", "offer", "rejected"];
  return typeof value === "string" && allowed.includes(value) ? value : "sent";
}

function autoApplyStub() {
  return {
    error: "not_implemented",
    message: "Auto-apply is not built. It needs Google OAuth verification, and it must never touch LinkedIn or any job board that bans automation.",
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function leadScore(value: unknown, source: LeadSource): number | null | Response {
  if (value === null || value === undefined || value === "") {
    if (source === "voice-taste") return null;
    return Response.json({ error: "bad_score", message: "Finish the three questions before saving the score." }, { status: 400 });
  }
  const score = Number(value);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    return Response.json({ error: "bad_score", message: "Finish the three questions before saving the score." }, { status: 400 });
  }
  return Math.round(score * 10) / 10;
}

function publicLead(lead: {
  id: string;
  first_name: string;
  email: string;
  role: string;
  linkedin: string | null;
  consent: number;
  session_avg: number | null;
  source: string;
  created_at: string;
}) {
  return {
    id: lead.id,
    firstName: lead.first_name,
    email: lead.email,
    role: lead.role,
    linkedin: lead.linkedin,
    consent: lead.consent === 1,
    sessionAvg: lead.session_avg,
    source: lead.source,
    createdAt: lead.created_at,
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function publicQuestion(question: TryQuestion) {
  return {
    role: question.role,
    roleLabel: question.roleLabel,
    taskId: question.taskId,
    title: question.title,
    prompt: question.prompt,
  };
}

async function scoreTry(c: AppContext, question: TryQuestion, answer: string): Promise<Feedback> {
  if (!hasApiKey(c.env.LLM_API_KEY)) return offlineFeedback(answer, question.prompt);
  const failures: { reason: string; status: number | null }[] = [];
  let tokens = TRY_MAX_OUTPUT_TOKENS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await scoreWithModel({
        apiBase: modelsFromEnv(c.env).apiBase,
        apiKey: c.env.LLM_API_KEY,
        model: modelsFromEnv(c.env).textModel,
        roleLabel: question.roleLabel,
        prompt: question.prompt,
        answer,
        history: "",
        maxOutputTokens: tokens,
        json: true,
      });
    } catch (error) {
      const reason = error instanceof ModelCallError ? error.reason : "parse";
      const status = error instanceof ModelCallError ? error.status ?? null : null;
      failures.push({ reason, status });
      if (reason === "truncated") tokens = TRY_RETRY_OUTPUT_TOKENS;
    }
  }
  const last = failures[failures.length - 1];
  logEvent("try_score_failed", { reason: last?.reason ?? "parse", status: last?.status ?? null, attempts: failures.length });
  return offlineFeedback(answer, question.prompt);
}

function offlineMakeover(headline: string, resume: string, roleLabel: string) {
  const lines = resume.split(/\n+/).map((line) => line.replace(/^[\s\-*•]+/, "").trim()).filter(Boolean).slice(0, 4);
  const bullets = (lines.length ? lines : [resume]).map((line) => {
    const trimmed = line.replace(/^(i|we)\s+/i, "").trim();
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  });
  return {
    headlines: [
      `${roleLabel} who ships the first production month, not the slide.`,
      headline ? headline.slice(0, 120) : `${roleLabel}. Clear stories, measured results.`,
      `${roleLabel} · customer systems, written decisions, a number on the result.`,
    ],
    bullets,
    notes: "Offline pass: headlines point at the role, bullets keep your lines.",
  };
}

async function mePayload(c: { env: AppEnv }, user: UserRow) {
  return {
    user: publicUser(user, c.env.ADMIN_EMAILS),
    usage: await usagePayload(c, user),
    roles: ROLES,
  };
}

async function usagePayload(c: { env: AppEnv }, user: UserRow) {
  const caps = parseCaps(c.env);
  const limits = capsForTier(user.tier, caps);
  const usage = await getUsage(c.env.DB, user.id, utcDate());
  return {
    date: utcDate(),
    text: { usedSeconds: usage.text, capSeconds: limits.text, unlimited: user.tier !== "free" },
    voice: { usedSeconds: usage.voice, capSeconds: limits.voice, included: allows(user.tier, "voice") },
    live: { usedSeconds: usage.live, capSeconds: limits.live, included: allows(user.tier, "live") },
    pauseMs: caps.voicePause * 1000,
  };
}

interface Assignment {
  id: string;
  status: string;
  prompt: string;
  title: string;
  kind: string;
  answer_text: string | null;
  score_json: string | null;
}

async function ensureAssignment(c: { env: AppEnv }, user: UserRow, today: string): Promise<Assignment> {
  const existing = await loadAssignment(c, user.id, today);
  if (existing) return existing;
  const role = user.target_role ?? "fde";
  const tasks = await c.env.DB.prepare(`SELECT id FROM tasks WHERE role = ? ORDER BY id`).bind(role).all<{ id: string }>();
  const ids = (tasks.results ?? []).map((row) => row.id);
  if (ids.length === 0) throw new Error("no tasks seeded");
  const index = await stableIndex(`${user.id}:${today}`, ids.length);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO daily_assignments (id, user_id, usage_date, task_id, status) VALUES (?, ?, ?, ?, 'pending')
     ON CONFLICT (user_id, usage_date) DO NOTHING`,
  )
    .bind(id, user.id, today, ids[index])
    .run();
  const created = await loadAssignment(c, user.id, today);
  if (!created) throw new Error("assignment missing");
  return created;
}

async function loadAssignment(c: { env: AppEnv }, userId: string, today: string): Promise<Assignment | null> {
  return c.env.DB.prepare(
    `SELECT a.id, a.status, a.answer_text, a.score_json, t.prompt, t.title, t.kind
     FROM daily_assignments a JOIN tasks t ON t.id = a.task_id
     WHERE a.user_id = ? AND a.usage_date = ?`,
  )
    .bind(userId, today)
    .first<Assignment>();
}

async function stableIndex(key: string, modulo: number): Promise<number> {
  const hex = await sha256Hex(key);
  return Number(BigInt(`0x${hex.slice(0, 12)}`) % BigInt(modulo));
}

async function scoreAnswer(c: { env: AppEnv }, user: UserRow, prompt: string, answer: string, today: string): Promise<Feedback> {
  if (!hasApiKey(c.env.LLM_API_KEY)) return offlineFeedback(answer, prompt);
  const historyRows = await c.env.DB.prepare(
    `SELECT user_text, assistant_text FROM coaching_turns WHERE user_id = ? AND usage_date = ? ORDER BY created_at DESC LIMIT 4`,
  )
    .bind(user.id, today)
    .all<{ user_text: string | null; assistant_text: string | null }>();
  const history = (historyRows.results ?? [])
    .reverse()
    .map((row) => `Them: ${row.user_text ?? ""}\nCoach: ${row.assistant_text ?? ""}`)
    .join("\n");
  const models = modelsFromEnv(c.env);
  const feedback = await scoreWithModel({
    apiBase: models.apiBase,
    apiKey: c.env.LLM_API_KEY,
    model: models.textModel,
    roleLabel: user.target_role ? ROLES[user.target_role] : "the target role",
    prompt,
    answer,
    history,
  });
  return normalizeFeedback(feedback, "model") ?? feedback;
}

async function setTier(
  c: { env: AppEnv },
  userId: string,
  tier: Tier,
  customer: string | null,
  subscription: string | null,
): Promise<void> {
  const firstPick = tier === "coach" ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE users
     SET tier = ?, first_pick = ?, stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_subscription_id = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(tier, firstPick, customer, subscription, new Date().toISOString(), userId)
    .run();
  logEvent("tier_set", { userId, tier, firstPick });
}

function priceIdFromSubscription(object: Record<string, unknown>): string | null {
  const items = object.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
  return items?.data?.[0]?.price?.id ?? null;
}

export { api };
