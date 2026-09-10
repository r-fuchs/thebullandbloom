import type { Fulfillment } from "./orders";

export type SubscriberStatus = "active" | "paused" | "cancelled";

export interface Subscriber {
  id: string; createdAt: number; status: SubscriberStatus;
  stripeCustomerId: string; stripeSubscriptionId: string;
  sizeId: string; cadenceId: string; weekday: number; fulfillment: Fulfillment;
  addressJson: string | null; deliveryAddOnCents: number;
  anchorDate: string; pausedWeeks: string[];
  customerName: string; customerEmail: string; customerPhone: string | null; note: string | null;
}
export interface NewSubscriber {
  id: string; stripeCustomerId: string; stripeSubscriptionId: string;
  sizeId: string; cadenceId: string; weekday: number; fulfillment: Fulfillment;
  addressJson: string | null; deliveryAddOnCents: number; anchorDate: string;
  customerName: string; customerEmail: string; customerPhone: string | null; note: string | null;
}

interface Row {
  id: string; created_at: number; status: SubscriberStatus; stripe_customer_id: string; stripe_subscription_id: string;
  size_id: string; cadence_id: string; weekday: number; fulfillment: Fulfillment; address_json: string | null;
  delivery_add_on_cents: number; anchor_date: string; paused_weeks_json: string;
  customer_name: string; customer_email: string; customer_phone: string | null; note: string | null;
}
const COLS = `id, created_at, status, stripe_customer_id, stripe_subscription_id, size_id, cadence_id, weekday, fulfillment,
  address_json, delivery_add_on_cents, anchor_date, paused_weeks_json, customer_name, customer_email, customer_phone, note`;

function fromRow(r: Row): Subscriber {
  let pausedWeeks: string[] = [];
  try { const p = JSON.parse(r.paused_weeks_json); if (Array.isArray(p)) pausedWeeks = p.filter((x) => typeof x === "string"); } catch { /* treat as none */ }
  return {
    id: r.id, createdAt: r.created_at, status: r.status, stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id, sizeId: r.size_id, cadenceId: r.cadence_id, weekday: r.weekday,
    fulfillment: r.fulfillment, addressJson: r.address_json, deliveryAddOnCents: r.delivery_add_on_cents,
    anchorDate: r.anchor_date, pausedWeeks, customerName: r.customer_name, customerEmail: r.customer_email,
    customerPhone: r.customer_phone, note: r.note,
  };
}

/** Inserts an active subscriber; returns false when the Stripe subscription is already known (a replayed webhook). */
export async function insertSubscriber(db: D1Database, s: NewSubscriber, now: number): Promise<boolean> {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO subscribers (id, created_at, status, stripe_customer_id, stripe_subscription_id, size_id, cadence_id,
       weekday, fulfillment, address_json, delivery_add_on_cents, anchor_date, paused_weeks_json, customer_name, customer_email, customer_phone, note)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).bind(s.id, now, s.stripeCustomerId, s.stripeSubscriptionId, s.sizeId, s.cadenceId, s.weekday, s.fulfillment,
    s.addressJson, s.deliveryAddOnCents, s.anchorDate, s.customerName, s.customerEmail, s.customerPhone, s.note).run();
  return res.meta.changes === 1;
}

export async function getSubscriber(db: D1Database, id: string): Promise<Subscriber | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM subscribers WHERE id = ?`).bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

export async function byStripeSubscription(db: D1Database, stripeSubscriptionId: string): Promise<Subscriber | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM subscribers WHERE stripe_subscription_id = ?`).bind(stripeSubscriptionId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function listSubscribers(db: D1Database, status?: SubscriberStatus): Promise<Subscriber[]> {
  const q = status
    ? db.prepare(`SELECT ${COLS} FROM subscribers WHERE status = ? ORDER BY created_at`).bind(status)
    : db.prepare(`SELECT ${COLS} FROM subscribers ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, created_at`);
  return (await q.all<Row>()).results.map(fromRow);
}

export async function setSubscriberStatus(db: D1Database, id: string, status: SubscriberStatus): Promise<void> {
  await db.prepare("UPDATE subscribers SET status = ? WHERE id = ?").bind(status, id).run();
}

export async function setPausedWeeks(db: D1Database, id: string, weeks: readonly string[]): Promise<void> {
  await db.prepare("UPDATE subscribers SET paused_weeks_json = ? WHERE id = ?").bind(JSON.stringify([...new Set(weeks)].sort()), id).run();
}

export interface MaterializedOrder {
  id: string; subscriberId: string; date: string; sizeId: string; fulfillment: Fulfillment;
  customerName: string; customerEmail: string; customerPhone: string | null; addressJson: string | null; note: string | null;
}

/** Inserts the paid, zero-priced order for one due date; false when that (subscriber, date) already exists (D29). */
export async function insertMaterializedOrder(db: D1Database, o: MaterializedOrder, now: number): Promise<boolean> {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, customer_phone,
       address_json, note, bouquet_cents, delivery_cents, source, subscriber_id)
     VALUES (?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'subscription', ?)`,
  ).bind(o.id, now, o.date, o.sizeId, o.fulfillment, o.customerName, o.customerEmail, o.customerPhone, o.addressJson, o.note, o.subscriberId).run();
  return res.meta.changes === 1;
}

/** Removes not-yet-made subscription bouquets after `afterYmd` (a cancellation, or a paused week). */
export async function deleteFutureMaterialized(db: D1Database, subscriberId: string, afterYmd: string, week?: string): Promise<number> {
  const res = week
    ? await db.prepare("DELETE FROM orders WHERE subscriber_id = ? AND source = 'subscription' AND status = 'paid' AND date > ? AND date BETWEEN ? AND ?")
        .bind(subscriberId, afterYmd, week, addWeek(week)).run()
    : await db.prepare("DELETE FROM orders WHERE subscriber_id = ? AND source = 'subscription' AND status = 'paid' AND date > ?")
        .bind(subscriberId, afterYmd).run();
  return res.meta.changes;
}

function addWeek(mondayYmd: string): string {
  const [y, m, d] = mondayYmd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 6));
  return t.toISOString().slice(0, 10);
}
