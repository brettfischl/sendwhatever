# PRD: Adaptive JSON Ingestion Platform

## 1. Overview

Build a platform that accepts arbitrary JSON payloads sent to per-account endpoints, classifies their structure, and writes them into per-account storage. When an unrecognized payload structure arrives, the system quarantines it, and a continuously running LLM process writes a new data adapter for it. Once the adapter passes validation, it is activated (or waits for an operator, if the account's `auto_activate` setting is off) and all matching quarantined payloads are replayed through it, so the delay for a new shape is essentially the time it takes to generate the adapter. A human operator can step in at any point.

The platform has one way in and two ways to use the result:
1. **Direct adapter-driven ingestion** — any JSON payload is classified and written automatically.
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

- Accept any JSON object or array, with no required envelope, and let the LLM use the body, path, method, and headers to work out what it is.
- Write recognized payload shapes into normalized relational tables per account.
- Quarantine unrecognized or malformed JSON payloads instead of failing the request. Only a body that isn't valid JSON is rejected.
- Generate adapters continuously with an LLM against quarantined samples, with human override.
- Replay quarantined payloads through new adapters transactionally.
- Provide a clean intermediate object contract so adapters reason about shape, not SQL or any specific data store.
- Keep all platform state in Postgres, independent of where account data lives.
- Keep a durable log of every ingress event, so an account's data can be replayed to a different storage backend.
- Support any data store as a storage backend through one interface, chosen per account, without changes to adapters or the ingestion pipeline.

## 3. Non-Goals (MVP)

- Roles beyond super admin and account member, and login methods beyond email and password (§19). Ingestion itself uses only per-account API keys and webhook signatures (§13.4).
- Billing, usage metering, or rate limiting.
- Throughput targets. This is a low-volume, one-day hackathon build (§17).
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
                    │        (send any JSON body)         │
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
  │ database: │     │ namespace:│     │ database:  │
  │ acct_<id> │     │ acct_<id> │     │ acct_<id>  │
  │ ├─ user   │     │ ...       │     │ ...        │
  │ ├─ user_  │     │           │     │            │
  │ │  profile│     │           │     │            │
  │ └─ user_  │     │           │     │            │
  │    orders │     │           │     │            │
  └───────────┘     └───────────┘     └────────────┘
```

System tables live outside the account's storage namespace, so an adapter that writes a table called `adapters` cannot collide with platform state. The `acct_<id>` labels above are shorthand: each store's full namespace is `acct_<account id>_<generation>` (§10). Not drawn: customers also connect directly to their namespace with read-only SQL credentials (§14.1).

---

## 5. Data Flow

### 5.1 Happy Path

1. Client POSTs any JSON object or array, such as `{ "email": "ada@example.com" }`, to `https://account-123.api.example.com/ingest`.
2. Caddy routes the request to the Ingestion Service with the account slug.
3. Ingestion Service resolves the account in the application database, checks the API key (§13.4), derives `source` and `op` from the path and method (§6), and computes a structural fingerprint of the body (sorted keys, nesting shape, array/object kinds) ignoring values.
4. In one transaction, it appends the raw body and request context to `events` and inserts an `ingest` job into `queue`. It then returns `202 Accepted` with the `event_id`. An `Idempotency-Key` repeated for the same `(source, op)` creates nothing and returns the original `event_id` (§13.1).
5. A worker claims the job.
6. It queries the application database for an active adapter matching `(account_id, source, op, fingerprint)`, taking opaque paths into account (§7.1).
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
4. The Adapter Generator (§12.1), which runs continuously, picks up the new shape and samples quarantined rows for that `(source, op, fingerprint)`.
5. The LLM writes an adapter that normalizes the shape into the intermediate object format.
6. Adapter is inserted with `active = false` and validated against the sample. If it passes, `validated_at` is set.
7. If validation passes and the account has `auto_activate` on, adapter is set `active = true` (in the same transaction, deactivating any earlier version for the same `(source, op, fingerprint)` and setting `superseded_at` on every other version of that shape) and a `replay` job is enqueued. With it off, the adapter waits for an operator.
8. The worker pages through matching unreleased rows in batches, reading each payload from `events`. Each event is written through the storage backend, to the store its quarantine row names or to all live stores if it names none. It is then marked released and logged in `replay_log` in one application database transaction.

An event that fails during replay stays open, and its `reason` and `detail` are updated to the new failure, such as `adapter_error`.

A worker can look up an adapter just before activation and quarantine just after the replay finishes, stranding the row. A periodic sweep enqueues a replay for any active adapter that has matching `unknown_fingerprint` rows. Because a failed replay changes the row's reason, the sweep doesn't retry it forever.

### 5.3 Malformed Payload Path

1. Payload is valid JSON but not an object or array, such as a bare string or number.
2. In one transaction, Ingestion Service appends it to `events` with no fingerprint and inserts a `quarantine` row with `reason = 'malformed'`. There is nothing for a worker to do, so no queue job is created.
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
5. Operator activates the store. One application database transaction marks the old store `retired`, then marks the new store `active`, in that order because `account_stores_one_active` allows only one at any moment, and closes quarantine rows that name the old store. A retired store receives no further writes and is kept until an operator removes it.

No event can be missed. An event that isn't yet visible to the scan in step 3 commits after the store exists, so the worker that handles it sees the new store and writes to it. Any other event is already in the log for the scan to find. `_event_seq` stops the rebuild from overwriting newer live writes with older events (§11.2).

A rebuild uses current adapters, so it also serves to reprocess an account's history on the same backend after adapters change.

---

## 6. Ingest Requests

There is no required envelope or type. Any JSON object or array can be sent to `/ingest`, and the body is treated as-is. A body with `type` and `data` keys is just another shape.

```json
{
  "email": "ada@example.com",
  "profile": { "first_name": "Ada", "last_name": "Lovelace" },
  "orders": [
    { "sku": "A1", "amount": 100 },
    { "sku": "A2", "amount": 200 }
  ]
}
```

Everything else about the request is optional, and all of it is shown to the LLM as context:

- **Path.** Anything after `/ingest`, such as `/ingest/users` or `/ingest/customers/123`. The first segment is the event's `source`, and an event with no path has an empty `source`. Any string of up to 255 bytes works, since a table name comes from the adapter rather than the path. A segment that is longer, or that percent-decodes to invalid UTF-8 or a NUL byte, gets `400` and nothing is stored. `events.request` keeps the path as received, without decoding it, so it can't introduce a NUL that `JSONB` would reject.
- **Method.** `POST`, `PUT`, and `PATCH` are writes. `DELETE` is a delete (below). Other methods get `405`.
- **Headers.** Available to the LLM and to adapters, for signals like `X-GitHub-Event`, but never used for matching.

**Matching.** An adapter matches on `(source, op, fingerprint)`, where `op` is `write` or `delete`. `source` is part of the key so that a path can keep lookalike payloads apart. Only the first path segment counts, so `/ingest/customers/123` and `/ingest/customers/124` share an adapter. `op` is part of it so an adapter written for writes never silently handles a delete of the same shape.

**Deletes.** A `DELETE` request is how a client says a record is gone. The body is optional, and the record can be identified by the body or the path. The LLM writes a delete adapter that marks the record with `_deleted: true`, in the table and under the `id` the account's write adapters use, and the platform soft-deletes it (§8). Sources that can only `POST`, like most webhooks, can still produce deletes: the LLM reads the body or headers and uses `_deleted` the same way.

### 6.1 Do We Need a Type?

We start with no type and find out. Without one, a user `{ id, name }` and a product `{ id, name }` share a fingerprint, so one adapter would handle both and write them to the same table. The end-to-end demo checks this directly by sending lookalike payloads, and also looks at first-attempt validation pass rate and whether similar shapes get consistent table names. If lookalikes turn out to be a real problem, clients already have the fix: sending them to different paths, like `/ingest/users` and `/ingest/products`, gives each its own adapter.

### 6.2 Webhook Sources

Third-party tools (Stripe, Shopify, GitHub, …) send their own formats and usually let you set only a URL, with no custom headers. They use the same route as everything else, with these additions.

**Core:**
- **Key in the URL.** Since most providers can't send `Authorization`, the API key may be passed as `?key=` instead (§13.4). It is removed before the request is logged, and Caddy's access logs must not record query strings.
- **Request context.** `events.request` stores `{ method, path, query, headers }`: the path as received, the raw query string without the leading `?`, and headers as single strings with lowercase names, joining repeated headers with `, `. Obvious auth is stripped first: the `Authorization`, `Proxy-Authorization`, `Cookie`, and `X-Api-Key` headers, and the `key` query parameter. Adapters receive it as `payload.request`, and the LLM sees it in samples.
- **Duplicate deliveries.** Providers retry, so delivery is at least once. A known delivery header (`X-GitHub-Delivery`, `X-Shopify-Webhook-Id`, …) is used as the `Idempotency-Key` when none is sent. Keys apply per `(source, op)`, so two providers on different paths can't collide, and are limited to 255 bytes; a longer key gets `400`.

**If time allows:**
- **Setup handshakes.** Built-in responders answer provider verification synchronously and log nothing: Slack `url_verification`, Microsoft Graph `validationToken`, and Meta `hub.challenge` (a `GET`).
- **Signatures.** An optional secret per `(account, source)` checks provider signatures (Stripe, Shopify, GitHub HMAC) against the raw bytes, replacing the URL key for that source. Failures get `401`.
- **Batches.** A top-level array body is logged as one event per element, so batches that mix event kinds (e.g., SendGrid) don't produce a new fingerprint for every combination (§7).
- **Form bodies.** `application/x-www-form-urlencoded` bodies (Twilio, Slack commands) are parsed into a JSON object. The raw bytes are still what's logged.

**Out of scope:** thin events, which carry only an ID and expect the receiver to fetch the resource.

---

## 7. Structural Fingerprint

The fingerprint is a stable hash of the shape of the request body. A `DELETE` with no body has the shape `null`.

Algorithm (v1):
1. Recursively traverse the body.
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
- **Matching an event:** try an exact match on its full fingerprint first, including fingerprints an active adapter has been validated against (`adapter_fingerprints`, §12.1). Then, for each distinct set of opaque paths among the active adapters for that `(account_id, source, op)`, recompute the event's fingerprint with those paths collapsed and look for a match. If several match, the adapter with the fewest opaque paths wins, then the newest. Replays and rebuilds use the same matching.

An exact match takes priority, so a specific adapter can still be added for a shape that an opaque adapter would otherwise catch.

---

## 8. Intermediate Object Contract

Adapters transform the raw payload into an intermediate object. The platform turns that object into storage backend writes. The block below is a summary, and `src/contracts` holds the exact types.

```typescript
// An adapter returns IntermediateObject | IntermediateObject[]
interface IntermediateObject {
  table: string;        // chosen by the adapter; child tables may omit it (see children)
  rows: IntermediateRow[];
  append?: boolean;     // child tables: each event adds rows, instead of updating by position
  column_types?: Record<string, 'timestamp'>;  // types that can't be inferred from a JSON value
}

interface IntermediateRow {
  id?: string;          // if omitted, platform injects a deterministic UUID
  _deleted?: true;      // mark this record deleted; included fields are still written
  [column: string]: any;
  children?: Record<string, IntermediateObject>;
}
```

Rules:
- `table` is required at the top level, since there is no type to default to.
- `rows` is required. Each row represents one record in the table. One ingress event can produce any number of rows: `{ "messages": [{ "msg": "hi" }, { "msg": "hello!" }] }` can become two `messages` rows.
- `id` is optional on each row, including child rows. If missing, the platform injects a UUIDv5, so reprocessing the same event produces the same IDs:
  - A child of a parent with a stable `id` derives from `(parent id, table, position)`, so a repeat of the parent updates its children instead of adding more. A parent's `id` is stable if the adapter supplied it, or if it was itself derived this way, so grandchildren stay stable too.
  - A shorter list never removes anything. If a later event has fewer children, the extra rows stay current, because the event may be a partial update. Removing a child takes an explicit delete: a `DELETE` request for it, or a `_deleted: true` child row (below).
  - Every other row, and any child table with `append: true`, derives from `(event_id, table, row path)`.
- An adapter-supplied `id` is treated as the record's identity, and writes to it merge: columns in the write are updated, and columns absent from it keep their values. An explicit `null` clears a column, and so does a column set to `undefined`, which the write planner converts to `null`; only a missing key keeps the stored value. On `id`, `_deleted`, and `children`, `undefined` means the key is omitted. When events conflict on a column, the one latest in the log wins (§11.2).
- An adapter-supplied `id` must be a string, and `_deleted` may only be `true`. Anything else fails with `adapter_error`, because the platform never coerces, so adapters must cast numeric IDs and must not pass a payload's own flag straight through.
- `_deleted: true` marks the record deleted by setting `_deleted_at` to the deleting event's `received_at`, so replays match, and any fields included on the row are written too, so nothing in the event is lost. A write later in the log for the same `id` restores it; a delayed earlier event does not (§11.2). Rows are never physically removed. This works on child rows too, so an adapter can turn `{ "id": "order_1", "items": [{ "id": "1", "deleted": true }] }` into a `_deleted: true` row for item 1. Deletes are always explicit, and the platform never infers one from a missing row.
- Returning an array writes several top-level tables from one event, such as an order and the customer embedded in it. An entity with its own identity belongs in its own table, referenced by a column like `customer_id`, rather than repeated as a child of each parent.
- Column values are strings, finite numbers, booleans, or `null`, plus objects or arrays at declared opaque paths (§9). `NaN` and `Infinity` fail with `adapter_error`, because JSON would turn them into `null` and clear the column. A `timestamp` column is declared in `column_types`, and its values must be ISO 8601 strings with a timezone.
- `children` is reserved, as are injected foreign key names. An adapter must rename payload fields that collide with them, and a collision fails with `adapter_error`.
- `children` is optional. Each key becomes a child table named `{parent_table}_{key}` (or uses the adapter hint if provided).
- The platform injects `{parent_table}_id` as a foreign key column on every child row.

Example input:

```json
{
  "email": "ada@example.com",
  "profile": { "first_name": "Ada", "last_name": "Lovelace" },
  "orders": [
    { "sku": "A1", "amount": 100 },
    { "sku": "A2", "amount": 200 }
  ]
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

- Tables are created on first write if they do not exist. Every table has an `id` primary key and platform-managed columns: `_event_seq` (the highest `events.seq` that has written the row) and `_deleted_at` (set when the record is marked deleted, §8). Per-column ordering (§11.2) adds `_column_seq`, which isn't in the MVP.
- Columns are added on first non-null value if they do not exist. A value that is always `null` creates no column.
- Column types are inferred from the first non-null value seen, unless the adapter declares them:
  - `number` → `number`
  - `string` → `string`
  - `boolean` → `boolean`
  - string declared in `column_types` → `timestamp`
  - any non-null value at a declared opaque path (§7.1) → `json`, even a scalar, since the contents of that path can vary. A column's location in the output matches a declared path by its ending, so `metadata` matches `data.object.metadata`, and a renamed field fails with `adapter_error`.
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
- Postgres system column names (`xmin`, `xmax`, `cmin`, `cmax`, `ctid`, `tableoid`) are reserved, and fail with `adapter_error`.

**Concurrent changes.** Workers run in parallel, so schema changes for a store are serialized with a Postgres advisory lock on the application database. The lock is taken only when the registry shows a change is needed. The backend change is applied first and the registry updated second, so a crash between them is repaired by reapplying the idempotent change.

This allows adapters to introduce new shapes without upfront schema design.

---

## 10. Application Database Schema

Postgres, managed with versioned migrations.

```sql
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
  scope TEXT NOT NULL DEFAULT 'ingest'  -- 'ingest' or 'read' (§13.4)
    CHECK (scope IN ('ingest', 'read')),
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
  FOREIGN KEY (account_id, released_by_adapter_id) REFERENCES adapters(account_id, id),
  UNIQUE (account_id, id)                         -- target for same-account foreign keys
);

