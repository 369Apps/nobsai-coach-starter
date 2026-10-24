# No BS AI

Free voice-first coaching that trains job seekers to become Forward Deployed Engineers.

**Get hired as a Forward Deployed Engineer.**

Built by No BS AI. Placement through DeployedX.

The coach in the product is **Coach from Hire Me**. The screen does not name the model vendor. Forks can change the brand, the headline, and the trust line without editing the coach script.

This is a Cloudflare Worker: static pages, a D1 database, a voice-session proxy, a lead form, email magic-link sign-in, paid tiers, and an admin desk. Anyone can deploy their own copy.

Maintainer: Bobby Ve.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/369Apps/nobsai-coach-starter)

## What you supply

The repository does not contain an account id, a database id, a domain, or any API key.

| Name | Where | What it is |
| --- | --- | --- |
| Cloudflare account | `wrangler login` | The account that will own the Worker and D1 database. |
| D1 database id | `wrangler.jsonc` | Printed by `wrangler d1 create`. Replace the all-zero placeholder. |
| `LLM_API_KEY` | secret | Key for the voice and text API. The browser never sees it. |
| `LLM_API_BASE` and model ids | `wrangler.jsonc` vars | Defaults speak the API this Worker was built against (`https://api.x.ai/v1`). Change them if your key is for another host with the same request shape. |
| `STRIPE_SECRET_KEY` | secret | Stripe **test** key (`sk_test_` or `rk_test_`). Live keys are refused. |
| `STRIPE_WEBHOOK_SECRET` | secret | Signing secret for `POST /api/stripe/webhook`. |
| `STRIPE_PRICE_VOICE`, `STRIPE_PRICE_LIVE`, `STRIPE_PRICE_COACH` | vars | Stripe test price ids for the $20, $100, and $200 plans. The `price_test_` placeholders disable checkout. |
| `ADMIN_EMAILS` | var | Comma-separated inboxes that may open `#/admin`. Leave empty until you choose them. Do not commit a private list. |
| `EMAIL_WEBHOOK_URL` | secret | Only when `ENVIRONMENT` is `production`. Receives `POST { "email", "magicLink" }`. |
| `APP_ORIGIN` | var | Public origin, such as your `workers.dev` host. Empty uses the request host. |
| `LIVE_RATE_USD_PER_MINUTE` | var | Optional. Your provider's per-minute rate for the admin cost estimate. |

Copy [`.dev.vars.example`](.dev.vars.example) to `.dev.vars` for local secrets. Wrangler loads that file and it is gitignored.

## Deploy

Requires Node 22+.

1. Install and log in.

   ```bash
   npm install -g pnpm
   pnpm install
   npx wrangler login
   ```

2. Create the D1 database and put the printed id in `database_id` in `wrangler.jsonc`.

   ```bash
   npx wrangler d1 create nobsai-coach
   ```

3. Apply the migrations **in order** (`0001` through `0006`).

   ```bash
   npx wrangler d1 migrations apply nobsai-coach --remote
   ```

   `0002_seed.sql` inserts synthetic demo accounts on `example.com` and the practice questions. Skip that file on a database that should not contain demo people: apply `0001_schema.sql`, then `0003` through `0006`.

4. Set `APP_ORIGIN` to the public URL and `ENVIRONMENT` to `production` when you are ready for real sign-in mail. Create three recurring Stripe test prices ($20, $100, $200) and replace the `STRIPE_PRICE_*` placeholders.

5. Set secrets. Wrangler prompts so the value is not a shell flag.

   ```bash
   npx wrangler secret put LLM_API_KEY
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

6. Deploy.

   ```bash
   pnpm deploy
   ```

7. In the Stripe test dashboard, point a webhook at `https://<your-host>/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`. Use that endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`.

The Deploy to Cloudflare button opens this repository in the Workers deploy flow. You still create D1, paste the database id, apply migrations, and set secrets. The committed config has no real account, database, or domain.

## Local setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:migrate
pnpm dev
```

Open http://127.0.0.1:44521.

`npm install` works if you delete `pnpm-lock.yaml` first. This lockfile is pnpm.

In development the magic link is shown on the sign-in screen. Nothing is emailed. The local demo inboxes are `free@example.com`, `voice@example.com`, `live@example.com`, and `coach@example.com`. They are synthetic. They are hidden when `ENVIRONMENT` is `production`.

Without `LLM_API_KEY`, text coaching and the headline makeover use a deterministic offline rubric and the screen says so. Voice and live voice return a clear error until the key is set.

The API key stays on the Worker. Live audio is proxied so the daily cap can close the socket.

### Brand

Edit the `BRAND_*` vars in `wrangler.jsonc` and deploy again. The page reads them from `GET /api/brand`.

| Var | Default |
| --- | --- |
| `BRAND_NAME` | No BS AI |
| `BRAND_HEADLINE` | Get hired as a Forward Deployed Engineer. |
| `BRAND_TRUST` | Built by No BS AI. Placement through DeployedX. |
| `BRAND_COACH` | Coach from Hire Me |
| `BRAND_PRODUCT` | Hire Me |

### Plans

| Plan | Price | What you get |
| --- | --- | --- |
| Free | $0 | 10 minutes a day of text coaching, the daily brief, the streak, and a resume / LinkedIn headline makeover. |
| Voice | $20 | Text coaching, with a server safety ceiling, and voice mocks. |
| Live | $100 | Everything in Voice, live voice, and the application tracker. |
| Coach | $200 | Everything in Live, a weekly human-coach request, and a first-pick flag on the sample roles. |

Placement through DeployedX is separate from checkout. The app does not state a placement rate or a placement guarantee.

Voice and live minutes are capped in D1 before the model is called. Defaults are in `wrangler.jsonc`. Paid text has a safety ceiling so a bug cannot run up a bill. Caps reset at midnight UTC.

The homepage offers one free 3-minute live taste per IP per day before sign-in. `FREE_VOICE_DAILY_SESSIONS` (default 200) is the global daily cap. The Worker mints a short-lived client secret, holds it only until the socket connects, and proxies the audio. The browser never receives the API key or the secret. If the mic is missing, permission is denied, or the cap is hit, the three-question text practice stays on the page.

Stripe stays in **test mode**. A live secret key (`sk_live_` or `rk_live_`) is rejected. Local webhook forwarding:

```bash
stripe listen --forward-to localhost:44521/api/stripe/webhook
```

Use test card `4242 4242 4242 4242`.

There is a disabled auto-apply control. `POST /api/applications/auto-apply` returns 501. It must not send mail or touch a job board that bans automation.

## Tests

```bash
pnpm typecheck
pnpm test
pnpm smoke
```

The suite runs in the Workers runtime with a local D1. It covers minute caps, tier gates, the coach prompt, streaks, the admin desk, Stripe test-mode refusal, and webhook signatures. No test calls the model API or Stripe. `pnpm smoke` checks the public copy and rejects committed secrets, real ids, and vendor names in the UI.

## Community

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md). Security reports go through GitHub's private vulnerability reporting, not a public issue.

License: [MIT](LICENSE). Copyright No BS AI.
