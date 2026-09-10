import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { App } from "../app";
import { COOKIE, makeSession, verifySession, passcodeMatches } from "../admin/session";
import { availabilityFor, type Defaults } from "../core/capacity";
import { isYmd, ymdRange } from "../core/time";
import { loadDefaults, saveDefaults } from "../store/settings";
import { getOverrides, putAdminOverride, clearAdminOverride } from "../store/overrides";
import { countUsed, listOrders, getOrder, setStatus } from "../store/orders";
import { registerGoogleAdmin } from "./admin-google";
import { registerInstagramAdmin } from "./instagram";
import { listSubscribers } from "../store/subscribers";
import { dueDates } from "../core/subscriptions";
import { addDays, ymdIn } from "../core/time";
import { loadFlags } from "../jobs/materialize";

const TTL = 30 * 24 * 3600;
const MAX_DAYS = 62;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validCap(v: unknown): v is number | null {
  return v === null || (Number.isInteger(v) && (v as number) >= 0);
}

function validateSettingsPatch(p: any): { ok: true; patch: Partial<Defaults> } | { ok: false; error: string } {
  const patch: Partial<Defaults> = {};
  if (p.cap !== undefined) { if (!validCap(p.cap) || p.cap === null) return { ok: false, error: "cap must be a non-negative integer" }; patch.cap = p.cap; }
  if (p.cutoff !== undefined) { if (typeof p.cutoff !== "string" || !HM.test(p.cutoff)) return { ok: false, error: "cutoff must be HH:MM" }; patch.cutoff = p.cutoff; }
  if (p.openWeekdays !== undefined) {
    if (!Array.isArray(p.openWeekdays) || !p.openWeekdays.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))
      return { ok: false, error: "openWeekdays must be integers 0..6" };
    patch.openWeekdays = [...new Set(p.openWeekdays as number[])].sort();
  }
  return { ok: true, patch };
}