CREATE INDEX quarantine_unreleased
  ON quarantine (account_id, event_id) WHERE released_at IS NULL;

-- At most one open quarantine entry per event and store
CREATE UNIQUE INDEX quarantine_one_open
  ON quarantine (event_id, store_id) NULLS NOT DISTINCT WHERE released_at IS NULL;

CREATE TABLE replay_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id),
  quarantine_id UUID NOT NULL,
  adapter_id UUID NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, quarantine_id) REFERENCES quarantine(account_id, id),
  FOREIGN KEY (account_id, adapter_id) REFERENCES adapters(account_id, id)
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
- **Replay requested during a replay:** a running replay may already have paged past rows that a new fingerprint now matches. A replay enqueue therefore uses `ON CONFLICT (adapter_id) WHERE kind = 'replay' DO UPDATE SET rerun_requested = true`. When the replay finishes, the worker deletes the job only if `rerun_requested` is false. Otherwise it clears the flag and sets `run_at = now()` in one statement, so the replay runs again from the start and no request is lost.

### 10.2 Dynamic Data Tables

These live in the storage backend, not the application database. They are created lazily by the platform. Example after processing user payloads on the Postgres backend, in the `public` schema of the store's own database, such as `acct_0f3a..._1`:

```sql
CREATE TABLE "user" (
  "id" TEXT PRIMARY KEY,
  "_event_seq" BIGINT NOT NULL,
  "_deleted_at" TIMESTAMPTZ,
  "email" TEXT
);

CREATE TABLE "user_profile" (
  "id" TEXT PRIMARY KEY,
  "_event_seq" BIGINT NOT NULL,
  "_deleted_at" TIMESTAMPTZ,
  "user_id" TEXT,
  "first_name" TEXT,
  "last_name" TEXT
);

CREATE TABLE "user_orders" (
  "id" TEXT PRIMARY KEY,
  "_event_seq" BIGINT NOT NULL,
  "_deleted_at" TIMESTAMPTZ,
  "user_id" TEXT,
  "sku" TEXT,
  "amount" NUMERIC
);

CREATE INDEX ON "user_profile" ("user_id");
CREATE INDEX ON "user_orders" ("user_id");
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
  | { kind: 'create_table'; table: string }   // includes id and the platform columns (§9)
  | { kind: 'add_column'; table: string; column: string; type: LogicalType }
  | { kind: 'add_index'; table: string; column: string };

interface TableRow {
  id: string;
  _event_seq: string;                         // events.seq as decimal text; compare it in SQL
  _deleted_at?: string;                       // the deleting event's received_at (§11.2)
  [column: string]: unknown;                  // an absent key keeps the stored value; null clears it
}

interface TableRows {
  table: string;
  columns: Record<string, LogicalType>;       // every data column in rows, or write() throws; not platform columns
  rows: TableRow[];
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

- `provision` and `applySchema` must be idempotent. A repeat `provision` may rotate the read-only password, since Postgres can't return an existing one, so callers only call it before a store goes active and serialize those calls. `applySchema` may commit each change separately, so a retry finishes what's left.
- A row's data keys must all be listed in `columns`. An undeclared key makes `write` throw a permanent `StorageError`, whatever its value, so a clear can't be silently lost.
- `write` receives all rows for one event and must be idempotent on `id`: writing the same row twice leaves one logical row.
- `write` merges into existing rows, so a store's final state doesn't depend on the order workers ran in or on when a quarantined event is released:
  - Each included column is updated only if the write's `_event_seq` is at least that column's entry in `_column_seq`; other columns are left alone. Out-of-order partial updates therefore all land, and a late event never overrides a newer value.
  - The row keeps the higher `_event_seq`. Deletes (§8) compare it, and raise it to the deleting event's `seq`.
  - `_deleted_at` follows its own rule, and only a write at or above the row's `_event_seq` can change it. Such a write sets it if the row includes it, and clears it if not, which is the one exception to an absent key keeping its value. A lower write never touches it, so a delayed delete can't mark a newer row deleted, and a delayed write can't restore a newer delete.
  - *MVP option:* skip `_column_seq`, compare only the row's `_event_seq`, and let a lower write fill just the `NULL` columns other than `_deleted_at`. A rebuild, which runs in order, corrects anything missed. One known gap: if a newer event clears a column that doesn't exist yet, the clear is dropped (§9), and a delayed older event can then set that column and keep its value until a rebuild.
- `provision` must also create read-only credentials limited to that store's namespace, and they must keep working for tables and columns added later. On Postgres it returns `{ user, password, database }`, and customers connect to that `database`, not to `connection.database`.
- `applySchema` and `write` run for each event, and must classify every failure as retryable or permanent through `StorageError`. A worker treats any other error as retryable.
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
| Store isolation | Database | Namespace | Database |
| `string` | `TEXT` | `TEXT` | `Nullable(String)` |
| `number` | `NUMERIC` | `NUMERIC` | `Nullable(Float64)` |
| `boolean` | `BOOLEAN` | `INTEGER` | `Nullable(Bool)` |
| `timestamp` | `TIMESTAMPTZ` | `TEXT` | `Nullable(DateTime64)` |
| `json` | `JSONB` | `TEXT` | `Nullable(String)` |
| `_event_seq` | `BIGINT` | `INTEGER` | `Int64` |
| `_column_seq` | `JSONB` | `TEXT` | `Map(String, Int64)` |
| `_deleted_at` | `TIMESTAMPTZ` | `TEXT` | `Nullable(DateTime64)` |
| Merging write | `INSERT ... ON CONFLICT (id) DO UPDATE`, with each included column set by comparing its `_column_seq` entry | Same as Postgres | Needs design: `ReplacingMergeTree` replaces whole rows, so merging likely means `AggregatingMergeTree` with per-column latest values |
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
    "connection": { "host": "pg-data", "port": 5432, "database": "postgres" },
    "credentials": { "user": "sw_data", "password": "..." }
  }
}
```

