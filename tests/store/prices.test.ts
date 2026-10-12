import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { loadConfig, subscriptionCell } from "../../src/config";
import { loadPrices, savePrices, pricedConfig } from "../../src/store/prices";

const cfg = loadConfig();
const posy = cfg.sizes[0];

describe("prices", () => {
  it("has nothing saved to begin with and leaves the config alone", async () => {
    expect(await loadPrices(env.DB)).toEqual({ sizes: {}, cells: {} });
    const priced = await pricedConfig(env.DB, cfg);
    expect(priced.sizes).toEqual(cfg.sizes);
    expect(priced.subscriptions.cells).toEqual(cfg.subscriptions.cells);
  });

  it("overlays saved prices onto the config and keeps everything else", async () => {
    await savePrices(env.DB, { sizes: { [posy.id]: { priceCents: 6500 } }, cells: { [`${posy.id}/weekly`]: 20000 } });
    expect(await loadPrices(env.DB)).toEqual({ sizes: { [posy.id]: { priceCents: 6500 } }, cells: { [`${posy.id}/weekly`]: 20000 } });
    const priced = await pricedConfig(env.DB, cfg);
    expect(priced.sizes[0]).toEqual({ ...posy, priceCents: 6500 });
    expect(priced.sizes.slice(1)).toEqual(cfg.sizes.slice(1));
    expect(subscriptionCell(priced, posy.id, "weekly")?.priceCents).toBe(20000);
    expect(subscriptionCell(priced, posy.id, "twice-monthly")?.priceCents).toBe(subscriptionCell(cfg, posy.id, "twice-monthly")?.priceCents);
    expect(priced.timezone).toBe(cfg.timezone);
  });

  it("replaces the whole set on save so a cleared price goes back to the config", async () => {
    await savePrices(env.DB, { sizes: { [posy.id]: { vaseFeeCents: 1800 } }, cells: {} });
    const priced = await pricedConfig(env.DB, cfg);
    expect(priced.sizes[0]).toEqual({ ...posy, vaseFeeCents: 1800 });
    expect(subscriptionCell(priced, posy.id, "weekly")?.priceCents).toBe(subscriptionCell(cfg, posy.id, "weekly")?.priceCents);
  });

  it("ignores saved ids the config no longer has", async () => {
    await savePrices(env.DB, { sizes: { gone: { priceCents: 100 } }, cells: { "gone/weekly": 100, [`${posy.id}/never`]: 100 } });
    const priced = await pricedConfig(env.DB, cfg);
    expect(priced.sizes).toEqual(cfg.sizes);
    expect(priced.subscriptions.cells).toEqual(cfg.subscriptions.cells);
  });

  it("does not mutate the config it was given", async () => {
    await savePrices(env.DB, { sizes: { [posy.id]: { priceCents: 9900 } }, cells: {} });
    const before = JSON.stringify(cfg);
    await pricedConfig(env.DB, cfg);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});
