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
 * Plan 7 §3.7, D50. The only place the street address reaches a customer. The cancellation line is
 * the §6 default (no refund promise either way) until Ryan and Anthony replace it.
 */
export function bookingConfirmedEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig): Mail {
  const length = humanDuration(offer.durationMinutes);
  const lines = [
    `Hi ${firstNameOf(booking.customerName)},`,
    "",
    `Your seat is saved for ${offer.name} on ${longDate(session.date)} at ${humanTime(session.start)}.${length ? ` Plan on about ${length}.` : ""}`,
    "",
    "Where: Anthony's home studio",
    formatAddress(cfg.studio.address),
    "",
    "Everything you need to make your wreath is provided, and it goes home with you.",
    "Refreshments will be provided.",
    "",
    "Can't make it? Email or call Anthony as soon as you know.",
    "",
    `Questions? Reply to this email or call ${prettyPhone(cfg.studio.phone)}.`,
    cfg.studio.ownerEmail,
    "",
    "Anthony",
    "The Bull and Bloom",
    "thebullandbloom.com",
  ];
  return { to: booking.customerEmail, subject: `Your seat at ${offer.name}`, text: lines.join("\n") };
}

/** "Jane Doe booked Wreath & Sip, Sat Nov 7 — 5 of 8 seats": the headcount is what Anthony needs (D52). */
export function ownerBookingEmail(booking: Booking, offer: Offer, session: OfferSession, cfg: StoreConfig, taken: number, siteUrl: string): Mail {
  const contact = booking.customerPhone ? `${booking.customerEmail} · ${booking.customerPhone}` : booking.customerEmail;
  const lines = [
    `${offer.name} · ${sessionLabel(session)} · ${taken} of ${session.seats} seats taken`,
    "",
    booking.customerName,
    contact,
  ];
  if (booking.note) lines.push(`Note: ${booking.note}`);
  lines.push("", `Booking ${booking.id.slice(0, 8)} · paid online`, `${siteUrl}/admin/`);
  return {
    to: cfg.studio.ownerEmail,
    subject: `${booking.customerName} booked ${offer.name}, ${humanDate(session.date)} — ${taken} of ${session.seats} seats`,
    text: lines.join("\n"),
  };
}
