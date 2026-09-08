CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','paid','done','cancelled','refunded')),
  date TEXT NOT NULL,
  size_id TEXT NOT NULL,
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  address_json TEXT,
  note TEXT,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  bouquet_cents INTEGER NOT NULL,
  delivery_cents INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'one_time' CHECK (source IN ('one_time','subscription')),
  subscriber_id TEXT,
  calendar_event_id TEXT,
  hold_expires_at INTEGER
);
CREATE INDEX orders_date_status ON orders (date, source, status);
CREATE INDEX orders_hold ON orders (status, hold_expires_at);

CREATE TABLE day_overrides (
  date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin','calendar')),
  cap INTEGER,
  closed INTEGER NOT NULL DEFAULT 0,
  calendar_event_id TEXT,
  PRIMARY KEY (date, source)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
