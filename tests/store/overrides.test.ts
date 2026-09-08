import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getOverrides, putAdminOverride, clearAdminOverride, syncCalendarOverrides } from "../../src/store/overrides";

describe("overrides", () => {
  it("round-trips an admin override", async () => {
    await putAdminOverride(env.DB, "2026-09-10", { cap: 2, closed: false });
    const m = await getOverrides(env.DB, "2026-09-01", "2026-09-30");
    expect(m.get("2026-09-10")).toEqual({ cap: 2, closed: false });
  });
  it("replaces on second put and clears", async () => {
    await putAdminOverride(env.DB, "2026-09-11", { cap: null, closed: true });
    await putAdminOverride(env.DB, "2026-09-11", { cap: 5, closed: false });
    expect((await getOverrides(env.DB, "2026-09-11", "2026-09-11")).get("2026-09-11")).toEqual({ cap: 5, closed: false });
    await clearAdminOverride(env.DB, "2026-09-11");
    expect((await getOverrides(env.DB, "2026-09-11", "2026-09-11")).has("2026-09-11")).toBe(false);
  });
  it("merges sources: closed wins from either, cap from admin", async () => {
    await env.DB.prepare("INSERT INTO day_overrides (date, source, cap, closed) VALUES ('2026-09-12','calendar',NULL,1)").run();
    await putAdminOverride(env.DB, "2026-09-12", { cap: 3, closed: false });
    expect((await getOverrides(env.DB, "2026-09-12", "2026-09-12")).get("2026-09-12")).toEqual({ cap: 3, closed: true });
  });
  it("respects the date range", async () => {
    await putAdminOverride(env.DB, "2026-10-01", { cap: 1, closed: false });
    expect((await getOverrides(env.DB, "2026-09-01", "2026-09-30")).has("2026-10-01")).toBe(false);
  });
});

describe("syncCalendarOverrides", () => {
  it("adds and removes calendar rows without touching admin rows", async () => {
    await env.DB.prepare("DELETE FROM day_overrides WHERE date BETWEEN '2026-10-01' AND '2026-10-31'").run();
    await env.DB.prepare("INSERT INTO day_overrides (date, source, cap, closed) VALUES ('2026-10-02', 'admin', 2, 0)").run();
    await env.DB.prepare("INSERT INTO day_overrides (date, source, cap, closed, calendar_event_id) VALUES ('2026-10-03', 'calendar', NULL, 1, 'old')").run();

    const r1 = await syncCalendarOverrides(env.DB, "2026-10-01", "2026-10-31", new Map([["2026-10-02", "e2"], ["2026-10-05", "e5"]]));
    expect(r1).toEqual({ added: 2, removed: 1 });
    const rows = await env.DB.prepare("SELECT date, source, cap, closed, calendar_event_id FROM day_overrides WHERE date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY date, source").all<any>();
    expect(rows.results).toEqual([
      { date: "2026-10-02", source: "admin", cap: 2, closed: 0, calendar_event_id: null },
      { date: "2026-10-02", source: "calendar", cap: null, closed: 1, calendar_event_id: "e2" },
      { date: "2026-10-05", source: "calendar", cap: null, closed: 1, calendar_event_id: "e5" },
    ]);
    // the merged view: 10-02 is closed (calendar wins on closed) with the admin cap still recorded
    const merged = await getOverrides(env.DB, "2026-10-01", "2026-10-31");
    expect(merged.get("2026-10-02")).toEqual({ cap: 2, closed: true });
    expect(merged.get("2026-10-05")).toEqual({ cap: null, closed: true });

    const r2 = await syncCalendarOverrides(env.DB, "2026-10-01", "2026-10-31", new Map([["2026-10-05", "e5b"]]));
    expect(r2).toEqual({ added: 0, removed: 1 });
    const after = await env.DB.prepare("SELECT date, source, calendar_event_id FROM day_overrides WHERE date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY date, source").all<any>();
    expect(after.results).toEqual([
      { date: "2026-10-02", source: "admin", calendar_event_id: null },
      { date: "2026-10-05", source: "calendar", calendar_event_id: "e5b" },
    ]);
  });
  it("leaves calendar rows outside the window alone", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO day_overrides (date, source, cap, closed, calendar_event_id) VALUES ('2027-01-05', 'calendar', NULL, 1, 'far')").run();
    await syncCalendarOverrides(env.DB, "2026-10-01", "2026-10-31", new Map());
    const far = await env.DB.prepare("SELECT calendar_event_id FROM day_overrides WHERE date = '2027-01-05'").first<any>();
    expect(far).toEqual({ calendar_event_id: "far" });
  });
});
