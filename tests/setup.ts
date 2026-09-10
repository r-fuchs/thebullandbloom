import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";

// This version of @cloudflare/vitest-pool-workers (0.22.x, for vitest v4) types
// test bindings via the ambient `Cloudflare.Env` interface (merged in by
// @cloudflare/workers-types) rather than a `cloudflare:test` `ProvidedEnv`
// interface. See task-1-report.md for details.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      SITE_URL: string;
      STRIPE_SECRET_KEY: string;
      STRIPE_WEBHOOK_SECRET: string;
      ADMIN_PASSCODE: string;
      ADMIN_SECRET: string;
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      MEDIA: R2Bucket;
      INSTAGRAM_APP_ID?: string;
      INSTAGRAM_APP_SECRET?: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
