-- The photo backfill now decides when to look at a page again: in 3 days when the page or photo did not load
-- (a timeout, a server error), in 14 days when the page has no usable picture (src/db/photo-backfill.ts, retryAfter).
ALTER TABLE photo_tries ADD COLUMN retry_at INTEGER;

-- Forget every failed try so far. Most were made before the backfill read long heads and JSON-LD (Oct 2026),
-- and many of those pages give a photo now. Rows with saved = 1 stay: they keep a photo someone took down removed.
DELETE FROM photo_tries WHERE saved = 0;
