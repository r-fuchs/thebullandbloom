import type { Mail, NewAllDayEvent } from "../adapters/google";
import type { Order } from "../store/orders";
import { sizeById, subscriptionCell, type PostalAddress, type StoreConfig } from "../config";
import type { Subscriber } from "../store/subscribers";
import { humanDate, longDate } from "./time";

export function dollars(cents: number): string {
  const whole = Math.floor(cents / 100), frac = cents % 100;
  return `$${whole.toLocaleString("en-US")}.${String(frac).padStart(2, "0")}`;
}

export interface DeliveryAddress extends PostalAddress { notes: string }

/** "5 Elm Street, Apt 2, Hudson, NY 12534" */
export function formatAddress(a: PostalAddress): string {
  return [a.street, a.unit, `${a.city}, ${a.state} ${a.zip}`].filter((p) => p && p.trim() !== "").join(", ");
}

/** The delivery address stored on an order, or null for pickup / anything unreadable. */
export function deliveryAddressOf(order: Order): DeliveryAddress | null {
  if (!order.addressJson) return null;
  try {
    const a = JSON.parse(order.addressJson) as Partial<DeliveryAddress>;
    if (!a || typeof a.street !== "string" || typeof a.city !== "string" || typeof a.state !== "string" || typeof a.zip !== "string") {
      return null;
    }
    return { street: a.street, unit: a.unit ?? "", city: a.city, state: a.state, zip: a.zip, notes: a.notes ?? "" };
  } catch {
    console.error(`messages: order ${order.id} has unreadable address_json`);
    return null;
  }
}

/** Google event ids must be 5–1024 chars of [a-v0-9]; a lowercase UUID's hex fits once the hyphens go (D21). */
export function eventIdFor(orderId: string): string {
  return `bb${orderId.toLowerCase().replace(/-/g, "")}`;
}

function sizeName(order: Order, cfg: StoreConfig): string {
  return sizeById(cfg, order.sizeId)?.name ?? order.sizeId;
}
function contactLine(order: Order): string {
  return order.customerPhone ? `${order.customerEmail} · ${order.customerPhone}` : order.customerEmail;
}
function shortId(order: Order): string { return order.id.slice(0, 8); }
const inVase = (o: Order) => o.presentation === "vase";
function adminLink(order: Order, siteUrl: string): string { return `${siteUrl}/admin/#${order.date}`; }

/** Lines shared by the calendar description and Anthony's email: who, how to reach them, where, note, order link. */
function detailLines(order: Order, siteUrl: string): string[] {
  const lines = [order.customerName, contactLine(order)];
  const addr = deliveryAddressOf(order);
  if (addr) {
    lines.push(formatAddress(addr));
    if (addr.notes) lines.push(`Where to leave it: ${addr.notes}`);
  }
  if (order.note) lines.push(`Note: ${order.note}`);
  lines.push("", `Order ${shortId(order)} · paid online`, adminLink(order, siteUrl));
  return lines;
}

export function orderEvent(order: Order, cfg: StoreConfig, siteUrl: string): NewAllDayEvent {
  const size = sizeName(order, cfg);
  const sub = order.source === "subscription";
  return {
    id: eventIdFor(order.id),
    date: order.date,
    summary: `${size}${inVase(order) ? " · vase" : ""} · ${order.customerName} · ${order.fulfillment}${sub ? " (subscription)" : ""}`,
    description: [
      sub
        ? `${size} · subscription · ${order.fulfillment}`
        : `${size} (${dollars(order.bouquetCents)})${inVase(order) ? ` · vase (${dollars(order.vaseCents)})` : ""} · ${order.fulfillment}`,
      ...detailLines(order, siteUrl),
    ].join("\n"),
  };
}

// ---- subscriptions (Plan 4). Copy approved by Ryan and Anthony 2026-09-10.

function planLine(sub: Subscriber, cfg: StoreConfig): { size: string; cadence: string; price: string } {
  const size = sizeById(cfg, sub.sizeId)?.name ?? sub.sizeId;
  const cadence = cfg.subscriptions.cadences.find((c) => c.id === sub.cadenceId)?.name.toLowerCase() ?? sub.cadenceId;
  const cell = subscriptionCell(cfg, sub.sizeId, sub.cadenceId);
  return { size, cadence, price: cell ? dollars(cell.priceCents) : "" };
}
const WEEKDAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const firstNameOf = (name: string) => name.trim().split(/\s+/)[0];

export function subscriptionConfirmedEmail(sub: Subscriber, cfg: StoreConfig, portalUrl: string): Mail {
  const { size, cadence, price } = planLine(sub, cfg);
  const lines = [
    `Hi ${firstNameOf(sub.customerName)},`,
    "",
    `Thank you. You're set for a ${size} ${cadence}, on ${WEEKDAY_PLURAL[sub.weekday]}, for ${sub.fulfillment}.`,
    "",
    `Your first one is ${longDate(sub.anchorDate)}.`,
    "",
    `Pickup: ${cfg.studio.pickupInstructions}`,
    `Address: ${cfg.studio.pickupAddress}`,
    "",
    "Your plan",
    `  ${size}, ${cadence}: ${price} a month`,
    "",
    "Need to cancel or change your card? Manage it here:",
    portalUrl,
    "",
    "Questions? Just reply to this email.",
    "",
    "Anthony",
    "The Bull and Bloom",
    "thebullandbloom.com",
  ];
  return { to: sub.customerEmail, subject: `Your Bull and Bloom subscription starts ${humanDate(sub.anchorDate)}`, text: lines.join("\n") };
}

