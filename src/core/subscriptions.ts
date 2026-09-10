import { addDays, weekdayOf } from "./time";

/** Days between bouquets for a cadence: 4 a month = weekly, 2 = every other week, 1 = every four weeks (D26). */
export function intervalDays(perMonth: number): number {
  if (perMonth === 4) return 7;
  if (perMonth === 2) return 14;
  if (perMonth === 1) return 28;
  throw new Error(`subscriptions: unsupported cadence perMonth=${perMonth}`);
}

/** Monday of the Mon–Sun week holding `ymd`, as YYYY-MM-DD. The key admin uses to pause a week (D30). */
export function weekKey(ymd: string): string {
  const wd = weekdayOf(ymd); // 0 = Sunday
  return addDays(ymd, wd === 0 ? -6 : 1 - wd);
}

/** Sunday of the same Mon–Sun week. */
function weekEnd(ymd: string): string {
  return addDays(weekKey(ymd), 6);
}

export type IsOpen = (ymd: string) => boolean;

/**
 * First date on `weekday` at least `leadDays` after `fromYmd` that is open, searching eight weeks.
 * Null when nothing in that window is open (a fully closed studio); the caller decides.
 */
export function nextAnchor(weekday: number, fromYmd: string, leadDays: number, isOpen: IsOpen): string | null {
  let d = addDays(fromYmd, leadDays);
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  for (let i = 0; i < 8; i++, d = addDays(d, 7)) if (isOpen(d)) return d;
  return null;
}

export interface DueInput { anchorDate: string; perMonth: number; pausedWeeks: readonly string[] }

/** Dates the subscriber is due a bouquet in [from, to], on the cadence from the anchor, skipping paused weeks. */
export function dueDates(sub: DueInput, from: string, to: string): string[] {
  const step = intervalDays(sub.perMonth);
  const paused = new Set(sub.pausedWeeks);
  const out: string[] = [];
  for (let d = sub.anchorDate; d <= to; d = addDays(d, step)) {
    if (d < from) continue;
    if (paused.has(weekKey(d))) continue;
    out.push(d);
  }
  return out;
}

export type Shift = { date: string; shifted: boolean } | { skipped: true; week: string };

/**
 * D13: a bouquet due on a closed day moves to the next open day in the same Mon–Sun week;
 * a fully closed week is skipped and flagged (the caller records the week for admin).
 */
export function shiftForClosed(date: string, isOpen: IsOpen): Shift {
  if (isOpen(date)) return { date, shifted: false };
  const end = weekEnd(date);
  for (let d = addDays(date, 1); d <= end; d = addDays(d, 1)) if (isOpen(d)) return { date: d, shifted: true };
  return { skipped: true, week: weekKey(date) };
}
