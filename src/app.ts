import { Hono } from "hono";
import type { Env } from "./env";
import type { Payments } from "./adapters/payments";
import type { Google } from "./adapters/google";
import type { Instagram } from "./adapters/instagram";
import type { StoreConfig } from "./config";
import { publicRoutes } from "./routes/public";
import { webhookRoutes } from "./routes/webhooks";
import { adminRoutes } from "./routes/admin";
import { instagramPublic } from "./routes/instagram";

export interface Services { payments: Payments; google: Google; instagram: Instagram; clock: () => Date; config: StoreConfig }
export type App = Hono<{ Bindings: Env; Variables: { services: Services } }>;

export function buildApp(services: Services): App {
  const app: App = new Hono();
  app.use("*", async (c, next) => { c.set("services", services); await next(); });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/", publicRoutes());
  instagramPublic(app);
  app.route("/", webhookRoutes());
  app.route("/", adminRoutes());

  // In production, Cloudflare serves static assets ahead of the Worker
  // (default `run_worker_first = false`), so this fallback only matters for the
  // vitest-pool-workers test harness, which invokes this fetch handler
  // directly without that outer asset-routing layer. Wired as `notFound`
  // (not a wildcard route) so it fires only when nothing else matched,
  // regardless of registration order or method.
  app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
