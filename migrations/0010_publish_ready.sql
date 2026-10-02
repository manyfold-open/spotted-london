-- Verification by a second agent (SPEC §13.4): a Triage note can carry its own quote from the source and a
-- publish_ready flag, set by the server when every condition for publishing holds. The admin publishes
-- the ready posts in one click. Only new columns, so the code deployed before this migration keeps working.
ALTER TABLE agent_notes ADD COLUMN evidence TEXT;
ALTER TABLE agent_notes ADD COLUMN publish_ready INTEGER NOT NULL DEFAULT 0;
