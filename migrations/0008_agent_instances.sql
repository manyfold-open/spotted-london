-- Many agents per role (SPEC §13.4). agents.id used to be limited to scout, triage and checker by a
-- CHECK, so it is rebuilt: id is free text, role says what the agent does, name is what the admin sees.
-- The three existing agents keep their ids, keys, schedules and history.
-- Foreign keys from agent_runs and agent_notes point at the name agents, which the new table takes over.
PRAGMA defer_foreign_keys = true;

CREATE TABLE agents_new (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('scout', 'triage', 'checker')),
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
  created_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO agents_new (id, role, name, user_id, enabled, schedule, run_hour, instructions, max_items, rpc_url, token_sealed,
    token_hint, key_hash, key_hint, next_run_at, updated_at, created_at)
  SELECT id, id, CASE id WHEN 'scout' THEN 'Scout' WHEN 'triage' THEN 'Triage' ELSE 'Checker' END, user_id, enabled, schedule, run_hour,
    instructions, max_items, rpc_url, token_sealed, token_hint, key_hash, key_hint, next_run_at, updated_at, updated_at FROM agents;

DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
CREATE INDEX idx_agents_role ON agents(role, created_at);
