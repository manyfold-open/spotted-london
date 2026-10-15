-- Health checks also count the public MCP tools (POST /mcp search_popups and get_popup, used through the visitor's own AI).
-- health_daily.feature has a CHECK, and SQLite cannot change one in place, so the table is rebuilt: park the rows, drop it,
-- create it again under the same name with 'mcp' allowed, put the rows back. Never rename (see 0014_categories.sql).
-- Nothing points at health_daily, but the deferred check keeps this the same recipe as the other rebuilds.
PRAGMA defer_foreign_keys = on;

CREATE TABLE health_park AS SELECT * FROM health_daily;
DROP TABLE health_daily;

CREATE TABLE health_daily (
  day TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (feature IN ('ask', 'autofill', 'mcp')),
  ok INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  other INTEGER NOT NULL DEFAULT 0,
  ms_sum INTEGER NOT NULL DEFAULT 0,
  ms_max INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (day, feature)
);

INSERT INTO health_daily (day, feature, ok, failed, other, ms_sum, ms_max, last_error)
  SELECT day, feature, ok, failed, other, ms_sum, ms_max, last_error FROM health_park;

DROP TABLE health_park;
