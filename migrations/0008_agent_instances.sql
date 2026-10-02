-- Many agents per role (SPEC §13.4). agents.id used to be limited to scout, triage and checker by a
-- CHECK, so the table is rebuilt: id is free text, role says what the agent does, name is what the admin sees.
-- The three existing agents keep their ids, keys, schedules and history.
--
-- agent_runs, agent_notes and others point at agents(id). With foreign keys deferred, dropping the table
-- counts every child row as orphaned, and only inserting the parent rows again cancels that out (a rename
-- does not). So the rows are parked in a plain copy, the table is dropped and created again, and the rows
-- are put back before the transaction ends.
PRAGMA defer_foreign_keys = true;

CREATE TABLE agents_parked AS SELECT * FROM agents;
DROP TABLE agents;

CREATE TABLE agents (
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

INSERT INTO agents (id, role, name, user_id, enabled, schedule, run_hour, instructions, max_items, rpc_url, token_sealed,
    token_hint, key_hash, key_hint, next_run_at, updated_at, created_at)
  SELECT id, id, CASE id WHEN 'scout' THEN 'Scout' WHEN 'triage' THEN 'Triage' ELSE 'Checker' END, user_id, enabled, schedule, run_hour,
    instructions, max_items, rpc_url, token_sealed, token_hint, key_hash, key_hint, next_run_at, updated_at, updated_at FROM agents_parked;

DROP TABLE agents_parked;
CREATE INDEX idx_agents_role ON agents(role, created_at);
