import { startLive } from "./live.js";
import { startVoiceTaste } from "./voice-taste.js";

const ROLES = [
  { id: "fde", title: "Forward Deployed Engineer", line: "Customer systems, go-lives, the first month in production." },
  { id: "ai_engineer", title: "AI Engineer", line: "Models, evals, and the incident after launch." },
  { id: "solutions_architect", title: "Solutions Architect", line: "The technical win, the security review, the plan a buyer can forward." },
];

const TRY_ROLES = [
  { id: "ai_engineer", label: "AI Engineer" },
  { id: "fde", label: "FDE" },
  { id: "data_engineer", label: "Data Engineer" },
];

const LINKEDIN_PREFIX = "https://linkedin.com/in/";

const DEFAULT_BRAND = {
  name: "No BS AI",
  headline: "Get hired as a Forward Deployed Engineer.",
  trust: "Built by No BS AI. Placement through DeployedX.",
  coach: "Coach from Hire Me",
  product: "Hire Me",
  byline: "Free FDE coaching",
  placement: "Placement through DeployedX is a separate path. The $200 plan is a weekly human coach and first pick of the sample roles.",
  demoInboxes: [],
};

const state = {
  me: null,
  today: null,
  route: "home",
  error: "",
  notice: "",
  feedback: null,
  transcript: "",
  coachSpoken: "",
  busy: false,
  startedAt: Date.now(),
  live: null,
  captions: "",
  liveStatus: "",
  tryRole: "",
  tryQuestions: [],
  tryStep: 0,
  tryScores: [],
  tryAnswer: "",
  tryRemaining: 9,
  tryError: "",
  tryBusy: false,
  tryLead: null,
  leadEmail: "",
  leadDraft: null,
  voicePhase: "loading",
  voiceReason: "ready",
  voiceError: "",
  voiceRole: "",
  voiceBusy: false,
  voiceLive: null,
  voiceLeft: 180,
  voiceExpiresAt: 0,
  voiceTimer: null,
  voiceCaption: "",
  voiceStatus: "",
  voiceHeard: false,
  voiceSummary: null,
  voiceLead: null,
  voiceStream: null,
  voiceAudio: null,
  brand: { ...DEFAULT_BRAND },
};

const app = document.querySelector("#app");

document.addEventListener("focusin", onFieldFocus);

boot().catch((error) => {
  app.innerHTML = `<main class="stage"><p class="banner bad">${esc(error.message)}</p></main>`;
});

async function boot() {
  state.brand = { ...DEFAULT_BRAND, ...(await api("/api/brand").catch(() => ({}))) };
  document.title = `${state.brand.name} | ${state.brand.headline.replace(/\.$/, "")}`;
  const description = document.querySelector('meta[name="description"]');
  if (description) {
    description.setAttribute("content", `${state.brand.headline} Free daily coaching from ${state.brand.name}. Talk to ${state.brand.coach} for three minutes, no install.`);
  }
  const billing = new URLSearchParams(location.search).get("billing");
  if (billing === "success") state.notice = "Checkout came back. The plan updates when the Stripe test webhook lands.";
  if (billing === "cancel") state.notice = "Checkout cancelled. Your plan is unchanged.";
  if (billing) history.replaceState(null, "", `/${location.hash}`);
  state.me = await api("/api/me").catch(() => null);
  state.route = guarded(routeFromHash());
  render();
  await loadRoute();
}

window.addEventListener("hashchange", () => {
  dropVoice();
  state.error = "";
  state.feedback = null;
  state.coachSpoken = "";
  state.route = guarded(routeFromHash());
  render();
  window.scrollTo(0, 0);
  void loadRoute();
});

