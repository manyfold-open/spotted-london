-- AI agents that run on Manyfold (SPEC §13.4). Spotted keeps their settings, starts their runs
-- over A2A, and gives them a scoped API key for the MCP endpoint. Agents only ever write drafts
-- (pending pop-ups) and notes for the admin; they never publish or decide.

-- Each agent posts as its own account, so its drafts show who made them.
INSERT OR IGNORE INTO users (id, email, display_name, role, karma, email_verified, created_at) VALUES
  ('agent_scout', 'scout@agents.spotted.invalid', 'Scout agent', 'user', 0, 0, 1790726400000),
  ('agent_triage', 'triage@agents.spotted.invalid', 'Triage agent', 'user', 0, 0, 1790726400000),
  ('agent_checker', 'checker@agents.spotted.invalid', 'Checker agent', 'user', 0, 0, 1790726400000);

CREATE TABLE agents (
  id TEXT PRIMARY KEY CHECK (id IN ('scout', 'triage', 'checker')),
  user_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  schedule TEXT NOT NULL DEFAULT 'daily' CHECK (schedule IN ('hourly', 'every_6h', 'daily', 'weekly', 'manual')),
  -- London hour for daily and weekly runs (weekly runs on Mondays)
  run_hour INTEGER NOT NULL DEFAULT 7 CHECK (run_hour BETWEEN 0 AND 23),
  -- extra guidance from the admin, added to every run's brief
  instructions TEXT,
  -- most drafts or notes the agent may write in one run
  max_items INTEGER NOT NULL DEFAULT 20,
  -- Manyfold A2A endpoint and caller token (AES-GCM sealed with the AGENTS_KEY secret)
  rpc_url TEXT,
  token_sealed TEXT,
  token_hint TEXT,
  -- the key the agent uses on /mcp; only its SHA-256 is stored
  key_hash TEXT UNIQUE,
  key_hint TEXT,
  next_run_at INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO agents (id, user_id, schedule, run_hour, max_items, updated_at) VALUES
  ('scout', 'agent_scout', 'daily', 7, 20, 1790726400000),
  ('triage', 'agent_triage', 'every_6h', 8, 30, 1790726400000),
  ('checker', 'agent_checker', 'daily', 9, 30, 1790726400000);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  task_id TEXT,
  summary TEXT,
  error TEXT,
  items INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  -- last time cron asked Manyfold how the task is doing
  checked_at INTEGER
);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at);
CREATE INDEX idx_agent_runs_open ON agent_runs(status, started_at);

-- What triage and checker agents tell the admin about a pop-up. Shown in the review queue
-- until the admin makes a decision on that pop-up.
CREATE TABLE agent_notes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  popup_id TEXT NOT NULL REFERENCES popups(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('looks_real', 'needs_check', 'likely_fake', 'duplicate', 'details_changed', 'cancelled')),
  note TEXT NOT NULL,
  evidence_url TEXT,
  duplicate_of TEXT REFERENCES popups(id),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, popup_id)
);
CREATE INDEX idx_agent_notes_open ON agent_notes(resolved_at, popup_id);
