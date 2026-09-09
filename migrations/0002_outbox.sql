-- D20: queued side effects of a paid order. One row per (order, kind); the Stripe webhook
-- inserts them in the same batch as the status flip, the drain job delivers and retries.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_event','email_customer','email_owner')),
  order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,          -- NULL = given up; admin "retry" resets it
  last_error TEXT,
  done_at INTEGER,
  UNIQUE (order_id, kind)
);
CREATE INDEX outbox_due ON outbox (done_at, next_attempt_at);
