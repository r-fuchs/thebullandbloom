// This version of @cloudflare/vitest-pool-workers (0.22.x, for vitest v4)
// configures the pool through a Vite plugin (`cloudflareTest`) rather than
// `defineWorkersConfig`/`poolOptions.workers`, and exports `readD1Migrations`
// from the package root instead of a `/config` subpath. See task-1-report.md.
import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            STRIPE_SECRET_KEY: "sk_test_fake",
            STRIPE_WEBHOOK_SECRET: "whsec_fake",
            ADMIN_PASSCODE: "open-sesame-1234",
            ADMIN_SECRET: "test-secret",
            GOOGLE_CLIENT_ID: "test-client-id",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            INSTAGRAM_APP_ID: "ig-app-id",
            INSTAGRAM_APP_SECRET: "ig-app-secret",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./tests/setup.ts"],
    },
  };
});