- `connection.database` is where the platform connects to run `provision`. On Postgres, each store then gets its own database, named after its `namespace`.
- Settings are stored in `account_stores`, and the row with `status = 'active'` is the current one. A separate table is needed because a rebuild has two stores live at once, each with its own column registry.
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
- Adapters have a 5-second limit by default, so a busy machine isn't mistaken for a bad adapter.
- `Date.now()`, `new Date()` without arguments, and `Math.random()` are removed from the sandbox. Replays depend on an adapter producing the same output for the same event.
- Integers too large for a JavaScript number are passed to adapters as strings, so long numeric IDs aren't rounded.
- `payload` is `{ data, request }`, where `data` is the parsed body and `request` is the logged `{ method, path, query, headers }` (§6.2).
- The function must return an `IntermediateObject` or an array of them. A column set to `undefined` must survive the sandbox boundary, because it clears the column (§8), and serializing with `JSON.stringify` would silently drop it.
- Adapters should normalize values to consistent types, such as casting `5` to `"5"` for a text column. The platform never coerces values (§9), so this is where mixed types get resolved.

Example adapter code:

```javascript
function adapt(payload) {
  const data = payload.data;
  return {
    table: 'user',
    rows: Array.isArray(data) ? data.map(normalize) : [normalize(data)]
  };

  function normalize(item) {
    return {
      id: item.id,
      // Leave out a missing field: setting it to undefined would clear the stored value (§8).
      ...('email' in item ? { email: item.email } : {}),
      children: item.profile ? {
        profile: {
          rows: [{
            ...field(item.profile, 'first_name', 'firstName', 'first_name'),
            ...field(item.profile, 'last_name', 'lastName', 'last_name')
          }]
        }
      } : undefined
    };
  }

  // Returns the column only if the payload has one of these keys.
  function field(source, column, ...keys) {
    const key = keys.find((name) => name in source);
    return key ? { [column]: source[key] } : {};
  }
}
```

