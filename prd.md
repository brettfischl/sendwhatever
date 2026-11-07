# PRD: Adaptive JSON Ingestion Platform

## 1. Overview

Build a platform that accepts arbitrary JSON payloads sent to per-account endpoints, classifies their structure, and writes them into per-account storage. When an unrecognized payload structure arrives, the system quarantines it, and a continuously running LLM process writes a new data adapter for it. Once the adapter passes validation, it is activated and all matching quarantined payloads are replayed through it, so the delay for a new shape is essentially the time it takes to generate the adapter. A human operator can step in at any point.

The platform gives each account one way in and two ways to use the result:
1. **Direct adapter-driven ingestion** — raw `{ type, data }` JSON payloads are classified and written automatically.
2. **Direct SQL access** — customers connect to their own clean, normalized database with read-only credentials.
3. **Custom API built on top** — our application server connects to the same per-account storage and exposes domain-specific HTTP endpoints.

The platform has two distinct data layers:

| | Application database | Storage backend |
|---|---|---|
| **Holds** | Accounts and their storage settings, ingress event log, queue, quarantine, adapters, replay log, column registry | The account's normalized data tables |
| **Technology** | Postgres, always | Pluggable per account: Postgres first, then sqld, ClickHouse, others |
| **Schema** | Fixed, versioned migrations | Dynamic, created lazily from payloads |
| **Tenancy** | Shared tables keyed by `account_id` | One isolated namespace per account |
| **Role** | Source of truth | Derived from the event log; can be rebuilt at any time |

Every accepted payload is kept in an append-only ingress event log. Normalized tables in a storage backend are a projection of that log, so they can be rebuilt on the same backend or a different one.

---

## 2. Goals

- Accept open-ended JSON payloads in a constrained envelope: `{ "type": string, "data": object|array }`.
- Write recognized payload shapes into normalized relational tables per account.
- Quarantine unrecognized or malformed JSON payloads instead of failing the request. Only a body that isn't valid JSON is rejected.
- Generate adapters continuously with an LLM against quarantined samples, with human override.
- Replay quarantined payloads through new adapters transactionally.
- Provide a clean intermediate object contract so adapters reason about shape, not SQL or any specific data store.
- Keep all platform state in Postgres, independent of where account data lives.
- Keep a durable log of every ingress event, so an account's data can be replayed to a different storage backend.
- Support any data store as a storage backend through one interface, chosen per account, without changes to adapters or the ingestion pipeline.

## 3. Non-Goals (MVP)

- User logins, roles, or authorization beyond per-account API keys (§13.4).
- Billing, usage metering, or rate limiting.
- Payload size limits and throughput targets. This is a low-volume, one-day hackathon build (§17).
- Customer-supplied databases. Storage connections are set by the platform, and customers only receive read-only access.
- Multi-region replication or edge distribution.
- Strict foreign-key constraints or schema validation beyond column existence and logical type.
- Real-time streaming or subscriptions.
- WebSocket protocol support.
- Storage backends other than Postgres (the interface is defined now; sqld and ClickHouse follow, see §17).
- A generic query abstraction across storage backends (see §13.2).
- Distributed transactions spanning the application database and a storage backend. Replay gets its guarantees from the event log instead (see §11.2).
- A dedicated message broker. Postgres is the queue for now.
- Pruning the event log to a backup store, and handling deletion requests (see §10.3).

---

## 4. Architecture

```text
                    ┌─────────────────────────────────────┐
                    │               Clients               │
                    │    (send raw {type, data} JSON)     │
                    └──────────────────┬──────────────────┘
                                       ▼
                    ┌─────────────────────────────────────┐
                    │         Caddy Reverse Proxy         │
                    │  account-123.api → X-Account-Slug   │
                    └───────┬─────────────────────┬───────┘
                            ▼                     ▼
              ┌───────────────────────┐   ┌───────────────────────┐
              │   Ingestion Service   │   │    Custom API App     │
              │   (HTTP, enqueue,     │   │    (domain routes)    │
              │    adapter admin)     │   │                       │
              └───────────┬───────────┘   └───┬───────────────┬───┘
                          ▼                   │               │
    ┌───────────────────────────────────┐     │               │
    │      Application DB (Postgres)    │◄────┘               │
    │  accounts · account_stores        │  account lookup     │
    │  events · queue · quarantine      │                     │
    │  adapters · replay_log            │                     │
    │  data_columns · api_keys          │                     │
    └───────────────────┬───────────────┘                     │
                        ▲ claim jobs, record outcomes         │
                        ▼                                     │
              ┌───────────────────────┐ ┌──────────────────┐  │
              │    Ingestion Worker   │ │ Adapter Generator│  │
              │  fingerprint, adapter │ │ quarantine → LLM │  │
              │  run, write planning  │ │ → adapters       │  │
              └───────────┬───────────┘ └──────────────────┘  │
                          ▼                                   │
              ┌───────────────────────┐                       │
              │ StorageBackend (§11)  │                       │ native driver
              └───────────┬───────────┘                       │
        ┌─────────────────┼─────────────────┐                 │
        ▼                 ▼                 ▼                 │
  ┌───────────┐     ┌───────────┐     ┌────────────┐          │
  │ Postgres  │     │   sqld    │     │ ClickHouse │◄─────────┘
  │   (MVP)   │     │  (later)  │     │  (later)   │
  │           │     │           │     │            │
  │ schema:   │     │ namespace:│     │ database:  │
  │ acct_<id> │     │ acct_<id> │     │ acct_<id>  │
  │ ├─ user   │     │ ...       │     │ ...        │
  │ ├─ user_  │     │           │     │            │
  │ │  profile│     │           │     │            │
  │ └─ user_  │     │           │     │            │
  │    orders │     │           │     │            │
  └───────────┘     └───────────┘     └────────────┘
```

System tables live outside the account's storage namespace, so a payload with `type: "adapters"` cannot collide with platform state. The `acct_<id>` labels above are shorthand: each store's full namespace is `acct_<account id>_<generation>` (§10). Not drawn: customers also connect directly to their namespace with read-only SQL credentials (§14.1).

