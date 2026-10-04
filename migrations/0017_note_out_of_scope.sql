-- Triage and Checker notes get a verdict `out_of_scope` (a concert, a regular menu, a trade evening: not a pop-up), and the
-- agent actions that fix, remove or end a post are counted per agent per day, so audit_log gets an index for that count.
-- SQLite cannot change a CHECK in place, so agent_notes is rebuilt: park the rows, drop, recreate under the same name, put the
-- rows back. No table references agent_notes. Never rename (see 0014_categories.sql). The column list is spelled out because
-- production added `evidence` and `publish_ready` later with ALTER TABLE, so their order differs from a fresh database.
-- The code deployed before this migration keeps working: it never sends the new verdict.
PRAGMA defer_foreign_keys = on;

CREATE TABLE agent_notes_park AS SELECT * FROM agent_notes;

DROP TABLE agent_notes;

CREATE TABLE agent_notes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  popup_id TEXT NOT NULL REFERENCES popups(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('looks_real', 'needs_check', 'likely_fake', 'duplicate', 'details_changed', 'cancelled', 'out_of_scope')),
  note TEXT NOT NULL,
  evidence_url TEXT,
  duplicate_of TEXT REFERENCES popups(id),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  evidence TEXT,
  publish_ready INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, popup_id)
);

INSERT INTO agent_notes (id, agent_id, run_id, popup_id, verdict, note, evidence_url, duplicate_of, resolved_at, created_at, evidence, publish_ready)
  SELECT id, agent_id, run_id, popup_id, verdict, note, evidence_url, duplicate_of, resolved_at, created_at, evidence, publish_ready FROM agent_notes_park;

DROP TABLE agent_notes_park;

CREATE INDEX idx_agent_notes_open ON agent_notes(resolved_at, popup_id);
CREATE INDEX idx_agent_notes_popup ON agent_notes(popup_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(admin_id, action, created_at);
