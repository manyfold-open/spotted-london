-- Sign in: email magic links and Google (SPEC 3.4).
-- Tokens and session ids are stored as SHA-256 hashes, never in the clear.

ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_users_google ON users(google_sub) WHERE google_sub IS NOT NULL;

-- sessions.id now holds sha256(cookie value); old rows are dropped because they can never match
DELETE FROM sessions;
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip_hash TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email, created_at);
CREATE INDEX idx_login_tokens_ip ON login_tokens(ip_hash, created_at);

-- OAuth state + PKCE verifier, valid for 10 minutes
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  return_to TEXT,
  expires_at INTEGER NOT NULL
);
