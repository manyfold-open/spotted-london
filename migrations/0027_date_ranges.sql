-- Pop-ups that run on more than one separate date range (two single days, two periods).
--   NULL                        an ordinary pop-up: one range, start_at to end_at
--   '[[start,end],[start,end]]' two or more ranges, Unix ms, sorted, not overlapping, at most 12
-- start_at and end_at stay NOT NULL and always hold the whole span (the first day to the last day), so the cron that
-- ends pop-ups, the indexes and every overlap query work as before. Only "is it on now / in this window" reads this column.
-- A migration that rebuilds `popups` must carry this column (and `tags`, `date_kind`).
ALTER TABLE popups ADD COLUMN date_ranges TEXT;
