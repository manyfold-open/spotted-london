-- Leases (SPEC §13.4): with many agents per role, a source or a pop-up is handed to one agent at a time
-- for a while, so two agents never do the same work. A lease that runs out is free again.
-- Only new columns, so the code deployed before this migration keeps working.
ALTER TABLE scout_sources ADD COLUMN leased_to TEXT;
ALTER TABLE scout_sources ADD COLUMN lease_until INTEGER;
ALTER TABLE popups ADD COLUMN lease_agent TEXT;
ALTER TABLE popups ADD COLUMN lease_until INTEGER;
