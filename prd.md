# PRD: Adaptive JSON Ingestion Platform

## 1. Overview

Build a platform that accepts arbitrary JSON payloads sent to per-account endpoints, classifies their structure, and writes them into per-account storage. When an unrecognized payload structure arrives, the system quarantines it and provides a workflow for an AI (or human operator) to author a new data adapter. Once the adapter is approved, all matching quarantined payloads are replayed through it.

The platform exposes two consumption paths for each account:
1. **Direct adapter-driven ingestion** — raw `{ type, data }` JSON payloads are classified and written automatically.
2. **Custom API built on top** — our application server connects to the same per-account storage and exposes domain-specific HTTP endpoints.

The platform has two distinct data layers:

| | Application database | Storage backend |
|---|---|---|
| **Holds** | Accounts, queue, quarantine, adapters, replay log, column registry | The account's normalized data tables |
| **Technology** | Postgres, always | Pluggable: Postgres first, then sqld, ClickHouse, others |
| **Schema** | Fixed, versioned migrations | Dynamic, created lazily from payloads |
| **Tenancy** | Shared tables keyed by `account_id` | One isolated namespace per account |

---

## 2. Goals

- Accept open-ended JSON payloads in a constrained envelope: `{ "type": string, "data": object|array }`.
- Write recognized payload shapes into normalized relational tables per account.
- Quarantine unrecognized or malformed payloads instead of failing the request.
- Support AI/human adapter generation against quarantined samples.
- Replay quarantined payloads through new adapters safely, with idempotent writes.
- Provide a clean intermediate object contract so adapters reason about shape, not SQL or any specific data store.
- Keep all platform state in Postgres, independent of where account data lives.
- Support any data store as a storage backend through one interface, without changes to adapters or the ingestion pipeline.

## 3. Non-Goals (MVP)

- Authentication or authorization.
- Billing, usage metering, or rate limiting.
- Multi-region replication or edge distribution.
- Full AI adapter generation implementation (the interface and workflow are defined; the LLM integration is out of scope).
- Strict foreign-key constraints or schema validation beyond column existence and logical type.
- Real-time streaming or subscriptions.
- WebSocket protocol support.
- Storage backends other than Postgres (the interface is defined now; sqld and ClickHouse follow, see §17).
- Moving an account's data between storage backends.
- A generic query abstraction across storage backends (see §13.2).
- Atomic transactions spanning the application database and a storage backend (see §11.2).
- Ordering guarantees between events.

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
    │  accounts · queue · quarantine    │  account lookup     │
    │  adapters · replay_log            │                     │
    │  data_columns                     │                     │
    └───────────────────┬───────────────┘                     │
                        ▲ claim jobs, record outcomes         │
                        ▼                                     │
              ┌───────────────────────┐                       │
              │    Ingestion Worker   │                       │
              │  fingerprint, adapter │                       │
              │  run, write planning  │                       │
              └───────────┬───────────┘                       │
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

System tables live outside the account's storage namespace, so a payload with `type: "adapters"` cannot collide with platform state.

---

## 5. Data Flow

### 5.1 Happy Path

1. Client POSTs `{ "type": "user", "data": { ... } }` to `https://account-123.api.example.com/ingest`.
2. Caddy routes the request to the Ingestion Service with the account slug.
3. Ingestion Service resolves the account in the application database, checks the envelope, inserts the raw body into `queue` as an `ingest` job, and returns `202 Accepted` with the job's ID as the `event_id`.
4. A worker claims the job.
5. Worker computes a structural fingerprint of `data` (sorted keys, nesting shape, array/object kinds) ignoring values.
6. It queries the application database for an active adapter matching `(account_id, type, fingerprint)`.
7. If found, it runs the adapter to produce an intermediate object.
8. Platform plans the write: injects deterministic IDs and FK columns, then compares the rows against `data_columns` (§9).
9. Any new tables or columns are applied through the storage backend and recorded in `data_columns`.
10. Rows are written through the storage backend.
11. The queue job is deleted.

The write in step 10 and the delete in step 11 are not atomic. If a worker dies between them, its lease expires and another worker repeats the job. Idempotent writes make that harmless (§11.2).

### 5.2 Unknown Format Path

1. Steps 1–6 above are the same.
2. No active adapter matches.
3. Payload is inserted into `quarantine` with `reason = 'unknown_fingerprint'`, using the `event_id` as its ID, and the queue job is deleted in the same transaction.
4. A background or on-demand process samples quarantined rows for that `(type, fingerprint)`.
5. AI/human writes an adapter that normalizes the shape into the intermediate object format.
6. Adapter is inserted with `active = false`, tested against the sample.
7. On approval, adapter is set `active = true` (deactivating any earlier version for the same `(type, fingerprint)` in the same transaction) and a `replay` job is enqueued.
8. The worker pages through matching unreleased rows in batches. Each row is written through the storage backend, then marked released and logged in `replay_log` in one application database transaction.