Security note: Adapter code is written by an LLM from client-supplied payloads and can be activated without human review (§12.1), so it must be treated as untrusted from the MVP onward. A payload can contain text aimed at steering the LLM, which makes a basic VM wrapper insufficient. Sample payloads are passed to the LLM as data, never as instructions.

### 12.1 Adapter Generator

A continuously running process that turns quarantined shapes into active adapters. It calls its LLM through Fireworks, using `accounts/fireworks/models/deepseek-v4p1-flash` by default, set by the `FIREWORKS_MODEL` config value. This is a reasoning model, and reasoning counts against `max_tokens`. Requests run with reasoning off (`reasoning_effort: "none"`, also a config value) and `max_tokens` of 16000, since adapters for large payloads like Shopify orders can exceed 8000: in testing this took about 2 seconds and $0.002 per adapter, while reasoning on took around 100 seconds and often ran out of tokens with no code. An empty reply with `finish_reason: length` is a failed attempt.

1. It polls for `(account_id, source, op, fingerprint)` shapes with open quarantine rows, no generation in progress, and no validated adapter awaiting an operator, and records a `running` row in `adapter_attempts`. A validated adapter is awaiting an operator when `validated_at` is set, `active` is false, and `superseded_at` is null. An attempt left `running` past a timeout blocks the shape until it is updated, so the poll marks it `failed` in the same transaction that records the new attempt. The timeout must be longer than a generation's retries and backoff, so a live attempt isn't failed.
2. It first tries to avoid an LLM call:
   - If an active adapter now covers the shape through opaque paths (§7.1), it enqueues a replay.
   - Otherwise it runs the active adapters for that `(source, op)` against a sample of the shape, through the validation gate below. If one passes, a quick LLM check confirms the sample is the same kind of record that adapter handles, since lookalikes can pass the gate. If it is, the fingerprint is added to `adapter_fingerprints` and a replay is enqueued. With `auto_activate` off, a shape isn't bound this way, and waits for an operator instead. A later version of that adapter doesn't inherit these entries; those shapes pass through this step again.
