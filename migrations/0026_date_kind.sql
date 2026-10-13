-- Pop-ups whose dates are not a normal short run. They can be added, but an admin looks at them before they go live.
--   NULL        an ordinary pop-up: a start and an end, at most 180 days
--   'long'      runs for more than 180 days
--   'open_end'  no end date announced (end_at is a year after the start, as a stand-in)
--   'undated'   no dates announced (start_at is the day it was added, end_at a year later, as stand-ins)
-- start_at and end_at stay NOT NULL, so lists, ranking and the cron that ends pop-ups work as before.
-- A migration that rebuilds `popups` must carry this column.
ALTER TABLE popups ADD COLUMN date_kind TEXT;
