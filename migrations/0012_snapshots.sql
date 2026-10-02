-- Prebuilt copies of public lists, one row per key. 'popups' is the public pop-up list, rebuilt by cron and
-- whenever a pop-up enters or leaves the public set. Readers fetch this one row instead of scanning popups.
-- New table only, so the code that is deployed now keeps working until this PR ships.

CREATE TABLE snapshots (
  key      TEXT PRIMARY KEY,
  version  TEXT NOT NULL,      -- hash of json, used as the ETag
  json     TEXT NOT NULL,
  built_at INTEGER NOT NULL
);