3. If neither applies, it samples rows and asks the LLM for an adapter. It includes the account's full schema (`data_columns`), so that new adapters reuse existing tables and types. It also includes each sample's path, method, and headers as optional signals, and the other open fingerprints for that `(source, op)`, so the LLM can spot fields whose keys vary.
4. It validates the adapter against the sample, using the same checks as `POST /adapters/:id/test`.
5. If validation passes and the account has `auto_activate` on (the default), the adapter is activated and its replay enqueued (§5.2). With it off, the adapter waits for an operator to call `POST /adapters/:id/activate`. If validation fails, the LLM retries with the errors, with backoff between attempts.

A configurable cap limits generations per shape, and the shape then waits for an operator. The cap counts adapters that passed validation and then failed during replay, so a shape can't loop through generations indefinitely. A separate limit (default 5) stops a shape after that many consecutive failed attempts, which bounds LLM cost for shapes that never pass. LLM outages back off without counting toward it, so a brief outage can't park every open shape. Generation runs one at a time per `(account, source, op)`, so the first adapter can absorb variations arriving together.

**Which rows it reads:** `unknown_fingerprint`, `adapter_error`, and `schema_conflict`, where a new adapter can fix the problem. `malformed` and `write_error` rows are left to operators.

**Non-destructive prompting.** The generator's prompt instructs the LLM to evolve schemas only by adding:
- Reuse existing tables, columns, and types where they fit.
- Add new columns or tables for anything new, and never repurpose or stop writing an existing column.
- Never discard a field. Every field gets a clearly named column or child table, with no catch-all columns. When deriving a value, such as a full name, also keep the original fields.
- Normalize nested data: objects and arrays of objects become child tables, and arrays of primitives become child tables with a `value` column.
- Declare an opaque path only for a field whose keys truly vary. Store it as a child table with `key` and `value` columns when its values are uniform, or as a named `json` column when it is truly free-form. JSON is never a place to put data that could be modeled.
- Use a stable `id` from the payload when events describe the same real-world record, so they merge into one row, and cast it to a string. Omit it when each event is a new record. Cast every ID-like field to a string too, such as `product_id`. The sandbox turns integers above 2^53 into strings to keep them exact, so a field left as a number would change type once its values grow.
- Pass `null` through only when the source means to clear a value. Leave out any field the event doesn't include: `email: item.email` on a partial update would set `undefined` and clear the stored email.
- Give child rows a natural `id` where one exists, such as a SKU. Set `append: true` for lists where each event adds new items, such as messages.
- Declare date and time fields as `timestamp`, and normalize them to ISO 8601 with a timezone.
- Give an entity with its own identity one table, wherever it appears, keyed by the same `id`. A speaker sent directly and a speaker embedded in a session both go to `speakers`. Link many-to-many relationships through a join table, such as `session_speakers`, using array output, so one entity is never split across parent-specific child tables.
- Choose table names from the content of the payload. Use the path and headers as hints when they are present, and don't rely on them being there.
- Use `payload.request` to tell event kinds apart. For `DELETE` requests, and events whose body or headers say a record was deleted, set `_deleted: true` on the same table and `id` the write adapter uses. Keep any fields the event includes. Look for per-item signals too, like `items: [{ "id": 1, "deleted": true }]`, and mark that child row the same way. Never treat a missing item as a delete.

Prompts are guidance, so the rules that matter are also enforced in code, by the gate below and the schema layer (§9).

**Validation gate.** An adapter is activated only if, across the sample, it:
- Runs without errors or timeouts, and returns a valid intermediate object with valid identifiers.
- Produces identical output when run twice on the same payload.
- Produces parseable values for every declared `timestamp` column.
- Writes no number to an ID-like column: `id` or a name ending in `_id`. It must be cast to a string, because the column's type can never change later.
- Writes no ISO 8601 date-time to a new string column. It must be declared as `timestamp`, for the same reason. A column already registered as `string` is exempt, since it can't change.
- Causes no type conflicts with registered columns.
- Declares opaque paths only on specific named fields, never the payload root or an array of the root, so an adapter can't match everything.
- For `op = delete`, sets `_deleted: true` on every top-level row, with an `id`.
- Carries every field value in the payload through to the output, allowing for casts like `5` to `"5"` and for a delete flag becoming `_deleted`, so an adapter can't pass while silently losing data.
- If it replaces an earlier version for the same shape, still writes every column that version wrote, so a column can't quietly stop being populated.

**Mistakes are recoverable.** A bad adapter that passes the gate writes wrong rows, not lost data. The original payloads remain in the event log, so a corrected adapter and a rebuild (§5.4) can repair the account once rebuilds exist.

