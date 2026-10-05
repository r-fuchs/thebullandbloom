import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { WREATH } from "../helpers";

/**
 * Migration 0010 queues the customer confirmation for in-person bookings recorded before the admin
 * form sent mail. The test harness applied it to an empty database, so its statements are run again
 * here against seeded rows; being guarded on "no row yet", it is safe to run any number of times.
 */
const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0010_"))!;
const runBackfill = async () => { for (const q of migration.queries) await env.DB.prepare(q).run(); };

const INSERT = `INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, price_cents, stripe_session_id, seats)
  VALUES (?, 1, ?, ?, 'sat', ?, ?, 8500, ?, 1)`;
const booking = (id: string, status: string, email: string, stripeSession: string | null) =>
  env.DB.prepare(INSERT).bind(id, status, WREATH.id, id, email, stripeSession).run();

describe("0010: confirmation emails for in-person bookings recorded before the form sent them", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bookings").run();
    await env.DB.prepare("DELETE FROM outbox").run();
  });

  it("queues the customer email once for each paid in-person booking that gave an address", async () => {
    await booking("manual1", "paid", "m1@example.com", null);
    await booking("manual2", "paid", "m2@example.com", null);
    await booking("walkin", "paid", "", null);            // no address to write to
    await booking("online", "paid", "o@example.com", "cs_1"); // Stripe booked: the webhook already queued its mail
    await booking("refunded", "cancelled", "r@example.com", null);
    await env.DB.prepare("INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at, done_at) VALUES ('x', 'booking_confirmed_customer', 'manual2', 1, 1, NULL, 2)").run();
    await runBackfill();
    const rows = await env.DB.prepare("SELECT kind, order_id, attempts, done_at FROM outbox ORDER BY order_id").all<any>();
    expect(rows.results).toEqual([
      { kind: "booking_confirmed_customer", order_id: "manual1", attempts: 0, done_at: null },
      { kind: "booking_confirmed_customer", order_id: "manual2", attempts: 1, done_at: 2 }, // already sent: left alone
    ]);
    const queued = await env.DB.prepare("SELECT id, next_attempt_at FROM outbox WHERE order_id = 'manual1'").first<any>();
    expect(queued.id).toMatch(/^[0-9a-f]{32}$/);
    expect(queued.next_attempt_at).toBeGreaterThan(1_700_000_000);
    await runBackfill();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<any>()).n).toBe(2);
  });
});
