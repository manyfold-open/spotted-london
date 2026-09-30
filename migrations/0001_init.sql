-- Spotted London: initial schema (SPEC §6). All times are Unix milliseconds.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_key TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'organizer', 'admin')),
  karma INTEGER NOT NULL DEFAULT 0,
  verified_posts INTEGER NOT NULL DEFAULT 0,
  bad_posts INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'shadowbanned', 'banned', 'deleted')),
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE popups (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  host TEXT,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('food', 'fashion', 'sample', 'art', 'market', 'beauty', 'tech', 'other')),
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
  -- 'real' | 'fake' once known; drives karma settlement
  final_verdict TEXT CHECK (final_verdict IN ('real', 'fake')),
  merged_into TEXT REFERENCES popups(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  -- cached aggregates, written by the Worker (math happens in JS, not SQL)
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
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_popups_list ON popups(status, end_at, hot DESC);
CREATE INDEX idx_popups_geo ON popups(geohash);
CREATE INDEX idx_popups_box ON popups(lat, lng);
CREATE INDEX idx_popups_user ON popups(created_by, created_at);

CREATE TABLE popup_images (
  id TEXT PRIMARY KEY,
  popup_id TEXT NOT NULL REFERENCES popups(id),
  r2_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  uploaded_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_images_popup ON popup_images(popup_id, position);

CREATE TABLE votes (
  user_id TEXT NOT NULL REFERENCES users(id),
  popup_id TEXT NOT NULL REFERENCES popups(id),
  kind TEXT NOT NULL CHECK (kind IN ('existence', 'quality')),
  value INTEGER NOT NULL CHECK (value IN (1, -1)),
  weight REAL NOT NULL,
  ip_hash TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, popup_id, kind)
);
CREATE INDEX idx_votes_popup ON votes(popup_id, kind);
CREATE INDEX idx_votes_unsettled ON votes(settled, popup_id);

CREATE TABLE checkins (
  user_id TEXT NOT NULL REFERENCES users(id),
  popup_id TEXT NOT NULL REFERENCES popups(id),
  lat REAL,
  lng REAL,
  distance_m REAL NOT NULL,
  photo_key TEXT,
  valid INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, popup_id)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  popup_id TEXT NOT NULL REFERENCES popups(id),
  reason TEXT NOT NULL CHECK (reason IN ('not_exist', 'cancelled', 'wrong_details', 'duplicate', 'spam', 'inappropriate')),
  note TEXT,
  weight REAL NOT NULL,
  resolution TEXT CHECK (resolution IN ('upheld', 'rejected')),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, popup_id)
);
CREATE INDEX idx_reports_open ON reports(resolution, popup_id);

CREATE TABLE saves (
  user_id TEXT NOT NULL REFERENCES users(id),
  popup_id TEXT NOT NULL REFERENCES popups(id),
  remind INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, popup_id)
);

CREATE TABLE karma_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_karma_user ON karma_log(user_id, created_at);
-- one award per (user, reason, reference) keeps every karma event idempotent
CREATE UNIQUE INDEX idx_karma_once ON karma_log(user_id, reason, ref_id);

CREATE TABLE subscribers (
  email TEXT PRIMARY KEY,
  confirmed INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  unsubscribed_at INTEGER
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
