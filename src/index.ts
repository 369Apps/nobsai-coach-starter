import { Hono } from "hono";
import { brandFromEnv } from "./lib/brand";
import type { AppEnv } from "./lib/http";
import { logEvent } from "./lib/http";
import { api } from "./routes";

const app = new Hono<{ Bindings: AppEnv }>();

app.use("*", async (c, next) => {
  const canonical = (c.env.CANONICAL_HOST ?? "").trim().toLowerCase();
  if (!canonical) {
    await next();
    return;
  }
  const url = new URL(c.req.url);
  if (url.hostname === `www.${canonical}`) {
    url.hostname = canonical;
    return c.redirect(url.toString(), 301);
  }
  await next();
});

app.route("/api", api);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    const product = brandFromEnv(c.env).product;
    return c.json({ error: "not_found", message: `That API path is not part of ${product}.` }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  logEvent("server_error", { message: error.message, path: c.req.path });
  return c.json({ error: "server_error", message: "Something broke on our side. Try again." }, 500);
});

export default app;
