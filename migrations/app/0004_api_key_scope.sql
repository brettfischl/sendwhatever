-- Up Migration
-- A key does one job. Existing keys can be in third-party webhook URLs, so they stay `ingest` and
-- can't read tables.

ALTER TABLE api_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'ingest' CHECK (scope IN ('ingest', 'read'));

-- Down Migration

ALTER TABLE api_keys DROP COLUMN scope;
