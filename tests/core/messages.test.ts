import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config";
import type { Order } from "../../src/store/orders";
import { courierEmail, customerEmail, deliveryAddressOf, dollars, eventIdFor, formatAddress, orderEvent, ownerEmail } from "../../src/core/messages";

const cfg = loadConfig();
const SITE = "https://thebullandbloom.com";
const order: Order = {
  id: "7a1b2c3d-0000-4000-8000-123456789abc", createdAt: 1, status: "paid", date: "2026-09-09", sizeId: "bouquet",
  fulfillment: "pickup", customerName: "Pat Smith", customerEmail: "pat@example.com", customerPhone: "518-555-0100",
  addressJson: null, note: "For my mother. Something soft.", stripeSessionId: "cs_1", stripePaymentIntent: "pi_1",
  bouquetCents: 8500, deliveryCents: 0, uberQuoteId: null, source: "one_time", holdExpiresAt: null, calendarEventId: null,
  presentation: "hand-tied", vaseCents: 0, taxCents: 0, discountCents: 0, recipientName: null,
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
        "Ordered by: Pat Smith",
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
    expect(ev.description.split("\n").slice(0, 3)).toEqual(["mystery ($1.00) · pickup", "Ordered by: Pat Smith", "pat@example.com"]);
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
  it("shows sales tax and a total including it", () => {
    const m = customerEmail({ ...order, taxCents: 680 }, cfg);
    expect(m.text).toContain("  Bouquet: $85.00\n  Sales tax: $6.80\n  Total: $91.80");
  });
  it("shows a promotion-code discount above the tax, and a total net of it", () => {
    const m = customerEmail({ ...order, taxCents: 612, discountCents: 850 }, cfg);
    expect(m.text).toContain("  Bouquet: $85.00\n  Discount: -$8.50\n  Sales tax: $6.12\n  Total: $82.62");
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
      "Ordered by: Pat Smith",
      "pat@example.com · 518-555-0100",
      "Note: For my mother. Something soft.",
      "",
      "Order 7a1b2c3d · paid online",
      "https://thebullandbloom.com/admin/#2026-09-09",
    ].join("\n"));
  });
  it("sends Anthony's reply to the person who ordered, not back to the shop", () => {
    expect(ownerEmail(order, cfg, SITE).replyTo).toBe("pat@example.com");
  });
});

