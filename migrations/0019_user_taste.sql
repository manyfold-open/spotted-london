-- Two files carry the number 0019 (0019_photo_source.sql and this one). Both are recorded in production under these
-- exact names (d1_migrations ids 19 and 20), and wrangler tracks migrations by name: do not rename either.
--
-- "For you" taste kept on the account (docs: CLAUDE.md "For you (taste)").
-- One row per signed-in person. `data` is the Taste JSON from src/shared/taste.ts, already cleaned by parseTaste and
-- capped in size by the route. `updated_at` is the server clock (Unix ms) and doubles as the version the browser
-- sends back as `base`, so two devices cannot overwrite each other without noticing.
-- A plain new table: the code deployed before this migration never reads or writes it, and the new code answers
-- 503 on /me/taste (and still deletes accounts) if it runs before the table exists.
CREATE TABLE user_taste (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
