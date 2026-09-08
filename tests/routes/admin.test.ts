import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testApp, seedAdminOverride } from "../helpers";

async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  expect(r.status).toBe(204);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" } });
}

describe("admin auth", () => {
  it("refuses without a cookie and with a wrong passcode", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/month?from=2026-09-01&to=2026-09-02")).status).toBe(401);
    const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "wrong" }) });
    expect(r.status).toBe(401);
  });
  it("sets an HttpOnly cookie on login", async () => {
    const { fetch } = testApp();
    const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "open-sesame-1234" }) });
    expect(r.headers.get("set-cookie")).toMatch(/bb_admin=.*HttpOnly/);
  });
  it("refuses logout without a cookie", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/logout", { method: "POST" })).status).toBe(401);
  });
  it("clears the cookie on a logged-in logout", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    const r = await as("/admin/api/logout", { method: "POST" });
    expect(r.status).toBe(204);
    expect(r.headers.get("set-cookie")).toMatch(/bb_admin=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/);
  });
});

describe("admin month and days", () => {
  it("reports counts and applies day edits", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    await env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents, source)
      VALUES ('m1', 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'A', 'a@example.com', 8500, 'one_time'),
             ('m2', 1, 'held', '2026-09-09', 'bouquet', 'pickup', 'B', 'b@example.com', 8500, 'one_time'),
             ('m3', 1, 'paid', '2026-09-09', 'bouquet', 'pickup', 'C', 'c@example.com', 8500, 'subscription')`).run();
    let { days } = await (await as("/admin/api/month?from=2026-09-09&to=2026-09-09")).json() as any;
    expect(days[0]).toMatchObject({ used: 2, paidCount: 1, heldCount: 1, subscriptionCount: 1, closed: false, overrideCap: null });

    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ cap: 6 }) })).status).toBe(200);
    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ closed: true }) })).status).toBe(200);
    ({ days } = await (await as("/admin/api/month?from=2026-09-09&to=2026-09-09")).json() as any);
    expect(days[0]).toMatchObject({ overrideCap: 6, closed: true, cap: 0 });

    expect((await as("/admin/api/days/2026-09-09", { method: "DELETE" })).status).toBe(204);
    ({ days } = await (await as("/admin/api/month?from=2026-09-09&to=2026-09-09")).json() as any);
    expect(days[0]).toMatchObject({ overrideCap: null, closed: false, cap: 4 });
  });
  it("validates day edits", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    expect((await as("/admin/api/days/2026-9-9", { method: "PUT", body: JSON.stringify({ cap: 1 }) })).status).toBe(400);
    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ cap: -1 }) })).status).toBe(400);
    expect((await as("/admin/api/days/2026-09-09", { method: "PUT", body: JSON.stringify({ cap: 2.5 }) })).status).toBe(400);
  });
});

describe("admin settings and orders", () => {
  it("reads and updates settings with validation", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    expect(await (await as("/admin/api/settings")).json()).toEqual({ cap: 4, cutoff: "11:00", openWeekdays: [2, 3, 4, 5, 6] });
    const r = await as("/admin/api/settings", { method: "PUT", body: JSON.stringify({ cap: 7, cutoff: "10:15" }) });
    expect(await r.json()).toEqual({ cap: 7, cutoff: "10:15", openWeekdays: [2, 3, 4, 5, 6] });
    expect((await as("/admin/api/settings", { method: "PUT", body: JSON.stringify({ cutoff: "27:00" }) })).status).toBe(400);
    expect((await as("/admin/api/settings", { method: "PUT", body: JSON.stringify({ openWeekdays: [7] }) })).status).toBe(400);
  });
  it("lists a day's orders and toggles done", async () => {
    const { fetch } = testApp();
    const as = await login(fetch);
    await env.DB.prepare(`INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, bouquet_cents)
      VALUES ('d1', 1, 'paid', '2026-09-10', 'posy', 'pickup', 'A', 'a@example.com', 5500),
             ('d2', 2, 'held', '2026-09-10', 'posy', 'pickup', 'B', 'b@example.com', 5500)`).run();
    const { orders } = await (await as("/admin/api/orders?date=2026-09-10")).json() as any;
    expect(orders.map((o: any) => o.id)).toEqual(["d1", "d2"]);
    expect((await as("/admin/api/orders/d1/done", { method: "POST" })).status).toBe(200);
    expect((await as("/admin/api/orders/d2/done", { method: "POST" })).status).toBe(409);
    expect((await as("/admin/api/orders/d1/undone", { method: "POST" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM orders WHERE id='d1'").first<any>()).status).toBe("paid");
  });
});
