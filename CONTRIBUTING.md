# Contributing

Thanks for helping No BS AI stay useful for people training to become Forward Deployed Engineers.

Maintainer: Bobby Ve.

## Suggest a feature or report a bug

Open a GitHub issue with the feature or bug template. A clear report is enough. You do not need to write code.

Security problems are different. Read [SECURITY.md](SECURITY.md) and report them privately. Do not open a public issue for a vulnerability.

## Send a fix

1. Fork the repository and create a branch.
2. Install dependencies with `pnpm install` (Node 22+).
3. Copy `.dev.vars.example` to `.dev.vars` if you need local secrets. Leave the example file empty.
4. Make the change. Keep the coach's public name as **Coach from Hire Me** unless you are changing the brand config itself. Do not put a model vendor's name in the UI.
5. Run `pnpm typecheck`, `pnpm test`, and `pnpm smoke`.
6. Open a pull request. Fill in the template. Describe what changed and how you checked it.

## What not to commit

- API keys, Stripe keys, webhook secrets, or Cloudflare tokens
- Real account ids, D1 database ids, or private domains
- Email addresses, phone numbers, or names of real customers
- An admin email list
- Seed data that names real people

Demo accounts in migrations use `example.com` and labels such as Demo Free. Keep new fixtures that way.

The `database_id` in `wrangler.jsonc` stays the all-zero placeholder. Put your own id only in a local or deployed config that is not committed.

## Brand and provider

Brand copy lives in the `BRAND_*` vars in `wrangler.jsonc`. The page loads `GET /api/brand`.

The voice and text API is configured with `LLM_API_KEY` (a secret) and the `LLM_*` vars. Do not hard-code a key or a private endpoint.