A worker can look up an adapter just before activation and quarantine just after the replay finishes, stranding the row. A periodic sweep enqueues a replay for any active adapter that has matching `unknown_fingerprint` rows.

### 5.3 Malformed Payload Path

1. Payload cannot be parsed as `{ type, data }` or `type` is missing/not a string.
2. Ingestion Service inserts it into `quarantine` directly, with `reason = 'malformed'` and no fingerprint. It does not enter the queue.
3. Malformed rows are not auto-replayed; they require operator inspection.

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

---

## 7. Structural Fingerprint

The fingerprint is a stable hash of the shape of `data`.

Algorithm (v1):
1. Recursively traverse `data`.
2. For objects: sort keys alphabetically; output `{key: <type>, ...}`.
3. For arrays: output `[<element-type>]`.
4. For primitives: output the JSON type name (`string`, `number`, `boolean`, `null`).
5. Serialize deterministically and hash with SHA-256 (truncated to first 16 chars for storage).

Example:

```json
{ "email": "a", "profile": { "first_name": "b" }, "orders": [{"sku":"c"}] }
```

Fingerprint shape:

```json
{"email":"string","orders":[{"sku":"string"}],"profile":{"first_name":"string"}}
```

This groups functionally identical shapes together even when values differ.

---

## 8. Intermediate Object Contract

Adapters transform the raw payload into an intermediate object. The platform turns that object into storage backend writes.

```typescript
interface IntermediateObject {
  table?: string;       // override top-level table name; default = payload.type
  rows: IntermediateRow[];
}

interface IntermediateRow {
  id?: string;          // if omitted, platform injects a deterministic UUID
  [column: string]: any;
  children?: Record<string, IntermediateObject>;
}
```

Rules:
- `table` is optional. If omitted, the platform uses the payload `type`.
- `rows` is required. Each row represents one record in the table.
- `id` is optional on each row, including child rows. If missing, the platform injects a UUIDv5 derived from `(event_id, table, row path)`, so reprocessing the same event produces the same IDs.
- An adapter-supplied `id` is treated as the record's identity: a later event with the same `id` overwrites it.
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

- Tables are created on first write if they do not exist. Every table has an `id` primary key.
- Columns are added on first non-null value if they do not exist. A value that is always `null` creates no column.
- Column types are inferred from the first non-null value seen:
  - `number` → `number`
  - `string` → `string`
  - `boolean` → `boolean`
  - object or array → `json`
- Existing columns are never modified or removed by the platform.
- Foreign keys are not enforced on any backend; the platform relies on convention (`{parent_table}_id`).

`number` is one logical type with no integer/float split, so `100` followed by `100.5` is not a conflict.

**Column registry.** `data_columns` in the application database records each column's logical type. It lets the platform detect conflicts the same way on every backend, without relying on store-specific errors or type coercion. SQLite, for example, would silently store a string in a numeric column, while Postgres would reject it.

**Type conflicts.** A non-null value whose logical type differs from the registered type sends the whole event to quarantine with `reason = 'schema_conflict'`. Nothing is coerced and nothing from that event is written.

**Identifiers.** Table and column names come from client payloads and adapter output, so they are untrusted:
- They must match `^[a-z_][a-z0-9_]*$` and be at most 63 characters, the Postgres limit. Nothing is truncated, since truncated names can collide. Output that breaks these rules is an `adapter_error`.
- Backends must always quote identifiers. Common names like `user` and `order` are reserved words in Postgres.

**Concurrent changes.** Workers run in parallel, so schema changes for an account are serialized with a Postgres advisory lock on the application database. The lock is taken only when the registry shows a change is needed. The backend change is applied first and the registry updated second, so a crash between them is repaired by reapplying the idempotent change.

This allows adapters to introduce new shapes without upfront schema design.

---

## 10. Application Database Schema

Postgres, managed with versioned migrations.

