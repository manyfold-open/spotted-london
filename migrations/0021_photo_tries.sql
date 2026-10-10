-- The photo backfill (src/db/photo-backfill.ts) looks for a picture on the source page of every public
-- pop-up that has none. It writes one row per pop-up it tried, so a page without a usable picture
-- is not fetched again every 10 minutes: it gets another look after RETRY_AFTER (14 days).
CREATE TABLE photo_tries (
  popup_id TEXT PRIMARY KEY REFERENCES popups(id),
  tried_at INTEGER NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0,   -- 1 when a photo was added
  reason TEXT                         -- why not, in plain words (admin reads it)
);
