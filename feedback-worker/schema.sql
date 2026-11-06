-- One row per shared correction. Mirrors FeedbackRecord in
-- ../src/shared/feedback.ts minus local bookkeeping (`uploaded`).
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id TEXT NOT NULL,
  ext_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('false_positive', 'false_negative')),
  title TEXT NOT NULL,
  channel TEXT,
  context TEXT,
  domain TEXT NOT NULL,
  model_label TEXT NOT NULL,
  score REAL NOT NULL,
  corrected_label TEXT,
  model_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  -- Retention (#32): the worker stamps every row with received_at + 90 days
  -- (PRIVACY.md "Data retention"); the daily cron and the write path both
  -- DELETE rows where expires_at < now, and export excludes them.
  expires_at INTEGER NOT NULL,
  -- The uploader retries un-acked batches, so make replays harmless.
  UNIQUE (install_id, ts, kind, title)
);

CREATE INDEX IF NOT EXISTS idx_feedback_model ON feedback (model_id, kind);
-- Daily purge + export exclusion + self-service delete all scan/filter by TTL.
CREATE INDEX IF NOT EXISTS idx_feedback_expires ON feedback (expires_at);
CREATE INDEX IF NOT EXISTS idx_feedback_install ON feedback (install_id);

-- Fixed-window rate-limit counters (#18), one row per live bucket.
-- bucket: "<scope>:<window>:<installId|ip>:<slot>", e.g. "i:d:<uuid>:21000"
-- (i/p = install/IP, d/m/h = day/minute/hour). expires_at is bucket end plus
-- one extra window of slack, purged by the same daily cron as feedback rows.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires_at);
