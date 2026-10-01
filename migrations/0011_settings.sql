-- Small admin switches (SPEC §13.4). auto_publish is 'suggest' (the admin publishes what agents marked
-- ready, in one click) or 'auto' (the server publishes it as soon as a note is ready).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('auto_publish', 'suggest', 1790812800000);
