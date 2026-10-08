-- "Ask" for recommendations (docs/superpowers/specs/2026-10-08-ask-recommendations-design.md).
--
-- 1. A fourth agent role, `concierge`. agents.role has a CHECK, and SQLite cannot change a CHECK in place, so agents is
--    rebuilt the way 0008 and 0014 did it: park the rows in a plain copy, drop the table, create it again under the same
--    name and put the rows back before the transaction ends. Never rename: the foreign-key violations raised by the drop
--    (agent_runs and agent_notes point at agents) are only cleared by inserting the parent rows again.
--    The columns are exactly those of 0008 plus manyfold_scheduled from 0013. The code deployed before this migration
--    keeps working: it never writes a concierge row and does not know the asks table.
-- 2. asks: one row per question typed into Ask. The page polls it. Rows are purged after 7 days (cron, 04:00).
--    Limits are counted from this table (a visitor's questions today, all questions today), which is exact and costs no
--    KV writes (the free KV plan allows 1,000 writes a day).
PRAGMA defer_foreign_keys = true;

CREATE TABLE agents_parked AS SELECT * FROM agents;
DROP TABLE agents;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('scout', 'triage', 'checker', 'concierge')),
  name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  schedule TEXT NOT NULL DEFAULT 'daily' CHECK (schedule IN ('hourly', 'every_6h', 'daily', 'weekly', 'manual')),
  run_hour INTEGER NOT NULL DEFAULT 7 CHECK (run_hour BETWEEN 0 AND 23),
  instructions TEXT,
  max_items INTEGER NOT NULL DEFAULT 20,
  rpc_url TEXT,
  token_sealed TEXT,
  token_hint TEXT,
  key_hash TEXT UNIQUE,
  key_hint TEXT,
  next_run_at INTEGER,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  manyfold_scheduled INTEGER NOT NULL DEFAULT 0
);

INSERT INTO agents (id, role, name, user_id, enabled, schedule, run_hour, instructions, max_items, rpc_url, token_sealed,
    token_hint, key_hash, key_hint, next_run_at, updated_at, created_at, manyfold_scheduled)
  SELECT id, role, name, user_id, enabled, schedule, run_hour, instructions, max_items, rpc_url, token_sealed,
    token_hint, key_hash, key_hint, next_run_at, updated_at, created_at, manyfold_scheduled FROM agents_parked;

DROP TABLE agents_parked;
CREATE INDEX idx_agents_role ON agents(role, created_at);

CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  asked_at INTEGER NOT NULL,
  -- salted hash of the visitor's IP (never the IP itself), or 'none' when the request carried none
  ip_hash TEXT NOT NULL,
  -- what the visitor typed, at most 300 characters. Data for the agent, never instructions
  text TEXT NOT NULL,
  -- short taste summary the browser chose to send: {"likes":[...],"left_out":[...],"free":"likes"}. No position.
  taste TEXT,
  -- 1 when the browser will order the answer by distance itself, so the agent returns more candidates
  near_me INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  agent_id TEXT,
  task_id TEXT,
  -- {"picks":[{"id","reason"}],"note"}: only pop-ups that were in the public list when the answer arrived
  answer TEXT,
  error TEXT,
  -- last time a poll asked Manyfold how the task is doing
  checked_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX idx_asks_ip ON asks(ip_hash, asked_at);
CREATE INDEX idx_asks_at ON asks(asked_at);
