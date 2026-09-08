import { Hono } from "hono";
import type { App } from "../app";
import { availabilityFor } from "../core/capacity";
import { isYmd, ymdRange } from "../core/time";
import { loadDefaults } from "../store/settings";
import { getOverrides } from "../store/overrides";
import { countUsed } from "../store/orders";

const MAX_DAYS = 62;

export function publicRoutes(): App {
  const r: App = new Hono();

  r.get("/api/config", (c) => {
    const { config } = c.get("services");
    return c.json({
      timezone: config.timezone,
      sizes: config.sizes,
      studio: { pickupInstructions: config.studio.pickupInstructions },
    });
  });

  r.get("/api/availability", async (c) => {
    const { config, clock } = c.get("services");
    const from = c.req.query("from"), to = c.req.query("to");
    if (!isYmd(from) || !isYmd(to)) return c.json({ error: "from and to must be YYYY-MM-DD" }, 400);
    const dates = ymdRange(from, to);
    if (dates.length === 0 || dates.length > MAX_DAYS) return c.json({ error: `range must be 1..${MAX_DAYS} days` }, 400);
    const [defaults, overrides, used] = await Promise.all([
      loadDefaults(c.env.DB, config.defaults),
      getOverrides(c.env.DB, from, to),
      countUsed(c.env.DB, from, to),
    ]);
    const clk = { now: clock(), tz: config.timezone };
    const days = dates.map((d) => availabilityFor(d, defaults, overrides.get(d) ?? null, used.get(d) ?? 0, clk));
    return c.json({ days });
  });

  return r;
}
