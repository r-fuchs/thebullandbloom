import type { Env } from "./env";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { StripePayments } from "./adapters/stripe";
import { runScheduled } from "./scheduled";

let cached: ReturnType<typeof buildApp> | null = null;
function appFor(env: Env) {
  if (!cached) {
    const payments = new StripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
    cached = buildApp({ payments, clock: () => new Date(), config: loadConfig() });
  }
  return cached;
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
    ctx.waitUntil(runScheduled(env, new Date()).then((r) => console.log("scheduled", JSON.stringify(r))));
  },
};
