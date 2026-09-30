-- Example pop-ups shown before launch. Labelled in the app, hidden from search engines,
-- and removable in one go with seed/clear-examples.sql.
ALTER TABLE popups ADD COLUMN is_example INTEGER NOT NULL DEFAULT 0;
