-- The /admin/agent numbers (src/db/publish.ts publishStats) and the agent undo look up audit_log by action.
-- idx_audit_actor starts with admin_id, so those lookups read the whole table (about 4,200 rows on 10 Oct 2026, growing).
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