function routeFromHash() {
  const hash = location.hash.replace(/^#\/?/, "").split("?")[0];
  if (hash) return hash;
  return state.me ? "today" : "home";
}

function signinEmail() {
  const query = location.hash.split("?")[1] ?? "";
  return new URLSearchParams(query).get("email") || state.leadEmail || "";
}

function guarded(route) {
  if (!state.me) return ["home", "signin", "path"].includes(route) ? route : "home";
  if (route === "signin" || route === "home") return state.me.user.targetRole ? "today" : "role";
  if (!state.me.user.targetRole && !["role", "path", "account"].includes(route)) return "role";
  return route;
}

async function loadRoute() {
  if (state.route === "home") {
    await Promise.all([loadTryQuestion(state.tryRole), loadVoiceStatus()]);
    return;
  }
  if (!state.me) return;
  if (state.route === "today" || state.route === "practice") {
    state.today = await api("/api/today").catch((error) => {
      state.error = error.message;
      return null;
    });
    state.startedAt = Date.now();
    render();
  }
}

function render() {
  if (state.live || state.voiceLive) return;
  app.innerHTML = `${nav()}${stage()}`;
  bind();
}

function nav() {
  if (!state.me) return "";
  const items = [
    ["today", "Today"],
    ["practice", "Practice"],
    ["path", "Path"],
    ["account", "You"],
  ];
  return `<nav class="nav">${items
    .map(([id, label]) => `<a href="#/${id}" class="${state.route === id ? "active" : ""}"><strong>${label}</strong></a>`)
    .join("")}</nav>`;
}

function stage() {
  const body = views[state.route] ? views[state.route]() : views.today();
  const guest = !state.me;
  return `<main class="stage ${guest ? "guest" : ""}">
    <header class="topbar">
      <div>
        <a class="wordmark" href="#/"><i></i>${esc(state.brand.name)}</a>
        <div class="byline">${esc(state.brand.byline)}</div>
      </div>
      ${guest ? `<a class="btn accent header-cta" href="#/signin">Sign in / Start free</a>` : ""}
    </header>
    ${state.notice ? `<p class="banner good">${esc(state.notice)}</p>` : ""}
    ${state.error ? `<p class="banner bad">${esc(state.error)}</p>` : ""}
    ${body}
  </main>`;
}

const views = {
  home() {
    return `${voiceHome()}${dailyPitch()}`;
  },
  signin() {
    return `<section class="stack">
      <p class="kicker">Sign in or start free</p>
      <h1>Same email either way.</h1>
      <p class="lede">One field starts a free account or opens the one you already have. We'll send a magic link. No password.</p>
      <form id="signin" class="stack">
        <label>Email<input name="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@company.com" value="${esc(signinEmail())}" /></label>
        <button class="btn accent full" type="submit">Email me a link</button>
      </form>
      ${demoInboxLine()}
      <p><a href="#/">Back to the homepage</a></p>
      <div id="magic"></div>
    </section>`;
  },
  role() {
    return `<section class="stack">
      <p class="kicker">Target role</p>
      <h1>What are you hiring for?</h1>
      <p class="lede">The brief, the stories, and the DeployedX seats follow this choice. You can change it later.</p>
      <div class="choices" id="roles">
        ${ROLES.map((role) => `<button class="choice" data-role="${role.id}" type="button"><strong>${esc(role.title)}</strong><small>${esc(role.line)}</small></button>`).join("")}
      </div>
    </section>`;
  },
  today() {
    if (!state.today) return `<p class="muted">Opening today's brief…</p>`;
    if (state.today.needsRole) return views.role();
    const task = state.today.assignment;
    const usage = state.me.usage;
    return `<section class="stack">
      <p class="kicker">${esc(state.today.roleLabel)} · ${esc(formatDate(state.today.date))}</p>
      <h1>${state.today.streak ? `Day ${state.today.streak}.` : "Start the streak."}</h1>
      ${meters(usage)}
      <article class="brief">
        <p class="kicker">${task.kind === "action" ? "Today's action" : "Today's question"}</p>
        <h2>${esc(task.title)}</h2>
        <p>${esc(task.prompt)}</p>
      </article>
      ${task.status === "completed" ? `<p class="banner good">Answered today. The streak is set. Practice again if you want another pass.</p>` : ""}
      <a class="btn accent full" href="#/practice">Answer the brief</a>
      <div class="row">
        <a class="ghost" href="#/makeover">Headline makeover</a>
        <a class="ghost" href="#/tracker">${state.today.tracker ? `Applications · ${state.today.applicationsSentToday}` : "Application tracker"}</a>
      </div>
    </section>`;
  },
  practice() {
    const task = state.today?.assignment;
    if (!task) return `<p class="muted">Loading the brief…</p>`;
    const tier = state.me.user.tier;
    const voice = state.me.usage.voice.included;
    const live = state.me.usage.live.included;
    return `<section class="stack">
      <p class="kicker">${esc(task.title)}</p>
      <h2>${esc(task.prompt)}</h2>
      <form id="answer" class="stack">
        <label>Say it in writing<textarea name="answer" placeholder="Situation, what you did, the result.">${esc(state.transcript)}</textarea></label>
        <button class="btn accent full" type="submit">Score this answer</button>
      </form>
      <div id="score">${state.feedback ? scoreCard(state.feedback) : ""}</div>
      <section class="card stack">
        <h2>Voice coach, $20</h2>
        <p class="muted">Same coach script as live voice: warm open, two questions, scores, a close. The 10-minute outline is pacing. ${voice ? `${clock(left(state.me.usage.voice))} of the server cap left today.` : "Locked on the free plan."}</p>
        ${coachBrief()}
        ${voice ? `<button class="btn full" id="coach-open" type="button">Start the coach</button><button class="btn full" id="record" type="button">Answer out loud</button><p id="voice-status" class="muted"></p>` : `<a class="ghost" href="#/path">Unlock voice</a>`}
      </section>
      <section class="card stack">
        <h2>Live voice, $100</h2>
        <p class="muted">The same script, speech-to-speech. The Worker closes the socket when today's live minutes are gone. ${live ? `${clock(left(state.me.usage.live))} left today.` : "Locked below the $100 plan."}</p>
        ${live ? `<button class="btn full" id="live" type="button">Start live mock</button>` : `<a class="ghost" href="#/path">Unlock live voice</a>`}
        <div id="live-panel"></div>
      </section>
      ${tier === "free" ? `<p class="muted">Free is 10 minutes of text a day, enforced on the server.</p>` : ""}
    </section>`;
  },
  makeover() {
    return `<section class="stack">
      <p class="kicker">The hook</p>
      <h1>Headline, then the bullets.</h1>
      <p class="lede">Free on every plan. It spends text minutes. Coach will not invent employers or numbers you did not write.</p>
      <form id="makeover" class="stack">
        <label>Current headline<input name="headline" maxlength="220" value="${esc(state.me?.user.headline ?? "")}" /></label>
        <label>Resume lines<textarea name="resume" placeholder="Paste the bullets you actually earned."></textarea></label>
        <button class="btn accent full" type="submit">Make it over</button>
      </form>
      <div id="makeover-out"></div>
    </section>`;
  },
  tracker() {
    if (!["live", "coach"].includes(state.me.user.tier)) {
      return `<section class="stack"><p class="kicker">$100</p><h1>The tracker is locked.</h1><p class="lede">Companies, status, and notes start on the Live plan. Until then, write the application as today's action.</p><a class="btn" href="#/path">See the $100 plan</a></section>`;
    }
    return `<section class="stack" id="tracker-root"><p class="muted">Loading the tracker…</p></section>`;
  },
  path() {
    const tier = state.me?.user.tier ?? "free";
    const plans = [
      ["coach", "$200", "Coach", ["Everything in Live.", "Book a weekly human coach.", "First pick of DeployedX roles."]],
      ["live", "$100", "Live", ["Unlimited text, with a safety ceiling.", "At least 10 minutes of live voice.", "The cheaper voice pipeline too.", "Application tracker."]],
      ["voice", "$20", "Voice", ["Unlimited text, with a safety ceiling.", "At least 10 minutes of voice mocks: speech-to-text, Coach, a short pause, text-to-speech."]],
      ["free", "$0", "Free", ["10 minutes of text coaching a day.", "The daily brief and the streak.", "One resume and headline makeover."]],
    ];
    return `<section class="stack">
      <p class="kicker">The ladder</p>
      <h1>Climb it on purpose.</h1>
      <div class="ladder">
        <article class="rung top">
          <p class="kicker">Top rung</p>
          <h2>Placement through DeployedX</h2>
          <p>${esc(state.brand.placement)}</p>
          <a class="ghost" href="#/roles">See the sample seats</a>
        </article>
        ${plans.map(([id, price, name, points]) => `<article class="rung">
          <div class="row"><span class="price">${price}</span>${tier === id ? `<span class="tag">Current plan</span>` : ""}</div>
          <h2>${name}</h2>
          <ul>${points.map((point) => `<li>${esc(point)}</li>`).join("")}</ul>
          ${id === "free" || !state.me ? "" : tier === id ? "" : rank(tier) > rank(id) ? `<span class="tag">Included</span>` : `<button class="btn" type="button" data-checkout="${id}">Subscribe in test mode</button>`}
        </article>`).join("")}
      </div>
      <p class="muted">Stripe stays in test mode. Use card 4242 4242 4242 4242. Live keys are refused.</p>
    </section>`;
  },
  account() {
    const user = state.me.user;
    const usage = state.me.usage;
    return `<section class="stack">
      <p class="kicker">${esc(user.email)}</p>
      <h1>${esc(user.name || labelFor(user.targetRole) || "No role yet")}</h1>
      <p>${esc(planName(user.tier))}${user.firstPick ? " · First pick of DeployedX roles" : ""}</p>
      <form id="profile" class="stack">
        <label>Name the coach uses<input name="displayName" maxlength="80" value="${esc(user.displayName || "")}" placeholder="${esc(user.name || "Your name")}" /></label>
        <label>Target company<input name="targetCompany" maxlength="120" value="${esc(user.targetCompany || "")}" placeholder="Optional" /></label>
        <label>Interview date<input name="interviewDate" type="date" value="${esc(user.interviewDate || "")}" /></label>
        <button class="btn full" type="submit">Save for the coach</button>
      </form>
      ${user.lastWeakSpot ? `<p>Next drill on file: ${esc(user.lastWeakSpot)}.</p>` : ""}
      ${meters(usage)}
      <div class="row">
        <a class="ghost" href="#/role">Change role</a>
        <a class="ghost" href="#/coach">Human coach</a>
        <a class="ghost" href="#/roles">DeployedX seats</a>
        ${user.isAdmin ? `<a class="ghost" href="#/admin">Admin</a>` : ""}
      </div>
      <button class="ghost" id="portal" type="button">Billing portal</button>
      <button class="ghost" id="logout" type="button">Sign out</button>
    </section>`;
  },
  coach() {
    if (state.me.user.tier !== "coach") {
      return `<section class="stack"><p class="kicker">$200</p><h1>The human coach is the top paid rung.</h1><p class="lede">A weekly human coach, plus first pick of the sample roles. ${esc(state.brand.trust)}</p><a class="btn" href="#/path">See the $200 plan</a></section>`;
    }
    return `<section class="stack" id="coach-root">
      <p class="kicker">$200</p>
      <h1>A weekly human slot.</h1>
      <p class="lede">This is a request, not a calendar. A person confirms the slot. Nothing is booked automatically.</p>
      <form id="coach" class="stack">
        <label>Focus<input name="focus" placeholder="A production-incident story" /></label>
        <label>Times that work<textarea name="preferredTimes" placeholder="Tue or Thu, morning PT"></textarea></label>
        <label>Notes<textarea name="notes"></textarea></label>
        <button class="btn accent full" type="submit">Request the slot</button>
      </form>
      <div id="coach-list"></div>
    </section>`;
  },
  roles() {
    return `<section class="stack" id="roles-root"><p class="muted">Loading seats…</p></section>`;
  },
  admin() {
    return `<section class="stack" id="admin-root"><p class="muted">Opening the desk…</p></section>`;
  },
};

function dailyPitch() {
  return `<section class="stack hero quiet">
    <p class="kicker">Then keep the streak</p>
    <h2>Ten honest minutes, every day.</h2>
    <p class="lede">One brief a day for Forward Deployed Engineer, AI Engineer, and Solutions Architect candidates. Answer it. Get scored. Keep the streak.</p>
    <a class="btn accent hero-cta" href="#/signin">Start free</a>
    <p><a href="#/path">See the ladder</a></p>
  </section>`;
}

function voiceHome() {
  if (state.voicePhase === "summary") return voiceSummaryCard();
  if (state.voicePhase === "text") {
    return `${voiceNote()}${tryWidget()}`;
  }
  return voiceWidget();
}

function voiceNote() {
  const message = state.voiceError || (state.voiceReason === "ready" ? "" : voiceReasonCopy(state.voiceReason));
  const retry = state.voiceReason === "ready"
    ? `<p><button class="ghost" id="talk-again" type="button">Talk to Coach</button></p>`
    : "";
  if (!message && !retry) return "";
  const tone = /denied|no microphone|isn't available|spots are full|already talked/i.test(message) ? "bad" : "";
  return `${message ? `<p class="banner ${tone}">${esc(message)}</p>` : ""}${retry}`;
}

function voiceReasonCopy(reason) {
  if (reason === "used") return "You've already talked with Coach today. Type the three questions, or start free.";
  if (reason === "full") return "Today's free voice spots are full. Type the three questions instead.";
  if (reason === "offline") return "Voice isn't available right now. Type your answers instead.";
  return "";
}

function voiceWidget() {
  if (state.voicePhase === "roles") {
    return `<section class="card stack voice-hero" id="talk-coach">
      <p class="kicker">Talk to Coach</p>
      <h1>Which seat?</h1>
      <p class="lede">Coach asks one question, scores it, and follows up. Three minutes.</p>
      <div class="chips" role="group" aria-label="Role">
        ${TRY_ROLES.map((role) => `<button class="chip ${state.voiceRole === role.id ? "active" : ""}" type="button" data-voice-role="${role.id}" aria-pressed="${state.voiceRole === role.id}" ${state.voiceBusy ? "disabled" : ""}>${esc(role.label)}</button>`).join("")}
      </div>
      ${state.voiceBusy ? `<p class="muted" id="voice-status" role="status">Connecting…</p>` : ""}
      <button class="ghost" id="type-instead" type="button">Type instead</button>
    </section>`;
  }
  if (state.voicePhase === "live") {
    return `<section class="card stack voice-hero" id="talk-coach">
      <p class="kicker">Talk to Coach</p>
      <p class="clock" id="voice-clock" aria-live="polite">${clock(state.voiceLeft)}</p>
      <button class="mic live" id="voice-end" type="button" aria-label="End the session">End</button>
      <p class="lede" id="voice-caption">${esc(state.voiceCaption)}</p>
      <p class="muted" id="voice-status" role="status">${esc(state.voiceStatus || "Connecting…")}</p>
    </section>`;
  }
  return `<section class="stack voice-hero" id="talk-coach">
    <p class="kicker">${esc(state.brand.coach)}</p>
    <h1>${esc(state.brand.headline)}</h1>
    <p class="lede">Free voice-first coaching from ${esc(state.brand.name)}. Practice the interview out loud.</p>
    <button class="mic ${state.voicePhase === "loading" ? "" : "pulse"}" id="talk" type="button" ${state.voicePhase === "loading" ? "disabled" : ""}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
      <span>${state.voicePhase === "loading" ? "One moment" : "Talk to Coach"}</span>
    </button>
    <p class="lede">Tap, allow the mic, and pick a role. Three minutes of a live mock interview.</p>
    <button class="ghost" id="type-instead" type="button">Type instead</button>
    <a class="btn full" href="#/signin">Start free coaching</a>
    <p class="muted">${esc(state.brand.trust)}</p>
  </section>`;
}

function voiceSummaryCard() {
  const summary = state.voiceSummary ?? {
    overall: null,
    bestMoment: "",
    fix: "",
    short: true,
    note: "Talk a bit longer to get a score",
  };
  const scored = summary.overall != null && summary.bestMoment && summary.fix;
  const detail = scored
    ? `<div class="scores"><div><b>${esc(String(summary.overall))}</b><span>overall</span></div></div>
    <p><strong>Best moment.</strong> ${esc(summary.bestMoment)}</p>
    <p><strong>One thing to fix.</strong> ${esc(summary.fix)}</p>`
    : `<p class="lede">${esc(summary.note || "Talk a bit longer to get a score")}</p>`;
  return `<section class="card stack voice-hero" id="talk-coach">
    <p class="kicker">Talk to Coach</p>
    <h2>Streak: Day 1</h2>
    ${detail}
    ${state.voiceError ? `<p class="banner bad">${esc(state.voiceError)}</p>` : ""}
    ${leadForm("voice-taste", state.voiceLead, state.voiceRole || state.tryRole)}
  </section>`;
}

function leadForm(source, saved, role) {
  const email = saved?.email || "";
  const draft = state.leadDraft ?? {};
  if (saved) {
    return `<div class="stack">
      <p class="banner good">You're in. Start free to keep your streak.</p>
      <a class="btn accent full" href="#/signin?email=${encodeURIComponent(email)}">Start free coaching</a>
    </div>`;
  }
  return `<form id="lead" class="stack" data-source="${source}">
    <h2>Save your score and get tomorrow's question.</h2>
    <label>First name<input name="firstName" maxlength="80" inputmode="text" autocomplete="given-name" required value="${esc(draft.firstName ?? "")}" /></label>
    <label>Email<input name="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@company.com" value="${esc(draft.email ?? "")}" /></label>
    <label>Target role<select name="role">${TRY_ROLES.map((item) => `<option value="${item.id}" ${(draft.role || role) === item.id ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select></label>
    <label>LinkedIn URL<input name="linkedin" type="url" inputmode="url" autocomplete="url" spellcheck="false" value="${esc(draft.linkedin || LINKEDIN_PREFIX)}" /></label>
    <label class="consent"><input name="consent" type="checkbox" ${draft.consent ? "checked" : ""} /> <span>Email me one practice question a day. Unsubscribe anytime.</span></label>
    <button class="btn accent full" type="submit">Save my score</button>
  </form>`;
}

function tryRoleLabel(role) {
  return TRY_ROLES.find((item) => item.id === role)?.label ?? role;
}

function sessionsLeft(remaining) {
  if (remaining <= 0) return "No free sessions left today.";
  const sessions = Math.ceil(remaining / 3);
  return `${sessions} free ${sessions === 1 ? "session" : "sessions"} left today.`;
}

function trySummary(scores) {
  const avg = Math.round((scores.reduce((sum, item) => sum + Number(item.score), 0) / scores.length) * 10) / 10;
  const weakest = scores.reduce((low, item) => (Number(item.score) < Number(low.score) ? item : low));
  return { avg, fix: weakest.fix };
}

function tryWidget() {
  const questions = state.tryQuestions;
  const total = questions.length || 3;
  const done = state.tryScores.length >= total && total > 0;
  const step = Math.min(state.tryStep, Math.max(total - 1, 0));
  const question = questions[step];
  const scored = state.tryScores[step];
  const shown = done ? total : Math.min(step + 1, total);
  const width = done ? 100 : Math.round((shown / total) * 100);
  return `<section class="card stack try" id="try-coach">
    <p class="kicker">Try Coach</p>
    <h2>Today's session.</h2>
    <p class="muted">Three short questions from ${esc(state.brand.coach)}. No account for this taste. Three free sessions a day.</p>
    <div class="chips" role="group" aria-label="Role">
      ${TRY_ROLES.map((role) => `<button class="chip ${state.tryRole === role.id ? "active" : ""}" type="button" data-try-role="${role.id}" aria-pressed="${state.tryRole === role.id}" ${state.tryBusy ? "disabled" : ""}>${esc(role.label)}</button>`).join("")}
    </div>
    <div class="meter" aria-label="Session progress">
      <div class="row"><span>Question ${shown} of ${total}</span><span class="muted">${sessionsLeft(state.tryRemaining)}</span></div>
      <div class="track"><div class="fill" style="width:${width}%"></div></div>
    </div>
    ${!done && question ? `<article class="brief"><p class="kicker">${esc(question.title)}</p><p>${esc(question.prompt)}</p></article>` : ""}
    ${!questions.length && !state.tryError ? `<p class="muted">Pulling today's three questions…</p>` : ""}
    ${state.tryError ? `<p class="banner bad">${esc(state.tryError)}</p>` : ""}
    ${!done && question && !scored ? `<form id="try" class="stack">
      <label>Your answer<textarea id="try-answer" name="answer" maxlength="1200" placeholder="Situation, what you did, the result." ${state.tryRemaining <= 0 ? "disabled" : ""}>${esc(state.tryAnswer)}</textarea></label>
      <div class="row"><span class="muted" id="try-count">${state.tryAnswer.length} / 1,200</span></div>
      <button class="btn accent full" type="submit" ${state.tryRemaining <= 0 || state.tryBusy ? "disabled" : ""}>${state.tryBusy ? "Coach is reading it…" : "Get my score"}</button>
    </form>` : ""}
    ${scored ? tryScore(scored) : ""}
    ${!done && scored ? `<button class="btn full" id="try-next" type="button">Next question</button>` : ""}
    ${done ? trySummaryCard(trySummary(state.tryScores)) : ""}
    ${state.tryRemaining <= 0 && !done && !scored ? `<a class="btn accent full wrap" href="#/signin">Want 10 minutes of this every day? Start free</a>` : ""}
  </section>`;
}

function tryScore(result) {
  return `<article class="stack">
    <p class="kicker">${result.offline ? "Offline rubric" : "Coach"}</p>
    <div class="scores"><div><b>${esc(result.score)}</b><span>out of 5</span></div></div>
    <p><strong>What worked.</strong> ${esc(result.strength)}</p>
    <p><strong>One fix.</strong> ${esc(result.fix)}</p>
  </article>`;
}

function trySummaryCard(summary) {
  return `<article class="stack summary">
    <p class="kicker">Today's session</p>
    <h2>Your streak: Day 1</h2>
    <div class="scores"><div><b>${esc(Number(summary.avg).toFixed(1))}</b><span>average</span></div></div>
    <p><strong>Work on this.</strong> ${esc(summary.fix)}</p>
  </article>
  ${leadForm("try-coach", state.tryLead, state.tryRole)}`;
}

function bind() {
  document.querySelector("#signin")?.addEventListener("submit", onSignin);
  document.querySelector("#talk")?.addEventListener("click", () => void onTalk());
  document.querySelector("#type-instead")?.addEventListener("click", onTypeInstead);
  document.querySelector("#talk-again")?.addEventListener("click", () => {
    state.voicePhase = "intro";
    state.voiceError = "";
    render();
  });
  document.querySelector("#voice-end")?.addEventListener("click", onVoiceEnd);
  document.querySelectorAll("[data-voice-role]").forEach((button) => button.addEventListener("click", () => void onVoiceRole(button.dataset.voiceRole)));
  document.querySelector("#try")?.addEventListener("submit", onTry);
  document.querySelector("#try-next")?.addEventListener("click", onTryNext);
  document.querySelector("#try-answer")?.addEventListener("input", onTryInput);
  document.querySelector("#lead")?.addEventListener("submit", onLead);
  document.querySelector("#lead input[name=linkedin]")?.addEventListener("paste", onLinkedInPaste);
  document.querySelectorAll("[data-try-role]").forEach((button) => button.addEventListener("click", () => onTryRole(button.dataset.tryRole)));
  document.querySelectorAll("[data-role]").forEach((button) => button.addEventListener("click", () => pickRole(button.dataset.role)));
  document.querySelector("#answer")?.addEventListener("submit", onAnswer);
  document.querySelector("#record")?.addEventListener("click", onRecord);
  document.querySelector("#coach-open")?.addEventListener("click", onCoachOpen);
  document.querySelector("#live")?.addEventListener("click", onLive);
  document.querySelector("#profile")?.addEventListener("submit", onProfile);
  document.querySelector("#makeover")?.addEventListener("submit", onMakeover);
  document.querySelectorAll("[data-checkout]").forEach((button) => button.addEventListener("click", () => checkout(button.dataset.checkout)));
  document.querySelector("#logout")?.addEventListener("click", onLogout);
  document.querySelector("#portal")?.addEventListener("click", onPortal);
  document.querySelector("#coach")?.addEventListener("submit", onCoach);
  if (state.route === "tracker") void loadTracker();
  if (state.route === "roles") void loadRoles();
  if (state.route === "admin") void loadAdmin();
  if (state.route === "coach" && state.me?.user.tier === "coach") void loadCoach();
}

let tryLoad = 0;

async function loadTryQuestion(role) {
  const ticket = ++tryLoad;
  const query = role ? `?role=${encodeURIComponent(role)}` : "";
  try {
    const data = await api(`/api/try${query}`);
    if (ticket !== tryLoad) return;
    const nextIds = (data.questions ?? []).map((item) => item.taskId).join();
    const same = state.tryQuestions.map((item) => item.taskId).join() === nextIds && nextIds.length > 0;
    state.tryQuestions = data.questions ?? [];
    if (!state.voiceRole) state.tryRole = data.role;
    state.tryRemaining = data.remaining;
    if (!same) {
      state.tryStep = 0;
      state.tryScores = [];
      state.tryAnswer = "";
      state.tryLead = null;
    }
    state.tryError = "";
  } catch (error) {
    if (ticket !== tryLoad) return;
    state.tryError = error.message;
  }
  if (state.route === "home" && state.voicePhase !== "live") render();
}

async function loadVoiceStatus() {
  const phase = state.voicePhase;
  try {
    const data = await api("/api/voice-taste/status");
    state.voiceReason = data.reason || "offline";
    if (!state.voiceLive) state.voiceLeft = data.seconds || 180;
    if (phase === "loading") {
      state.voicePhase = data.reason === "used" || data.reason === "full" ? "text" : "intro";
      if (state.voicePhase === "text") state.voiceError = voiceReasonCopy(data.reason);
    }
  } catch {
    if (phase === "loading") {
      state.voiceReason = "offline";
      state.voicePhase = "intro";
    }
  }
  if (state.route === "home" && !state.voiceLive && state.voicePhase !== "live") render();
}

async function onTalk() {
  if (state.voicePhase === "loading") return;
  if (state.voiceReason === "used" || state.voiceReason === "full" || state.voiceReason === "offline") {
    state.voicePhase = "text";
    state.voiceError = voiceReasonCopy(state.voiceReason);
    render();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    state.voicePhase = "text";
    state.voiceError = "This browser has no microphone. Type the three questions instead.";
    render();
    return;
  }
  const audio = unlockAudio();
  state.voiceAudio = audio;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (audio.state === "suspended") await audio.resume();
    state.voiceStream = stream;
    state.voicePhase = "roles";
    state.voiceError = "";
  } catch (error) {
    stopMic();
    state.voicePhase = "text";
    state.voiceError = micErrorMessage(error);
  }
  render();
}

function onTypeInstead() {
  dropVoice();
  state.voicePhase = "text";
  if (!state.voiceError && state.voiceReason !== "ready") state.voiceError = voiceReasonCopy(state.voiceReason);
  render();
}

async function onVoiceRole(role) {
  if (!role || state.voiceBusy || !state.voiceStream) return;
  state.voiceBusy = true;
  state.voiceRole = role;
  state.tryRole = role;
  state.voiceError = "";
  void loadTryQuestion(role);
  render();
  try {
    const session = await api("/api/voice-taste/session", {
      method: "POST",
      body: JSON.stringify({ role }),
    });
    state.voicePhase = "live";
    state.voiceLeft = session.seconds || 180;
    state.voiceExpiresAt = Date.parse(session.expiresAt) || Date.now() + state.voiceLeft * 1000;
    state.voiceCaption = "";
    state.voiceStatus = "Connecting…";
    state.voiceHeard = false;
    state.voiceSummary = null;
    state.voiceBusy = false;
    render();
    startVoiceClock();
    state.voiceLive = startVoiceTaste({
      sessionId: session.sessionId,
      audio: state.voiceAudio,
      stream: state.voiceStream,
      onEvent: onVoiceEvent,
    });
  } catch (error) {
    stopMic();
    clearVoiceClock();
    state.voiceBusy = false;
    state.voiceLive = null;
    state.voicePhase = "text";
    state.voiceError = error.message;
    render();
  }
}

function onVoiceEnd() {
  state.voiceLive?.stop();
}

function onVoiceEvent(payload) {
  const type = String(payload.type ?? "");
  if (type === "hireme.audio" || type === "hireme.caption" || type === "hireme.score" || type === "hireme.ready") {
    state.voiceHeard = true;
  }
  if (type === "hireme.remaining") {
    state.voiceLeft = Number(payload.seconds);
    const clockEl = document.querySelector("#voice-clock");
    if (clockEl) clockEl.textContent = clock(state.voiceLeft);
    return;
  }
  if (type === "hireme.caption" && payload.text && payload.speaker !== "you") {
    state.voiceCaption += payload.text;
    const caption = document.querySelector("#voice-caption");
    if (caption) caption.textContent = state.voiceCaption;
    return;
  }
  if (type === "hireme.score") {
    state.voiceSummary = {
      overall: payload.overall ?? null,
      bestMoment: payload.bestMoment || "",
      fix: payload.fix || "",
      short: false,
      note: "",
    };
    const status = document.querySelector("#voice-status");
    if (status && payload.overall) status.textContent = `Score ${payload.overall} out of 5.`;
    return;
  }
  if (type === "hireme.status" && payload.text) {
    const status = document.querySelector("#voice-status");
    if (status) status.textContent = payload.text;
    return;
  }
  if (type === "hireme.ready") {
    void state.voiceAudio?.resume?.();
    const status = document.querySelector("#voice-status");
    if (status) status.textContent = "Coach is asking. Speak when you hear the question.";
    return;
  }
  if (type === "hireme.error") {
    state.voiceError = payload.message || "Voice dropped.";
    const status = document.querySelector("#voice-status");
    if (status) status.textContent = state.voiceError;
    return;
  }
  if (type === "hireme.done" || type === "hireme.cap") {
    showVoiceSummary(payload);
    return;
  }
  if (type === "hireme.socket_closed") {
    if (state.voicePhase !== "live") return;
    if (state.voiceHeard) showVoiceSummary(payload);
    else {
      const message = state.voiceError || "Voice didn't connect. Type the three questions instead.";
      dropVoice();
      state.voicePhase = "text";
      state.voiceError = message;
      if (state.route === "home") render();
    }
  }
}

function showVoiceSummary(payload) {
  if (state.voicePhase !== "live") return;
  const handle = state.voiceLive;
  state.voiceLive = null;
  clearVoiceClock();
  state.voicePhase = "summary";
  const prior = state.voiceSummary;
  const short = Boolean(payload.short) || (payload.overall == null && !payload.bestMoment);
  state.voiceSummary = {
    overall: short ? null : payload.overall ?? prior?.overall ?? null,
    bestMoment: short ? "" : payload.bestMoment || prior?.bestMoment || "",
    fix: short ? "" : payload.fix || prior?.fix || "",
    short,
    note: payload.note || (short ? "Talk a bit longer to get a score" : ""),
  };
  handle?.stop();
  stopMic();
  if (state.route === "home") render();
}

function startVoiceClock() {
  clearVoiceClock();
  state.voiceTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((state.voiceExpiresAt - Date.now()) / 1000));
    state.voiceLeft = left;
    const clockEl = document.querySelector("#voice-clock");
    if (clockEl) clockEl.textContent = clock(left);
    if (left <= 0) clearVoiceClock();
  }, 250);
}

function clearVoiceClock() {
  if (state.voiceTimer) clearInterval(state.voiceTimer);
  state.voiceTimer = null;
}

function unlockAudio() {
  const audio = new AudioContext();
  const buffer = audio.createBuffer(1, 1, 22050);
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  source.start();
  void audio.resume();
  return audio;
}

function micErrorMessage(error) {
  const name = error?.name || "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Type the three questions instead.";
  }
  return "Microphone access was denied. Type the three questions instead.";
}

function onFieldFocus(event) {
  const field = event.target?.closest?.("input, textarea, select");
  if (!field || field.type === "checkbox" || field.type === "radio") return;
  if (field.name === "linkedin") {
    if (!field.value.trim()) field.value = LINKEDIN_PREFIX;
    placeLinkedInCursor(field);
  }
  window.setTimeout(() => {
    field.scrollIntoView({ block: "center", inline: "nearest" });
  }, 320);
}

function placeLinkedInCursor(field) {
  const place = () => {
    const end = field.value.length;
    try {
      field.setSelectionRange(end, end);
    } catch {
      // Some browsers reject selection changes on a url input before it is laid out.
    }
  };
  place();
  window.setTimeout(place, 0);
}

function onLinkedInPaste(event) {
  const field = event.target;
  const pasted = event.clipboardData?.getData("text") ?? "";
  if (!pasted) return;
  event.preventDefault();
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const next = `${field.value.slice(0, start)}${pasted}${field.value.slice(end)}`;
  field.value = normalizeLinkedIn(next) || LINKEDIN_PREFIX;
  placeLinkedInCursor(field);
}

/** Mirrors linkedinUrl() in src/lib/try.ts. A bare prefix becomes an empty string. */
function normalizeLinkedIn(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const marker = /linkedin\.com\/in\//gi;
  let start = -1;
  for (const match of text.matchAll(marker)) {
    if (match.index != null) start = match.index + match[0].length;
  }
  if (start >= 0) {
    let slug = text.slice(start).split(/[/?#\s]/)[0] ?? "";
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // Keep the raw segment when it is not valid percent-encoding.
    }
    slug = slug.replace(/\/+$/, "");
    if (slug && !/^(https?:?|www\.linkedin\.com|linkedin\.com)$/i.test(slug)) return `${LINKEDIN_PREFIX}${slug}`;
  }
  const bare = text.replace(/\/+$/, "").toLowerCase();
  if (
    bare === "https://linkedin.com/in" ||
    bare === "http://linkedin.com/in" ||
    bare === "https://www.linkedin.com/in" ||
    bare === "http://www.linkedin.com/in" ||
    bare === "www.linkedin.com/in" ||
    bare === "linkedin.com/in"
  ) {
    return "";
  }
  return text;
}

function stopMic() {
  state.voiceStream?.getTracks().forEach((track) => track.stop());
  state.voiceStream = null;
  const audio = state.voiceAudio;
  state.voiceAudio = null;
  if (audio && audio.state !== "closed") void audio.close();
}

function dropVoice() {
  const handle = state.voiceLive;
  state.voiceLive = null;
  if (state.voicePhase === "live" || state.voicePhase === "roles") state.voicePhase = "intro";
  clearVoiceClock();
  handle?.stop();
  stopMic();
}

async function onTryRole(role) {
  if (!role || role === state.tryRole || state.tryBusy) return;
  state.tryRole = role;
  state.tryQuestions = [];
  state.tryStep = 0;
  state.tryScores = [];
  state.tryAnswer = "";
  state.tryLead = null;
  state.tryError = "";
  render();
  await loadTryQuestion(role);
}

function onTryNext() {
  state.tryAnswer = "";
  state.tryError = "";
  state.tryStep += 1;
  render();
}

function onTryInput(event) {
  state.tryAnswer = event.target.value;
  const count = document.querySelector("#try-count");
  if (count) count.textContent = `${state.tryAnswer.length} / 1,200`;
}

async function onTry(event) {
  event.preventDefault();
  const answer = String(new FormData(event.target).get("answer") ?? "");
  state.tryAnswer = answer;
  state.tryBusy = true;
  state.tryError = "";
  render();
  try {
    const question = state.tryQuestions[state.tryStep];
    const result = await api("/api/try", {
      method: "POST",
      body: JSON.stringify({ role: state.tryRole, taskId: question?.taskId, answer }),
    });
    state.tryScores = [...state.tryScores.slice(0, state.tryStep), result];
    state.tryRemaining = result.remaining;
  } catch (error) {
    state.tryError = error.message;
    if (error.status === 429) state.tryRemaining = 0;
  }
  state.tryBusy = false;
  if (state.route === "home") render();
}

async function onLead(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const draft = {
    firstName: String(form.get("firstName") ?? ""),
    email: String(form.get("email") ?? ""),
    role: String(form.get("role") ?? state.tryRole),
    linkedin: normalizeLinkedIn(String(form.get("linkedin") ?? "")),
    consent: form.get("consent") === "on",
  };
  state.leadDraft = draft;
  const source = event.target.dataset.source === "voice-taste" ? "voice-taste" : "try-coach";
  const sessionAvg = source === "voice-taste" ? state.voiceSummary?.overall ?? null : trySummary(state.tryScores).avg;
  const button = event.target.querySelector("button");
  if (button) button.disabled = true;
  state.tryError = "";
  state.voiceError = "";
  try {
    const result = await api("/api/lead", {
      method: "POST",
      body: JSON.stringify({ ...draft, sessionAvg, source }),
    });
    if (source === "voice-taste") state.voiceLead = result;
    else state.tryLead = result;
    state.leadEmail = result.email;
  } catch (error) {
    if (source === "voice-taste") state.voiceError = error.message;
    else state.tryError = error.message;
  }
  if (state.route === "home") render();
}

async function onSignin(event) {
  event.preventDefault();
  const email = new FormData(event.target).get("email");
  try {
    const result = await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email }) });
    const box = document.querySelector("#magic");
    box.innerHTML = result.magicLink
      ? `<p class="banner">Development shows the link here. Nothing was emailed.</p><a class="btn full" href="${esc(result.magicLink)}">Open magic link</a>`
      : `<p class="banner good">${esc(result.message)}</p>`;
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function pickRole(role) {
  try {
    state.me = await api("/api/me", { method: "PATCH", body: JSON.stringify({ targetRole: role }) });
    state.error = "";
    state.route = "today";
    if (location.hash !== "#/today") location.hash = "#/today";
    else {
      render();
      await loadRoute();
    }
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onProfile(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    state.me = await api("/api/me", { method: "PATCH", body: JSON.stringify({
      displayName: form.get("displayName"),
      targetCompany: form.get("targetCompany"),
      interviewDate: form.get("interviewDate"),
    }) });
    state.notice = "Saved. The next coach session uses this.";
    state.error = "";
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onCoachOpen() {
  const status = document.querySelector("#voice-status");
  if (status) status.textContent = "Coach is starting…";
  try {
    const result = await api("/api/interview/voice/open", { method: "POST", body: "{}" });
    state.coachSpoken = result.spoken || "";
    if (result.coach && state.today) state.today.coach = result.coach;
    if (result.streak) state.me.user.streak = result.streak;
    state.me.usage = result.usage;
    if (status) {
      status.textContent = result.replayed ? "This session is already open." : "A short pause.";
      status.className = result.replayed ? "muted" : "pause";
    }
    if (!result.replayed && result.pauseMs) await sleep(result.pauseMs);
    if (result.audioBase64) playBase64(result.audioBase64, result.contentType);
    state.error = "";
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onAnswer(event) {
  event.preventDefault();
  const answer = new FormData(event.target).get("answer");
  const elapsedSeconds = Math.round((Date.now() - state.startedAt) / 1000);
  try {
    const result = await api("/api/today/answer", { method: "POST", body: JSON.stringify({ answer, elapsedSeconds }) });
    state.feedback = result.feedback;
    state.me.usage = result.usage;
    state.me.user.streak = result.streak;
    if (state.today?.assignment) state.today.assignment.status = "completed";
    state.error = "";
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

let recorder;
let recordStream;
async function onRecord(event) {
  const button = event.currentTarget;
  const status = document.querySelector("#voice-status");
  try {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    button.textContent = "Record";
    return;
  }
  recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  recorder = new MediaRecorder(recordStream);
  recorder.ondataavailable = (item) => chunks.push(item.data);
  recorder.onstop = async () => {
    recordStream.getTracks().forEach((track) => track.stop());
    status.textContent = "Transcribing…";
    const form = new FormData();
    form.append("audio", new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), "answer.webm");
    try {
      const result = await api("/api/interview/voice", { method: "POST", body: form });
      state.transcript = result.transcript || state.transcript;
      state.coachSpoken = result.spoken || "";
      if (result.coach && state.today) state.today.coach = result.coach;
      if (result.streak) state.me.user.streak = result.streak;
      state.me.usage = result.usage;
      status.textContent = "A short pause.";
      status.className = "pause";
      await sleep(result.pauseMs);
      if (result.audioBase64) playBase64(result.audioBase64, result.contentType);
      state.error = "";
      render();
    } catch (error) {
      state.error = error.message;
      render();
    }
  };
  recorder.start();
  button.textContent = "Stop";
  status.textContent = "Recording. Stop when the answer is done.";
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Microphone unavailable.";
    render();
  }
}

async function onLive() {
  const panel = document.querySelector("#live-panel");
  try {
    const session = await api("/api/interview/live/session", { method: "POST", body: "{}" });
    state.captions = "";
    state.liveStatus = "Connecting to Coach…";
    panel.innerHTML = `<p id="live-status">${esc(state.liveStatus)}</p><p id="captions"></p><button class="ghost full" id="end-live" type="button">End</button>`;
    state.live = startLive({
      sessionId: session.sessionId,
      onEvent(payload) {
        const type = String(payload.type ?? "");
        if (type === "hireme.cap") state.liveStatus = "Daily live minutes are used.";
        else if (type === "hireme.score") state.liveStatus = `Stored: structure ${payload.structure}/5, clarity ${payload.clarity}/5, impact ${payload.impact}/5.`;
        else if (type === "hireme.await_playback") state.liveStatus = "Score saved. One moment.";
        else if (type === "hireme.error") state.liveStatus = payload.message || "Live voice failed.";
        else if (type.includes("transcript") && payload.delta) state.captions += payload.delta;
        else if (type === "session.updated") state.liveStatus = "Live. Speak when you're ready.";
        const status = document.querySelector("#live-status");
        const captions = document.querySelector("#captions");
        if (status) status.textContent = state.liveStatus;
        if (captions) captions.textContent = state.captions;
      },
    });
    document.querySelector("#end-live")?.addEventListener("click", endLive);
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function endLive() {
  state.live?.stop();
  state.live = null;
  state.notice = "Live session closed. Minutes are metered on the server.";
  void api("/api/me").then((me) => {
    state.me = me;
    render();
  });
}

async function onMakeover(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const result = await api("/api/makeover", {
      method: "POST",
      body: JSON.stringify({ headline: form.get("headline"), resume: form.get("resume") }),
    });
    state.me.usage = result.usage;
    const data = result.result;
    document.querySelector("#makeover-out").innerHTML = `<article class="card stack">
      <p class="kicker">${data.source === "offline-rubric" ? "Offline rubric" : "Coach"}</p>
      ${(data.headlines ?? []).map((line) => `<h2>${esc(line)}</h2>`).join("")}
      <ul>${(data.bullets ?? []).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
      <p>${esc(data.notes ?? "")}</p>
    </article>`;
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function loadTracker() {
  const root = document.querySelector("#tracker-root");
  if (!root) return;
  try {
    const data = await api("/api/applications");
    root.innerHTML = `<p class="kicker">Applications</p><h1>What you sent.</h1>
      <form id="app-form" class="stack">
        <label>Company<input name="company" required /></label>
        <label>Role<input name="roleTitle" required /></label>
        <label>Link<input name="url" type="url" placeholder="https://" /></label>
        <label>Status<select name="status">${statusOptions("sent")}</select></label>
        <label>Notes<textarea name="notes"></textarea></label>
        <button class="btn accent full" type="submit">Log it</button>
      </form>
      <div class="list">${(data.applications ?? []).map(applicationCard).join("") || `<p class="muted">Nothing logged yet.</p>`}</div>
      <div class="todo"><strong>Auto-apply</strong><p>${esc(data.autoApply.message)}</p><button class="ghost" type="button" disabled>Auto-apply is off</button></div>`;
    document.querySelector("#app-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      try {
        await api("/api/applications", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(form.entries())),
        });
        await loadTracker();
      } catch (error) {
        state.error = error.message;
        render();
      }
    });
    document.querySelectorAll("[data-status]").forEach((select) => {
      select.addEventListener("change", async () => {
        await api(`/api/applications/${select.dataset.status}`, {
          method: "PATCH",
          body: JSON.stringify({ status: select.value }),
        });
      });
    });
  } catch (error) {
    root.innerHTML = `<p class="banner bad">${esc(error.message)}</p><a class="ghost" href="#/path">See plans</a>`;
  }
}

function applicationCard(appRow) {
  return `<article class="card item">
    <header><strong>${esc(appRow.company)}</strong><span class="muted">${esc(appRow.applied_at?.slice(0, 10) ?? "")}</span></header>
    <div>${esc(appRow.role_title)}</div>
    <label>Status<select data-status="${esc(appRow.id)}">${statusOptions(appRow.status)}</select></label>
    ${appRow.notes ? `<p class="muted">${esc(appRow.notes)}</p>` : ""}
  </article>`;
}

async function onCoach(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api("/api/coach/requests", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    state.notice = "Request sent. A person confirms the slot.";
    await loadCoach();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function loadCoach() {
  const list = document.querySelector("#coach-list");
  if (!list) return;
  try {
    const data = await api("/api/coach/requests");
    list.innerHTML = (data.requests ?? []).map((item) => `<article class="card"><strong>${esc(item.preferred_times)}</strong><p>${esc(item.focus ?? "")}</p><p class="muted">${esc(item.status)}</p></article>`).join("");
  } catch (error) {
    list.innerHTML = `<p class="banner">${esc(error.message)}</p>`;
  }
}

async function loadRoles() {
  const root = document.querySelector("#roles-root");
  try {
    const data = await api("/api/roles");
    root.innerHTML = `<p class="kicker">${data.firstPick ? "First pick" : "Sample seats"}</p>
      <h1>${data.firstPick ? "You are flagged." : "DeployedX roles"}</h1>
      <p class="lede">${esc(data.placement)}</p>
      <div class="list">${(data.roles ?? []).map((role) => `<article class="card"><h2>${esc(role.title)}</h2><p class="muted">${esc(role.location)} · sample</p><p>${esc(role.summary)}</p>${data.firstPick ? `<span class="tag">First pick</span>` : `<span class="muted">First pick is the $200 flag.</span>`}</article>`).join("")}</div>`;
  } catch (error) {
    root.innerHTML = `<p class="banner bad">${esc(error.message)}</p>`;
  }
}

async function loadAdmin() {
  const root = document.querySelector("#admin-root");
  try {
    const data = await api("/api/admin/summary");
    root.innerHTML = `<p class="kicker">${esc(data.date)}</p><h1>${data.dau} active today.</h1>
      <p class="muted">Live cost estimate ${money(data.liveCostEstimateUsd)}. ${esc(data.rateNote)}</p>
      <div class="card scroll"><table>
        <thead><tr><th>Tier</th><th>Text</th><th>Voice</th><th>Live</th><th>People</th></tr></thead>
        <tbody>${(data.minutesByTier ?? []).map((row) => `<tr><td>${esc(row.label)}</td><td>${row.textMinutes}m</td><td>${row.voiceMinutes}m</td><td>${row.liveMinutes}m</td><td>${row.users}</td></tr>`).join("") || `<tr><td colspan="5">No minutes yet today.</td></tr>`}</tbody>
      </table></div>
      <h2>Log a hire</h2>
      <form id="hire" class="stack">
        <label>Candidate<input name="candidateName" required /></label>
        <label>Company<input name="company" required /></label>
        <label>Role<input name="roleTitle" required /></label>
        <label>Week of<input name="weekStart" type="date" value="${esc(data.weekStart)}" /></label>
        <label>Notes<textarea name="notes"></textarea></label>
        <button class="btn accent" type="submit">Log hire</button>
      </form>
      <div class="list">${(data.hires ?? []).map((hire) => `<article class="card"><strong>${esc(hire.candidate_name)}</strong> · ${esc(hire.company)}<p>${esc(hire.role_title)} · week of ${esc(hire.week_start)}</p></article>`).join("")}</div>
      <div class="row"><h2>Leads</h2><a class="btn" href="/api/admin/leads.csv">Download CSV</a></div>
      <div class="card scroll"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Avg</th><th>Email ok</th><th>When</th></tr></thead>
        <tbody>${(data.leads ?? []).map((lead) => `<tr><td>${esc(lead.firstName)}</td><td>${esc(lead.email)}</td><td>${esc(tryRoleLabel(lead.role))}</td><td>${esc(lead.sessionAvg ?? "")}</td><td>${lead.consent ? "Yes" : "No"}</td><td>${esc(String(lead.createdAt).slice(0, 10))}</td></tr>`).join("") || `<tr><td colspan="6">No leads yet.</td></tr>`}</tbody>
      </table></div>`;
    document.querySelector("#hire")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      await api("/api/admin/hires", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) });
      await loadAdmin();
    });
  } catch (error) {
    root.innerHTML = `<p class="banner bad">${esc(error.message)}</p>`;
  }
}

async function checkout(tier) {
  try {
    const result = await api("/api/billing/checkout", { method: "POST", body: JSON.stringify({ tier }) });
    if (result.url) location.href = result.url;
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onPortal() {
  try {
    const result = await api("/api/billing/portal", { method: "POST", body: "{}" });
    if (result.url) location.href = result.url;
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onLogout() {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  state.me = null;
  location.hash = "#/signin";
  state.route = "signin";
  render();
}

function meters(usage) {
  return `<div class="meters">
    ${meter("Text", usage.text)}
    ${meter("Voice pipeline", usage.voice)}
    ${meter("Live voice", usage.live)}
  </div>`;
}

function meter(label, bucket) {
  if (bucket.unlimited && label === "Text") {
    return `<div class="meter"><div class="row"><span>${label}</span><strong>Unlimited</strong></div><p class="muted">A server safety ceiling still applies.</p></div>`;
  }
  if (!bucket.included && label !== "Text") {
    return `<div class="meter"><div class="row"><span>${label}</span><strong>Not on this plan</strong></div></div>`;
  }
  const leftSeconds = Math.max(0, bucket.capSeconds - bucket.usedSeconds);
  const pct = bucket.capSeconds ? Math.min(100, Math.round((bucket.usedSeconds / bucket.capSeconds) * 100)) : 0;
  return `<div class="meter"><div class="row"><span>${label}</span><strong>${clock(leftSeconds)} left</strong></div><div class="track"><div class="fill ${pct > 85 ? "warn" : ""}" style="width:${pct}%"></div></div></div>`;
}

function coachBrief() {
  const coach = state.today?.coach;
  if (!coach) return "";
  const scores = coach.scores;
  return `<div class="stack">
    <p>Sharpening: <strong>${esc(coach.drill)}</strong>.</p>
    ${state.coachSpoken ? `<p>${esc(state.coachSpoken)}</p>` : ""}
    ${scores ? `<div class="scores"><div><b>${scores.structure ?? "–"}</b><span>Structure</span></div><div><b>${scores.clarity ?? "–"}</b><span>Clarity</span></div><div><b>${scores.impact ?? "–"}</b><span>Impact</span></div></div>` : `<p class="muted">Structure, clarity, and impact are stored when the coach scores you, and the weak spot carries to tomorrow.</p>`}
    ${coach.tomorrowWeakSpot ? `<p>On file for tomorrow: ${esc(coach.tomorrowWeakSpot)}.</p>` : ""}
  </div>`;
}

function scoreCard(feedback) {
  const star = feedback.star;
  return `<article class="card stack">
    <p class="kicker">${feedback.source === "offline-rubric" ? "Offline rubric" : "Scored by Coach"}</p>
    <div class="scores">
      <div><b>${star.situation + star.task + star.action + star.result}</b><span>STAR / 20</span></div>
      <div><b>${feedback.clarity}</b><span>Clarity</span></div>
      <div><b>${feedback.impact}</b><span>Impact</span></div>
    </div>
    <div class="star">
      <span>S <b>${star.situation}</b></span><span>T <b>${star.task}</b></span><span>A <b>${star.action}</b></span><span>R <b>${star.result}</b></span>
    </div>
    <p>${esc(feedback.summary)}</p>
    <p><strong>Say it tighter.</strong> ${esc(feedback.rewrite)}</p>
  </article>`;
}

function statusOptions(current) {
  return ["drafted", "sent", "replied", "interview", "offer", "rejected"]
    .map((status) => `<option value="${status}" ${status === current ? "selected" : ""}>${status}</option>`)
    .join("");
}

function left(bucket) {
  return Math.max(0, bucket.capSeconds - bucket.usedSeconds);
}

function clock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function rank(tier) {
  return { free: 0, voice: 1, live: 2, coach: 3 }[tier] ?? 0;
}

function planName(tier) {
  return { free: "Free · $0", voice: "Voice · $20", live: "Live · $100", coach: "Coach · $200" }[tier] ?? tier;
}

function labelFor(role) {
  return ROLES.find((item) => item.id === role)?.title ?? "";
}

function formatDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value ?? 0);
}

function playBase64(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: type || "audio/mpeg" }));
  const audio = new Audio(url);
  void audio.play();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body && typeof options.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  const guestCall = path === "/api/auth/request" || path === "/api/me" || path === "/api/try" || path === "/api/lead" || path.startsWith("/api/voice-taste");
  if (response.status === 401 && !guestCall) {
    state.me = null;
    if (state.route !== "signin" && state.route !== "home") {
      state.route = "signin";
      render();
    }
  }
  if (!response.ok) {
    const error = new Error(data.message || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function demoInboxLine() {
  const demos = state.brand.demoInboxes ?? [];
  if (!demos.length) return "";
  return `<p class="muted">Local demo inboxes: ${demos.map((item) => esc(item)).join(", ")}.</p>`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
