import { Hono } from "hono";
import type { Env } from "./env";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// In production, Cloudflare serves static assets ahead of the Worker
// (default `run_worker_first = false`), so this route only matters for the
// vitest-pool-workers test harness, which invokes this fetch handler
// directly without that outer asset-routing layer.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {},
};
