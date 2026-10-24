# Security

## Report a vulnerability privately

Do not open a public GitHub issue for a security problem. A public issue is for bugs and feature ideas.

Use GitHub private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability**.
3. Describe what you found, where it is, and how to reproduce it.

If private reporting is unavailable, contact the maintainer through a private GitHub message. Do not include exploit details in a public channel.

Please give the maintainers time to confirm the report before you publish it.

## What to include

- The affected path, request, or screen
- Steps to reproduce
- The impact you expect (data exposure, account takeover, cost abuse, and so on)
- Whether you have already told anyone else

## What this project treats as sensitive

Secrets, session cookies, Stripe data, lead email addresses, and the model API key must stay on the server. The browser is not supposed to receive the API key, a live client secret, or the model vendor's name.

Do not send real customer data, live keys, or a production database dump with the report. A description or a redacted request is enough.
