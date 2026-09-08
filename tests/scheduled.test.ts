import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runScheduled } from "../src/scheduled";
import { testServices } from "./helpers";

describe("runScheduled", () => {
  it("expires stale holds and leaves fresh ones", async () => {
    const now = 1_800_000_000;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, hold_expires_at)
        VALUES ('s1', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'A', 'a@example.com', 8500, ?)`).bind(now - 1),
      env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, hold_expires_at)
        VALUES ('s2', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'B', 'b@example.com', 8500, ?)`).bind(now + 600),
    ]);
    const { services } = testServices();
    expect(await runScheduled(env, services, new Date(now * 1000))).toEqual({ expiredHolds: 1 });
    const s = await env.DB.prepare("SELECT id, status FROM orders WHERE id IN ('s1','s2') ORDER BY id").all<any>();
    expect(s.results).toEqual([{ id: "s1", status: "cancelled" }, { id: "s2", status: "held" }]);
  });
});
