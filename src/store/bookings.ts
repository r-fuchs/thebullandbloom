export type BookingStatus = "held" | "paid" | "cancelled";

export interface Booking {
  id: string; createdAt: number; status: BookingStatus; offerId: string; sessionId: string;
  customerName: string; customerEmail: string; customerPhone: string | null; note: string | null;
  stripeSessionId: string | null; stripePaymentIntent: string | null;
  priceCents: number; taxCents: number; discountCents: number; holdExpiresAt: number | null;
  /** how many seats this party holds; priceCents is per seat */
  seats: number;
}
export interface NewBooking {
  id: string; offerId: string; sessionId: string; customerName: string; customerEmail: string;
  customerPhone: string | null; note: string | null; priceCents: number;
  /** seats for the party; 1 when absent */
  seats?: number;
}

interface Row {
  id: string; created_at: number; status: BookingStatus; offer_id: string; session_id: string;
  customer_name: string; customer_email: string; customer_phone: string | null; note: string | null;
  stripe_session_id: string | null; stripe_payment_intent: string | null;
  price_cents: number; tax_cents: number; discount_cents: number; hold_expires_at: number | null; seats: number;
}
const COLS = `id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note,
  stripe_session_id, stripe_payment_intent, price_cents, tax_cents, discount_cents, hold_expires_at, seats`;

function fromRow(r: Row): Booking {
  return {
    id: r.id, createdAt: r.created_at, status: r.status, offerId: r.offer_id, sessionId: r.session_id,
    customerName: r.customer_name, customerEmail: r.customer_email, customerPhone: r.customer_phone, note: r.note,
    stripeSessionId: r.stripe_session_id, stripePaymentIntent: r.stripe_payment_intent,
    priceCents: r.price_cents, taxCents: r.tax_cents, discountCents: r.discount_cents, holdExpiresAt: r.hold_expires_at,
    seats: r.seats,
  };
}

const TAKEN = `SELECT COALESCE(SUM(seats), 0) FROM bookings WHERE offer_id = ?1 AND session_id = ?2 AND status IN ('held','paid')`;

/** Seats taken per session of one offer (held + paid). Sessions with no bookings are absent. */
export async function countTaken(db: D1Database, offerId: string): Promise<Map<string, number>> {
  const rows = await db.prepare(
    `SELECT session_id, SUM(seats) AS n FROM bookings WHERE offer_id = ? AND status IN ('held','paid') GROUP BY session_id`,
  ).bind(offerId).all<{ session_id: string; n: number }>();
  return new Map(rows.results.map((r) => [r.session_id, r.n]));
}

/** The seat guard: the row lands only while taken + the party's seats fit under capacity, in one statement, so two parties cannot both get the last seats. */
export async function tryInsertHeldBooking(
  db: D1Database, b: NewBooking, seats: number, now: number, holdExpiresAt: number,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, customer_phone, note, price_cents, hold_expires_at, seats)
     SELECT ?3, ?4, 'held', ?1, ?2, ?5, ?6, ?7, ?8, ?9, ?10, ?12
     WHERE (${TAKEN}) + ?12 <= ?11`,
  ).bind(b.offerId, b.sessionId, b.id, now, b.customerName, b.customerEmail, b.customerPhone, b.note, b.priceCents, holdExpiresAt, seats, b.seats ?? 1).run();
  return res.meta.changes === 1;
}

export async function attachSession(db: D1Database, bookingId: string, sessionId: string): Promise<void> {
  await db.prepare("UPDATE bookings SET stripe_session_id = ? WHERE id = ?").bind(sessionId, bookingId).run();
}

export async function getBooking(db: D1Database, id: string): Promise<Booking | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM bookings WHERE id = ?`).bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

/**
 * Flips held → paid with the Stripe amounts, running `extra` (outbox inserts) in the same batch.
 * A hold the expiry job cancelled before a late completion is resurrected (D17), but a seat that
 * was paid and then cancelled in admin after a refund (D53) stays cancelled: that row already
 * carries a payment intent.
 */
export async function markPaidBySession(
  db: D1Database, sessionId: string, paymentIntent: string, taxCents: number, discountCents: number,
  extra: D1PreparedStatement[] = [],
): Promise<Booking | null> {
  const [upd] = await db.batch([
    db.prepare(
      `UPDATE bookings SET status = 'paid', stripe_payment_intent = ?, tax_cents = ?, discount_cents = ?, hold_expires_at = NULL
       WHERE stripe_session_id = ? AND (status = 'held' OR (status = 'cancelled' AND stripe_payment_intent IS NULL))`,
    ).bind(paymentIntent, taxCents, discountCents, sessionId),
    ...extra,
  ]);
  if (upd.meta.changes !== 1) return null;
  const r = await db.prepare(`SELECT ${COLS} FROM bookings WHERE stripe_session_id = ?`).bind(sessionId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function cancelHeldBySession(db: D1Database, sessionId: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE stripe_session_id = ? AND status = 'held'",
  ).bind(sessionId).run();
  return res.meta.changes === 1;
}

/** Admin cancel (D53) and the Stripe-failure path: a held or paid seat is freed. Refunds happen in Stripe. */
export async function cancelBooking(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = ? AND status IN ('held','paid')",
  ).bind(id).run();
  return res.meta.changes === 1;
}

export async function expireHolds(db: D1Database, now: number): Promise<number> {
  const res = await db.prepare(
    "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at <= ?",
  ).bind(now).run();
  return res.meta.changes;
}

export async function listForOffer(db: D1Database, offerId: string): Promise<Booking[]> {
  const rows = await db.prepare(`SELECT ${COLS} FROM bookings WHERE offer_id = ? ORDER BY created_at, id`).bind(offerId).all<Row>();
  return rows.results.map(fromRow);
}
