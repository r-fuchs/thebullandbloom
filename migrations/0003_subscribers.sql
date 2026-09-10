-- Plan 4: subscribers. Stripe owns billing state; this row mirrors it and carries what the
-- nightly materialization needs (size, cadence, weekday, anchor, paused weeks).
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','cancelled')),
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  size_id TEXT NOT NULL,
  cadence_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  address_json TEXT,
  delivery_add_on_cents INTEGER NOT NULL DEFAULT 0,
  anchor_date TEXT NOT NULL,
  paused_weeks_json TEXT NOT NULL DEFAULT '[]',
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  note TEXT
);
CREATE INDEX subscribers_status ON subscribers (status);
-- Materialization is idempotent on (subscriber, date) (D29).
CREATE UNIQUE INDEX orders_subscriber_date ON orders (subscriber_id, date) WHERE subscriber_id IS NOT NULL;
