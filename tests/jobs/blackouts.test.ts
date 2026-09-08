import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { syncBlackouts, SYNC_DAYS } from "../../src/jobs/blackouts";
import { clearConnection, saveState, loadSync } from "../../src/store/google";
import { FakeGoogle } from "../fakes/google";

const TZ = "America/New_York";
const NOW = new Date("2026-09-08T14:00:00Z"); // Tue Sep 8, 10:00 EDT
const STATE = { account: "a@b.c", closedCalendarId: "cal_closed", ordersCalendarId: "cal_orders", connectedAt: 1 };

describe("syncBlackouts", () => {
  beforeEach(async () => {
    await clearConnection(env.DB);
    await env.DB.prepare("DELETE FROM day_overrides WHERE source = 'calendar'").run();
  });

  it("skips when Google is not connected", async () => {
    const g = new FakeGoogle();
    expect(await syncBlackouts(env.DB, g, TZ, NOW)).toEqual({ status: "skipped" });
    expect(await loadSync(env.DB)).toEqual({ at: null, error: null });
  });

  it("writes closed days from the Closed calendar over a 90-day window and records the sync", async () => {
    await saveState(env.DB, STATE);
    const g = new FakeGoogle();
    g.events["cal_closed"] = [
      { id: "vac", start: { date: "2026-09-14" }, end: { date: "2026-09-17" } },
      { id: "past", start: { date: "2026-09-01" }, end: { date: "2026-09-02" } },
      { id: "far", start: { date: "2027-01-10" }, end: { date: "2027-01-11" } },
    ];
    const r = await syncBlackouts(env.DB, g, TZ, NOW);
    expect(r).toEqual({ status: "ok", added: 3, removed: 0, closed: 3 });
    const rows = await env.DB.prepare("SELECT date, calendar_event_id FROM day_overrides WHERE source = 'calendar' ORDER BY date").all<any>();
    expect(rows.results).toEqual([
      { date: "2026-09-14", calendar_event_id: "vac" },
      { date: "2026-09-15", calendar_event_id: "vac" },
      { date: "2026-09-16", calendar_event_id: "vac" },
    ]);
    expect(await loadSync(env.DB)).toEqual({ at: Math.floor(NOW.getTime() / 1000), error: null });
    expect(SYNC_DAYS).toBe(90);
  });

  it("removes days whose event disappeared", async () => {
    await saveState(env.DB, STATE);
    const g = new FakeGoogle();
    g.events["cal_closed"] = [{ id: "a", start: { date: "2026-09-20" }, end: { date: "2026-09-21" } }];
    await syncBlackouts(env.DB, g, TZ, NOW);
    g.events["cal_closed"] = [];
    expect(await syncBlackouts(env.DB, g, TZ, NOW)).toEqual({ status: "ok", added: 0, removed: 1, closed: 0 });
  });

  it("keeps the last state and records the error when Google fails", async () => {
    await saveState(env.DB, STATE);
    const g = new FakeGoogle();
    g.events["cal_closed"] = [{ id: "a", start: { date: "2026-09-20" }, end: { date: "2026-09-21" } }];
    await syncBlackouts(env.DB, g, TZ, NOW);
    g.failNext = "google down";
    const later = new Date(NOW.getTime() + 900_000);
    expect(await syncBlackouts(env.DB, g, TZ, later)).toEqual({ status: "error", error: "google down" });
    const rows = await env.DB.prepare("SELECT date FROM day_overrides WHERE source = 'calendar'").all<any>();
    expect(rows.results).toEqual([{ date: "2026-09-20" }]);
    expect(await loadSync(env.DB)).toEqual({ at: Math.floor(later.getTime() / 1000), error: "google down" });
  });
});
