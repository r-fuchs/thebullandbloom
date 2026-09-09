/** The Uber delivery lifecycle (spec §4.4). Terminal failures free the order for another attempt. */
export type DeliveryStatus =
  | "pending" | "pickup" | "pickup_complete" | "dropoff" | "delivered" | "canceled" | "returned";

/** A delivery in one of these is over; Anthony may request a new courier for the order. */
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = ["canceled", "returned"];

export interface Delivery {
  id: string; orderId: string; uberDeliveryId: string; status: DeliveryStatus;
  quotedCents: number; feeCents: number; trackingUrl: string;
  createdAt: number; updatedAt: number; lastError: string | null;
}
export interface NewDelivery {
  id: string; orderId: string; uberDeliveryId: string; status: DeliveryStatus;
  quotedCents: number; feeCents: number; trackingUrl: string; at: number;
}

interface Row {
  id: string; order_id: string; uber_delivery_id: string; status: DeliveryStatus;
  quoted_cents: number; fee_cents: number; tracking_url: string;
  created_at: number; updated_at: number; last_error: string | null;
}
const COLS = `id, order_id, uber_delivery_id, status, quoted_cents, fee_cents, tracking_url,
  created_at, updated_at, last_error`;

function fromRow(r: Row): Delivery {
  return {
    id: r.id, orderId: r.order_id, uberDeliveryId: r.uber_delivery_id, status: r.status,
    quotedCents: r.quoted_cents, feeCents: r.fee_cents, trackingUrl: r.tracking_url,
    createdAt: r.created_at, updatedAt: r.updated_at, lastError: r.last_error,
  };
}

const NOT_TERMINAL = `status NOT IN ('canceled','returned')`;

/**
 * The INSERT as a statement, so dispatch can batch it with the courier-email enqueue (D29).
 * OR IGNORE: when Uber de-duplicates a double dispatch (same idempotency key) it hands back the
 * delivery we already stored, and the second insert must be a no-op rather than a UNIQUE failure.
 */
export function insertDeliveryStatement(db: D1Database, d: NewDelivery): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO deliveries (id, order_id, uber_delivery_id, status, quoted_cents, fee_cents, tracking_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(d.id, d.orderId, d.uberDeliveryId, d.status, d.quotedCents, d.feeCents, d.trackingUrl, d.at, d.at);
}

export async function insertDelivery(db: D1Database, d: NewDelivery): Promise<void> {
  await insertDeliveryStatement(db, d).run();
}

/** The live courier job for an order, if any. Canceled and returned jobs do not block a retry. */
export async function activeDeliveryFor(db: D1Database, orderId: string): Promise<Delivery | null> {
  const r = await db.prepare(
    `SELECT ${COLS} FROM deliveries WHERE order_id = ? AND ${NOT_TERMINAL} ORDER BY created_at DESC LIMIT 1`,
  ).bind(orderId).first<Row>();
  return r ? fromRow(r) : null;
}

/** The newest delivery for an order in any status; dispatch keys its idempotency on it. */
export async function latestDeliveryFor(db: D1Database, orderId: string): Promise<Delivery | null> {
  const r = await db.prepare(
    `SELECT ${COLS} FROM deliveries WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(orderId).first<Row>();
  return r ? fromRow(r) : null;
}

/** The most recent delivery per order for one order date, for the admin day panel. */
export async function deliveriesForDate(db: D1Database, date: string): Promise<Map<string, Delivery>> {
  const rows = await db.prepare(
    `SELECT ${COLS.split(",").map((c) => `d.${c.trim()}`).join(", ")}
     FROM deliveries d JOIN orders o ON o.id = d.order_id
     WHERE o.date = ? ORDER BY d.created_at`,
  ).bind(date).all<Row>();
  const out = new Map<string, Delivery>();
  for (const r of rows.results) out.set(r.order_id, fromRow(r)); // later rows win: the newest attempt
  return out;
}

/**
 * Move a delivery to `status`. Idempotent: replaying the same event rewrites the same values.
 * `reason` is stored on a failure status and cleared on any other, so admin shows only a live problem.
 * Returns the updated row, or null when we have never heard of this delivery.
 */
export async function applyStatus(
  db: D1Database, uberDeliveryId: string, status: DeliveryStatus, reason: string | null, now: number,
): Promise<Delivery | null> {
  const keepReason = (TERMINAL_STATUSES as readonly string[]).includes(status);
  await db.prepare("UPDATE deliveries SET status = ?, updated_at = ?, last_error = ? WHERE uber_delivery_id = ?")
    .bind(status, now, keepReason ? reason?.slice(0, 500) ?? null : null, uberDeliveryId).run();
  const r = await db.prepare(`SELECT ${COLS} FROM deliveries WHERE uber_delivery_id = ?`).bind(uberDeliveryId).first<Row>();
  return r ? fromRow(r) : null;
}

/**
 * What Anthony's margin absorbed (D8): Uber's fee minus what the customer was charged, over every
 * delivery that actually ran. A positive number means he paid the difference.
 */
export async function varianceTotal(db: D1Database): Promise<{ deliveries: number; varianceCents: number }> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(d.fee_cents - o.delivery_cents), 0) AS v
     FROM deliveries d JOIN orders o ON o.id = d.order_id
     WHERE d.${NOT_TERMINAL}`,
  ).first<{ n: number; v: number }>();
  return { deliveries: r?.n ?? 0, varianceCents: r?.v ?? 0 };
}