```sql
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,            -- subdomain label
  storage_target TEXT NOT NULL,         -- key into deployment config (§11.4); fixed after provisioning
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE adapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL,
  code TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, type, fingerprint, version)
);

-- At most one active adapter per shape
CREATE UNIQUE INDEX adapters_one_active
  ON adapters (account_id, type, fingerprint) WHERE active;

CREATE TABLE queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- the event_id for ingest jobs
  account_id UUID NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('ingest', 'replay')),
  body BYTEA,                                     -- raw request body (ingest)
  adapter_id UUID REFERENCES adapters(id),        -- adapter to replay (replay)
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),      -- next eligible time; doubles as lease and backoff
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'ingest' AND body IS NOT NULL) OR (kind = 'replay' AND adapter_id IS NOT NULL))
);

CREATE INDEX queue_ready ON queue (run_at);

CREATE TABLE quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- the event_id, when the payload came through the queue
  account_id UUID NOT NULL REFERENCES accounts(id),
  payload BYTEA NOT NULL,                         -- exact bytes received
  type TEXT,                                      -- NULL when malformed
  fingerprint TEXT,                               -- NULL when malformed
  reason TEXT NOT NULL CHECK (reason IN
    ('unknown_fingerprint', 'malformed', 'adapter_error', 'schema_conflict', 'write_error')),
  detail TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  released_by_adapter_id UUID REFERENCES adapters(id)
);

CREATE INDEX quarantine_unreleased
  ON quarantine (account_id, type, fingerprint, id) WHERE released_at IS NULL;

CREATE TABLE replay_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quarantine_id UUID NOT NULL REFERENCES quarantine(id),
  adapter_id UUID NOT NULL REFERENCES adapters(id),
  status TEXT NOT NULL,
  detail TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE data_columns (
  account_id UUID NOT NULL REFERENCES accounts(id),
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  logical_type TEXT NOT NULL CHECK (logical_type IN ('string', 'number', 'boolean', 'json')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, table_name, column_name)
);
```

Payloads are `BYTEA`, not `JSONB`, because a malformed payload may not be valid JSON and `JSONB` rejects `\u0000` even in valid JSON. Keeping the exact bytes also means quarantine loses nothing.

### 10.1 Queue Behavior

- **Claiming:** workers claim jobs with `FOR UPDATE SKIP LOCKED` on rows where `run_at <= now()`, advancing `run_at` by the lease duration and incrementing `attempts` in the same statement. No transaction stays open during adapter runs or backend writes.
- **Crash recovery:** if a worker dies, its job becomes eligible again when the lease expires.
- **Transient errors** (backend unreachable, timeout): the job stays in the queue and `run_at` moves forward with capped exponential backoff, so a backend outage delays writes without filling quarantine. After a configurable maximum age (default 72 hours), the event moves to quarantine with `reason = 'write_error'`.
- **Permanent errors** go to quarantine immediately (§15).
- **Completion:** jobs are deleted when done. Outcomes live in the data tables, `quarantine`, or `replay_log`.

### 10.2 Dynamic Data Tables

These live in the storage backend, not the application database. They are created lazily by the platform. Example after processing user payloads on the Postgres backend:

```sql
CREATE TABLE "acct_0f3a..."."user" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT
);

CREATE TABLE "acct_0f3a..."."user_profile" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT,
  "first_name" TEXT,
  "last_name" TEXT
);

CREATE TABLE "acct_0f3a..."."user_orders" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT,
  "sku" TEXT,
  "amount" NUMERIC
);
```

---

## 11. Storage Backends

### 11.1 Interface

Every data store implements one interface. The pipeline above it knows nothing about the store.

```typescript
type LogicalType = 'string' | 'number' | 'boolean' | 'json';

interface StorageNamespace {
  name: string;         // derived from accounts.id, e.g. acct_0f3a...; never from the slug
}

type SchemaChange =
  | { kind: 'create_table'; table: string }   // includes the id primary key
  | { kind: 'add_column'; table: string; column: string; type: LogicalType };

interface TableRows {
  table: string;
  columns: Record<string, LogicalType>;
  rows: Record<string, unknown>[];            // every row has an id
}

interface StorageBackend {
  readonly capabilities: {
    atomicWrites: boolean;                    // a write() commits fully or not at all
    idempotency: 'immediate' | 'eventual';    // when a repeated row stops being visible as a duplicate
  };

  provision(ns: StorageNamespace): Promise<void>;
  applySchema(ns: StorageNamespace, changes: SchemaChange[]): Promise<void>;
  write(ns: StorageNamespace, tables: TableRows[]): Promise<void>;
  health(): Promise<void>;
}

class StorageError extends Error {
  retryable: boolean;   // true: stays in the queue with backoff; false: quarantined as write_error
}
```

### 11.2 Backend Requirements

