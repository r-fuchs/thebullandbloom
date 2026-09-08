import type { Env } from "./env";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import type { Payments } from "./adapters/payments";

let cached: ReturnType<typeof buildApp> | null = null;
function appFor(env: Env) {
  if (!cached) {
    const payments: Payments = {
      async createCheckout() { throw new Error("payments not configured"); },
      async parseWebhook() { throw new Error("payments not configured"); },
    };
    cached = buildApp({ payments, clock: () => new Date(), config: loadConfig() });
  }
  return cached;
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => appFor(env).fetch(req, env, ctx),
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {},
};