---

## 5. Data Flow

### 5.1 Happy Path

1. Client POSTs `{ "type": "user", "data": { ... } }` to `https://account-123.api.example.com/ingest`.
2. Caddy routes the request to the Ingestion Service with the account slug.
3. Ingestion Service resolves the account in the application database, checks the API key (§13.4), checks the envelope, and computes a structural fingerprint of `data` (sorted keys, nesting shape, array/object kinds) ignoring values.
4. In one transaction, it appends the raw body to `events` and inserts an `ingest` job into `queue`. It then returns `202 Accepted` with the `event_id`. A repeated `Idempotency-Key` creates nothing and returns the original `event_id` (§13.1).
5. A worker claims the job.
6. It queries the application database for an active adapter matching `(account_id, type, fingerprint)`, taking opaque paths into account (§7.1).
7. If found, it runs the adapter to produce an intermediate object.
8. Platform plans the write: injects deterministic IDs, `_event_seq`, and FK columns, then compares the rows against `data_columns` (§9).
9. Any new tables or columns are applied through the storage backend and recorded in `data_columns`.
10. Rows are written through the storage backend to each of the account's live stores: normally just the active store, plus the new store during a rebuild (§5.4). The active store is written first.
11. The queue job is deleted.

The write in step 10 and the delete in step 11 are not atomic. If a worker dies between them, its lease expires and another worker repeats the job. Idempotent writes make that harmless (§11.2).

### 5.2 Unknown Format Path

1. Steps 1–6 above are the same.
2. No active adapter matches.
3. A `quarantine` row referencing the event is inserted with `reason = 'unknown_fingerprint'`, and the queue job is deleted in the same transaction.
4. The Adapter Generator (§12.1), which runs continuously, picks up the new shape and samples quarantined rows for that `(type, fingerprint)`.
5. The LLM writes an adapter that normalizes the shape into the intermediate object format.
6. Adapter is inserted with `active = false` and validated against the sample.
7. If validation passes, adapter is set `active = true` (deactivating any earlier version for the same `(type, fingerprint)` in the same transaction) and a `replay` job is enqueued.
8. The worker pages through matching unreleased rows in batches, reading each payload from `events`. Each event is written through the storage backend, to the store its quarantine row names or to all live stores if it names none. It is then marked released and logged in `replay_log` in one application database transaction.

An event that fails during replay stays open, and its `reason` and `detail` are updated to the new failure, such as `adapter_error`.

A worker can look up an adapter just before activation and quarantine just after the replay finishes, stranding the row. A periodic sweep enqueues a replay for any active adapter that has matching `unknown_fingerprint` rows. Because a failed replay changes the row's reason, the sweep doesn't retry it forever.

### 5.3 Malformed Payload Path

1. Payload is valid JSON but doesn't match `{ type, data }`: `type` is missing/not a string, or `data` is not an object or array.
2. In one transaction, Ingestion Service appends it to `events` with no type or fingerprint and inserts a `quarantine` row with `reason = 'malformed'`. There is nothing for a worker to do, so no queue job is created.
3. Malformed rows are not auto-replayed; they require operator inspection.

A body that isn't valid JSON, such as `{ messages: [ msg: broken]}`, never reaches this path. The Ingestion Service rejects it with `400` and stores nothing.

### 5.4 Replay to a Different Store

An account's data can be rebuilt from the event log into a new store, on any backend, and switched over in one step.

1. Operator creates a store for the account with its backend and connection settings. The platform provisions it with `status = 'building'`.
2. From that commit on, workers write new events to both the active store and the new store.
3. A `rebuild` job reads the current maximum `events.seq`, then replays every event up to it, in `seq` order, through the currently active adapters into the new store.
   - Malformed events and events with no active adapter are skipped. Their quarantine rows stay open, and they reach all live stores when released.
   - An event that fails goes to quarantine against the new store, and the rebuild continues.
4. The store moves to `ready`. Operator reviews any failures.
5. Operator activates the store. One application database transaction points `accounts.active_store_id` at it, marks the old store `retired`, and closes quarantine rows that name the old store. A retired store receives no further writes and is kept until an operator removes it.

No event can be missed. An event that isn't yet visible to the scan in step 3 commits after the store exists, so the worker that handles it sees the new store and writes to it. Any other event is already in the log for the scan to find. `_event_seq` stops the rebuild from overwriting newer live writes with older events (§11.2).

A rebuild uses current adapters, so it also serves to reprocess an account's history on the same backend after adapters change.

---

## 6. Payload Envelope

All ingestion requests must use this envelope:

```json
{
  "type": "user",
  "data": {
    "email": "ada@example.com",
    "profile": {
      "first_name": "Ada",
      "last_name": "Lovelace"
    },
    "orders": [
      { "sku": "A1", "amount": 100 },
      { "sku": "A2", "amount": 200 }
    ]
  }
}
```

Rules:
- `type` must be a string. It names the top-level table (unless the adapter remaps it).
- `data` must be an object or array. If it is an array, each element is treated as a row of type `type`.
- Additional top-level keys are ignored by the platform but may be logged.

### 6.1 Experiment: No Envelope

We want to test how well the LLM does without the `{ type, data }` convention, accepting any JSON object or array as the payload.

`type` currently gives the generator a table name and keeps apart shapes that look alike. Without it, a user `{ id, name }` and a product `{ id, name }` share a fingerprint, so one adapter would have to handle both.

**Run it offline first.** The event log makes this possible without production changes: strip `type` from logged events, run the generator on them, and compare the results to the known types. Measure:
- First-attempt validation pass rate, against enveloped events.
- Events routed to the wrong table.
- Whether similar shapes get consistent table names.
- Generation time.

**If it holds up**, it becomes a per-account setting, which requires:
- Fingerprinting the whole body.
- Making `type` optional on `events` and `adapters`, with adapters required to set `table`.
- A new rule for what `malformed` means, since only JSON scalars would still fail the envelope check.

---

## 7. Structural Fingerprint

The fingerprint is a stable hash of the shape of `data`.

