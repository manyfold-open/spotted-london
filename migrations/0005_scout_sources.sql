-- Scout's memory (SPEC §13.4): where to look, what it already read, and extra links per pop-up.
-- Only new tables, so the code deployed before this migration keeps working.

-- Places Scout checks on each run: listing sites, venue "what's on" pages, brand sites, social
-- accounts and web searches. Scout can only suggest new ones; the admin turns them on.
CREATE TABLE scout_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('listing', 'venue', 'brand', 'social', 'search')),
  -- a web address, or the search words for kind 'search'
  target TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suggested', 'paused', 'rejected')),
  -- how many days between checks
  every_days INTEGER NOT NULL DEFAULT 1 CHECK (every_days BETWEEN 1 AND 60),
  -- the admin's note, or why Scout suggested it
  note TEXT,
  suggested_by_run TEXT REFERENCES agent_runs(id),
  last_checked_at INTEGER,
  -- next time Scout should look; NULL means now. Set in JS (no maths in SQL).
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_scout_sources_due ON scout_sources(status, due_at);

-- Pages Scout already read and what came of them, so it does not read them again. Rows that led
-- to a draft are kept for the source's track record; the rest are purged after 90 days.
CREATE TABLE scout_seen (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'duplicate', 'not_popup', 'ended', 'too_far_ahead', 'no_details', 'outside_london', 'other')),
  reason TEXT,
  source_id TEXT REFERENCES scout_sources(id),
  popup_id TEXT REFERENCES popups(id),
  run_id TEXT REFERENCES agent_runs(id),
  seen_at INTEGER NOT NULL
);
CREATE INDEX idx_scout_seen_url ON scout_seen(url, seen_at);
CREATE INDEX idx_scout_seen_source ON scout_seen(source_id, outcome);

-- Links beyond popups.source_url: the brand site, the venue page, an Instagram, TikTok or
-- Xiaohongshu (RED) post about the same pop-up.
CREATE TABLE popup_links (
  popup_id TEXT NOT NULL REFERENCES popups(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('official', 'venue', 'ticket', 'article', 'instagram', 'tiktok', 'xiaohongshu', 'other')),
  added_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (popup_id, url)
);

-- Web addresses are stored the way normalizeUrl() in src/db/scout.ts writes them.
-- The starting list: what SKILL.md used to name, plus web searches that surface public social
-- posts (Scout reads search results, never logs in or scrolls feeds).
INSERT OR IGNORE INTO scout_sources (id, kind, target, label, every_days, created_at, updated_at) VALUES
  ('src_timeout', 'listing', 'https://www.timeout.com/london/things-to-do', 'Time Out London: things to do', 1, 1790812800000, 1790812800000),
  ('src_secretldn', 'listing', 'https://secretldn.com/', 'Secret London', 1, 1790812800000, 1790812800000),
  ('src_londonist', 'listing', 'https://londonist.com/', 'Londonist', 1, 1790812800000, 1790812800000),
  ('src_hypebeast', 'listing', 'https://hypebeast.com/', 'Hypebeast and Hypebae (London pop-ups)', 2, 1790812800000, 1790812800000),
  ('src_eventbrite', 'listing', 'https://www.eventbrite.co.uk/d/united-kingdom--london/pop-up', 'Eventbrite: London pop-up search', 1, 1790812800000, 1790812800000),
  ('src_coaldrops', 'venue', 'https://www.coaldropsyard.com/', 'Coal Drops Yard', 3, 1790812800000, 1790812800000),
  ('src_sevendials', 'venue', 'https://www.sevendials.co.uk/', 'Seven Dials', 3, 1790812800000, 1790812800000),
  ('src_coventgarden', 'venue', 'https://www.coventgarden.london/', 'Covent Garden', 3, 1790812800000, 1790812800000),
  ('src_carnaby', 'venue', 'https://www.carnaby.co.uk/', 'Carnaby', 3, 1790812800000, 1790812800000),
  ('src_spitalfields', 'venue', 'https://www.oldspitalfieldsmarket.com/', 'Old Spitalfields Market', 3, 1790812800000, 1790812800000),
  ('src_truman', 'venue', 'https://www.trumanbrewery.com/', 'Old Truman Brewery', 3, 1790812800000, 1790812800000),
  ('src_boxpark', 'venue', 'https://www.boxpark.co.uk/', 'Boxpark', 3, 1790812800000, 1790812800000),
  ('src_battersea', 'venue', 'https://batterseapowerstation.co.uk/', 'Battersea Power Station', 3, 1790812800000, 1790812800000),
  ('src_kerb', 'venue', 'https://www.kerbfood.com/', 'KERB', 3, 1790812800000, 1790812800000),
  ('src_flatiron', 'venue', 'https://flatironsquare.co.uk/', 'Flat Iron Square', 3, 1790812800000, 1790812800000),
  ('src_westfield_london', 'venue', 'https://uk.westfield.com/london', 'Westfield London', 3, 1790812800000, 1790812800000),
  ('src_westfield_stratford', 'venue', 'https://uk.westfield.com/stratfordcity', 'Westfield Stratford City', 3, 1790812800000, 1790812800000),
  ('src_q_sample', 'search', 'London sample sale this week', 'Search: London sample sales', 1, 1790812800000, 1790812800000),
  ('src_q_popup', 'search', 'London pop-up shop opening this week', 'Search: London pop-up shops', 1, 1790812800000, 1790812800000),
  ('src_q_instagram', 'search', 'site:instagram.com London pop-up', 'Search: Instagram posts about London pop-ups', 2, 1790812800000, 1790812800000),
  ('src_q_tiktok', 'search', 'site:tiktok.com London pop-up', 'Search: TikTok videos about London pop-ups', 2, 1790812800000, 1790812800000),
  ('src_q_red', 'search', 'site:xiaohongshu.com 伦敦 快闪', 'Search: Xiaohongshu (RED) notes about London pop-ups', 2, 1790812800000, 1790812800000),
  ('src_q_red_cn', 'search', '伦敦 快闪店', 'Search: Chinese-language London pop-up posts', 2, 1790812800000, 1790812800000);
