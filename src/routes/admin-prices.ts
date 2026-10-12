import type { App } from "../app";
import { sizeById, subscriptionCell, type StoreConfig } from "../config";
import { loadPrices, savePrices, applyPrices, type PriceOverrides } from "../store/prices";

/** $100,000 in cents: anything above this is a typo, not a bouquet. */
const MAX_CENTS = 10_000_000;

function cents(v: unknown, min: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= MAX_CENTS;
}

/**
 * Checks a save from the admin and drops any value equal to its config default,
 * so the config stays the source of truth until a price is actually changed.
 */
export function validatePrices(cfg: StoreConfig, body: any): { ok: true; prices: PriceOverrides } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const sizesIn = body.sizes ?? {}, cellsIn = body.cells ?? {};
  if (typeof sizesIn !== "object" || Array.isArray(sizesIn) || typeof cellsIn !== "object" || Array.isArray(cellsIn)) return { ok: false, error: "sizes and cells must be objects" };
  const prices: PriceOverrides = { sizes: {}, cells: {} };
  for (const [id, v] of Object.entries<any>(sizesIn)) {
    const size = sizeById(cfg, id);
    if (!size) return { ok: false, error: `unknown size ${id}` };
    if (!v || typeof v !== "object") return { ok: false, error: `size ${id} must be an object` };
    const o: { priceCents?: number; vaseFeeCents?: number } = {};
    if (v.priceCents !== undefined) {
      if (!cents(v.priceCents, 1)) return { ok: false, error: `size ${id} priceCents must be a positive whole number of cents` };
      if (v.priceCents !== size.priceCents) o.priceCents = v.priceCents;
    }
    if (v.vaseFeeCents !== undefined) {
      if (!cents(v.vaseFeeCents, 0)) return { ok: false, error: `size ${id} vaseFeeCents must be a whole number of cents` };
      if (v.vaseFeeCents !== size.vaseFeeCents) o.vaseFeeCents = v.vaseFeeCents;
    }
    if (Object.keys(o).length) prices.sizes[id] = o;
  }
  for (const [key, v] of Object.entries<unknown>(cellsIn)) {
    const [sizeId = "", cadenceId = ""] = key.split("/");
    const cell = subscriptionCell(cfg, sizeId, cadenceId);
    if (!cell) return { ok: false, error: `unknown subscription ${key}` };
    if (!cents(v, 1)) return { ok: false, error: `subscription ${key} must be a positive whole number of cents` };
    if (v !== cell.priceCents) prices.cells[key] = v;
  }
  return { ok: true, prices };
}

/** What the admin Prices table shows: the price in force beside the config default, for every size and cell. */
export function priceSheet(cfg: StoreConfig, prices: PriceOverrides) {
  const priced = applyPrices(cfg, prices);
  return {
    cadences: cfg.subscriptions.cadences.map((c) => ({ id: c.id, name: c.name })),
    sizes: priced.sizes.map((s, i) => ({
      id: s.id, name: s.name, description: s.description, priceCents: s.priceCents, vaseFeeCents: s.vaseFeeCents,
      defaults: { priceCents: cfg.sizes[i].priceCents, vaseFeeCents: cfg.sizes[i].vaseFeeCents },
    })),
    cells: priced.subscriptions.cells.map((c, i) => ({
      sizeId: c.sizeId, cadenceId: c.cadenceId, priceCents: c.priceCents, defaults: { priceCents: cfg.subscriptions.cells[i].priceCents },
    })),
  };
}

/** Mounted from adminRoutes() AFTER its Access middleware, so every route here needs an identity. */
export function registerPricesAdmin(r: App): void {
  // Both routes work from the shipped config: services.config already carries the saved prices.
  r.get("/admin/api/prices", async (c) => c.json(priceSheet(c.get("baseConfig"), await loadPrices(c.env.DB))));

  r.put("/admin/api/prices", async (c) => {
    const config = c.get("baseConfig");
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const v = validatePrices(config, body);
    if (!v.ok) return c.json({ error: v.error }, 400);
    await savePrices(c.env.DB, v.prices);
    return c.json(priceSheet(config, v.prices));
  });
}
