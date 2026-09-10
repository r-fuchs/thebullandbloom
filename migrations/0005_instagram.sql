-- Plan 5: Instagram posts mirrored into our storage (D12). One row per post; the image lives in R2 under media_key.
CREATE TABLE ig_posts (
  ig_id TEXT PRIMARY KEY,
  permalink TEXT NOT NULL,
  caption TEXT,
  media_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX ig_posts_taken ON ig_posts (hidden, taken_at);