- `provision` and `applySchema` must be idempotent.
- `write` receives all rows for one event and must be idempotent on `id`: writing the same row twice leaves one logical row.
- `write` must classify every failure as retryable or permanent through `StorageError`.
- Backends do not validate identifiers or types, since the platform has already done so, but must quote identifiers and bind values as parameters.

**Delivery guarantee.** No transaction spans the application database and a backend, and a store like ClickHouse has no multi-table transaction to offer. The platform therefore provides at-least-once delivery with idempotent writes. Deterministic IDs (§8) make any retry converge on the same rows. On a backend with `atomicWrites: false`, a partially written event can be visible until its retry completes.

### 11.3 Backend Mapping

| Concern | Postgres (MVP) | sqld (later) | ClickHouse (later) |
|---|---|---|---|
| Account isolation | Schema `acct_<id>` | Namespace `acct_<id>` | Database `acct_<id>` |
| `string` | `TEXT` | `TEXT` | `Nullable(String)` |
| `number` | `NUMERIC` | `NUMERIC` | `Nullable(Float64)` |
| `boolean` | `BOOLEAN` | `INTEGER` | `Nullable(Bool)` |
| `json` | `JSONB` | `TEXT` | `Nullable(String)` |
| Idempotent write | `INSERT ... ON CONFLICT (id) DO UPDATE` | `INSERT ... ON CONFLICT (id) DO UPDATE` | `ReplacingMergeTree`, ordered by `id` |
| `atomicWrites` | true | true | false |
| `idempotency` | immediate | immediate | eventual: duplicates remain until merge unless read with `FINAL` |

ClickHouse differences to account for when that backend is built:
- A repeated `id` replaces the whole row, while the SQL backends update only the columns present in the write. Adapters that send partial records under a shared `id` behave differently there.
- `write` is called once per event, and ClickHouse handles many small inserts poorly, so the backend should use `async_insert` or its own buffering.

### 11.4 Backend Selection

Each account points at a named storage target, defined in deployment config. Credentials stay out of the application database.

```yaml
storage_targets:
  pg-main:
    backend: postgres
    dsn_env: STORAGE_PG_MAIN_DSN
  sqld-main:
    backend: sqld
    url: http://sqld:8080
    auth_token_env: STORAGE_SQLD_MAIN_TOKEN
```

Different accounts can use different targets in the same deployment. An account's target is fixed once provisioned.

### 11.5 Conformance Suite

A single test suite, run against every backend, covers idempotent provisioning and schema changes, repeated writes, reserved-word identifiers, all logical types and nulls, adding columns to populated tables, and error classification. Passing it is the definition of a supported backend.

---

## 12. Adapter Runtime

Adapters are stored as code strings in the application database's `adapters` table and executed in a sandboxed environment.

MVP approach:
- Adapters are JavaScript functions stored as text.
- The worker runs them in a restricted VM or function constructor with no access to network, filesystem, or globals other than a provided `payload` argument, and with an execution timeout.
- The function must return an `IntermediateObject`.

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

Security note: In production, adapters should run in a proper sandbox (e.g., isolated-vm, WebAssembly, or a separate process). For MVP, a basic VM wrapper is acceptable with the understanding that adapter code is trusted/audited before activation.

---

## 13. API Surface

### 13.1 Ingestion Service

`POST /ingest`
- Accepts `{ type, data }` JSON.
- Returns `202 Accepted` once the payload is durably stored in the application database.
- Returns `503` if the application database is unavailable, and the client should retry.
- Response body:
  - `status`: `queued`, `malformed`
  - `event_id`: if queued
  - `quarantine_id`: if malformed
- Processing is asynchronous, so the response does not report whether a queued payload was written or quarantined. Quarantined payloads appear in `GET /quarantine`, under the `event_id` as their ID.

`GET /quarantine`
- Lists quarantined payloads, optionally filtered by `type`, `fingerprint`, or `reason`.

`POST /adapters`
- Creates a new adapter (initially `active = false`).
- Body: `type`, `fingerprint`, `code`.

`POST /adapters/:id/activate`
- Sets `active = true` and enqueues a replay of matching quarantined rows.

`POST /adapters/:id/test`
- Runs the adapter against a sample of matching quarantined rows without writing data. Reports the output, plus the schema changes and type conflicts it would cause.

`POST /adapters/:id/replay`
- Enqueues a replay of matching unreleased rows on an active adapter. Used to recover `write_error` rows after a backend problem is fixed.

Replays cover all reasons except `malformed`.

### 13.2 Custom API App

Reads the account's storage target from the application database and connects to that account's namespace with the backend's native driver. Exposes domain-specific routes built on top of the normalized tables. Exact routes are out of scope for this PRD; they will be defined per-account/use case.

