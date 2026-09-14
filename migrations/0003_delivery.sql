-- Plan 3 (Uber Direct delivery). Three changes:
--  1. orders.uber_quote_id — the checkout-time quote id, informational only (D8: the FEE is
--     what is locked, in delivery_cents; the quote itself expires in minutes).
--  2. deliveries — one row per courier job Anthony requests (spec §4.3).
--  3. outbox gains the 'courier_email' kind. SQLite cannot alter a CHECK constraint, so the
--     table is rebuilt and its rows copied (D28).

ALTER TABLE orders ADD COLUMN uber_quote_id TEXT;

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  uber_delivery_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  quoted_cents INTEGER NOT NULL,   -- the day-of quote this delivery was created from
  fee_cents INTEGER NOT NULL,      -- what Uber says the job costs (spec §4.3 called this actual_cents; D27)
  tracking_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX deliveries_order ON deliveries (order_id);

CREATE TABLE outbox_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_event','email_customer','email_owner','courier_email')),
  order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  done_at INTEGER,
  UNIQUE (order_id, kind)
);
INSERT INTO outbox_new (id, kind, order_id, created_at, attempts, next_attempt_at, last_error, done_at)
  SELECT id, kind, order_id, created_at, attempts, next_attempt_at, last_error, done_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX outbox_due ON outbox (done_at, next_attempt_at);
