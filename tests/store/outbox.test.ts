import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  ORDER_PAID_KINDS, backoff, counts, dueItems, enqueueForSessionStatements, markDone, markFailed, retryFailed,
} from "../../src/store/outbox";

async function order(id: string, session: string, status: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, stripe_session_id)
     VALUES (?, 1, ?, '2026-09-09', 'bouquet', 'pickup', 'Pat', 'pat@example.com', 8500, ?)`,
  ).bind(id, status, session).run();
}

describe("store/outbox", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM outbox").run(); });

  it("enqueues three rows for a paid session, idempotently, and nothing for an unpaid one", async () => {
    await order("o1", "cs_o1", "paid");
    await order("o2", "cs_o2", "held");
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 1000));
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 2000));
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o2", ORDER_PAID_KINDS, 1000));
    const rows = await env.DB.prepare("SELECT order_id, kind, created_at, attempts, next_attempt_at FROM outbox ORDER BY kind").all<any>();
    expect(rows.results).toEqual([
      { order_id: "o1", kind: "calendar_event", created_at: 1000, attempts: 0, next_attempt_at: 1000 },
      { order_id: "o1", kind: "email_customer", created_at: 1000, attempts: 0, next_attempt_at: 1000 },
      { order_id: "o1", kind: "email_owner", created_at: 1000, attempts: 0, next_attempt_at: 1000 },
    ]);
  });

  it("lists due items oldest first and respects the limit", async () => {
    await order("o1", "cs_o1", "paid");
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 1000));
    expect((await dueItems(env.DB, 999)).length).toBe(0);
    const due = await dueItems(env.DB, 1000);
    expect(due.map((i) => i.kind)).toEqual(["calendar_event", "email_customer", "email_owner"]);
    expect(due[0]).toMatchObject({ orderId: "o1", attempts: 0, nextAttemptAt: 1000, lastError: null, doneAt: null });
    expect((await dueItems(env.DB, 1000, 2)).length).toBe(2);
  });

  it("marks done and failed, counts, and retries", async () => {
    await order("o1", "cs_o1", "paid");
    await env.DB.batch(enqueueForSessionStatements(env.DB, "cs_o1", ORDER_PAID_KINDS, 1000));
    const [a, b, c] = await dueItems(env.DB, 1000);
    await markDone(env.DB, a.id, 1001);
    await markFailed(env.DB, b.id, 1, 1120, "boom");
    await markFailed(env.DB, c.id, 24, null, "gave up");
    expect(await counts(env.DB)).toEqual({ pending: 1, failed: 1 });
    expect((await dueItems(env.DB, 1119)).length).toBe(0);
    expect((await dueItems(env.DB, 1120)).map((i) => i.id)).toEqual([b.id]);
    const failedRow = await env.DB.prepare("SELECT attempts, next_attempt_at, last_error, done_at FROM outbox WHERE id = ?").bind(c.id).first<any>();
    expect(failedRow).toEqual({ attempts: 24, next_attempt_at: null, last_error: "gave up", done_at: null });
    expect(await retryFailed(env.DB, 5000)).toBe(1);
    expect(await counts(env.DB)).toEqual({ pending: 2, failed: 0 });
    expect((await dueItems(env.DB, 5000)).map((i) => i.id).sort()).toEqual([b.id, c.id].sort());
    const reset = await env.DB.prepare("SELECT attempts, next_attempt_at FROM outbox WHERE id = ?").bind(c.id).first<any>();
    expect(reset).toEqual({ attempts: 0, next_attempt_at: 5000 });
  });

  it("backs off exponentially, caps the delay, and gives up after 24 attempts", () => {
    expect(backoff(1, 0)).toBe(120);
    expect(backoff(2, 0)).toBe(240);
    expect(backoff(6, 0)).toBe(3840);
    expect(backoff(7, 0)).toBe(3840);
    expect(backoff(23, 1000)).toBe(4840);
    expect(backoff(24, 0)).toBeNull();
  });
});