Algorithm (v1):
1. Recursively traverse `data`.
2. For objects: skip keys whose value is `null`, sort the rest alphabetically, and output `{key: <type>, ...}`.
3. For arrays: skip `null` elements, compute the shape of each remaining element, remove duplicates, sort by serialized form, and output `[<shape>, ...]`.
4. For primitives: output the JSON type name (`string`, `number`, `boolean`).
5. Serialize deterministically and hash with SHA-256 (truncated to first 16 chars for storage).

Example:

```json
{ "email": "a", "profile": { "first_name": "b" }, "orders": [{"sku":"c"}] }
```

Fingerprint shape:

```json
{"email":"string","orders":[{"sku":"string"}],"profile":{"first_name":"string"}}
```

This groups functionally identical shapes together even when values differ. Ignoring nulls stops nullable fields from multiplying shapes: `{"a":null,"b":1}` matches `{"b":1}`. Fields that are sometimes absent still produce different fingerprints, which the generator handles by trying existing adapters first (§12.1).

Array length and order don't affect the fingerprint, but a mixed array gets its own. `[{"msg":"hi"},{"msg":"hello!"}]` has the same fingerprint as `[{"msg":"hi"}]`, while `[{"msg":"hi"},{"msg":5}]` has the shape:

```json
[{"msg":"number"},{"msg":"string"}]
```

An event with an unexpected item therefore lands in quarantine as `unknown_fingerprint`, ready for an adapter written for that exact shape.

### 7.1 Opaque Paths

Some fields have keys that vary by design, like a `metadata` map or an object keyed by user ID. Under exact matching, every new key would look like a new shape and trigger a pointless generation. An adapter can therefore declare **opaque paths**, such as `metadata` or `orders[].metadata`, whose contents are ignored for matching.

- `events.fingerprint` always holds the full shape, so the log never depends on which adapters exist.
- An adapter's `fingerprint` is computed with each opaque path's value replaced by the marker `"opaque"`. Its `opaque_paths` are stored alongside it.
- **Matching an event:** try an exact match on its full fingerprint first, including fingerprints an active adapter has been validated against (`adapter_fingerprints`, §12.1). Then, for each distinct set of opaque paths among the active adapters for that `(account_id, type)`, recompute the event's fingerprint with those paths collapsed and look for a match. If several match, the adapter with the fewest opaque paths wins, then the newest. Replays and rebuilds use the same matching.

An exact match takes priority, so a specific adapter can still be added for a shape that an opaque adapter would otherwise catch.

---

## 8. Intermediate Object Contract

Adapters transform the raw payload into an intermediate object. The platform turns that object into storage backend writes.

```typescript
interface IntermediateObject {
  table?: string;       // override top-level table name; default = payload.type
  rows: IntermediateRow[];
  append?: boolean;     // child tables: each event adds rows, instead of updating by position
  column_types?: Record<string, 'timestamp'>;  // types that can't be inferred from a JSON value
}

interface IntermediateRow {
  id?: string;          // if omitted, platform injects a deterministic UUID
  [column: string]: any;
  children?: Record<string, IntermediateObject>;
}
```

Rules:
- `table` is optional. If omitted, the platform uses the payload `type`.
- `rows` is required. Each row represents one record in the table. One ingress event can produce any number of rows: `{ "messages": [{ "msg": "hi" }, { "msg": "hello!" }] }` can become two `messages` rows.
- `id` is optional on each row, including child rows. If missing, the platform injects a UUIDv5, so reprocessing the same event produces the same IDs:
  - A child of a parent with an adapter-supplied `id` derives from `(parent id, table, position)`, so a repeat of the parent updates its children instead of adding more. If a later event has fewer children, the extra rows stay, since the platform never deletes data.
  - Every other row, and any child table with `append: true`, derives from `(event_id, table, row path)`.
- An adapter-supplied `id` is treated as the record's identity, and writes to it merge: columns in the write are updated, and columns absent from it keep their values. An explicit `null` clears a column. When events conflict on a column, the one latest in the log wins (§11.2).
- Column values are strings, numbers, booleans, or `null`, plus objects or arrays at declared opaque paths (§9). A `timestamp` column is declared in `column_types`, and its values must be ISO 8601 strings with a timezone.
- `children` is reserved, as are injected foreign key names. An adapter must rename payload fields that collide with them, and a collision fails with `adapter_error`.
- `children` is optional. Each key becomes a child table named `{parent_table}_{key}` (or uses the adapter hint if provided).
- The platform injects `{parent_table}_id` as a foreign key column on every child row.

Example input:

```json
{
  "type": "user",
  "data": {
    "email": "ada@example.com",
    "profile": { "first_name": "Ada", "last_name": "Lovelace" },
    "orders": [
      { "sku": "A1", "amount": 100 },
      { "sku": "A2", "amount": 200 }
    ]
  }
}
```

Example adapter output:

```json
{
  "table": "user",
  "rows": [
    {
      "id": "usr_01J...",
      "email": "ada@example.com",
      "children": {
        "profile": {
          "table": "user_profile",
          "rows": [
            { "first_name": "Ada", "last_name": "Lovelace" }
          ]
        },
        "orders": {
          "table": "user_orders",
          "rows": [
            { "sku": "A1", "amount": 100 },
            { "sku": "A2", "amount": 200 }
          ]
        }
      }
    }
  ]
}
```

The platform then:
1. Writes the `user` row.
2. Writes `user_profile` rows with injected `id` and `user_id`.
3. Writes `user_orders` rows with injected `id` and `user_id`.

---

## 9. Schema Strategy

The platform uses a lazy, additive schema strategy, defined in logical types so it behaves the same on every storage backend.

- Tables are created on first write if they do not exist. Every table has an `id` primary key and a platform-managed `_event_seq` column holding the highest `events.seq` that has written the row.
- Columns are added on first non-null value if they do not exist. A value that is always `null` creates no column.
- Column types are inferred from the first non-null value seen, unless the adapter declares them:
  - `number` → `number`
  - `string` → `string`
  - `boolean` → `boolean`
  - string declared in `column_types` → `timestamp`
  - object or array at a declared opaque path (§7.1) → `json`
