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
  it("loads the studio ready time, phone, structured address, and delivery fallback", () => {
    const cfg = loadConfig();
    expect(cfg.studio.readyTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(cfg.studio.phone).toMatch(/^\+1\d{10}$/);
    expect(cfg.studio.address.state).toHaveLength(2);
    expect(cfg.studio.address.zip).toMatch(/^\d{5}$/);
    expect(Number.isInteger(cfg.delivery.fallbackFeeCents)).toBe(true);
    expect(Array.isArray(cfg.delivery.fallbackZips)).toBe(true);
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
  it("rejects a bad delivery fallback", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, delivery: { fallbackFeeCents: -1, fallbackZips: [] } })).toThrow(/fallbackFeeCents/);
    expect(() => validateConfig({ ...base, delivery: { fallbackFeeCents: 1500, fallbackZips: ["1253"] } })).toThrow(/fallbackZips/);
  });
  it("accepts an empty fallback zip list (no fallback offered)", () => {
    const base = loadConfig();
    expect(validateConfig({ ...base, delivery: { fallbackFeeCents: 1500, fallbackZips: [] } }).delivery.fallbackZips).toEqual([]);
  });
});
