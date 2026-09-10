import type { Mail, NewAllDayEvent } from "../adapters/google";
import type { Order } from "../store/orders";
import { sizeById, subscriptionCell, type StoreConfig } from "../config";
import type { Subscriber } from "../store/subscribers";
import { humanDate, longDate } from "./time";

export function dollars(cents: number): string {
  const whole = Math.floor(cents / 100), frac = cents % 100;
  return `$${whole.toLocaleString("en-US")}.${String(frac).padStart(2, "0")}`;
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
function adminLink(order: Order, siteUrl: string): string { return `${siteUrl}/admin/#${order.date}`; }

/** Lines shared by the calendar description and Anthony's email: who, how to reach them, note, order link. */
function detailLines(order: Order, siteUrl: string): string[] {
  const lines = [order.customerName, contactLine(order)];
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
    summary: `${size} · ${order.customerName} · ${order.fulfillment}${sub ? " (subscription)" : ""}`,
    description: [
      sub ? `${size} · subscription · ${order.fulfillment}` : `${size} (${dollars(order.bouquetCents)}) · ${order.fulfillment}`,
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
  const lines = [
    `Hi ${firstName},`,
    "",
    `Thank you. Your ${size} is booked for ${order.fulfillment} on ${longDate(order.date)}.`,
    "",
    `Pickup: ${cfg.studio.pickupInstructions}`,
    `Address: ${cfg.studio.pickupAddress}`,
    "",
    "What you ordered",
    `  ${size}: ${dollars(order.bouquetCents)}`,
  ];
  if (order.note) lines.push(`  Your note: ${order.note}`);
  lines.push("", "Questions or a change of plans? Just reply to this email.", "", "Anthony", "The Bull and Bloom", "thebullandbloom.com");
  return { to: order.customerEmail, subject: `Your Bull and Bloom bouquet for ${humanDate(order.date)}`, text: lines.join("\n") };
}

export function ownerEmail(order: Order, cfg: StoreConfig, siteUrl: string): Mail {
  const size = sizeName(order, cfg);
  return {
    to: cfg.studio.ownerEmail,
    subject: `New order: ${size} · ${order.customerName} · ${humanDate(order.date)} (${order.fulfillment})`,
    text: [`${size} (${dollars(order.bouquetCents)}) · ${order.fulfillment} · ${longDate(order.date)}`, "", ...detailLines(order, siteUrl)].join("\n"),
  };
}
