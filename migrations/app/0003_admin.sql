-- Up Migration
-- The admin login tables from PRD §19.2, as written there.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email ON users (lower(email));

CREATE TABLE account_members (
  account_id UUID NOT NULL REFERENCES accounts(id),
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

CREATE INDEX account_members_user ON account_members (user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 of the cookie token; the token itself is never stored
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
-- No CASCADE, so this fails rather than silently removing anything added outside this migration.
DROP TABLE sessions, account_members, users;