**Limits.** Generation concurrency is capped per account, so one account sending many new shapes can't starve others or run up unbounded LLM cost.

---

## 13. API Surface

### 13.1 Ingestion Service

`POST`, `PUT`, `PATCH`, or `DELETE` to `/ingest`, optionally followed by any path
- Requires an API key (§13.4).
- Accepts any JSON object or array (§6). The body is optional on `DELETE`. The path and all headers are optional. An `Idempotency-Key` header is also optional. A key repeated for the same `(source, op)` creates nothing and returns `202` with the original `event_id`, so clients can retry safely.
- Returns `202 Accepted` once the payload is committed to the event log, and queued if well formed.
- Returns `400` if the body isn't valid JSON, the first path segment or `Idempotency-Key` is over 255 bytes, or the first path segment percent-decodes to invalid UTF-8 or a NUL byte. Nothing is stored.
- Returns `401` if the API key is missing, invalid, or belongs to another account, `403` if the account is disabled, and `404` if the subdomain matches no account.
- Returns `413` if the body is over 5 MB, the most the adapter sandbox can reliably process, and nothing is stored.
- Returns `503` if the application database is unavailable, and the client should retry.
- Response body:
  - `status`: `queued`, `malformed`
  - `event_id`: always
- Processing is asynchronous, so the response does not report whether a queued payload was written or quarantined. Quarantined payloads appear in `GET /quarantine` with their `event_id`.

All routes below are internal only and not routed through Caddy. They require `Authorization: Bearer <INTERNAL_API_TOKEN>`, refuse everything if it isn't set, and return `404` to anything that arrived through a proxy, so don't send `X-Account-Slug` to them.

`GET /quarantine`
- Requires `account_id`. Lists quarantined events without their bodies, up to 200 per page, optionally filtered by `source`, `op`, `fingerprint`, or `reason`. Reading a payload is a separate, deliberate action.

`POST /adapters`
- Creates a new adapter (initially `active = false`). The generator normally does this; the route is the operator override, along with `activate`.
- Body: `account_id`, `op`, `fingerprint`, `code`, and optional `source` and `opaque_paths`.

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

These routes are internal only and not routed through Caddy, with the same token rule as §13.1.

`POST /accounts`
- Body: `slug`, `storage` (§11.4). `slug` must be one lowercase DNS label; anything else gets `400`.
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

Public routes use per-account API keys, sent as `Authorization: Bearer <key>`. Webhook sources that can't set headers may send the key as `?key=` on any `/ingest` route, or authenticate with a provider signature instead (§6.2). A key must belong to the account named by the subdomain. Only a hash of each key is stored. User logins and roles apply only to the admin interface (§19).

A key has one scope. An `ingest` key works only on `/ingest`, and a `read` key works only on `/tables`, only as `Authorization: Bearer <key>`. Ingest keys can be held by webhook providers, so they must never be able to read data.

`GET /tables/:table` lists live rows ordered by `id`, with `limit` (default 100, at most 1000) and `after` for paging and `?column=value` equality filters, and `GET /tables/:table/:id` returns one. Both use the store's read-only login, leave out soft-deleted rows and platform columns, and only reach tables in the registry. Each table's OpenAPI document is generated from the registry and shown with Swagger UI in the admin, from the Schema page.

---

## 14. Infrastructure

### 14.1 Postgres

Postgres 18, with the platform's databases kept separate, even when they share a server in development:

- `sw_app`: the application database.
- `acct_<account id>_<generation>`: one database per store, holding that store's tables in its `public` schema.

Each has its own access: the `sw_data` role has no access to `sw_app`, connects from the built-in `postgres` database, and has `CREATEDB` and `CREATEROLE` so `provision` can create store databases and logins. This keeps tenant data load and platform state independently movable and stops anyone reaching platform state through a data connection.

**Direct customer access.** Customers connect straight to their store's own database over TLS with standard Postgres clients. `provision` creates a login for each store that can connect only to that database, and read its tables, including tables added later through default privileges. The login has a default statement timeout and a limit of 10 connections so heavy use is less likely to starve ingestion. `sw_app` is not reachable from outside.

MVP limits: a customer can turn the statement timeout off for their own session. They can't connect to another store or see its tables, but can list other database and role names, which contain account IDs, because those catalogs are server-wide. Each store also has its own connection pool, so around 100 stores active at once would reach Postgres's default `max_connections`; beyond that, it needs a higher limit or PgBouncer.

Customers query the raw tables, including the platform columns `_event_seq` and `_deleted_at`. Soft-deleted rows are visible, so queries for current records filter on `_deleted_at IS NULL`.

### 14.2 Caddy Routing

Caddy terminates TLS and routes subdomains to the platform services, passing the account slug as a header. Only `/ingest`, `/tables`, and Custom API routes are public. Wildcard certificates require a DNS challenge provider. The hackathon deployment uses fixed hostnames instead (§21.2).

Example Caddyfile:

