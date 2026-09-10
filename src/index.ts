import type { Env } from "./env";
import { buildApp, type Services } from "./app";
import { loadConfig } from "./config";
import { StripePayments } from "./adapters/stripe";
import { GoogleApi } from "./adapters/google-api";
import { InstagramApi } from "./adapters/instagram-api";
import { connectionSource } from "./store/google";
import { runScheduled } from "./scheduled";

let services: Services | null = null;
let app: ReturnType<typeof buildApp> | null = null;

export function servicesFor(env: Env): Services {
  if (!services) {
    const payments = new StripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
    const google = new GoogleApi(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, connectionSource(env.DB, env.ADMIN_SECRET));
    const instagram = new InstagramApi(env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET);
    services = { payments, google, instagram, clock: () => new Date(), config: loadConfig() };
  }
  return services;
}

function appFor(env: Env) {
  if (!app) app = buildApp(servicesFor(env));
  return app;
}

const REQUIRED_SECRETS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "ADMIN_PASSCODE", "ADMIN_SECRET"] as const;

function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((k) => typeof env[k] !== "string" || env[k] === "");
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const missing = missingSecrets(env);
    if (missing.length > 0) {
      console.error("misconfigured: missing", missing.join(", "));
      return new Response("misconfigured", { status: 500 });
    }
    return appFor(env).fetch(req, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduled(env, servicesFor(env), new Date())
        .then((r) => console.log("scheduled", JSON.stringify(r)))
        .catch((e) => console.error("scheduled failed", e)),
    );
  },
};
