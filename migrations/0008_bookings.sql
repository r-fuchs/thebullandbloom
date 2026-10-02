-- Plan 7 (D46, D53): one row per seat booked at a class. Mirrors orders: held while the customer
-- pays on Stripe, paid on the webhook, cancelled on expiry or by admin after a refund in Stripe.
-- Seats taken for a session = rows with status held or paid.
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','paid','cancelled')),
  offer_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  note TEXT,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  price_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  hold_expires_at INTEGER
);
CREATE INDEX bookings_session ON bookings (offer_id, session_id, status);
CREATE INDEX bookings_hold ON bookings (status, hold_expires_at);