- The output is meant to be a clean relational database, so nested data becomes child tables (§8) unless it is truly free-form. An adapter that returns an object or array as a column value anywhere other than a declared opaque path fails with `adapter_error`.
- Existing columns are never modified or removed by the platform. This is enforced in code (see **Non-destructive by construction** below).
- Foreign keys are not enforced on any backend, because events can arrive out of order; the platform relies on convention (`{parent_table}_id`).
- Indexes are created automatically when a column is added, on every `{parent_table}_id` column and every `timestamp` column, so joins and time filters are fast.

`number` is one logical type with no integer/float split, so `100` followed by `100.5` is not a conflict.

**Column registry.** `data_columns` in the application database records each column's logical type, per store. It lets the platform detect conflicts the same way on every backend, without relying on store-specific errors or type coercion. SQLite, for example, would silently store a string in a numeric column, while Postgres would reject it.

**Type conflicts.** A non-null value whose logical type differs from the registered type sends the whole event to quarantine against that store with `reason = 'schema_conflict'`. Nothing is coerced and nothing from that event is written to that store.

**Non-destructive by construction.** LLM-written adapters cannot issue a `DROP`, because they emit no SQL and have no database access. They return intermediate objects, and the platform derives every schema change from those. `SchemaChange` (§11.1) can only express creating a table, adding a column, or adding an index, and backends generate no other DDL. The conformance suite (§11.5) verifies this. Any future path where LLM output reaches a store as SQL must first pass a SQL parser with an allowlist of statements, rejecting `DROP`, `TRUNCATE`, `DELETE`, and destructive `ALTER`. Text matching on adapter code isn't used, because it can't catch a constructed statement and would flag a harmless field named `drop`.

**Identifiers.** Table and column names come from client payloads and adapter output, so they are untrusted:
- They must match `^[a-z][a-z0-9_]*$` and be at most 63 characters, the Postgres limit. Nothing is truncated, since truncated names can collide. A leading underscore is reserved for platform columns. Output that breaks these rules is an `adapter_error`.
- Backends must always quote identifiers. Common names like `user` and `order` are reserved words in Postgres.

**Concurrent changes.** Workers run in parallel, so schema changes for a store are serialized with a Postgres advisory lock on the application database. The lock is taken only when the registry shows a change is needed. The backend change is applied first and the registry updated second, so a crash between them is repaired by reapplying the idempotent change.

This allows adapters to introduce new shapes without upfront schema design.

---

## 10. Application Database Schema

Postgres, managed with versioned migrations.

```sql
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,            -- subdomain label
  active_store_id UUID,                 -- the store custom APIs read from; see account_stores
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
  UNIQUE (account_id, generation)
);

ALTER TABLE accounts
  ADD FOREIGN KEY (active_store_id) REFERENCES account_stores(id);

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
  type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,            -- computed with opaque_paths collapsed (§7.1)
  opaque_paths TEXT[] NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL,
  code TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, type, fingerprint, version)
);

-- At most one active adapter per shape
CREATE UNIQUE INDEX adapters_one_active
  ON adapters (account_id, type, fingerprint) WHERE active;

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
  type TEXT,                                      -- NULL when malformed
  fingerprint TEXT,                               -- NULL when malformed
  idempotency_key TEXT,                           -- from the optional Idempotency-Key header
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX events_idempotency
  ON events (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX events_account_seq ON events (account_id, seq);
CREATE INDEX events_shape ON events (account_id, type, fingerprint);

CREATE TABLE queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('ingest', 'replay', 'rebuild')),
  event_id UUID REFERENCES events(id),            -- event to process (ingest)
  adapter_id UUID REFERENCES adapters(id),        -- adapter to replay (replay)
  store_id UUID REFERENCES account_stores(id),    -- store to fill (rebuild)
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),      -- next eligible time; doubles as lease and backoff
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'ingest' AND event_id IS NOT NULL) OR
    (kind = 'replay' AND adapter_id IS NOT NULL) OR
    (kind = 'rebuild' AND store_id IS NOT NULL)
  )
);

CREATE INDEX queue_ready ON queue (run_at);

-- At most one replay per adapter and one rebuild per store at a time
CREATE UNIQUE INDEX queue_one_replay ON queue (adapter_id) WHERE kind = 'replay';
CREATE UNIQUE INDEX queue_one_rebuild ON queue (store_id) WHERE kind = 'rebuild';

CREATE TABLE quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  store_id UUID REFERENCES account_stores(id),    -- store the failure applies to; NULL = all live stores
  reason TEXT NOT NULL CHECK (reason IN
    ('unknown_fingerprint', 'malformed', 'adapter_error', 'schema_conflict', 'write_error')),
  detail TEXT,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  released_by_adapter_id UUID REFERENCES adapters(id)
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
  type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  adapter_id UUID REFERENCES adapters(id),
  detail TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- At most one generation in progress per shape
CREATE UNIQUE INDEX adapter_attempts_one_running
  ON adapter_attempts (account_id, type, fingerprint) WHERE status = 'running';

CREATE TABLE data_columns (
  store_id UUID NOT NULL REFERENCES account_stores(id),
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  logical_type TEXT NOT NULL CHECK (logical_type IN ('string', 'number', 'boolean', 'timestamp', 'json')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, table_name, column_name)
);
```

`events.body` is `BYTEA`, not `JSONB`, because `JSONB` rejects `\u0000` even in valid JSON and doesn't preserve key order or duplicate keys. Keeping the exact bytes also means a replay sees exactly what was received.

### 10.1 Queue Behavior

