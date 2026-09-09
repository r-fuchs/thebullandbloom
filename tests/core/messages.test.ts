import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config";
import type { Order } from "../../src/store/orders";
import { customerEmail, dollars, eventIdFor, orderEvent, ownerEmail } from "../../src/core/messages";

const cfg = loadConfig();
const SITE = "https://thebullandbloom.com";
const order: Order = {
  id: "7a1b2c3d-0000-4000-8000-123456789abc", createdAt: 1, status: "paid", date: "2026-09-09", sizeId: "bouquet",
  fulfillment: "pickup", customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: "518-555-0100",
  addressJson: null, note: "For my mother. Something soft.", stripeSessionId: "cs_1", stripePaymentIntent: "pi_1",
  bouquetCents: 8500, deliveryCents: 0, source: "one_time", holdExpiresAt: null, calendarEventId: null,
};

describe("dollars", () => {
  it("formats cents", () => {
    expect(dollars(8500)).toBe("$85.00");
    expect(dollars(5)).toBe("$0.05");
    expect(dollars(123456)).toBe("$1,234.56");
  });
});

describe("eventIdFor", () => {
  it("is base32hex-safe and derived from the order id (D21)", () => {
    expect(eventIdFor(order.id)).toBe("bb7a1b2c3d000040008000123456789abc");
    expect(eventIdFor(order.id)).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe("orderEvent", () => {
  it("is an all-day event on the order date with the details Anthony needs", () => {
    const ev = orderEvent(order, cfg, SITE);
    expect(ev).toEqual({
      id: eventIdFor(order.id),
      date: "2026-09-09",
      summary: "Bouquet · Pat Smith · pickup",
      description: [
        "Bouquet ($85.00) · pickup",
        "Pat Smith",
        "pat@example.com · 518-555-0100",
        "Note: For my mother. Something soft.",
        "",
        "Order 7a1b2c3d · paid online",
        "https://thebullandbloom.com/admin/#2026-09-09",
      ].join("\n"),
    });
  });
  it("omits the phone and note lines when absent and names unknown sizes by id", () => {
    const ev = orderEvent({ ...order, customerPhone: null, note: null, sizeId: "mystery", bouquetCents: 100 }, cfg, SITE);
    expect(ev.summary).toBe("mystery · Pat Smith · pickup");
    expect(ev.description.split("\n").slice(0, 3)).toEqual(["mystery ($1.00) · pickup", "Pat Smith", "pat@example.com"]);
    expect(ev.description).not.toContain("Note:");
  });
});

describe("customerEmail", () => {
  it("confirms the order in plain text with pickup details", () => {
    const m = customerEmail(order, cfg);
    expect(m.to).toBe("pat@example.com");
    expect(m.subject).toBe("Your Bull and Bloom bouquet for Wed Sep 9");
    expect(m.text).toBe([
      "Hi Pat,",
      "",
      "Thank you. Your Bouquet is booked for pickup on Wednesday, September 9.",
      "",
      `Pickup: ${cfg.studio.pickupInstructions}`,
      `Address: ${cfg.studio.pickupAddress}`,
      "",
      "What you ordered",
      "  Bouquet: $85.00",
      "  Your note: For my mother. Something soft.",
      "",
      "Questions or a change of plans? Just reply to this email.",
      "",
      "Anthony",
      "The Bull and Bloom",
      "thebullandbloom.com",
    ].join("\n"));
  });
  it("uses the first name only and skips the note line when there is none", () => {
    const m = customerEmail({ ...order, customerName: "Pat", note: null }, cfg);
    expect(m.text.startsWith("Hi Pat,\n")).toBe(true);
    expect(m.text).not.toContain("Your note:");
  });
});

describe("ownerEmail", () => {
  it("tells Anthony what to make and links to the day in admin", () => {
    const m = ownerEmail(order, cfg, SITE);
    expect(m.to).toBe(cfg.studio.ownerEmail);
    expect(m.subject).toBe("New order: Bouquet · Pat Smith · Wed Sep 9 (pickup)");
    expect(m.text).toBe([
      "Bouquet ($85.00) · pickup · Wednesday, September 9",
      "",
      "Pat Smith",
      "pat@example.com · 518-555-0100",
      "Note: For my mother. Something soft.",
      "",
      "Order 7a1b2c3d · paid online",
      "https://thebullandbloom.com/admin/#2026-09-09",
    ].join("\n"));
  });
});
