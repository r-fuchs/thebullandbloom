import type { Offer, OfferSession } from "../config";
import { humanDate, instantAt } from "./time";

export interface OfferClock { now: Date; tz: string }

/** The instant a session starts: its date and start time read on the studio clock. */
export function sessionStart(session: OfferSession, tz: string): Date {
  return instantAt(tz, session.date, session.start);
}

export function seatsRemaining(seats: number, taken: number): number {
  return Math.max(0, seats - taken);
}

/**
 * Why a session cannot be booked right now, ignoring seats: the offer is switched off, or the
 * start is not more than `bookingClosesHoursBefore` hours away (D54). Seats are the guarded
 * insert's business (sold_out), so a full session has no blocker here.
 */
export function bookingBlocker(offer: Offer, session: OfferSession, clock: OfferClock): "disabled" | "closed" | null {
  if (!offer.enabled) return "disabled";
  const closesAt = sessionStart(session, clock.tz).getTime() - offer.bookingClosesHoursBefore * 3_600_000;
  if (clock.now.getTime() >= closesAt) return "closed";
  return null;
}

export function isBookable(offer: Offer, session: OfferSession, taken: number, clock: OfferClock): boolean {
  return bookingBlocker(offer, session, clock) === null && seatsRemaining(session.seats, taken) > 0;
}

/** The earliest bookable session, for the homepage teaser ("Next: …"); null when none. */
export function nextBookable(offer: Offer, takenBySession: ReadonlyMap<string, number>, clock: OfferClock): OfferSession | null {
  const open = offer.sessions
    .filter((s) => isBookable(offer, s, takenBySession.get(s.id) ?? 0, clock))
    .sort((a, b) => sessionStart(a, clock.tz).getTime() - sessionStart(b, clock.tz).getTime());
  return open[0] ?? null;
}

/** "18:00" → "6 pm"; "18:30" → "6:30 pm"; "12:00" → "12 pm"; "00:00" → "12 am". */
export function humanTime(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Sat Nov 7, 6 pm" — the Stripe line item and the emails use this. */
export function sessionLabel(session: OfferSession): string {
  return `${humanDate(session.date)}, ${humanTime(session.start)}`;
}

/** "2 hours", "1 hour", "90 minutes"; empty for zero. */
export function humanDuration(minutes: number): string {
  if (minutes <= 0) return "";
  if (minutes % 60 === 0) { const h = minutes / 60; return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${minutes} minutes`;
}
