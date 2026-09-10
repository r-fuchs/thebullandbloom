import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { anchorFor, loadFlags, materializeSubscriptions } from "../../src/jobs/materialize";
import { insertSubscriber, setSubscriberStatus } from "../../src/store/subscribers";
import { counts } from "../../src/store/outbox";
import { loadConfig } from "../../src/config";
import { seedAdminOverride } from "../helpers";

const cfg = loadConfig();
const deps = { db: env.DB, config: cfg };
const NOW = new Date("2026-09-10T14:00:00Z"); // Thu Sep 10, 10:00 Eastern
const weekly = {
  id: "m1", stripeCustomerId: "cus_m1", stripeSubscriptionId: "sub_m1", sizeId: "bouquet", cadenceId: "weekly", weekday: 2,
  fulfillment: "pickup" as const, addressJson: null, deliveryAddOnCents: 0, anchorDate: "2026-09-15",
  customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: null, note: null,
};
const dates = async (id: string) => (await env.DB.prepare("SELECT date FROM orders WHERE subscriber_id = ? ORDER BY date").bind(id).all<any>()).results.map((r) => r.date);

describe("materializeSubscriptions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM orders WHERE subscriber_id IS NOT NULL").run();
    await env.DB.prepare("DELETE FROM subscribers").run();
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM day_overrides").run();
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("anchors a signup on the first open weekday at least three days out", async () => {
    expect(await anchorFor(deps, 2, NOW)).toBe("2026-09-15");
    await seedAdminOverride("2026-09-15", null, true);
    expect(await anchorFor(deps, 2, NOW)).toBe("2026-09-22");
    // Sunday is never open: falls back to the bare weekday rather than failing the signup
    expect(await anchorFor(deps, 0, NOW)).toBe("2026-09-13");
  });

  it("creates three weeks of paid zero-priced bouquets with calendar events, idempotently", async () => {
    await insertSubscriber(env.DB, weekly, 1);
    expect(await materializeSubscriptions(deps, NOW)).toEqual({ status: "ok", created: 3, skippedWeeks: 0 });
    expect(await dates("m1")).toEqual(["2026-09-15", "2026-09-22", "2026-09-29"]);
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
    const kinds = (await env.DB.prepare("SELECT DISTINCT kind FROM outbox").all<any>()).results.map((r) => r.kind);
    expect(kinds).toEqual(["calendar_event"]);
    expect(await materializeSubscriptions(deps, NOW)).toEqual({ status: "ok", created: 0, skippedWeeks: 0 });
    expect(await counts(env.DB)).toEqual({ pending: 3, failed: 0 });
    // a week later the horizon rolls one more in
    expect((await materializeSubscriptions(deps, new Date("2026-09-17T14:00:00Z"))).created).toBe(1);
    expect(await dates("m1")).toEqual(["2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06"]);
  });

  it("shifts a closed day within the week and flags a fully closed week", async () => {
    await insertSubscriber(env.DB, weekly, 1);
    await seedAdminOverride("2026-09-22", null, true);
    for (const d of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]) await seedAdminOverride(d, null, true);
    expect(await materializeSubscriptions(deps, NOW)).toEqual({ status: "ok", created: 2, skippedWeeks: 1 });
    expect(await dates("m1")).toEqual(["2026-09-15", "2026-09-23"]);
    expect(await loadFlags(env.DB)).toEqual([{ subscriberId: "m1", customerName: "Pat Smith", week: "2026-09-28" }]);
  });

  it("runs for one subscriber on signup and leaves paused and cancelled ones alone", async () => {
    await insertSubscriber(env.DB, weekly, 1);
    await insertSubscriber(env.DB, { ...weekly, id: "m2", stripeSubscriptionId: "sub_m2", cadenceId: "twice-monthly", customerName: "Sam" }, 1);
    await insertSubscriber(env.DB, { ...weekly, id: "m3", stripeSubscriptionId: "sub_m3" }, 1);
    await setSubscriberStatus(env.DB, "m3", "cancelled");
    expect((await materializeSubscriptions(deps, NOW, "m2")).created).toBe(2);
    expect(await dates("m2")).toEqual(["2026-09-15", "2026-09-29"]);
    expect(await dates("m1")).toEqual([]);
    expect((await materializeSubscriptions(deps, NOW)).created).toBe(3);
    expect(await dates("m3")).toEqual([]);
  });
});
