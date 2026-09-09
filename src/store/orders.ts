export type OrderStatus = "held" | "paid" | "done" | "cancelled" | "refunded";
export type Fulfillment = "pickup" | "delivery";

export interface Order {
  id: string; createdAt: number; status: OrderStatus; date: string; sizeId: string; fulfillment: Fulfillment;
  customerName: string; customerEmail: string; customerPhone: string | null; addressJson: string | null; note: string | null;
  stripeSessionId: string | null; stripePaymentIntent: string | null; bouquetCents: number; deliveryCents: number;
  source: "one_time" | "subscription"; holdExpiresAt: number | null; calendarEventId: string | null;
}
export interface NewOrder {
  id: string; date: string; sizeId: string; fulfillment: Fulfillment; customerName: string; customerEmail: string;
  customerPhone: string | null; note: string | null; bouquetCents: number; deliveryCents: number;
}

interface Row {
  id: string; created_at: number; status: OrderStatus; date: string; size_id: string; fulfillment: Fulfillment;
  customer_name: string; customer_email: string; customer_phone: string | null; address_json: string | null; note: string | null;
  stripe_session_id: string | null; stripe_payment_intent: string | null; bouquet_cents: number; delivery_cents: number;
  source: "one_time" | "subscription"; hold_expires_at: number | null; calendar_event_id: string | null;
}
const COLS = `id, created_at, status, date, size_id, fulfillment, customer_name, customer_email, customer_phone,
  address_json, note, stripe_session_id, stripe_payment_intent, bouquet_cents, delivery_cents, source, hold_expires_at, calendar_event_id`;

function fromRow(r: Row): Order {
  return {
    id: r.id, createdAt: r.created_at, status: r.status, date: r.date, sizeId: r.size_id, fulfillment: r.fulfillment,
    customerName: r.customer_name, customerEmail: r.customer_email, customerPhone: r.customer_phone,
    addressJson: r.address_json, note: r.note, stripeSessionId: r.stripe_session_id,
    stripePaymentIntent: r.stripe_payment_intent, bouquetCents: r.bouquet_cents, deliveryCents: r.delivery_cents,
    source: r.source, holdExpiresAt: r.hold_expires_at, calendarEventId: r.calendar_event_id,
  };
}

const USED = `SELECT COUNT(*) FROM orders WHERE date = ?1 AND source = 'one_time' AND status IN ('held','paid','done')`;

export async function countUsed(db: D1Database, from: string, to: string): Promise<Map<string, number>> {
  const rows = await db.prepare(
    `SELECT date, COUNT(*) AS n FROM orders WHERE date BETWEEN ? AND ? AND source = 'one_time' AND status IN ('held','paid','done') GROUP BY date`,
  ).bind(from, to).all<{ date: string; n: number }>();
  return new Map(rows.results.map((r) => [r.date, r.n]));
}

export async function tryInsertHeldOrder(
  db: D1Database, o: NewOrder, cap: number, now: number, holdExpiresAt: number,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO orders (id, created_at, status, date, size_id, fulfillment, customer_name, customer_email,
       customer_phone, note, bouquet_cents, delivery_cents, source, hold_expires_at)
     SELECT ?2, ?3, 'held', ?1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'one_time', ?12
     WHERE (${USED}) < ?13`,
  ).bind(o.date, o.id, now, o.sizeId, o.fulfillment, o.customerName, o.customerEmail, o.customerPhone, o.note,
    o.bouquetCents, o.deliveryCents, holdExpiresAt, cap).run();
  return res.meta.changes === 1;
}

export async function attachSession(db: D1Database, orderId: string, sessionId: string): Promise<void> {
  await db.prepare("UPDATE orders SET stripe_session_id = ? WHERE id = ?").bind(sessionId, orderId).run();
}

export async function getOrder(db: D1Database, id: string): Promise<Order | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM orders WHERE id = ?`).bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

export async function markPaidBySession(
  db: D1Database, sessionId: string, paymentIntent: string, extra: D1PreparedStatement[] = [],
): Promise<Order | null> {
  const [upd] = await db.batch([
    db.prepare(
      `UPDATE orders SET status = 'paid', stripe_payment_intent = ?, hold_expires_at = NULL
       WHERE stripe_session_id = ? AND status IN ('held', 'cancelled')`,
    ).bind(paymentIntent, sessionId),
    ...extra,
  ]);
  if (upd.meta.changes !== 1) return null;
  const r = await db.prepare(`SELECT ${COLS} FROM orders WHERE stripe_session_id = ?`).bind(sessionId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function setCalendarEventId(db: D1Database, orderId: string, eventId: string): Promise<void> {
  await db.prepare("UPDATE orders SET calendar_event_id = ? WHERE id = ?").bind(eventId, orderId).run();
}

export async function cancelHeldBySession(db: D1Database, sessionId: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE orders SET status = 'cancelled', hold_expires_at = NULL WHERE stripe_session_id = ? AND status = 'held'",
  ).bind(sessionId).run();
  return res.meta.changes === 1;
}

export async function cancelOrder(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE orders SET status = 'cancelled', hold_expires_at = NULL WHERE id = ? AND status = 'held'",
  ).bind(id).run();
  return res.meta.changes === 1;
}

export async function expireHolds(db: D1Database, now: number): Promise<number> {
  const res = await db.prepare(
    "UPDATE orders SET status = 'cancelled', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at <= ?",
  ).bind(now).run();
  return res.meta.changes;
}

export async function listOrders(db: D1Database, date: string): Promise<Order[]> {
  const rows = await db.prepare(`SELECT ${COLS} FROM orders WHERE date = ? ORDER BY created_at, id`).bind(date).all<Row>();
  return rows.results.map(fromRow);
}

export async function setStatus(db: D1Database, id: string, status: OrderStatus): Promise<boolean> {
  const res = await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, id).run();
  return res.meta.changes === 1;
}