- **Scope:** every ingest goes through this queue, along with quarantine replays and rebuilds.
- **Claiming:** workers claim jobs with `FOR UPDATE SKIP LOCKED` on rows where `run_at <= now()`, advancing `run_at` by the lease duration and incrementing `attempts` in the same statement. No transaction stays open during adapter runs or backend writes.
- **Crash recovery:** if a worker dies, its job becomes eligible again when the lease expires.
- **Long jobs:** replays and rebuilds can outlast a lease, so the worker running one periodically pushes `run_at` forward as a heartbeat.
- **Transient errors** (backend unreachable, timeout): the job stays in the queue and `run_at` moves forward with capped exponential backoff, so a backend outage delays writes without filling quarantine. After a configurable maximum age (default 72 hours), the event moves to quarantine with `reason = 'write_error'`.
- **Permanent errors** go to quarantine immediately (§15).
- **Completion:** jobs are deleted when done. The payload stays in `events`, and outcomes live in the data tables, `quarantine`, or `replay_log`.

### 10.2 Dynamic Data Tables

These live in the storage backend, not the application database. They are created lazily by the platform. Example after processing user payloads on the Postgres backend:

```sql
CREATE TABLE "acct_0f3a..._1"."user" (
  "id" TEXT PRIMARY KEY,
  "_event_seq" BIGINT NOT NULL,
  "email" TEXT
);

CREATE TABLE "acct_0f3a..._1"."user_profile" (
  "id" TEXT PRIMARY KEY,
  "_event_seq" BIGINT NOT NULL,
  "user_id" TEXT,
  "first_name" TEXT,
  "last_name" TEXT
);

CREATE TABLE "acct_0f3a..._1"."user_orders" (
  "id" TEXT PRIMARY KEY,
  "_event_seq" BIGINT NOT NULL,
  "user_id" TEXT,
  "sku" TEXT,
  "amount" NUMERIC
);

CREATE INDEX ON "acct_0f3a..._1"."user_profile" ("user_id");
CREATE INDEX ON "acct_0f3a..._1"."user_orders" ("user_id");
```

### 10.3 Event Log Lifecycle (Future Work)

Out of scope for this PRD, and documented so the MVP doesn't rule it out. `events` is append-only by convention, not by constraint. It is an ordinary Postgres table, so historical rows can be updated or deleted when needed.

- **Pruning:** a separate implementation can move older events out of `events` into a backup store to limit its size, partitioned by account and time.
- **Deletion requests:** the affected events are removed from `events` directly. For pruned events, the account and time partitions narrow down where to find them in long-term storage.

That work will need to handle:

- **Derived rows:** removing an event doesn't remove what it produced in storage backends, and there is no direct reference between the two. One event can produce many rows across several tables, and with adapter-supplied IDs one row can be written by many events. `_event_seq` identifies only a row's last writer. Rebuilding into a new store (§5.4) without the deleted event handles all of these cases, including restoring a row an earlier event had written. If rebuilds prove too slow for this, a lineage table mapping events to rows is the alternative, at the cost of one more entry per derived row.
- **Rebuilds after pruning:** a rebuild reads from `events`, so once events are pruned it must also read the backup store, or it will silently produce an incomplete store.
- **Foreign keys:** `quarantine` and open `queue` rows reference `events(id)`, so they must be dealt with before an event can be pruned or deleted.

---

## 11. Storage Backends

### 11.1 Interface

Every data store implements one interface. The pipeline above it knows nothing about the store.

```typescript
type LogicalType = 'string' | 'number' | 'boolean' | 'timestamp' | 'json';

interface StoreConfig {
  namespace: string;                          // from account_stores; never from the slug
  connection: Record<string, unknown>;        // from account_stores
  credentials?: Record<string, unknown>;      // decrypted by the platform
}

type SchemaChange =
  | { kind: 'create_table'; table: string }   // includes id and _event_seq
  | { kind: 'add_column'; table: string; column: string; type: LogicalType }
  | { kind: 'add_index'; table: string; column: string };

interface TableRows {
  table: string;
  columns: Record<string, LogicalType>;       // the columns these rows use
  rows: Record<string, unknown>[];            // every row has id and _event_seq; an absent key keeps the stored value
}

interface StorageBackend {
  readonly capabilities: {
    atomicWrites: boolean;                    // a write() commits fully or not at all
    idempotency: 'immediate' | 'eventual';    // when a repeated row stops being visible as a duplicate
  };

  provision(store: StoreConfig): Promise<Record<string, unknown>>;  // returns the read-only credentials
  applySchema(store: StoreConfig, changes: SchemaChange[]): Promise<void>;
  write(store: StoreConfig, tables: TableRows[]): Promise<void>;
  health(store: StoreConfig): Promise<void>;
}

class StorageError extends Error {
  retryable: boolean;   // true: stays in the queue with backoff; false: quarantined as write_error
}
```

### 11.2 Backend Requirements

- `provision` and `applySchema` must be idempotent.
- `write` receives all rows for one event and must be idempotent on `id`: writing the same row twice leaves one logical row.
- `write` merges into existing rows, so a store's final state doesn't depend on the order workers ran in or on when a quarantined event is released:
  - A write with an equal or higher `_event_seq` updates the columns it includes and leaves the others alone.
  - A write with a lower `_event_seq` only fills columns that are currently `NULL`. Late events can add data but never override newer values.
  - The row keeps the higher `_event_seq`.
- `provision` must also create read-only credentials limited to that store's namespace, and they must keep working for tables and columns added later.
- `write` must classify every failure as retryable or permanent through `StorageError`.
- Backends do not validate identifiers or types, since the platform has already done so, but must quote identifiers and bind values as parameters.

**Transactional replay.** The event log is committed in Postgres before anything is processed, so a replay always has a complete, unchanged source to read from. Deterministic IDs (§8) and `_event_seq` make every replay converge on the same rows, however often it runs or wherever it is interrupted. On top of that:

| Operation | Guarantee |
|---|---|
| Rebuild to a new store (§5.4) | All-or-nothing on every backend. Readers see the old store until a single Postgres transaction switches them to the complete new one. |
| Quarantine replay, per event | All-or-nothing where `atomicWrites` is true. Elsewhere, a partly written event can be visible until its retry completes. An event is marked released only after its write succeeds. |
| Quarantine replay, whole batch | Applied event by event, so readers can see a batch partway through. A rebuild is the way to apply one all at once. |

No distributed transaction spans the application database and a backend, and a store like ClickHouse has no multi-table transaction to offer. These guarantees come from the log instead.

