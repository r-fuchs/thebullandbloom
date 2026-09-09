import { describe, it, expect } from "vitest";
import { ymdIn, hmIn, weekdayOf, addDays, isYmd, ymdRange, humanDate, longDate, instantAt } from "../../src/core/time";

const NY = "America/New_York";

describe("time", () => {
  it("renders date and time in the studio timezone", () => {
    // 2026-09-08T03:30Z is 2026-09-07 23:30 in New York (EDT, UTC-4)
    const at = new Date("2026-09-08T03:30:00Z");
    expect(ymdIn(NY, at)).toBe("2026-09-07");
    expect(hmIn(NY, at)).toBe("23:30");
  });
  it("renders midnight as 00:00 not 24:00", () => {
    const at = new Date("2026-09-08T04:00:00Z"); // 00:00 EDT
    expect(hmIn(NY, at)).toBe("00:00");
  });
  it("computes weekday without timezone drift", () => {
    expect(weekdayOf("2026-09-07")).toBe(1); // Monday
    expect(weekdayOf("2026-09-13")).toBe(0); // Sunday
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("validates YMD strings strictly", () => {
    expect(isYmd("2026-09-07")).toBe(true);
    expect(isYmd("2026-9-7")).toBe(false);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd(42)).toBe(false);
  });
  it("builds inclusive ranges", () => {
    expect(ymdRange("2026-09-07", "2026-09-09")).toEqual(["2026-09-07", "2026-09-08", "2026-09-09"]);
    expect(ymdRange("2026-09-09", "2026-09-07")).toEqual([]);
  });
  it("formats human and long dates", () => {
    expect(humanDate("2026-09-09")).toBe("Wed Sep 9");
    expect(longDate("2026-09-09")).toBe("Wednesday, September 9");
    expect(longDate("2026-11-01")).toBe("Sunday, November 1");
  });
});

describe("instantAt", () => {
  it("resolves a studio-local wall time to the right UTC instant in EDT", () => {
    expect(instantAt("America/New_York", "2026-09-15", "09:00").toISOString()).toBe("2026-09-15T13:00:00.000Z");
  });
  it("resolves the same wall time to a different instant in EST", () => {
    expect(instantAt("America/New_York", "2026-12-15", "09:00").toISOString()).toBe("2026-12-15T14:00:00.000Z");
  });
  it("handles the spring-forward day (2 am does not exist; 3 am local is returned)", () => {
    // 2027-03-14 is the US spring-forward date. 02:30 local does not exist; the
    // corrected instant lands on the instant Intl reports as 03:30 EDT.
    const d = instantAt("America/New_York", "2027-03-14", "02:30");
    expect(hmIn("America/New_York", d)).toBe("03:30");
  });
  it("round-trips any ordinary time through ymdIn/hmIn", () => {
    const d = instantAt("America/New_York", "2026-11-20", "16:45");
    expect(ymdIn("America/New_York", d)).toBe("2026-11-20");
    expect(hmIn("America/New_York", d)).toBe("16:45");
  });
});
