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
  -- The uploader retries un-acked batches, so make replays harmless.
  UNIQUE (install_id, ts, kind, title)
);

CREATE INDEX IF NOT EXISTS idx_feedback_model ON feedback (model_id, kind);
