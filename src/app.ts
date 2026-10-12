import { Hono } from "hono";
import type { Env } from "./env";
import type { Payments } from "./adapters/payments";
import type { Google } from "./adapters/google";
import type { Mailer } from "./adapters/mailer";
import type { Alerts } from "./adapters/alerts";
import type { Instagram } from "./adapters/instagram";
import type { Uber } from "./adapters/uber";
import type { MetaAds } from "./adapters/meta-ads";
import type { Access, AdminIdentity } from "./adapters/access";
import type { StoreConfig } from "./config";
import { publicRoutes } from "./routes/public";
import { offerRoutes } from "./routes/offers";
import { webhookRoutes } from "./routes/webhooks";
import { adminRoutes } from "./routes/admin";
import { instagramPublic } from "./routes/instagram";
import { pricedConfig } from "./store/prices";

export interface Services { payments: Payments; google: Google; mailer: Mailer; alerts: Alerts; instagram: Instagram; uber: Uber; metaAds: MetaAds; access: Access; clock: () => Date; config: StoreConfig }
/** `baseConfig` is store.config.json as shipped; `services.config` has the admin's saved prices laid over it. */
export type AppEnv = { Bindings: Env; Variables: { services: Services; baseConfig: StoreConfig; admin: AdminIdentity } };
export type App = Hono<AppEnv>;

export function buildApp(services: Services): App {
  const app: App = new Hono();
  // Prices Anthony sets in the admin lay over store.config.json per request, so every route charges and shows the same number.
  app.use("*", async (c, next) => {
    c.set("baseConfig", services.config);
    c.set("services", { ...services, config: await pricedConfig(c.env.DB, services.config) });
    await next();
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/", publicRoutes());
  app.route("/", offerRoutes());
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
