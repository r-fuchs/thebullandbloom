import { describe, it, expect } from "vitest";
import { dueDates, intervalDays, nextAnchor, shiftForClosed, weekKey } from "../../src/core/subscriptions";

// Studio open Tue–Sat; a closed set for specific days.
const open = (closed: string[] = []) => (d: string) => {
  const wd = new Date(d + "T00:00:00Z").getUTCDay();
  return wd >= 2 && wd <= 6 && !closed.includes(d);
};

describe("core/subscriptions", () => {
  it("maps cadences to day intervals and rejects the rest", () => {
    expect(intervalDays(4)).toBe(7); expect(intervalDays(2)).toBe(14); expect(intervalDays(1)).toBe(28);
    expect(() => intervalDays(3)).toThrow(/perMonth/);
  });

  it("keys a week by its Monday", () => {
    expect(weekKey("2026-09-10")).toBe("2026-09-07"); // Thu
    expect(weekKey("2026-09-07")).toBe("2026-09-07"); // Mon
    expect(weekKey("2026-09-13")).toBe("2026-09-07"); // Sun belongs to the week that started Mon 7th
    expect(weekKey("2026-09-14")).toBe("2026-09-14");
  });

  it("finds the first open weekday at least leadDays out", () => {
    // signup Thu Sep 10, 3-day lead → earliest Sun Sep 13; first Tuesday on/after is Sep 15
    expect(nextAnchor(2, "2026-09-10", 3, open())).toBe("2026-09-15");
    // same weekday as signup with lead 3 → next week
    expect(nextAnchor(4, "2026-09-10", 3, open())).toBe("2026-09-17");
    // that Tuesday closed → the following one
    expect(nextAnchor(2, "2026-09-10", 3, open(["2026-09-15"]))).toBe("2026-09-22");
    // nothing open for eight weeks → null
    expect(nextAnchor(2, "2026-09-10", 3, () => false)).toBeNull();
  });

  it("lists due dates on the cadence within a range, skipping paused weeks", () => {
    const weekly = { anchorDate: "2026-09-15", perMonth: 4, pausedWeeks: [] };
    expect(dueDates(weekly, "2026-09-10", "2026-10-10")).toEqual(["2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06"]);
    const twice = { anchorDate: "2026-09-15", perMonth: 2, pausedWeeks: ["2026-09-28"] };
    expect(dueDates(twice, "2026-09-10", "2026-10-31")).toEqual(["2026-09-15", "2026-10-13", "2026-10-27"]);
    // range starting after the anchor only returns what is inside it
    expect(dueDates(weekly, "2026-09-23", "2026-09-30")).toEqual(["2026-09-29"]);
  });

  it("handles a DST week without drifting off the weekday", () => {
    const weekly = { anchorDate: "2026-10-27", perMonth: 4, pausedWeeks: [] }; // Tue; DST ends Nov 1 in New York
    expect(dueDates(weekly, "2026-10-27", "2026-11-17")).toEqual(["2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17"]);
  });

  it("shifts a closed day to the next open day in the same Mon–Sun week, else skips the week", () => {
    expect(shiftForClosed("2026-09-15", open())).toEqual({ date: "2026-09-15", shifted: false });
    expect(shiftForClosed("2026-09-15", open(["2026-09-15"]))).toEqual({ date: "2026-09-16", shifted: true });
    // Saturday closed: Sunday is never open → skipped, flagged by Monday key
    expect(shiftForClosed("2026-09-19", open(["2026-09-19"]))).toEqual({ skipped: true, week: "2026-09-14" });
    const wholeWeek = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    expect(shiftForClosed("2026-09-15", open(wholeWeek))).toEqual({ skipped: true, week: "2026-09-14" });
  });
});
