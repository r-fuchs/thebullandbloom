import { describe, it, expect } from "vitest";
import {
  MAX_SCHEDULE_DAYS, addressKey, deliveryItemName, deliveryWindow, fallbackFeeFor, parseAddress, pickupReadyFor,
} from "../../src/core/delivery";
import { loadConfig } from "../../src/config";

const cfg = loadConfig();
const min = (n: number) => n * 60_000;

describe("deliveryWindow", () => {
  it("satisfies every Uber constraint for a future pickup", () => {
    const now = new Date("2026-09-15T13:00:00Z");
    const ready = new Date("2026-09-16T13:00:00Z");
    const w = deliveryWindow(ready, now);
    expect(w.pickupReadyAt.toISOString()).toBe("2026-09-16T13:00:00.000Z");
    expect(+w.pickupDeadlineAt - +w.pickupReadyAt).toBeGreaterThanOrEqual(min(10));
    expect(+w.pickupDeadlineAt - +now).toBeGreaterThanOrEqual(min(20));
    expect(+w.dropoffReadyAt).toBeLessThanOrEqual(+w.pickupDeadlineAt);
    expect(+w.dropoffDeadlineAt - +w.dropoffReadyAt).toBeGreaterThanOrEqual(min(20));
    expect(+w.dropoffDeadlineAt).toBeGreaterThanOrEqual(+w.pickupDeadlineAt);
  });

  it("never asks for a pickup in the past, and still clears the 20-minute deadline floor", () => {
    const now = new Date("2026-09-16T18:00:00Z");
    const ready = new Date("2026-09-16T13:00:00Z"); // this morning's ready time, already gone
    const w = deliveryWindow(ready, now);
    expect(+w.pickupReadyAt).toBe(+now);
    expect(+w.pickupDeadlineAt - +now).toBeGreaterThanOrEqual(min(20));
  });

  it("holds the deadline floor even when the pickup window would be too soon", () => {
    const now = new Date("2026-09-16T18:00:00Z");
    const w = deliveryWindow(new Date("2026-09-16T18:01:00Z"), now);
    expect(+w.pickupDeadlineAt - +now).toBeGreaterThanOrEqual(min(20));
  });
});

describe("pickupReadyFor", () => {
  it("schedules for the studio ready time on the order date, in studio time", () => {
    const now = new Date("2026-09-15T13:00:00Z");
    const r = pickupReadyFor(cfg, "2026-09-16", now);
    expect(r.scheduled).toBe(true);
    // 09:00 America/New_York on 2026-09-16 is 13:00 UTC (EDT).
    expect(r.at.toISOString()).toBe("2026-09-16T13:00:00.000Z");
  });

  it("falls back to an ASAP estimate beyond Uber's 30-day scheduling limit", () => {
    const now = new Date("2026-09-15T13:00:00Z");
    const far = new Date(+now + (MAX_SCHEDULE_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);
    const r = pickupReadyFor(cfg, far, now);
    expect(r.scheduled).toBe(false);
    expect(+r.at).toBe(+now);
  });
});

describe("parseAddress", () => {
  const good = { street: " 5 Elm Street ", unit: " Apt 2 ", city: " Hudson ", state: "ny", zip: "12534" };

  it("trims, upper-cases the state, and keeps the unit optional", () => {
    const r = parseAddress(good);
    expect(r.ok && r.address).toEqual({ street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" });
    const noUnit = parseAddress({ ...good, unit: undefined });
    expect(noUnit.ok && noUnit.address.unit).toBe("");
  });

  it("rejects every missing or malformed field with a message a person can act on", () => {
    expect(parseAddress(null)).toEqual({ ok: false, error: "address required" });
    expect(parseAddress({ ...good, street: "" })).toEqual({ ok: false, error: "street address required" });
    expect(parseAddress({ ...good, city: "  " })).toEqual({ ok: false, error: "city required" });
    expect(parseAddress({ ...good, state: "New York" })).toEqual({ ok: false, error: "state must be a two-letter code" });
    expect(parseAddress({ ...good, zip: "1253" })).toEqual({ ok: false, error: "zip must be five digits" });
    expect(parseAddress({ ...good, street: "x".repeat(201) })).toEqual({ ok: false, error: "street address is too long" });
  });
});

describe("addressKey", () => {
  it("is stable across case and spacing so a re-typed address keeps its quote", () => {
    const a = { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" };
    const b = { street: "5 elm street", unit: "apt 2", city: "HUDSON", state: "NY", zip: "12534" };
    expect(addressKey(a)).toBe(addressKey(b));
    expect(addressKey({ ...a, zip: "12535" })).not.toBe(addressKey(a));
  });
});

describe("fallbackFeeFor", () => {
  it("returns the flat fee for a listed zip and null for anything else", () => {
    expect(fallbackFeeFor(cfg, cfg.delivery.fallbackZips[0])).toBe(cfg.delivery.fallbackFeeCents);
    expect(fallbackFeeFor(cfg, "99999")).toBeNull();
  });
  it("returns null for every zip when the list is empty", () => {
    expect(fallbackFeeFor({ ...cfg, delivery: { fallbackFeeCents: 1500, fallbackZips: [] } }, "12534")).toBeNull();
  });
});

describe("deliveryItemName", () => {
  it("names the parcel for the courier without revealing the customer", () => {
    expect(deliveryItemName("Bouquet")).toBe("Bouquet — hand-tied flowers");
  });
});
