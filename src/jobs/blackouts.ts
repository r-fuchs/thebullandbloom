import type { Google } from "../adapters/google";
import { closedDatesFromEvents } from "../core/blackouts";
import { addDays, ymdIn } from "../core/time";
import { loadState, recordSync } from "../store/google";
import { syncCalendarOverrides } from "../store/overrides";

export const SYNC_DAYS = 90; // spec §4.4

export type BlackoutSyncResult =
  | { status: "skipped" }
  | { status: "ok"; added: number; removed: number; closed: number }
  | { status: "error"; error: string };

/** Read the Closed calendar for the next SYNC_DAYS days and mirror it into calendar-sourced overrides. */
export async function syncBlackouts(db: D1Database, google: Google, tz: string, now: Date): Promise<BlackoutSyncResult> {
  const state = await loadState(db);
  if (!state) return { status: "skipped" };
  const from = ymdIn(tz, now);
  const to = addDays(from, SYNC_DAYS);
  const nowSec = Math.floor(now.getTime() / 1000);
  try {
    // Pad the query window by a day each side: an event that began yesterday may still cover today,
    // and the exclusive all-day end can sit on the day after `to`.
    const timeMin = new Date(`${addDays(from, -1)}T00:00:00Z`);
    const timeMax = new Date(`${addDays(to, 2)}T00:00:00Z`);
    const events = await google.listEvents(state.closedCalendarId, timeMin, timeMax);
    const closed = closedDatesFromEvents(events, tz, from, to);
    const { added, removed } = await syncCalendarOverrides(db, from, to, closed);
    await recordSync(db, nowSec, null);
    return { status: "ok", added, removed, closed: closed.size };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("blackouts: sync failed, keeping last state", error);
    await recordSync(db, nowSec, error);
    return { status: "error", error };
  }
}