### 11.3 Backend Mapping

| Concern | Postgres (MVP) | sqld (later) | ClickHouse (later) |
|---|---|---|---|
| Store isolation | Schema | Namespace | Database |
| `string` | `TEXT` | `TEXT` | `Nullable(String)` |
| `number` | `NUMERIC` | `NUMERIC` | `Nullable(Float64)` |
| `boolean` | `BOOLEAN` | `INTEGER` | `Nullable(Bool)` |
| `timestamp` | `TIMESTAMPTZ` | `TEXT` | `Nullable(DateTime64)` |
| `json` | `JSONB` | `TEXT` | `Nullable(String)` |
| `_event_seq` | `BIGINT` | `INTEGER` | `Int64` |
| Merging write | `INSERT ... ON CONFLICT (id) DO UPDATE`, with each included column set by comparing `_event_seq` | Same as Postgres | Needs design: `ReplacingMergeTree` replaces whole rows, so merging likely means `AggregatingMergeTree` with per-column latest values |
| `add_index` | `CREATE INDEX IF NOT EXISTS` | `CREATE INDEX IF NOT EXISTS` | No-op at first; ClickHouse relies on its sort order |
| `atomicWrites` | true | true | false |
| `idempotency` | immediate | immediate | eventual: duplicates remain until merge unless read with `FINAL` |

`write` is called once per event, and ClickHouse handles many small inserts poorly, so that backend should use `async_insert` or its own buffering.

### 11.4 Backend Selection

The backend is part of the account object in the application database, set when the account is created. There is no deployment-level backend configuration, and different accounts can use different backends in the same deployment.

```json
{
  "slug": "account-123",
  "storage": {
    "backend": "postgres",
    "connection": { "host": "pg-data", "port": 5432, "database": "omni_data" },
    "credentials": { "user": "omni_data", "password": "..." }
  }
}
```

- Settings are stored in `account_stores`, and `accounts.active_store_id` selects the current one. A separate table is needed because a rebuild has two stores live at once, each with its own column registry.
- Workers load an account's stores from the application database at the start of each job, so a new store takes effect without a deployment.
- `credentials` are encrypted by the platform before storage. The encryption key comes from the service environment and is never stored in the database. They are never returned by the API.
- Changing an account's backend means rebuilding into a new store (§5.4), not editing settings in place.

### 11.5 Conformance Suite

A single test suite, run against every backend, covers idempotent provisioning and schema changes, additive-only DDL, read-only credentials, repeated and out-of-order merging writes, reserved-word identifiers, all logical types and nulls, adding columns to populated tables, and error classification. Passing it is the definition of a supported backend.

---

## 12. Adapter Runtime

Adapters are stored as code strings in the application database's `adapters` table and executed in a sandboxed environment.

MVP approach:
- All services are written in TypeScript on Node.js, so adapters run on the same engine as the platform.
- Adapters are JavaScript functions stored as text.
- The worker runs them in `isolated-vm` with no access to network, filesystem, or globals other than a provided `payload` argument, and with an execution timeout.
- `Date.now()`, `new Date()` without arguments, and `Math.random()` are removed from the sandbox. Replays depend on an adapter producing the same output for the same event.
- Integers too large for a JavaScript number are passed to adapters as strings, so long numeric IDs aren't rounded.
- The function must return an `IntermediateObject`.
- Adapters should normalize values to consistent types, such as casting `5` to `"5"` for a text column. The platform never coerces values (§9), so this is where mixed types get resolved.

Example adapter code:

```javascript
function adapt(payload) {
  const data = payload.data;
  return {
    table: payload.type === 'usr' ? 'user' : payload.type,
    rows: Array.isArray(data) ? data.map(normalize) : [normalize(data)]
  };

  function normalize(item) {
    return {
      id: item.id,
      email: item.email,
      children: item.profile ? {
        profile: {
          rows: [{
            first_name: item.profile.firstName || item.profile.first_name,
            last_name: item.profile.lastName || item.profile.last_name
          }]
        }
      } : undefined
    };
  }
}
```

Security note: Adapter code is written by an LLM from client-supplied payloads and activated without human review, so it must be treated as untrusted from the MVP onward. A payload can contain text aimed at steering the LLM, which makes a basic VM wrapper insufficient. Sample payloads are passed to the LLM as data, never as instructions.

### 12.1 Adapter Generator

A continuously running process that turns quarantined shapes into active adapters. It calls its LLM through Fireworks.

1. It polls for `(account_id, type, fingerprint)` shapes with open quarantine rows and no generation in progress, and records a `running` row in `adapter_attempts`. An attempt left `running` past a timeout is treated as failed.
2. It first tries to avoid an LLM call:
   - If an active adapter now covers the shape through opaque paths (§7.1), it enqueues a replay.
   - Otherwise it runs the type's active adapters against a sample of the shape, through the validation gate below. If one passes, the fingerprint is added to `adapter_fingerprints` and a replay is enqueued. A later version of that adapter doesn't inherit these entries; those shapes pass through this step again.
3. If neither applies, it samples rows and asks the LLM for an adapter. It includes the account's full schema (`data_columns`), so that new adapters reuse existing tables and types, and the type's other open fingerprints, so the LLM can spot fields whose keys vary.
4. It validates the adapter against the sample, using the same checks as `POST /adapters/:id/test`.
5. If validation passes, the adapter is activated and its replay enqueued (§5.2). If it fails, the LLM retries with the errors, with backoff between attempts.

A configurable cap limits generations per shape, and the shape then waits for an operator. The cap counts adapters that passed validation and then failed during replay, so a shape can't loop through generations indefinitely.

**Which rows it reads:** `unknown_fingerprint`, `adapter_error`, and `schema_conflict`, where a new adapter can fix the problem. `malformed` and `write_error` rows are left to operators.