export function subscriptionCancelledEmail(sub: Subscriber, cfg: StoreConfig): Mail {
  const { size } = planLine(sub, cfg);
  const lines = [
    `Hi ${firstNameOf(sub.customerName)},`,
    "",
    `Your ${size} subscription is cancelled, and there won't be another charge.`,
    "Any bouquet already on the calendar for this week is still yours.",
    "",
    "Thank you for letting me make flowers for you. If you'd like to start",
    "again, or just want a bouquet now and then, the shop is always open:",
    "thebullandbloom.com",
    "",
    "Anthony",
    "The Bull and Bloom",
  ];
  return { to: sub.customerEmail, subject: "Your Bull and Bloom subscription has ended", text: lines.join("\n") };
}

export function ownerSubscriptionEmail(sub: Subscriber, cfg: StoreConfig, siteUrl: string, what: "started" | "cancelled"): Mail {
  const { size, cadence, price } = planLine(sub, cfg);
  const contact = sub.customerPhone ? `${sub.customerEmail} · ${sub.customerPhone}` : sub.customerEmail;
  const lines = [
    `${size} ${cadence} · ${WEEKDAY_PLURAL[sub.weekday]} · ${sub.fulfillment} · ${price} a month`,
    "",
    sub.customerName, contact,
  ];
  if (sub.note) lines.push(`Note: ${sub.note}`);
  lines.push("", what === "started" ? `First bouquet ${longDate(sub.anchorDate)}. Bouquets appear on the calendar three weeks ahead.` : "Future bouquets have been taken off the calendar.", `${siteUrl}/admin/`);
  const subject = what === "started"
    ? `New subscription: ${size} ${cadence} · ${sub.customerName} · ${WEEKDAY_PLURAL[sub.weekday]}`
    : `Subscription cancelled: ${size} ${cadence} · ${sub.customerName}`;
  return { to: cfg.studio.ownerEmail, subject, text: lines.join("\n") };
}

export function customerEmail(order: Order, cfg: StoreConfig): Mail {
  const size = sizeName(order, cfg);
  const firstName = order.customerName.trim().split(/\s+/)[0];
  const addr = deliveryAddressOf(order);
  const lines = [
    `Hi ${firstName},`,
    "",
    `Thank you. Your ${size}${inVase(order) ? ", arranged in a vase," : ""} is booked for ${order.fulfillment} on ${longDate(order.date)}.`,
    "",
  ];
  if (order.fulfillment === "delivery") {
    if (addr) {
      lines.push(`Delivering to: ${formatAddress(addr)}`);
      if (addr.notes) lines.push(`Where to leave it: ${addr.notes}`);
    }
    lines.push("You will get a tracking link when the courier is on the way.");
  } else {
    lines.push(`Pickup: ${cfg.studio.pickupInstructions}`, `Address: ${cfg.studio.pickupAddress}`);
  }
  lines.push("", "What you ordered", `  ${size}: ${dollars(order.bouquetCents)}`);
  if (order.vaseCents > 0) lines.push(`  Vase: ${dollars(order.vaseCents)}`);
  if (order.deliveryCents > 0) lines.push(`  Delivery: ${dollars(order.deliveryCents)}`);
  if (order.taxCents > 0) lines.push(`  Sales tax: ${dollars(order.taxCents)}`);
  if (order.vaseCents > 0 || order.deliveryCents > 0 || order.taxCents > 0) {
    lines.push(`  Total: ${dollars(order.bouquetCents + order.vaseCents + order.deliveryCents + order.taxCents)}`);
  }
  if (order.note) lines.push(`  Your note: ${order.note}`);
  lines.push("", "Questions or a change of plans? Just reply to this email.", "", "Anthony", "The Bull and Bloom", "thebullandbloom.com");
  return { to: order.customerEmail, subject: `Your Bull and Bloom bouquet for ${humanDate(order.date)}`, text: lines.join("\n") };
}

export function ownerEmail(order: Order, cfg: StoreConfig, siteUrl: string): Mail {
  const size = sizeName(order, cfg);
  return {
    to: cfg.studio.ownerEmail,
    subject: `New order: ${size}${inVase(order) ? " in a vase" : ""} · ${order.customerName} · ${humanDate(order.date)} (${order.fulfillment})`,
    text: [
      `${size} (${dollars(order.bouquetCents)})${inVase(order) ? ` · vase (${dollars(order.vaseCents)})` : ""} · ${order.fulfillment} · ${longDate(order.date)}`,
      "", ...detailLines(order, siteUrl),
    ].join("\n"),
  };
}

/** Sent when Anthony taps "Request courier" (spec §2 item 10). One job: the tracking link. */
export function courierEmail(order: Order, cfg: StoreConfig, trackingUrl: string): Mail {
  const firstName = order.customerName.trim().split(/\s+/)[0];
  const addr = deliveryAddressOf(order);
  const lines = [
    `Hi ${firstName},`,
    "",
    `Your ${sizeName(order, cfg)} is made and a courier is on the way with it.`,
    "",
    `Follow it here: ${trackingUrl}`,
  ];
  if (addr) lines.push("", `Delivering to: ${formatAddress(addr)}`);
  lines.push("", "Questions? Just reply to this email.", "", "Anthony", "The Bull and Bloom", "thebullandbloom.com");
  return { to: order.customerEmail, subject: "Your Bull and Bloom bouquet is on the way", text: lines.join("\n") };
}
