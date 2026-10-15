-- One row per day and AI feature: how often it worked, how often we failed, how long it took (docs/superpowers/specs/2026-10-15-health-checks-design.md).
--   ok      it did its job
--   failed  our fault: the agent or the model did not answer, or not in a form Spotted can read
--   other   not ours: a site blocked the page, the pasted text had nothing in it
-- Counts, milliseconds and error text written by our own code. Nothing a visitor typed, no ids.
-- ask rows are rebuilt by the hourly cron from the asks table (which is purged after 7 days); autofill rows are added to by POST /extract.
CREATE TABLE health_daily (
  day TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (feature IN ('ask', 'autofill')),
  ok INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  other INTEGER NOT NULL DEFAULT 0,
  ms_sum INTEGER NOT NULL DEFAULT 0,
  ms_max INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (day, feature)
);
