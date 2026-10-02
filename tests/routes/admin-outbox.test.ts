import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp, asAdmin } from "../helpers";
import { counts } from "../../src/store/outbox";

const NOW = new Date("2026-09-08T14:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

async function row(id: string, kind: string, createdAt: number, nextAttemptAt: number | null) {
  await env.DB.prepare("INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at) VALUES (?, ?, ?, ?, 0, ?)")
    .bind(id, kind, id, createdAt, nextAttemptAt).run();
}

describe("admin outbox", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'watchdog.state'").run();
  });

  it("requires the Access identity", async () => {
    const { fetch } = testApp(NOW);
    expect((await fetch("/admin/api/outbox")).status).toBe(401);
    expect((await fetch("/admin/api/outbox/retry", { method: "POST" })).status).toBe(401);
  });

  it("reports counts, the oldest stuck age and the channel status", async () => {
    const { fetch, alerts, mailer } = testApp(NOW);
    const api = asAdmin(fetch);
    expect(await (await api("/admin/api/outbox")).json()).toEqual({
      pending: 0, failed: 0, stuck: 0, oldestAgeSec: null, mail: { configured: true }, alerts: { configured: true }, lastAlertAt: null,
    });
    await row("fresh", "email_owner", NOW_SEC - 60, NOW_SEC);
    await row("old", "email_customer", NOW_SEC - 1200, NOW_SEC + 60);
    await row("dead", "email_owner", NOW_SEC - 100, null);
    await env.DB.prepare("INSERT INTO settings (key, value_json) VALUES ('watchdog.state', ?)").bind(JSON.stringify({ stuckSince: 5, lastAlertAt: 7 })).run();
    alerts.isConfigured = false;
    mailer.isConfigured = false;
    expect(await (await api("/admin/api/outbox")).json()).toEqual({
      pending: 2, failed: 1, stuck: 2, oldestAgeSec: 1200, mail: { configured: false }, alerts: { configured: false }, lastAlertAt: 7,
    });
  });

  it("retry revives given-up rows and drains once", async () => {
    const { fetch } = testApp(NOW);
    const api = asAdmin(fetch);
    await row("dead", "calendar_event", NOW_SEC - 100, null);
    const res = await (await api("/admin/api/outbox/retry", { method: "POST" })).json() as any;
    expect(res.retried).toBe(1);
    expect(res.drain).toEqual({ status: "ok", delivered: 0, failed: 0, waiting: 1 });
    expect(await counts(env.DB)).toEqual({ pending: 1, failed: 0 });
  });
});
