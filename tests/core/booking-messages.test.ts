import { describe, it, expect } from "vitest";
import { bookingConfirmedEmail, ownerBookingEmail, prettyPhone } from "../../src/core/booking-messages";
import { loadConfig } from "../../src/config";
import type { Booking } from "../../src/store/bookings";
import { WREATH } from "../helpers";

const cfg = loadConfig();
const session = WREATH.sessions.find((s) => s.id === "sat")!; // Sat Sep 12, 6 pm
const booking: Booking = {
  id: "b1", createdAt: 1, status: "paid", offerId: WREATH.id, sessionId: "sat",
  customerName: "Jane Doe", customerEmail: "jane@example.com", customerPhone: "518-555-0100", note: "first wreath",
  stripeSessionId: "cs_1", stripePaymentIntent: "pi_1", priceCents: 8500, taxCents: 680, discountCents: 0, holdExpiresAt: null,
};

describe("booking messages (D50: home studio named, refreshments promised, nothing more specific)", () => {
  it("formats the studio phone", () => {
    expect(prettyPhone("+15183340517")).toBe("(518) 334-0517");
    expect(prettyPhone("+441234567890")).toBe("+441234567890");
  });
  it("customer email carries the date, time, length, the home-studio address, materials, refreshments and the contact", () => {
    const m = bookingConfirmedEmail(booking, WREATH, session, cfg);
    expect(m.to).toBe("jane@example.com");
    expect(m.subject).toBe("Your seat at Wreath & Sip");
    expect(m.text).toContain("Hi Jane,");
    expect(m.text).toContain("Thank you. Your seat at Wreath & Sip is booked for Saturday, September 12 at 6 pm. The class runs about 2 hours.");
    expect(m.text).toContain("Where: Anthony's home studio");
    expect(m.text).toContain(`${cfg.studio.address.street}, ${cfg.studio.address.city}, ${cfg.studio.address.state} ${cfg.studio.address.zip}`);
    expect(m.text).toContain("Everything is included, and you take home what you make.");
    expect(m.text).toContain("Refreshments will be provided.");
    expect(m.text).toContain("Questions or a change of plans? Just reply to this email, or call");
    expect(m.text).toContain(`${prettyPhone(cfg.studio.phone)}`);
    expect(m.text).not.toMatch(/wine|beer|cocktail|bring/i);
    expect(m.text.trim().endsWith("Anthony\nThe Bull and Bloom\nthebullandbloom.com")).toBe(true);
  });
  it("customer email leaves out the length when the offer has none", () => {
    const m = bookingConfirmedEmail(booking, { ...WREATH, durationMinutes: 0 }, session, cfg);
    expect(m.text).toContain("at 6 pm.\n");
    expect(m.text).not.toContain("The class runs");
  });
  it("owner email names who booked, the date and the headcount, with contact and note", () => {
    const m = ownerBookingEmail(booking, WREATH, session, cfg, 5, "https://x.test");
    expect(m.to).toBe(cfg.studio.ownerEmail);
    expect(m.subject).toBe("Jane Doe booked Wreath & Sip, Sat Sep 12 · 5 of 2 seats");
    expect(m.text).toContain("jane@example.com · 518-555-0100");
    expect(m.text).toContain("Note: first wreath");
    expect(m.text).toContain("Sat Sep 12, 6 pm · 5 of 2 seats taken");
    expect(m.text).toContain("https://x.test/admin/");
    const quiet = ownerBookingEmail({ ...booking, customerPhone: null, note: null }, WREATH, session, cfg, 1, "https://x.test");
    expect(quiet.text).not.toContain("Note:");
    expect(quiet.text).toContain("jane@example.com\n");
  });
});