export function adminRoutes(): App {
  const r: App = new Hono();

  r.post("/admin/api/login", async (c) => {
    let body: any = {};
    try { body = await c.req.json(); } catch { /* fallthrough */ }
    if (!(await passcodeMatches(String(body.passcode ?? ""), c.env.ADMIN_PASSCODE))) {
      await new Promise((res) => setTimeout(res, 1000));
      return c.json({ error: "wrong passcode" }, 401);
    }
    const nowSec = Math.floor(c.get("services").clock().getTime() / 1000);
    setCookie(c, COOKIE, await makeSession(c.env.ADMIN_SECRET, nowSec, TTL), {
      httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: TTL,
    });
    return c.body(null, 204);
  });

  r.use("/admin/api/*", async (c, next) => {
    if (c.req.path === "/admin/api/login") return next();
    const nowSec = Math.floor(c.get("services").clock().getTime() / 1000);
    if (!(await verifySession(getCookie(c, COOKIE), c.env.ADMIN_SECRET, nowSec))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  r.post("/admin/api/logout", (c) => { deleteCookie(c, COOKIE, { path: "/" }); return c.body(null, 204); });

  r.get("/admin/api/month", async (c) => {
    const { config, clock } = c.get("services");
    const from = c.req.query("from"), to = c.req.query("to");
    if (!isYmd(from) || !isYmd(to)) return c.json({ error: "from and to must be YYYY-MM-DD" }, 400);
    const dates = ymdRange(from, to);
    if (dates.length === 0 || dates.length > MAX_DAYS) return c.json({ error: `range must be 1..${MAX_DAYS} days` }, 400);
    const [defaults, overrides, used, adminRows, counts] = await Promise.all([
      loadDefaults(c.env.DB, config.defaults),
      getOverrides(c.env.DB, from, to),
      countUsed(c.env.DB, from, to),
      c.env.DB.prepare("SELECT date, cap FROM day_overrides WHERE source = 'admin' AND date BETWEEN ? AND ?").bind(from, to).all<{ date: string; cap: number | null }>(),
      c.env.DB.prepare(
        `SELECT date, source, status, COUNT(*) AS n FROM orders WHERE date BETWEEN ? AND ? AND status IN ('held','paid','done') GROUP BY date, source, status`,
      ).bind(from, to).all<{ date: string; source: string; status: string; n: number }>(),
    ]);
    const adminCap = new Map(adminRows.results.map((x) => [x.date, x.cap]));
    const clk = { now: clock(), tz: config.timezone };
    const days = dates.map((d) => {
      const o = overrides.get(d) ?? null;
      const rows = counts.results.filter((x) => x.date === d);
      const n = (src: string, st: string) => rows.filter((x) => x.source === src && x.status === st).reduce((a, x) => a + x.n, 0);
      return {
        ...availabilityFor(d, defaults, o, used.get(d) ?? 0, clk),
        closed: o?.closed ?? false,
        overrideCap: adminCap.get(d) ?? null,
        paidCount: n("one_time", "paid") + n("one_time", "done"),
        heldCount: n("one_time", "held"),
        subscriptionCount: n("subscription", "paid") + n("subscription", "done"),
      };
    });
    return c.json({ days });
  });

  r.put("/admin/api/days/:date", async (c) => {
    const date = c.req.param("date");
    if (!isYmd(date)) return c.json({ error: "bad date" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (body.cap !== undefined && !validCap(body.cap)) return c.json({ error: "cap must be a non-negative integer or null" }, 400);
    if (body.closed !== undefined && typeof body.closed !== "boolean") return c.json({ error: "closed must be boolean" }, 400);
    const cur = await c.env.DB.prepare("SELECT cap, closed FROM day_overrides WHERE date = ? AND source = 'admin'").bind(date).first<{ cap: number | null; closed: number }>();
    await putAdminOverride(c.env.DB, date, {
      cap: body.cap !== undefined ? body.cap : cur?.cap ?? null,
      closed: body.closed !== undefined ? body.closed : Boolean(cur?.closed),
    });
    return c.json({ ok: true });
  });

  r.delete("/admin/api/days/:date", async (c) => {
    const date = c.req.param("date");
    if (!isYmd(date)) return c.json({ error: "bad date" }, 400);
    await clearAdminOverride(c.env.DB, date);
    return c.body(null, 204);
  });

  r.get("/admin/api/settings", async (c) => c.json(await loadDefaults(c.env.DB, c.get("services").config.defaults)));

  r.put("/admin/api/settings", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const v = validateSettingsPatch(body);
    if (!v.ok) return c.json({ error: v.error }, 400);
    await saveDefaults(c.env.DB, v.patch);
    return c.json(await loadDefaults(c.env.DB, c.get("services").config.defaults));
  });

  r.get("/admin/api/orders", async (c) => {
    const date = c.req.query("date");
    if (!isYmd(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    return c.json({ orders: await listOrders(c.env.DB, date) });
  });

  r.post("/admin/api/orders/:id/done", async (c) => {
    const o = await getOrder(c.env.DB, c.req.param("id"));
    if (!o) return c.json({ error: "not found" }, 404);
    if (o.status !== "paid") return c.json({ error: `cannot mark ${o.status} order done` }, 409);
    await setStatus(c.env.DB, o.id, "done");
    return c.json({ ok: true });
  });

  r.post("/admin/api/orders/:id/undone", async (c) => {
    const o = await getOrder(c.env.DB, c.req.param("id"));
    if (!o) return c.json({ error: "not found" }, 404);
    if (o.status !== "done") return c.json({ error: `order is ${o.status}` }, 409);
    await setStatus(c.env.DB, o.id, "paid");
    return c.json({ ok: true });
  });

  // Plan 4: who subscribes, what, and when their next bouquet falls. Pause/cancel live in Stripe's portal (D30 as decided 2026-09-10).
  r.get("/admin/api/subscribers", async (c) => {
    const { config, clock } = c.get("services");
    const today = ymdIn(config.timezone, clock());
    const subs = await listSubscribers(c.env.DB);
    const rows = subs.map((s) => {
      const cadence = config.subscriptions.cadences.find((x) => x.id === s.cadenceId);
      const next = s.status === "active" && cadence ? dueDates({ anchorDate: s.anchorDate, perMonth: cadence.perMonth, pausedWeeks: s.pausedWeeks }, today, addDays(today, 60))[0] ?? null : null;
      return {
        id: s.id, status: s.status, sizeId: s.sizeId, cadenceId: s.cadenceId, cadenceName: cadence?.name ?? s.cadenceId, weekday: s.weekday,
        fulfillment: s.fulfillment, anchorDate: s.anchorDate, nextDate: next, customerName: s.customerName, customerEmail: s.customerEmail,
        customerPhone: s.customerPhone, note: s.note, createdAt: s.createdAt,
      };
    });
    return c.json({ subscribers: rows, flags: await loadFlags(c.env.DB) });
  });

  registerGoogleAdmin(r);
  registerInstagramAdmin(r);

  return r;
}