**Non-destructive prompting.** The generator's prompt instructs the LLM to evolve schemas only by adding:
- Reuse existing tables, columns, and types where they fit.
- Add new columns or tables for anything new, and never repurpose or stop writing an existing column.
- Never discard a field. Every field gets a clearly named column or child table, with no catch-all columns. When deriving a value, such as a full name, also keep the original fields.
- Normalize nested data: objects and arrays of objects become child tables, and arrays of primitives become child tables with a `value` column.
- Declare an opaque path only for a field whose keys truly vary. Store it as a child table with `key` and `value` columns when its values are uniform, or as a named `json` column when it is truly free-form. JSON is never a place to put data that could be modeled.
- Use a stable `id` from the payload when events describe the same real-world record, so they merge into one row. Omit it when each event is a new record.
- Pass `null` through only when the source means to clear a value.
- Give child rows a natural `id` where one exists, such as a SKU. Set `append: true` for lists where each event adds new items, such as messages.
- Declare date and time fields as `timestamp`, and normalize them to ISO 8601 with a timezone.

Prompts are guidance, so the rules that matter are also enforced in code, by the gate below and the schema layer (§9).

**Validation gate.** An adapter is activated only if, across the sample, it:
- Runs without errors or timeouts, and returns a valid intermediate object with valid identifiers.
- Produces identical output when run twice on the same payload.
- Produces parseable values for every declared `timestamp` column.
- Causes no type conflicts with registered columns.
- Declares opaque paths only on specific named fields, never the payload root or an array of the root, so an adapter can't match everything of a type.
- Carries every field value in the payload through to the output, allowing for casts like `5` to `"5"`, so an adapter can't pass while silently losing data.
- If it replaces an earlier version for the same shape, still writes every column that version wrote, so a column can't quietly stop being populated.

**Mistakes are recoverable.** A bad adapter that passes the gate writes wrong rows, not lost data. The original payloads remain in the event log, so a corrected adapter and a rebuild (§5.4) repair the account.

**Limits.** Generation concurrency is capped per account, so one account sending many new shapes can't starve others or run up unbounded LLM cost.

---

## 13. API Surface

### 13.1 Ingestion Service

`POST /ingest`
- Requires an API key (§13.4).
- Accepts `{ type, data }` JSON, and an optional `Idempotency-Key` header. A repeated key creates nothing and returns `202` with the original `event_id`, so clients can retry safely.
- Returns `202 Accepted` once the payload is committed to the event log, and queued if well formed.
- Returns `400` if the body isn't valid JSON. Nothing is stored.
- Returns `401` if the API key is missing, invalid, or belongs to another account, `403` if the account is disabled, and `404` if the subdomain matches no account.
- Returns `503` if the application database is unavailable, and the client should retry.
- Response body:
  - `status`: `queued`, `malformed`
  - `event_id`: always
- Processing is asynchronous, so the response does not report whether a queued payload was written or quarantined. Quarantined payloads appear in `GET /quarantine` with their `event_id`.

All routes below are internal only and not routed through Caddy.

`GET /quarantine`
- Lists quarantined payloads, optionally filtered by `type`, `fingerprint`, or `reason`.

`POST /adapters`
- Creates a new adapter (initially `active = false`). The generator normally does this; the route is the operator override, along with `activate`.
- Body: `type`, `fingerprint`, `code`, and optional `opaque_paths`.

`POST /adapters/:id/activate`
- Sets `active = true` and enqueues a replay of matching quarantined rows.

`POST /adapters/:id/test`
- Runs the adapter against a sample of matching quarantined rows without writing data. Reports the output, plus the schema changes and type conflicts it would cause.

`POST /adapters/:id/replay`
- Enqueues a replay of matching unreleased rows on an active adapter. Used to recover `write_error` rows after a backend problem is fixed.

Replays cover all reasons except `malformed`.

### 13.2 Custom API App

Looks up the account's active store on each request through an internal Ingestion Service route, which returns connection settings and read-only credentials. It then connects with the backend's native driver. It has no direct access to the application database or the encryption key. Exposes domain-specific routes built on top of the normalized tables. Exact routes are out of scope for this PRD; they will be defined per-account/use case.

`StorageBackend` is write-only by design. Queries are not abstracted, because a useful abstraction over Postgres, SQLite, and ClickHouse would either hide what makes each one worthwhile or grow into a query engine. Custom routes are therefore written for a specific backend, and must be updated if a rebuild moves the account to a different one.

### 13.3 Account Administration

These routes are internal only and not routed through Caddy.

`POST /accounts`
- Body: `slug`, `storage` (§11.4).
- Inserts the account as `provisioning` with its first store, calls `StorageBackend.provision`, and sets both `active`. Safe to retry if provisioning fails.
- Returns the account's first API key, shown once, and its read-only database connection details (§14.1).

`POST /accounts/:id/stores`
- Body: `storage`.
- Creates and provisions a `building` store and enqueues a rebuild from the event log (§5.4).

`GET /accounts/:id/stores`
- Lists the account's stores with status, rebuild progress, and open quarantine counts. Credentials are not returned.

`POST /accounts/:id/stores/:store_id/activate`
- Switches a `ready` store to active and retires the previous one, in one transaction. Direct SQL users must switch to the new store's connection details.

### 13.4 Authentication

Public routes use per-account API keys, sent as `Authorization: Bearer <key>`. A key must belong to the account named by the subdomain. Only a hash of each key is stored. There are no user logins or roles.

---

## 14. Infrastructure

### 14.1 Postgres

Postgres 16 or later, with two separate databases, even when they share a server in development:

- `omni_app`: the application database.
- `omni_data`: the Postgres storage backend, with one schema per store.

Each has its own role, and the `omni_data` role has no access to `omni_app`. This keeps tenant data load and platform state independently movable and stops anyone reaching platform state through a data connection.

**Direct customer access.** Customers connect straight to `omni_data` over TLS with standard Postgres clients. `provision` creates a login for each store that can read only that store's schema, including tables added later through default privileges, and has a statement timeout so heavy queries can't starve ingestion. `omni_app` is not reachable from outside. The `_event_seq` column is visible to customers in the MVP.

### 14.2 Caddy Routing

Caddy terminates TLS and routes subdomains to the platform services, passing the account slug as a header. Only `/ingest` and Custom API routes are public. Wildcard certificates require a DNS challenge provider.

Example Caddyfile:

