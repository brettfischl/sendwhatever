-- Up Migration
-- The application schema from PRD §10, as written there.

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE             -- subdomain label: one lowercase DNS label
    CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  auto_activate BOOLEAN NOT NULL DEFAULT true,  -- activate adapters that pass validation (§12.1)
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An account's storage settings (§11.4). Normally one row; more once a rebuild has run.
CREATE TABLE account_stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL,
  backend TEXT NOT NULL,                -- postgres, sqld, clickhouse, ...
  connection JSONB NOT NULL,            -- non-secret settings: host, port, database, url
  credentials BYTEA,                    -- encrypted by the platform; key held outside the database
  read_credentials BYTEA,               -- the customer's read-only login (§14.1); encrypted the same way
  namespace TEXT NOT NULL,              -- acct_<account id>_<generation>
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'active', 'retired')),
  rebuild_through_seq BIGINT,           -- end of the rebuild's scan
  rebuild_cursor BIGINT,                -- last seq the rebuild has processed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, generation),
  UNIQUE (account_id, id)               -- target for same-account foreign keys
);

-- The store custom APIs read from. A partial unique index can't be deferred, so
-- activation retires the old store before marking the new one active (§5.4).
CREATE UNIQUE INDEX account_stores_one_active
  ON account_stores (account_id) WHERE status = 'active';

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  key_hash TEXT NOT NULL UNIQUE,        -- the key itself is shown once and never stored
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE adapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL DEFAULT ''       -- first path segment; empty when there is no path (§6)
    CHECK (octet_length(source) <= 255),
  op TEXT NOT NULL CHECK (op IN ('write', 'delete')),
  fingerprint TEXT NOT NULL,            -- computed with opaque_paths collapsed (§7.1)
  opaque_paths TEXT[] NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL,
  code TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  validated_at TIMESTAMPTZ,             -- passed the validation gate; NULL for drafts that didn't (§12.1)
  superseded_at TIMESTAMPTZ,            -- another version of this shape was activated
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, source, op, fingerprint, version),
  UNIQUE (account_id, id)               -- target for same-account foreign keys
);

-- At most one active adapter per shape
CREATE UNIQUE INDEX adapters_one_active
  ON adapters (account_id, source, op, fingerprint) WHERE active;

-- Further shapes an adapter passed validation for (§12.1)
CREATE TABLE adapter_fingerprints (
  adapter_id UUID NOT NULL REFERENCES adapters(id),
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (adapter_id, fingerprint)
);

-- Ingress event log. Append-only by convention; see §10.3 for the exceptions.
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- the event_id
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, -- replay order; decides last-write-wins
  account_id UUID NOT NULL REFERENCES accounts(id),
  body BYTEA NOT NULL,                            -- exact bytes received
  source TEXT NOT NULL DEFAULT ''                 -- first path segment; empty when there is no path (§6)
    CHECK (octet_length(source) <= 255),
  op TEXT NOT NULL CHECK (op IN ('write', 'delete')),
  fingerprint TEXT,                               -- NULL when malformed
  idempotency_key TEXT                            -- Idempotency-Key header, or a webhook delivery ID (§6.2)
    CHECK (octet_length(idempotency_key) <= 255),
  request JSONB NOT NULL,                         -- method, path as received, raw query string, headers; obvious auth removed
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)                         -- target for same-account foreign keys
);

CREATE UNIQUE INDEX events_idempotency
  ON events (account_id, source, op, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX events_account_seq ON events (account_id, seq);
CREATE INDEX events_shape ON events (account_id, source, op, fingerprint);

CREATE TABLE queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('ingest', 'replay', 'rebuild')),
  event_id UUID,                                  -- event to process (ingest)
  adapter_id UUID,                                -- adapter to replay (replay)
  store_id UUID,                                  -- store to fill (rebuild)
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),      -- next eligible time; doubles as lease and backoff
  attempts INTEGER NOT NULL DEFAULT 0,
  rerun_requested BOOLEAN NOT NULL DEFAULT false, -- run this replay again when it finishes (§10.1)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, event_id) REFERENCES events(account_id, id),
  FOREIGN KEY (account_id, adapter_id) REFERENCES adapters(account_id, id),
  FOREIGN KEY (account_id, store_id) REFERENCES account_stores(account_id, id),
  CHECK (
    (kind = 'ingest' AND event_id IS NOT NULL AND adapter_id IS NULL AND store_id IS NULL) OR
    (kind = 'replay' AND adapter_id IS NOT NULL AND event_id IS NULL AND store_id IS NULL) OR
    (kind = 'rebuild' AND store_id IS NOT NULL AND event_id IS NULL AND adapter_id IS NULL)
  ),
  CHECK (kind = 'replay' OR NOT rerun_requested)
);

CREATE INDEX queue_ready ON queue (run_at);

-- At most one job per event, one replay per adapter, and one rebuild per store at a time
CREATE UNIQUE INDEX queue_one_ingest ON queue (event_id) WHERE kind = 'ingest';
CREATE UNIQUE INDEX queue_one_replay ON queue (adapter_id) WHERE kind = 'replay';
CREATE UNIQUE INDEX queue_one_rebuild ON queue (store_id) WHERE kind = 'rebuild';

CREATE TABLE quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id),
  store_id UUID,                                  -- store the failure applies to; NULL = all live stores
  reason TEXT NOT NULL CHECK (reason IN
    ('unknown_fingerprint', 'malformed', 'adapter_error', 'schema_conflict', 'write_error')),
  detail TEXT,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  released_by_adapter_id UUID,
  FOREIGN KEY (account_id, event_id) REFERENCES events(account_id, id),
  FOREIGN KEY (account_id, store_id) REFERENCES account_stores(account_id, id),
  FOREIGN KEY (account_id, released_by_adapter_id) REFERENCES adapters(account_id, id)
);

CREATE INDEX quarantine_unreleased
  ON quarantine (account_id, event_id) WHERE released_at IS NULL;

-- At most one open quarantine entry per event and store
CREATE UNIQUE INDEX quarantine_one_open
  ON quarantine (event_id, store_id) NULLS NOT DISTINCT WHERE released_at IS NULL;

CREATE TABLE replay_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quarantine_id UUID NOT NULL REFERENCES quarantine(id),
  adapter_id UUID NOT NULL REFERENCES adapters(id),
  status TEXT NOT NULL,
  detail TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE adapter_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL DEFAULT ''
    CHECK (octet_length(source) <= 255),
  op TEXT NOT NULL CHECK (op IN ('write', 'delete')),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  adapter_id UUID,
  detail TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (account_id, adapter_id) REFERENCES adapters(account_id, id)
);

-- At most one generation in progress per shape
CREATE UNIQUE INDEX adapter_attempts_one_running
  ON adapter_attempts (account_id, source, op, fingerprint) WHERE status = 'running';

CREATE TABLE data_columns (
  store_id UUID NOT NULL REFERENCES account_stores(id),
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  logical_type TEXT NOT NULL CHECK (logical_type IN ('string', 'number', 'boolean', 'timestamp', 'json')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, table_name, column_name)
);

-- Down Migration
-- No CASCADE, so this fails rather than silently removing anything added outside this migration.
DROP TABLE
  data_columns,
  adapter_attempts,
  replay_log,
  quarantine,
  queue,
  events,
  adapter_fingerprints,
  adapters,
  api_keys,
  account_stores,
  accounts;
