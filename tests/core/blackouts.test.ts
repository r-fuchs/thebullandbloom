import { describe, it, expect } from "vitest";
import { closedDatesFromEvents } from "../../src/core/blackouts";

const TZ = "America/New_York";
const FROM = "2026-09-08", TO = "2026-12-07";
const keys = (m: Map<string, string>) => [...m.keys()].sort();

describe("closedDatesFromEvents", () => {
  it("covers a single all-day event", () => {
    const m = closedDatesFromEvents([{ id: "e1", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }], TZ, FROM, TO);
    expect([...m]).toEqual([["2026-09-10", "e1"]]);
  });
  it("treats the all-day end date as exclusive", () => {
    const m = closedDatesFromEvents([{ id: "e1", start: { date: "2026-09-10" }, end: { date: "2026-09-13" } }], TZ, FROM, TO);
    expect(keys(m)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
  });
  it("covers start.date only when end is missing or not after start", () => {
    expect(keys(closedDatesFromEvents([{ id: "e", start: { date: "2026-09-10" }, end: {} }], TZ, FROM, TO))).toEqual(["2026-09-10"]);
    expect(keys(closedDatesFromEvents([{ id: "e", start: { date: "2026-09-10" }, end: { date: "2026-09-10" } }], TZ, FROM, TO))).toEqual(["2026-09-10"]);
  });
  it("maps a timed event to its studio-local dates, crossing midnight in New York", () => {
    // 2026-09-10 23:00 EDT (03:00Z on the 11th) to 2026-09-11 01:00 EDT (05:00Z)
    const m = closedDatesFromEvents([{ id: "t", start: { dateTime: "2026-09-11T03:00:00Z" }, end: { dateTime: "2026-09-11T05:00:00Z" } }], TZ, FROM, TO);
    expect(keys(m)).toEqual(["2026-09-10", "2026-09-11"]);
  });
  it("does not close the next day when a timed event ends exactly at local midnight", () => {
    // 2026-09-10 20:00 EDT to 2026-09-11 00:00 EDT (04:00Z)
    const m = closedDatesFromEvents([{ id: "t", start: { dateTime: "2026-09-11T00:00:00Z" }, end: { dateTime: "2026-09-11T04:00:00Z" } }], TZ, FROM, TO);
    expect(keys(m)).toEqual(["2026-09-10"]);
  });
  it("ignores cancelled and malformed events", () => {
    const m = closedDatesFromEvents([
      { id: "c", status: "cancelled", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } },
      { id: "x", start: {}, end: {} },
    ], TZ, FROM, TO);
    expect(m.size).toBe(0);
  });
  it("clips to the window and keeps the first event for a day", () => {
    const m = closedDatesFromEvents([
      { id: "a", start: { date: "2026-09-06" }, end: { date: "2026-09-10" } },
      { id: "b", start: { date: "2026-09-09" }, end: { date: "2026-09-12" } },
      { id: "z", start: { date: "2026-12-06" }, end: { date: "2026-12-10" } },
    ], TZ, FROM, TO);
    expect([...m]).toEqual([
      ["2026-09-08", "a"], ["2026-09-09", "a"], ["2026-09-10", "b"], ["2026-09-11", "b"],
      ["2026-12-06", "z"], ["2026-12-07", "z"],
    ]);
  });
});