`StorageBackend` is write-only by design. Queries are not abstracted, because a useful abstraction over Postgres, SQLite, and ClickHouse would either hide what makes each one worthwhile or grow into a query engine. Custom routes are therefore written for a specific backend.

### 13.3 Account Administration

`POST /accounts`
- Internal only; not routed through Caddy.
- Body: `slug`, `storage_target`.
- Inserts the account as `provisioning`, calls `StorageBackend.provision`, and sets it `active`. Safe to retry if provisioning fails.

---

## 14. Infrastructure

### 14.1 Postgres

Postgres 16 or later, with two separate databases, even when they share a server in development:

- `omni_app`: the application database.
- `omni_data`: the Postgres storage backend, with one schema per account.

Each has its own role, and the `omni_data` role has no access to `omni_app`. This keeps tenant data load and platform state independently movable and stops custom API code from reaching platform state through its data connection.

### 14.2 Caddy Routing

Caddy terminates TLS and routes subdomains to the platform services, passing the account slug as a header. Clients never reach a storage backend directly. Wildcard certificates require a DNS challenge provider.

Example Caddyfile:

```
*.api.example.com {
  @ingestion path /ingest /quarantine* /adapters*

  handle @ingestion {
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

`header_up` overwrites any client-supplied value. For development, skip Caddy and send `X-Account-Slug` directly.

### 14.3 sqld Backend Deployment (Later)

- Run `ghcr.io/tursodatabase/libsql-server:latest` as a container, with namespaces enabled.
- Persist data via volume mount at `/var/lib/sqld`.
- Expose HTTP on port `8080`, on the internal network only.
- Optionally enable JWT auth via `SQLD_AUTH_JWT_KEY_FILE`.
- `provision` creates a namespace through the sqld admin API. Confirm the admin port and request format against current sqld docs when building this backend:

```bash
curl -X POST http://sqld:8080/v1/namespaces/acct_0f3a.../create
```

---

## 15. Failure Modes

| Scenario | Behavior |
|----------|----------|
| Known type + fingerprint | Write via adapter |
| Known type, unknown fingerprint | Quarantine with `unknown_fingerprint` |
| Malformed payload | Quarantine with `malformed` |
| Adapter throws or times out | Quarantine with `adapter_error` |
| Adapter returns invalid intermediate object or identifier | Quarantine with `adapter_error` |
| Value conflicts with registered column type | Quarantine with `schema_conflict` |
| Application database unavailable at ingest | Return `503`; client retries |
| Storage backend unavailable or times out | Job stays queued with backoff; `write_error` after maximum age |
| Backend permanently rejects a write (e.g., NUL byte in Postgres `TEXT`, column limit reached) | Quarantine with `write_error` |
| Worker dies mid-job | Lease expires; job retries; idempotent writes prevent duplicates |
| Row fails during replay | Log in `replay_log` and continue; adapter stays active; operator inspects `replay_log` |
| Storage backend unavailable during replay | Replay job retries with backoff; rows already released are not repeated |

---

## 16. Open Questions

- Should the platform support adapter versioning with rollback?
- Should quarantined rows be deduplicated by content hash?
- What is the target runtime for the Ingestion Service, Worker, and Custom API App (Node.js, Python, Go, Rust)?
- Every event is a write to the Postgres queue, which caps ingest throughput at what the application database can sustain. At what volume would a dedicated broker be worth adding, particularly for ClickHouse accounts?
- How long should released quarantine rows and `replay_log` entries be retained?
- Do any account types need per-record ordering, given that adapter-supplied IDs are last-write-wins across parallel workers?

---

## 17. Rollout

1. **Postgres backend (MVP):** application database, queue and workers, `StorageBackend` interface, Postgres implementation, conformance suite.
2. **sqld backend:** the first test of the interface against a second store. Treat the interface as unstable until this ships.
3. **ClickHouse backend:** the first backend with `atomicWrites: false` and eventual idempotency. Further backends follow the same path.

---

## 18. Success Criteria

- Can ingest arbitrary `{ type, data }` payloads into per-account namespaces on the Postgres backend.
- Can quarantine unrecognized shapes without data loss.
- Can author, test, and activate adapters that normalize shapes into relational tables.
- Can replay quarantined rows after adapter activation, with repeated or interrupted replays producing no duplicate rows.
- A storage backend outage delays writes but loses no accepted payloads.
- Custom API App can query the same normalized tables independently.
- A new storage backend can be added by implementing `StorageBackend` and passing the conformance suite, with no changes to the pipeline or adapters.
