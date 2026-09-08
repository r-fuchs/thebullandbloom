import type { CalendarEvent } from "../adapters/google";
import { addDays, ymdIn } from "./time";

/** Studio-local dates within [from, to] covered by any non-cancelled event, mapped to the first covering event's id. */
export function closedDatesFromEvents(events: CalendarEvent[], tz: string, from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    const span = spanOf(ev, tz);
    if (!span) continue;
    for (let d = span.first < from ? from : span.first; d <= span.last && d <= to; d = addDays(d, 1)) {
      if (!out.has(d)) out.set(d, ev.id);
    }
  }
  return out;
}

function spanOf(ev: CalendarEvent, tz: string): { first: string; last: string } | null {
  if (ev.start.date) {
    const first = ev.start.date;
    const last = ev.end.date && ev.end.date > first ? addDays(ev.end.date, -1) : first;
    return { first, last };
  }
  if (ev.start.dateTime) {
    const first = ymdIn(tz, new Date(ev.start.dateTime));
    const last = ev.end.dateTime ? ymdIn(tz, new Date(new Date(ev.end.dateTime).getTime() - 1)) : first;
    return { first, last: last < first ? first : last };
  }
  return null;
}
