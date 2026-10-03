-- Two lookups scanned a whole table every time. On 3 Oct 2026 they used most of D1's 5 million rows read a day:
-- the Checker's and Triage's task leases (list_live_popups, list_review_queue) ask agent_notes about every pop-up by
-- popup_id, and every item an agent used counted scout_seen by run_id. Only new indexes, so the code deployed before
-- this migration keeps working. They were first created by hand in production; IF NOT EXISTS makes this safe to apply.
CREATE INDEX IF NOT EXISTS idx_agent_notes_popup ON agent_notes(popup_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_scout_seen_run ON scout_seen(run_id);
