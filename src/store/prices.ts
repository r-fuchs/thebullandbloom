import type { StoreConfig } from "../config";

/**
 * Prices Anthony sets from the admin, kept in the `settings` table under one key.
 * `store.config.json` stays the default: a size or cell missing here sells at its config price.
 * Cells are keyed `sizeId/cadenceId`. Ids the config no longer has are ignored when applied.
 */
export interface PriceOverrides {
  sizes: Record<string, { priceCents?: number; vaseFeeCents?: number }>;
  cells: Record<string, number>;
}

const KEY = "prices";

export async function loadPrices(db: D1Database): Promise<PriceOverrides> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(KEY).first<{ value_json: string }>();
  if (!row) return { sizes: {}, cells: {} };
  const parsed = JSON.parse(row.value_json) as Partial<PriceOverrides>;
  return { sizes: parsed.sizes ?? {}, cells: parsed.cells ?? {} };
}

/** Replaces the whole set, so leaving a size or cell out returns it to its config price. */
export async function savePrices(db: D1Database, prices: PriceOverrides): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(KEY, JSON.stringify({ sizes: prices.sizes, cells: prices.cells })).run();
}

/** The config with saved prices laid over it. Never mutates `cfg`. */
export function applyPrices(cfg: StoreConfig, prices: PriceOverrides): StoreConfig {
  const sizes = cfg.sizes.map((s) => {
    const o = prices.sizes[s.id];
    if (!o) return s;
    return { ...s, ...(o.priceCents !== undefined ? { priceCents: o.priceCents } : {}), ...(o.vaseFeeCents !== undefined ? { vaseFeeCents: o.vaseFeeCents } : {}) };
  });
  const cells = cfg.subscriptions.cells.map((c) => {
    const p = prices.cells[`${c.sizeId}/${c.cadenceId}`];
    return p === undefined ? c : { ...c, priceCents: p };
  });
  return { ...cfg, sizes, subscriptions: { ...cfg.subscriptions, cells } };
}

export async function pricedConfig(db: D1Database, cfg: StoreConfig): Promise<StoreConfig> {
  return applyPrices(cfg, await loadPrices(db));
}
