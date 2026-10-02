-- Finer categories, see docs/superpowers/specs/2026-10-02-category-split-design.md.
-- SQLite cannot change a CHECK in place, so popups is rebuilt: create the new table, copy, drop, rename.
-- Never rename the old table first, because SQLite would then point every child table at the old name.
-- defer_foreign_keys lets the drop run while nine tables still reference popups and checks them once at the end.
PRAGMA defer_foreign_keys = on;

CREATE TABLE popups_new (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  host TEXT,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('food', 'dining', 'market', 'exhibition', 'art', 'event', 'fashion', 'sample', 'beauty', 'tech', 'other')),
  price_type TEXT CHECK (price_type IN ('free', 'paid', 'unknown')),
  price_text TEXT,
  address TEXT,
  borough TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  geohash TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  hours_text TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'community', 'verified_community', 'verified_admin', 'hidden', 'removed', 'ended')),
  final_verdict TEXT CHECK (final_verdict IN ('real', 'fake')),
  merged_into TEXT REFERENCES popups(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  exist_pos REAL NOT NULL DEFAULT 0,
  exist_neg REAL NOT NULL DEFAULT 0,
  voter_count INTEGER NOT NULL DEFAULT 0,
  checkin_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  quality_pos INTEGER NOT NULL DEFAULT 0,
  quality_neg INTEGER NOT NULL DEFAULT 0,
  hot REAL NOT NULL DEFAULT 0,
  report_weight REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_example INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  evidence_url TEXT,
  evidence_check TEXT CHECK (evidence_check IN ('found', 'unchecked')),
  lease_agent TEXT,
  lease_until INTEGER
);

INSERT INTO popups_new (
  id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash,
  start_at, end_at, hours_text, source_url, status, final_verdict, merged_into, created_by,
  exist_pos, exist_neg, voter_count, checkin_count, confidence, quality_pos, quality_neg, hot, report_weight,
  created_at, updated_at, is_example, evidence, evidence_url, evidence_check, lease_agent, lease_until
) SELECT
  id, slug, title, host, description, category, price_type, price_text, address, borough, lat, lng, geohash,
  start_at, end_at, hours_text, source_url, status, final_verdict, merged_into, created_by,
  exist_pos, exist_neg, voter_count, checkin_count, confidence, quality_pos, quality_neg, hot, report_weight,
  created_at, updated_at, is_example, evidence, evidence_url, evidence_check, lease_agent, lease_until
FROM popups;

DROP TABLE popups;
ALTER TABLE popups_new RENAME TO popups;

CREATE INDEX idx_popups_list ON popups(status, end_at, hot DESC);
CREATE INDEX idx_popups_geo ON popups(geohash);
CREATE INDEX idx_popups_box ON popups(lat, lng);
CREATE INDEX idx_popups_user ON popups(created_by, created_at);
