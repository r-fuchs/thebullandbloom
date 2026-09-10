-- Plan 4: the outbox also carries subscription emails. The subject column keeps its name
-- (order_id) for the existing rows; for sub_* kinds it holds the subscriber id.
CREATE TABLE outbox_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_event','email_customer','email_owner',
    'sub_confirmed_customer','sub_confirmed_owner','sub_cancelled_customer','sub_cancelled_owner')),
  order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  done_at INTEGER,
  UNIQUE (order_id, kind)
);
INSERT INTO outbox_new SELECT id, kind, order_id, created_at, attempts, next_attempt_at, last_error, done_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX outbox_due ON outbox (done_at, next_attempt_at);
