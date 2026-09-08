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

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => appFor(env).fetch(req, env, ctx),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, new Date()).then((r) => console.log("scheduled", JSON.stringify(r))));
  },
};
