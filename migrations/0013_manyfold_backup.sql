-- Agents scheduled on Manyfold (SPEC §13.4). manyfold_scheduled = 1 means a Manyfold automation starts the
-- agent at its schedule and Spotted only steps in 30 minutes late when no run has started. agent_runs.via says
-- how a run began: 'manyfold' (the agent called start_run) or 'fallback' (Spotted started it after the wait).
-- Only new columns, so the code deployed before this migration keeps working.
ALTER TABLE agents ADD COLUMN manyfold_scheduled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN via TEXT;
