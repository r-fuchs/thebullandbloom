import type { Mail } from "../adapters/google";
import type { Offer, OfferSession, StoreConfig } from "../config";
import type { Booking } from "../store/bookings";
import { formatAddress } from "./messages";
import { humanDuration, humanTime, sessionLabel } from "./offers";
import { humanDate, longDate } from "./time";

/** "+15183340517" → "(518) 334-0517"; any other shape is returned as given. */
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const firstNameOf = (name: string) => name.trim().split(/\s+/)[0];

/**
 * Plan 7 §3.7, D50. The only place the home studio's street address reaches a customer; a class at a
 * host venue names that venue instead. The cancellation line is the §6 default (no refund promise
 * either way) until Ryan and Anthony replace it.
 */
export function bookingConfirmedEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig): Mail {
  const length = humanDuration(offer.durationMinutes);
  const party = booking.seats > 1 ? `Your ${booking.seats} seats` : "Your seat";
  const lines = [
    `Hi ${firstNameOf(booking.customerName)},`,
    "",
    `Thank you. ${party} at ${offer.name} ${booking.seats > 1 ? "are" : "is"} booked for ${longDate(session.date)} at ${humanTime(session.start)}.${length ? ` The class runs about ${length}.` : ""}`,
    "",
    `Where: ${offer.venue ? offer.venue.name : "Anthony's home studio"}`,
    formatAddress(offer.venue ? offer.venue.address : cfg.studio.address),
    "",
    // A host venue is a restaurant selling its own menu; only the home studio serves refreshments.
    offer.venue
      ? `All materials are included, and you take home what you make. Food and drinks will be available for purchase at ${offer.venue.name}.`
      : "Everything is included, and you take home what you make. Refreshments will be provided.",
    "",
    `Questions or a change of plans? Just reply to this email, or call ${prettyPhone(cfg.studio.phone)}.`,
    "",
    "Anthony",
    "The Bull and Bloom",
    "thebullandbloom.com",
  ];
  return { to: booking.customerEmail, subject: `${party} at ${offer.name}`, text: lines.join("\n") };
}

/** "Jane Doe booked Wreath & Sip, Sat Nov 7 — 5 of 8 seats": the headcount is what Anthony needs (D52). */
export function ownerBookingEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig, taken: number, siteUrl: string): Mail {
  const contact = booking.customerPhone ? `${booking.customerEmail} · ${booking.customerPhone}` : booking.customerEmail;
  const what = booking.seats > 1 ? `${booking.seats} seats at ${offer.name}` : offer.name;
  const lines = [
    `${offer.name} · ${sessionLabel(session)} · ${taken} of ${session.seats} seats taken`,
    "",
    booking.seats > 1 ? `${booking.customerName} · ${booking.seats} seats` : booking.customerName,
    contact,
  ];
  if (booking.note) lines.push(`Note: ${booking.note}`);
  // No Stripe session means admin recorded the party at the studio.
  lines.push("", `Booking ${booking.id.slice(0, 8)} · ${booking.stripeSessionId ? "paid online" : "paid in person"}`, `${siteUrl}/admin/`);
  return {
    to: cfg.studio.ownerEmail,
    subject: `${booking.customerName} booked ${what}, ${humanDate(session.date)} · ${taken} of ${session.seats} seats`,
    text: lines.join("\n"),
  };
}
