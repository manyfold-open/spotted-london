-- Instagram and Threads posts for Scout, fetched through Apify (see
-- docs/superpowers/specs/2026-10-01-social-posts-via-apify-design.md).
-- Only new tables, so the code deployed before this migration keeps working.

-- One Apify run per due social source. The cron job starts it, then checks it on later ticks.
-- While a run is 'running', cost_usd holds its worst case so the monthly budget cannot be overspent.
CREATE TABLE social_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES scout_sources(id),
  apify_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'skipped_budget')),
  items INTEGER NOT NULL DEFAULT 0,
  kept INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_social_runs_source ON social_runs(source_id, started_at);
CREATE INDEX idx_social_runs_open ON social_runs(status);

-- Posts that passed the cheap filter. Scout reads these; handled_at is set when Scout
-- reports the post through submit_draft or skip_url. Removed after 90 days.
CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'threads')),
  source_id TEXT NOT NULL REFERENCES scout_sources(id),
  run_id TEXT REFERENCES social_runs(id),
  author TEXT,
  body TEXT,
  -- JSON array of at most 4 image addresses
  image_urls TEXT,
  posted_at INTEGER,
  fetched_at INTEGER NOT NULL,
  handled_at INTEGER
);
CREATE INDEX idx_social_posts_new ON social_posts(source_id, handled_at, fetched_at);