```
*.api.example.com {
  handle /ingest* {
    reverse_proxy ingestion:3000 {
      header_up X-Account-Slug {http.request.host.labels.3}
    }
  }

  handle /tables* {
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

`header_up` overwrites any client-supplied value. Internal routes are unreachable from outside because only `/ingest` and `/tables` routes are forwarded to the Ingestion Service. For development, skip Caddy and send `X-Account-Slug` directly.

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
| Known source, op, and fingerprint | Write via adapter |
| Unknown shape | Quarantine with `unknown_fingerprint` |
| Body isn't valid JSON | Reject with `400`; nothing stored |
| Path segment or `Idempotency-Key` over 255 bytes, or a path segment that decodes to invalid UTF-8 or a NUL byte | Reject with `400`; nothing stored |
| Valid JSON that isn't an object or array | Quarantine with `malformed` |
| Unsupported HTTP method | Reject with `405`; nothing stored |
| `DELETE` for a record that was never written | Row is created and marked deleted; a later write restores it |
| Missing or invalid API key | Reject with `401`; nothing stored |
| Client retries with the same `Idempotency-Key`, `source`, and `op` | Return the original `event_id`; nothing new is stored |
| Adapter throws or times out | Quarantine with `adapter_error` |
| Adapter returns invalid intermediate object or identifier | Quarantine with `adapter_error` |
| Value conflicts with registered column type | Quarantine with `schema_conflict` |
| Generated adapter fails validation | Not activated; LLM retries with the errors, up to the generation cap, then the shape waits for an operator |
| Quarantined event released after newer writes to the same row | Updates only columns no newer event has written; newer values are kept |
| Parent resent with fewer children | Missing children stay current; removing one takes an explicit delete |
| Parent resent with a child marked deleted | That child row is soft-deleted |
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

- Providers don't guarantee delivery order, and `_event_seq` is arrival order, so a late `customer.updated` can overwrite a newer one. Should adapters be able to supply a source version (e.g., Stripe `created`, Shopify `updated_at`) that takes precedence?

Released quarantine rows, `replay_log` entries, and retired stores are kept indefinitely for now.

---

## 17. Build Plan

This is a one-day hackathon build at low volume: it needs to work end to end. Work proceeds in this order.

**1. Core (must work on the day).** A payload of an unknown shape arrives, an adapter is generated, and the customer queries clean tables over SQL.
- `/ingest` with any JSON body and no required type, optional paths, HTTP verbs including `DELETE`, API keys (header or `?key=`), and `Idempotency-Key`, including webhook delivery IDs (§6, §6.2).
- Event log, Postgres queue, and worker.
- Fingerprinting, Adapter Generator, validation gate, and `isolated-vm` sandbox.
- `StorageBackend` interface and Postgres implementation, including merging writes (the §11.2 MVP option is acceptable), soft deletes, timestamps, indexes, and read-only credentials.
- Quarantine and replay.
- Opaque paths (§7.1). Without them, a field with varying keys triggers repeated generations.

**Admin interface (§19).** Starts once the initial server exists (accounts and `/ingest`), and can run alongside the rest of core.

**2. If time allows.**
- Per-column ordering with `_column_seq` (§11.2).
- The remaining webhook features: handshakes, signatures, batches, and form bodies (§6.2).
- Rebuilds (§5.4), to repair bad adapters and reshape existing data. Until they exist, rows written by a bad adapter that passed validation stay in place, though the original events remain in the log.
- A basic conformance suite (§11.5).

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

- Can ingest arbitrary JSON payloads, with no type, into per-account namespaces on the Postgres backend.
- The demo shows whether no-type holds up against lookalike payloads, and whether paths resolve any confusion (§6.1).
- A `DELETE` request soft-deletes the record it names.
- Can quarantine unrecognized shapes without data loss.
- An unknown shape reaches relational tables with no human involvement, delayed only by adapter generation and replay.
- A customer can connect with read-only credentials and query normalized tables with typed timestamps and indexed joins.
- Partial updates to the same record merge into one row without losing earlier values.
- Resending a parent with fewer children leaves the others current, and a child can be removed with a `DELETE` or a per-item delete flag.
- A simulated third-party webhook, using a recorded GitHub or Shopify payload and headers sent to `/ingest?key=…`, reaches tables.
- Can replay quarantined rows transactionally after adapter activation, with repeated or interrupted replays producing no duplicate rows.
- A client retry with the same `Idempotency-Key` creates no duplicate data.
- Every accepted payload is retained in the event log, including malformed ones.
- A storage backend outage delays writes but loses no accepted payloads.
- A super admin can create an account and a user, and that user can log in, copy their endpoint and credentials, and see their schema and traffic, but nothing belonging to another account.

If time allows, and afterward:

- Can rebuild an account into a new store from the event log and switch to it atomically, with no accepted events missing.
- Custom API App can query the same normalized tables independently.
- A new storage backend can be added by implementing `StorageBackend` and passing the conformance suite, with no changes to the pipeline or adapters.

---

## 19. Admin Interface

A web interface for running the platform and using an account. It is built after the initial server (accounts and `/ingest`), because it reuses that server's Hono setup and account logic.

### 19.1 Approach

- A Hono app with server-rendered pages (`hono/jsx`) and polling instead of websockets, so there is no frontend build.
- It runs on its own host, such as `admin.example.com`, separate from `/ingest`. It calls platform logic in-process, and the internal routes stay private.
- There are two roles: super admin and account member. A user can belong to several accounts, and an account can have several users.

### 19.2 Login

- Email and password, hashed with `scrypt` from Node's `crypto`.
- The first super admin is created at startup from `ADMIN_EMAIL` and `ADMIN_PASSWORD`, if no super admin exists yet.
- Sessions use a random token in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` outside local development. Only the token's hash is stored.
- State-changing requests require a CSRF token.
- A super admin sets a user's initial password and can reset it. There is no email delivery, so no self-service reset.