```
*.api.example.com {
  handle /ingest {
    reverse_proxy ingestion:3000 {
      header_up X-Account-Slug {http.request.host.labels.3}
    }
  }

  handle {
    reverse_proxy custom-api:3001 {
      header_up X-Account-Slug {http.request.host.labels.3}
    }
  }
}
```

`header_up` overwrites any client-supplied value. Internal routes are unreachable from outside because only `/ingest` is forwarded to the Ingestion Service. For development, skip Caddy and send `X-Account-Slug` directly.

### 14.3 sqld Backend Deployment (Later)

- Run `ghcr.io/tursodatabase/libsql-server:latest` as a container, with namespaces enabled.
- Persist data via volume mount at `/var/lib/sqld`.
- Expose HTTP on port `8080`, on the internal network only.
- Optionally enable JWT auth via `SQLD_AUTH_JWT_KEY_FILE`.
- `provision` creates a namespace through the sqld admin API. Confirm the admin port and request format against current sqld docs when building this backend:

```bash
curl -X POST http://sqld:8080/v1/namespaces/acct_0f3a..._1/create
```

---

## 15. Failure Modes

| Scenario | Behavior |
|----------|----------|
| Known type + fingerprint | Write via adapter |
| Known type, unknown fingerprint | Quarantine with `unknown_fingerprint` |
| Body isn't valid JSON | Reject with `400`; nothing stored |
| Valid JSON that doesn't match the envelope | Quarantine with `malformed` |
| Missing or invalid API key | Reject with `401`; nothing stored |
| Client retries with the same `Idempotency-Key` | Return the original `event_id`; nothing new is stored |
| Adapter throws or times out | Quarantine with `adapter_error` |
| Adapter returns invalid intermediate object or identifier | Quarantine with `adapter_error` |
| Value conflicts with registered column type | Quarantine with `schema_conflict` |
| Generated adapter fails validation | Not activated; LLM retries with the errors, up to the generation cap, then the shape waits for an operator |
| Quarantined event released after newer writes to the same row | Fills only columns that are still `NULL`; newer values are kept |
| LLM provider unavailable | Generator retries with backoff; events stay safely in quarantine |
| Application database unavailable at ingest | Return `503`; client retries |
| Storage backend unavailable or times out | Job stays queued with backoff; `write_error` after maximum age |
| Backend permanently rejects a write (e.g., NUL byte in Postgres `TEXT`, column limit reached) | Quarantine with `write_error` |
| Worker dies mid-job | Lease expires; job retries; idempotent writes prevent duplicates |
| Row fails during replay | Log in `replay_log`, update the row's `reason`, and continue; adapter stays active; generator may write a new version, up to the generation cap |
| Storage backend unavailable during replay | Replay job retries with backoff; rows already released are not repeated |
| New store unavailable during a rebuild | Active store is written first and stays current; job retries for the new store, then records `write_error` against it after maximum age |
| Rebuild interrupted | Job resumes from `rebuild_cursor`; the active store is unaffected |
| Rebuild has failed events | Quarantined against the new store; operator decides whether to activate |

---

## 16. Open Questions

- Which Fireworks model does the generator use?

Released quarantine rows, `replay_log` entries, and retired stores are kept indefinitely for now.

---

## 17. Build Plan

This is a one-day hackathon build at low volume: it needs to work end to end. Work proceeds in this order.

**1. Core (must work on the day).** A payload of an unknown shape arrives, an adapter is generated, and the customer queries clean tables over SQL.
- `POST /ingest` with API keys and `Idempotency-Key`.
- Event log, Postgres queue, and worker.
- Fingerprinting, Adapter Generator, validation gate, and `isolated-vm` sandbox.
- `StorageBackend` interface and Postgres implementation, including merging writes, timestamps, indexes, and read-only credentials.
- Quarantine and replay.

**2. If time allows.**
- Opaque paths (§7.1). Without them, a field with varying keys triggers repeated generations.
- Rebuilds between Postgres stores (§5.4).
- A basic conformance suite (§11.5).
- The offline no-envelope experiment (§6.1).

**3. Stretch goals.**
- **Grader LLM:** a second LLM reviews each adapter that passes the validation gate, before activation. It judges what code checks can't, such as whether fields landed in sensible columns and whether table names fit the account's existing schema. It adds cost and some latency per new shape.
- **Sample masking:** let accounts have sample values masked before they reach the LLM. The MVP sends real values.
- **Operator controls:** routes to deactivate an adapter or pause generation for a shape, with rollback to an earlier version, plus alerts on queue age and generation failures.
- **Recurring LLM jobs:** scheduled jobs that reap old quarantined records and audit an account's tables for quality improvements. Improvements apply through new adapters and a rebuild.

**4. After the hackathon.**
- **sqld backend:** the first test of the interface against a second store, and of a rebuild across backends. Treat the interface as unstable until this ships.
- **ClickHouse backend:** the first backend with `atomicWrites: false` and eventual idempotency. Further backends follow the same path.

---

## 18. Success Criteria

For the hackathon:

- Can ingest arbitrary `{ type, data }` payloads into per-account namespaces on the Postgres backend.
- Can quarantine unrecognized shapes without data loss.
- An unknown shape reaches relational tables with no human involvement, delayed only by adapter generation and replay.
- A customer can connect with read-only credentials and query normalized tables with typed timestamps and indexed joins.
- Partial updates to the same record merge into one row without losing earlier values.
- Can replay quarantined rows transactionally after adapter activation, with repeated or interrupted replays producing no duplicate rows.
- A client retry with the same `Idempotency-Key` creates no duplicate data.
- Every accepted payload is retained in the event log, including malformed ones.
- A storage backend outage delays writes but loses no accepted payloads.

If time allows, and afterward:

- Can rebuild an account into a new store from the event log and switch to it atomically, with no accepted events missing.
- Can run the no-envelope experiment offline against the event log and report the results (§6.1).
- Custom API App can query the same normalized tables independently.
- A new storage backend can be added by implementing `StorageBackend` and passing the conformance suite, with no changes to the pipeline or adapters.
