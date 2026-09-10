import { describe, it, expect } from "vitest";
import { loadConfig, sizeById, subscriptionCell, validateConfig } from "../src/config";

describe("config", () => {
  it("loads the repo config", () => {
    const cfg = loadConfig();
    expect(cfg.timezone).toBe("America/New_York");
    expect(cfg.sizes.length).toBeGreaterThan(0);
    expect(sizeById(cfg, cfg.sizes[0].id)?.id).toBe(cfg.sizes[0].id);
    expect(sizeById(cfg, "nope")).toBeUndefined();
  });
  it("rejects bad cutoff", () => {
    const cfg = { ...loadConfig(), defaults: { cap: 1, cutoff: "25:00", openWeekdays: [1] } };
    expect(() => validateConfig(cfg)).toThrow(/cutoff/);
  });
  it("rejects duplicate size ids and non-integer cents", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, sizes: [base.sizes[0], base.sizes[0]] })).toThrow(/duplicate/);
    expect(() => validateConfig({ ...base, sizes: [{ ...base.sizes[0], priceCents: 1.5 }] })).toThrow(/priceCents/);
  });
  it("rejects a bad owner email and identical calendar names", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, ownerEmail: "nope" } })).toThrow(/ownerEmail/);
    expect(() => validateConfig({ ...base, calendars: { closed: "Same", orders: "Same" } })).toThrow(/calendars/);
  });
  it("loads the subscription grid and finds a cell", () => {
    const cfg = loadConfig();
    expect(cfg.subscriptions.cadences.map((c) => c.id)).toEqual(["weekly", "twice-monthly"]);
    expect(cfg.subscriptions.cells).toHaveLength(cfg.sizes.length * cfg.subscriptions.cadences.length);
    expect(subscriptionCell(cfg, "bouquet", "weekly")?.priceCents).toBeGreaterThan(0);
    expect(subscriptionCell(cfg, "bouquet", "nope")).toBeUndefined();
  });
  it("rejects subscription cells that name unknown sizes or cadences, duplicates, and bad prices", () => {
    const base = loadConfig();
    const sub = (cells: any[]) => ({ ...base, subscriptions: { ...base.subscriptions, cells } });
    expect(() => validateConfig(sub([{ sizeId: "nope", cadenceId: "weekly", priceCents: 100 }]))).toThrow(/unknown size/);
    expect(() => validateConfig(sub([{ sizeId: "posy", cadenceId: "nope", priceCents: 100 }]))).toThrow(/unknown cadence/);
    const c = base.subscriptions.cells[0];
    expect(() => validateConfig(sub([c, c]))).toThrow(/duplicate subscription cell/);
    expect(() => validateConfig(sub([{ ...c, priceCents: 0 }]))).toThrow(/priceCents/);
    expect(() => validateConfig({ ...base, subscriptions: { ...base.subscriptions, cadences: [{ id: "weekly", name: "x", perMonth: 9 }] } })).toThrow(/perMonth/);
  });
});