```sql
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
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 19.3 Security Rules

- Every query is scoped to an account the logged-in user belongs to, through one shared authorization check. A test proves a member can't read or change another account's data.
- A super admin can view any account, read-only in the MVP.
- Disabling a user ends their sessions.
- Payloads can hold personal data and customer secrets, so viewing one is a deliberate action, not shown in list views.
- API keys and passwords never appear in URLs or logs.

### 19.4 Pages

**Super admin:**
- Create and list accounts, wrapping `POST /accounts`.
- Disable or re-enable an account.
- Create and disable users, reset passwords, and assign users to accounts.
- A cross-account overview: events, oldest queue job, open quarantine, and generation failures per account.

**Account member:**

| Page | Shows | Data source |
|---|---|---|
| **Connect** | Endpoint URL, a copyable `curl` example, webhook URL format, Postgres connection string | `accounts`, `account_stores` |
| **Credentials** | Create and revoke API keys; reveal the read-only login | `api_keys`, `read_credentials` |
| **Schema** | Tables, columns, types, parent and child links, row counts | `data_columns`, store database |
| **Traffic** | Requests over time, by source and op | `events` |
| **Pipeline** | Queue depth, oldest job's age, retries | `queue` |

API keys are stored only as hashes, so an existing key can't be shown again. Creating a key shows it once, and members replace a lost key by creating a new one and revoking the old. The read-only login can be revealed, because it's stored encrypted. Resetting that password needs its own action, since `provision` must not run on an active store (§11.2).

**If time allows:**
- **Live pipeline view:** a new payload moving from quarantined, to adapter generated, to tables appearing.
- **Quarantine:** open items by reason, payload view, and replay.
- **Adapters:** shapes, versions, code, generation attempts and failures, and approving or rejecting adapters waiting on an operator.
- **Event explorer:** look up an event to see its payload, outcome, and any quarantine reason.

**Later:** an audit log of key changes, credential reveals, and super admin views; LLM usage and cost per account, which also requires the generator to record tokens; alerts; adapter rollback; and super admin actions taken on an account's behalf.

---

## 20. Demo Console

A UI for showing the platform off, separate from the admin interface (§19) and part of the existing demo site. It runs locally, or behind basic auth on the demo VPS (§21), and isn't a customer-facing product. It has two modes:

- **Arbitrary JSON:** edit any JSON, choose the method and optional path and headers, send it to `/ingest`, and see the request and response.
- **Webhook examples:** preset Shopify webhooks, sent with realistic headers to `/ingest/shopify?key=…`, in two guided flows: a product creation flow, and an order creation to refund flow. Payloads are based on Shopify's documented webhook shapes, using fictional data.

Both modes sit beside a **live tables view**, so viewers can watch tables, columns, and rows appear as events are processed. It reads through the store's read-only login, and shows each event's progress from the application database, using a local-only connection.

The console also works against the built-in stub, without tables, so it can be built and demonstrated before the full pipeline runs.

## 21. Deployment

One VPS runs everything for the hackathon demo. It's disposable: nothing on it needs to outlive the demo, and the local testbed stays the fallback if it fails.

### 21.1 Host

A DigitalOcean droplet with 2 GB of RAM and 2 GB of swap, running Ubuntu LTS, Node 22, Docker, and Caddy. Measured on the testbed, each Node service idles at about 110-150 MB and Postgres at about 210 MB, so the stack idles near 700 MB before any adapter runs, each of which starts a child process. A 512 MB droplet can't run it, and 1 GB leaves too little room for a demo.

Services run from a git checkout of `develop` with `node --import tsx`, without `--watch`. `tsx` is a dev dependency, so installs include dev dependencies. Each of the server, worker, generator, and demo is a systemd unit with `Restart=always`. Postgres runs in Compose with a restart policy, and stays bound to `127.0.0.1`.

Secrets are generated on the box and never copied from a development `.env`. `npm run setup` isn't used, and tests never run on the VPS, because the suite writes to the live `sw_app` and the worker and generator would process its rows. Bootstrap installs dependencies, starts Postgres, runs `npm run migrate`, and runs `npm run seed`.

### 21.2 Routing

Two hostnames, both TLS through Caddy. This replaces the wildcard subdomains in §14.2 for now, because wildcard certificates need a DNS challenge. Clients send `X-Account-Slug` as they do in development.

- **`app.<domain>`:** a default-deny allowlist of `/ingest*`, `/admin*`, and the read API and docs routes. `/accounts`, `/adapters`, and `/quarantine` are never forwarded, and everything else returns `404`.
- **`demo.<domain>`:** the demo site behind Caddy basic auth, because anyone who reaches it can send events that spend LLM credits, and read payloads. Caddy rewrites the upstream `Host` to the loopback address, which satisfies the tables panel's loopback check without changing it. `DEMO_HOST` and `DEMO_APP_DATABASE_URL` stay on loopback.

Caddy access logs stay off, because webhook URLs can carry `?key=`. The cloud firewall allows only ports 22, 80, 443, and 5432 (§21.4). Use DigitalOcean's cloud firewall rather than `ufw`, since Docker's published ports bypass `ufw`.

### 21.3 Code Changes

- **Public addresses.** Add `PUBLIC_BASE_URL`, `PUBLIC_DB_HOST`, and `PUBLIC_DB_PORT`. The Connect page, Credentials page, and account-created page use them for what they show customers, and fall back to today's localhost values when unset. When `PUBLIC_DB_HOST` is set, the connection string also ends in `?sslmode=require`. A store's own `connection` stays on `localhost`, because that's how the services reach Postgres.
- **CSRF behind TLS.** The admin's `csrf()` check compares `Origin` with the request URL, and behind Caddy the app is likely to see `http://` while the browser sends `https://`, which would reject the login form. When `PUBLIC_BASE_URL` is set, compare against it. Don't trust a client-supplied forwarded header for this. A test covers it, and the live login is checked after deploy.

### 21.4 Direct SQL

On at launch, as §14.1 describes, so customers connect to their store's database from the internet with the read-only login.

- **Port.** Compose publishes port 5432 publicly, alongside the existing loopback port for the services, and the cloud firewall allows it.
- **TLS.** Postgres runs with `ssl=on` and a self-signed certificate generated on the box. Connection strings shown to customers end in `?sslmode=require`, which encrypts the connection but doesn't verify the server's identity. That's acceptable for the demo; real certificates come later.
- **`pg_hba` rules.** The services connect from Docker's bridge network. From anywhere else, `hostssl` is the only accepted connection type, and `sw_app`, `sw_data`, and `postgres` are rejected by name, as are the `sw_app`, `postgres`, and template databases. So a leaked platform password still can't be used from outside.

Publishing the port without these rules would expose `sw_app` to the internet, so all three ship together. Verify from outside the VPS, because the source address Postgres sees depends on Docker's networking, and a rule that's wrong here could fail open.

### 21.5 Known Limits

No ingest rate limit and no login throttling, so the admin password must be long and random, and the Fireworks account needs a low spending cap. No backups beyond an optional droplet snapshot before the demo. Updates are manual: pull, install, migrate, restart, through `deploy/update.sh`.

### 21.6 Done When

From outside the VPS: the admin login works over HTTPS and copy buttons work; the Connect page shows the public endpoint; `curl` with the page's example reaches `/ingest`; `/accounts` returns `404`; the read-only login connects with `sslmode=require`, is refused without TLS, and can't reach another store; `sw_app`, `sw_data`, and `postgres` are refused from outside; the Shopify flows produce tables in the console behind basic auth; the services come back after a reboot.
