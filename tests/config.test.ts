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
  it("loads the studio ready time, phone, structured address, and delivery zones", () => {
    const cfg = loadConfig();
    expect(cfg.studio.readyTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(cfg.studio.phone).toMatch(/^\+1\d{10}$/);
    expect(cfg.studio.address.state).toHaveLength(2);
    expect(cfg.studio.address.zip).toMatch(/^\d{5}$/);
    expect(cfg.delivery.zones.length).toBeGreaterThan(0);
    for (const z of cfg.delivery.zones) {
      expect(z.name).not.toBe("");
      expect(Number.isInteger(z.feeCents)).toBe(true);
      expect(z.zips.length).toBeGreaterThan(0);
    }
  });
  it("rejects a bad ready time", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, readyTime: "9am" } })).toThrow(/readyTime/);
  });
  it("rejects a studio phone that is not E.164", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, phone: "(518) 334-0517" } })).toThrow(/studio.phone/);
  });
  it("rejects an incomplete studio address", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, studio: { ...base.studio, address: { ...base.studio.address, zip: "1253" } } })).toThrow(/studio.address.zip/);
    expect(() => validateConfig({ ...base, studio: { ...base.studio, address: { ...base.studio.address, state: "New York" } } })).toThrow(/studio.address.state/);
    expect(() => validateConfig({ ...base, studio: { ...base.studio, address: { ...base.studio.address, city: "" } } })).toThrow(/studio.address.city/);
  });
  it("rejects a bad delivery zone", () => {
    const base = loadConfig();
    const zone = (over: Record<string, unknown>) => ({ ...base, delivery: { ...base.delivery, zones: [{ name: "Near", feeCents: 1000, zips: ["12203"], ...over }] } });
    expect(() => validateConfig(zone({ name: "" }))).toThrow(/zone needs a name/);
    expect(() => validateConfig(zone({ feeCents: -1 }))).toThrow(/feeCents/);
    expect(() => validateConfig(zone({ feeCents: 10.5 }))).toThrow(/feeCents/);
    expect(() => validateConfig(zone({ zips: ["1253"] }))).toThrow(/zips/);
    expect(() => validateConfig({ ...base, delivery: { ...base.delivery, zones: "nope" as any } })).toThrow(/delivery.zones/);
  });
  it("rejects a zip that appears in two zones", () => {
    const base = loadConfig();
    const zones = [{ name: "A", feeCents: 1000, zips: ["12203", "12204"] }, { name: "B", feeCents: 3500, zips: ["12866", "12204"] }];
    expect(() => validateConfig({ ...base, delivery: { ...base.delivery, zones } })).toThrow(/12204 is in two delivery zones/);
  });
  it("accepts delivery.mode uber, flat or absent, and rejects anything else", () => {
    const base = loadConfig();
    const d = base.delivery;
    expect(validateConfig({ ...base, delivery: { ...d, mode: "flat" } }).delivery.mode).toBe("flat");
    expect(validateConfig({ ...base, delivery: { ...d, mode: "uber" } }).delivery.mode).toBe("uber");
    const { mode: _m, ...noMode } = d;
    expect(validateConfig({ ...base, delivery: noMode }).delivery.mode).toBeUndefined();
    expect(() => validateConfig({ ...base, delivery: { ...d, mode: "sometimes" as any } })).toThrow(/delivery.mode/);
  });
  it("accepts an empty zone list (no fallback offered)", () => {
    const base = loadConfig();
    expect(validateConfig({ ...base, delivery: { ...base.delivery, zones: [] } }).delivery.zones).toEqual([]);
  });
});
