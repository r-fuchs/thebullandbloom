import { describe, it, expect } from "vitest";
import { capFor, isOrderable, availabilityFor, type Defaults } from "../../src/core/capacity";

const NY = "America/New_York";
const defaults: Defaults = { cap: 4, cutoff: "11:00", openWeekdays: [2, 3, 4, 5, 6] }; // Tue–Sat
const tue = "2026-09-08", sun = "2026-09-13";
// 2026-09-08 10:00 EDT == 14:00Z ; 12:00 EDT == 16:00Z
const clockBeforeCutoff = { now: new Date("2026-09-08T14:00:00Z"), tz: NY };
const clockAfterCutoff = { now: new Date("2026-09-08T16:00:00Z"), tz: NY };

describe("capFor", () => {
  it("uses the default cap on an open weekday", () => expect(capFor(tue, defaults)).toBe(4));
  it("is zero on a non-open weekday", () => expect(capFor(sun, defaults)).toBe(0));
  it("is zero when closed, even with a cap override", () =>
    expect(capFor(tue, defaults, { cap: 9, closed: true })).toBe(0));
  it("uses the override cap", () => expect(capFor(tue, defaults, { cap: 2, closed: false })).toBe(2));
  it("an override cap opens a normally-closed weekday", () =>
    expect(capFor(sun, defaults, { cap: 3, closed: false })).toBe(3));
  it("a null override cap falls back to the default", () =>
    expect(capFor(tue, defaults, { cap: null, closed: false })).toBe(4));
});

describe("isOrderable", () => {
  it("past dates are never orderable", () =>
    expect(isOrderable("2026-09-07", 4, defaults, clockBeforeCutoff)).toBe(false));
  it("today is orderable before the cutoff with room", () =>
    expect(isOrderable(tue, 1, defaults, clockBeforeCutoff)).toBe(true));
  it("today is not orderable at or after the cutoff", () =>
    expect(isOrderable(tue, 1, defaults, clockAfterCutoff)).toBe(false));
  it("a future date is orderable after today's cutoff", () =>
    expect(isOrderable("2026-09-09", 1, defaults, clockAfterCutoff)).toBe(true));
  it("zero remaining is never orderable", () =>
    expect(isOrderable("2026-09-09", 0, defaults, clockBeforeCutoff)).toBe(false));
  it("the cutoff minute itself counts as closed", () => {
    const atCutoff = { now: new Date("2026-09-08T15:00:00Z"), tz: NY }; // 11:00 EDT
    expect(isOrderable(tue, 1, defaults, atCutoff)).toBe(false);
  });
});

describe("availabilityFor", () => {
  it("assembles the public shape", () => {
    expect(availabilityFor(tue, defaults, null, 3, clockBeforeCutoff)).toEqual({
      date: tue, open: true, cap: 4, used: 3, remaining: 1, orderable: true,
    });
  });
  it("remaining never goes negative", () => {
    const a = availabilityFor(tue, defaults, { cap: 2, closed: false }, 5, clockBeforeCutoff);
    expect(a.remaining).toBe(0);
    expect(a.orderable).toBe(false);
  });
  it("closed day reports open=false", () => {
    expect(availabilityFor(tue, defaults, { cap: null, closed: true }, 0, clockBeforeCutoff).open).toBe(false);
  });
});
