-- Plan 4: the outbox also carries subscription emails. The subject column keeps its name
-- (order_id) for the existing rows; for sub_* kinds it holds the subscriber id.
-- The kind CHECK is dropped: the drain validates kinds in code, and a rebuild must never lose
-- rows written by code this branch does not know about (the 2026-09-10 deploy found one).
DROP TABLE IF EXISTS outbox_new;
CREATE TABLE outbox_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
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