const ADDRESS = { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534", notes: "porch, behind the planter" };

function deliveryOrder(over: Partial<Order> = {}): Order {
  return {
    id: "11111111-2222-3333-4444-555555555555", createdAt: 1, status: "paid", date: "2026-09-23",
    sizeId: "bouquet", fulfillment: "delivery", customerName: "Pat Smith", customerEmail: "pat@example.com",
    customerPhone: "+15185550100", addressJson: JSON.stringify(ADDRESS), note: "for a birthday",
    stripeSessionId: "cs_1", stripePaymentIntent: "pi_1", bouquetCents: 8500, deliveryCents: 1350,
    uberQuoteId: "dqt_1", source: "one_time", holdExpiresAt: null, calendarEventId: null,
    presentation: "hand-tied", vaseCents: 0, taxCents: 0, discountCents: 0, recipientName: null, ...over,
  };
}

describe("formatAddress / deliveryAddressOf", () => {
  it("renders one readable line and skips an empty unit", () => {
    expect(formatAddress(ADDRESS)).toBe("5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(formatAddress({ ...ADDRESS, unit: "" })).toBe("5 Elm Street, Hudson, NY 12534");
  });
  it("reads the address off an order, and returns null for pickup or corrupt JSON", () => {
    expect(deliveryAddressOf(deliveryOrder())!.zip).toBe("12534");
    expect(deliveryAddressOf(deliveryOrder({ addressJson: null }))).toBeNull();
    expect(deliveryAddressOf(deliveryOrder({ addressJson: "{" }))).toBeNull();
    expect(deliveryAddressOf(deliveryOrder({ addressJson: '{"street":"a"}' }))).toBeNull();
  });
});

describe("customerEmail for a delivery order", () => {
  it("says where and when it is going, not where to collect it, and shows the delivery charge", () => {
    const m = customerEmail(deliveryOrder(), cfg);
    expect(m.subject).toBe("Your Bull and Bloom bouquet for Wed Sep 23");
    expect(m.text).toContain("Your Bouquet is booked for delivery on Wednesday, September 23.");
    expect(m.text).toContain("Delivering to: 5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(m.text).toContain("Where to leave it: porch, behind the planter");
    expect(m.text).toContain("  Bouquet: $85.00");
    expect(m.text).toContain("  Delivery: $13.50");
    expect(m.text).toContain("  Total: $98.50");
    expect(m.text).toContain("You will get a tracking link when the courier is on the way.");
    expect(m.text).not.toContain("Pickup:");
  });
  it("leaves the pickup wording exactly as Plan 2 wrote it", () => {
    const m = customerEmail(deliveryOrder({ fulfillment: "pickup", addressJson: null, deliveryCents: 0 }), cfg);
    expect(m.text).toContain(`Pickup: ${cfg.studio.pickupInstructions}`);
    expect(m.text).toContain(`Address: ${cfg.studio.pickupAddress}`);
    expect(m.text).not.toContain("Delivering to:");
    expect(m.text).not.toContain("Total:");
  });
});

describe("orderEvent and ownerEmail for a delivery order", () => {
  it("puts the address in the calendar description so Anthony's phone shows it (spec §6)", () => {
    const e = orderEvent(deliveryOrder(), cfg, "https://x.test");
    expect(e.summary).toBe("Bouquet · Pat Smith · delivery");
    expect(e.description).toContain("Bouquet ($85.00) · delivery");
    expect(e.description).toContain("5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(e.description).toContain("porch, behind the planter");
  });
  it("puts the address in Anthony's copy too", () => {
    expect(ownerEmail(deliveryOrder(), cfg, "https://x.test").text).toContain("5 Elm Street, Apt 2, Hudson, NY 12534");
  });
  it("shows what the customer paid for delivery, in the email and on the calendar", () => {
    expect(ownerEmail(deliveryOrder(), cfg, "https://x.test").text.split("\n")[0]).toBe("Bouquet ($85.00) · delivery ($13.50) · Wednesday, September 23");
    expect(orderEvent(deliveryOrder(), cfg, "https://x.test").description.split("\n")[0]).toBe("Bouquet ($85.00) · delivery ($13.50)");
  });
  it("keeps the buyer and the person the flowers are for apart when the order is a gift", () => {
    const gift = deliveryOrder({ recipientName: "Tina Warren" });
    const m = ownerEmail(gift, cfg, "https://x.test");
    expect(m.subject).toBe("New order: Bouquet · Pat Smith · Wed Sep 23 (delivery)");
    expect(m.text).toBe([
      "Bouquet ($85.00) · delivery ($13.50) · Wednesday, September 23",
      "",
      "Ordered by: Pat Smith",
      "pat@example.com · +15185550100",
      "For: Tina Warren",
      "5 Elm Street, Apt 2, Hudson, NY 12534",
      "Where to leave it: porch, behind the planter",
      "Note: for a birthday",
      "",
      "Order 11111111 · paid online",
      "https://x.test/admin/#2026-09-23",
    ].join("\n"));
  });
  it("titles the calendar event with the recipient, since that is whose door it goes to", () => {
    expect(orderEvent(deliveryOrder({ recipientName: "Tina Warren" }), cfg, "https://x.test").summary).toBe("Bouquet · Tina Warren · delivery");
  });
  it("has no For line when the buyer named no one else", () => {
    expect(ownerEmail(deliveryOrder(), cfg, "https://x.test").text).not.toContain("For:");
  });
  it("adds nothing to a pickup order", () => {
    const e = orderEvent(deliveryOrder({ fulfillment: "pickup", addressJson: null, deliveryCents: 0 }), cfg, "https://x.test");
    expect(e.description).not.toContain("Elm Street");
  });
});

describe("courierEmail", () => {
  it("gives the customer the tracking link and the address it is heading to", () => {
    const m = courierEmail(deliveryOrder(), cfg, "https://direct.uber.com/track/del_7");
    expect(m.to).toBe("pat@example.com");
    expect(m.subject).toBe("Your Bull and Bloom bouquet is on the way");
    expect(m.text).toContain("Hi Pat,");
    expect(m.text).toContain("https://direct.uber.com/track/del_7");
    expect(m.text).toContain("5 Elm Street, Apt 2, Hudson, NY 12534");
    expect(m.text).toContain("Anthony");
  });
  it("still sends when the address cannot be read, because the tracking link is the point", () => {
    const m = courierEmail(deliveryOrder({ addressJson: null }), cfg, "https://t.test/1");
    expect(m.text).toContain("https://t.test/1");
  });
});

describe("vase orders", () => {
  const vased: Order = { ...order, presentation: "vase", vaseCents: 2000 };
  it("names the vase in the calendar event", () => {
    const ev = orderEvent(vased, cfg, SITE);
    expect(ev.summary).toBe("Bouquet · vase · Pat Smith · pickup");
    expect(ev.description.split("\n")[0]).toBe("Bouquet ($85.00) · vase ($20.00) · pickup");
  });
  it("tells the customer and shows the vase line and total", () => {
    const m = customerEmail(vased, cfg);
    expect(m.text).toContain("Thank you. Your Bouquet, arranged in a vase, is booked for pickup on Wednesday, September 9.");
    expect(m.text).toContain("  Bouquet: $85.00\n  Vase: $20.00\n  Total: $105.00");
  });
  it("tells Anthony in the subject", () => {
    expect(ownerEmail(vased, cfg, SITE).subject).toBe("New order: Bouquet in a vase · Pat Smith · Wed Sep 9 (pickup)");
  });
});
