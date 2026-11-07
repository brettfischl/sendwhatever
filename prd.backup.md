# PRD: Adaptive JSON Ingestion Platform

## 1. Overview

Build a platform that accepts arbitrary JSON payloads sent to per-account endpoints, classifies their structure, and writes them into per-account SQLite databases. When an unrecognized payload structure arrives, the system quarantines it and provides a workflow for an AI (or human operator) to author a new data adapter. Once the adapter is approved, all matching quarantined payloads are replayed through it.

The platform exposes two consumption paths for each account:
1. **Direct adapter-driven ingestion** — raw `{ type, data }` JSON payloads are classified and written automatically.
2. **Custom API built on top** — our application server connects to the same per-account database via libSQL and exposes domain-specific HTTP endpoints.

Storage is per-account SQLite databases hosted on a self-managed libSQL (`sqld`) server. Each account has its own database namespace, its own adapters, and its own quarantine queue.

---

## 2. Goals

- Accept open-ended JSON payloads in a constrained envelope: `{ "type": string, "data": object|array }`.
- Write recognized payload shapes into normalized relational tables per account.
- Quarantine unrecognized or malformed payloads instead of failing the request.
- Support AI/human adapter generation against quarantined samples.
- Replay quarantined payloads through new adapters transactionally.
- Provide a clean intermediate object contract so adapters reason about shape, not SQL.
- Build the platform on self-hosted, open-source libSQL (`sqld`) with per-account namespaces.

## 3. Non-Goals (MVP)

- Authentication or authorization.
- Billing, usage metering, or rate limiting.
- Multi-region replication or edge distribution.
- Full AI adapter generation implementation (the interface and workflow are defined; the LLM integration is out of scope).
- Strict foreign-key constraints or schema validation beyond column existence.
- Real-time streaming or subscriptions.
- WebSocket protocol support.

---

## 4. Architecture

```text
                              ┌─────────────────────────────────────┐
                              │             Clients                 │
                              │   (send raw {type, data} JSON)      │
                              └─────────────┬───────────────────────┘
                                            │
                                            ▼
                              ┌─────────────────────────────────────┐
                              │        Caddy Reverse Proxy          │
                              │  route account-123.api → namespace  │
                              └─────────────┬───────────────────────┘
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    │                                               │
                    ▼                                               ▼
        ┌─────────────────────┐                         ┌─────────────────────┐
        │  Ingestion Service  │                         │   Custom API App    │
        │   (adapter router)  │                         │   (domain routes)   │
        └──────────┬──────────┘                         └──────────┬──────────┘
                   │                                               │
                   │  both speak libSQL HTTP to namespaces         │
                   └─────────────────┬─────────────────────────────┘
                                     ▼
                     ┌───────────────────────────────┐
                     │    Self-Hosted libSQL/sqld    │
                     │                               │
                     │   ┌───────────────────────┐   │
                     │   │  namespace: account-1 │   │
                     │   │  ├─ adapters          │   │
                     │   │  ├─ quarantine        │   │
                     │   │  ├─ user              │   │
                     │   │  ├─ user_profile      │   │
                     │   │  └─ user_orders       │   │
                     │   └───────────────────────┘   │
                     │   ┌───────────────────────┐   │
                     │   │  namespace: account-2 │   │
                     │   │  ...                  │   │
                     │   └───────────────────────┘   │
                     └───────────────────────────────┘
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │   Local filesystem / volume   │
                     │   ./data/dbs/{account-id}/    │
                     └───────────────────────────────┘
```

---

## 5. Data Flow

### 5.1 Happy Path

1. Client POSTs `{ "type": "user", "data": { ... } }` to `https://account-123.api.example.com/ingest`.
2. Caddy routes the request to the Ingestion Service with account context.
3. Ingestion Service computes a structural fingerprint of `data` (sorted keys, nesting shape, array/object kinds) ignoring values.
4. It queries the account namespace for an active adapter matching `(type, fingerprint)`.
5. If found, it runs the adapter to produce an intermediate object.
6. Platform converts the intermediate object into SQL `INSERT`s, injecting missing UUIDs and FK columns.
7. Writes are committed to the account database.

### 5.2 Unknown Format Path

1. Steps 1–4 above are the same.
2. No active adapter matches `(type, fingerprint)`.
3. Payload is inserted into `quarantine` with `reason = 'unknown_fingerprint'`.
4. A background or on-demand process samples quarantined rows for that `(type, fingerprint)`.
5. AI/human writes an adapter that normalizes the shape into the intermediate object format.
6. Adapter is inserted with `active = 0`, tested against the sample.
7. On approval, adapter is set `active = 1`.
8. All matching quarantined rows are replayed through the adapter in batches; on success they are marked released.

### 5.3 Malformed Payload Path

1. Payload cannot be parsed as `{ type, data }` or `type` is missing/not a string.
2. Payload is inserted into `quarantine` with `reason = 'malformed'`.
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

Adapters transform the raw payload into an intermediate object. The platform turns that object into SQL.

```typescript
interface IntermediateObject {
  table?: string;       // override top-level table name; default = payload.type
  rows: IntermediateRow[];
}

interface IntermediateRow {
  id?: string;          // if omitted, platform injects UUID
  [column: string]: any;
  children?: Record<string, IntermediateObject>;
}
```

Rules:
- `table` is optional. If omitted, the platform uses the payload `type`.
- `rows` is required. Each row represents one record in the table.
- `id` is optional on each row. The platform injects a UUID if missing.
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
1. Inserts the `user` row.
2. Inserts `user_profile` rows with injected `user_id`.
3. Inserts `user_orders` rows with injected `user_id`.

---

## 9. Schema Strategy

The platform uses a lazy, additive schema strategy.

- Tables are created on first write if they do not exist.
- Columns are added on first encounter if they do not exist.
- Column types are inferred from the first value seen:
  - `number` → `REAL` (or `INTEGER` if the value is integral)
  - `string` → `TEXT`
  - `boolean` → `INTEGER`
  - `null` → `TEXT` (default)
- Existing columns are never modified or removed by the platform.
- Foreign keys are not enforced by SQLite; the platform relies on convention (`{parent_table}_id`).

This allows adapters to introduce new shapes without upfront schema design.

---

## 10. Per-Account Database Schema

### 10.1 System Tables

```sql
CREATE TABLE adapters (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL,
  code TEXT NOT NULL,
  active BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type, fingerprint, version)
);

CREATE TABLE quarantine (
  id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  type TEXT,
  fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  released_at DATETIME,
  released_by_adapter_id TEXT REFERENCES adapters(id)
);

CREATE TABLE replay_log (
  id INTEGER PRIMARY KEY,
  quarantine_id INTEGER NOT NULL REFERENCES quarantine(id),
  adapter_id TEXT NOT NULL REFERENCES adapters(id),
  status TEXT NOT NULL,
  detail TEXT,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 10.2 Dynamic Data Tables

Created lazily by the platform. Example after processing user payloads:

```sql
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  email TEXT
);

CREATE TABLE user_profile (
  user_id TEXT,
  first_name TEXT,
  last_name TEXT
);

CREATE TABLE user_orders (
  user_id TEXT,
  sku TEXT,
  amount REAL
);
```

---

## 11. Adapter Runtime

Adapters are stored as code strings in the `adapters` table and executed in a sandboxed environment.

MVP approach:
- Adapters are JavaScript functions stored as text.
- The Ingestion Service runs them in a restricted VM or function constructor with no access to network, filesystem, or globals other than a provided `payload` argument.
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

## 12. API Surface

### 12.1 Ingestion Service

`POST /ingest`
- Accepts `{ type, data }` JSON.
- Returns `202 Accepted` if written or quarantined.
- Response body:
  - `status`: `written`, `quarantined`, `malformed`
  - `quarantine_id`: if quarantined

`GET /quarantine`
- Lists quarantined payloads, optionally filtered by `type`, `fingerprint`, or `reason`.

`POST /adapters`
- Creates a new adapter (initially `active = 0`).
- Body: `type`, `fingerprint`, `code`.

`POST /adapters/:id/activate`
- Sets `active = 1` and triggers replay of matching quarantined rows.

`POST /adapters/:id/test`
- Runs the adapter against a sample of matching quarantined rows without writing data.

### 12.2 Custom API App

Connects to the same libSQL namespaces as the Ingestion Service. Exposes domain-specific routes built on top of the normalized tables. Exact routes are out of scope for this PRD; they will be defined per-account/use case.

---

## 13. Infrastructure

### 13.1 libSQL/sqld Deployment

- Run `ghcr.io/tursodatabase/libsql-server:latest` as a container.
- Persist data via volume mount at `/var/lib/sqld`.
- Expose HTTP on port `8080`.
- Optionally enable JWT auth via `SQLD_AUTH_JWT_KEY_FILE`.

### 13.2 Caddy Routing

Caddy terminates TLS and routes subdomains to the appropriate sqld namespace.

Example Caddyfile:

```
account-*.api.example.com {
  reverse_proxy localhost:8080 {
    header_up Host {http.request.host.labels.2}.{http.request.host.labels.1}.{http.request.host.labels.0}
  }
}
```

For development, path-based routing can be used instead:

```
localhost:8081 {
  reverse_proxy /v1/namespaces/{account}/* localhost:8080
}
```

### 13.3 Account Namespace Creation

New accounts are provisioned by calling the sqld admin API:

```bash
curl -X POST http://sqld:8080/v1/namespaces/account-123/create
```

---

## 14. Failure Modes

| Scenario | Behavior |
|----------|----------|
| Known type + fingerprint | Write via adapter |
| Known type, unknown fingerprint | Quarantine with `unknown_fingerprint` |
| Malformed payload | Quarantine with `malformed` |
| Adapter throws at runtime | Quarantine with `adapter_error` |
| Adapter returns invalid intermediate object | Quarantine with `adapter_error` |
| Replay batch fails | Mark batch failed; adapter stays active; operator inspects replay_log |

---

## 15. Open Questions

- Should the platform support adapter versioning with rollback?
- Should quarantined rows be deduplicated by content hash?
- Should child tables use composite primary keys or surrogate UUIDs?
- How should column type conflicts be resolved (e.g., first value is integer, later value is string)?
- What is the target runtime for the Ingestion Service and Custom API App (Node.js, Python, Go, Rust)?

---

## 16. Success Criteria

- Can ingest arbitrary `{ type, data }` payloads into per-account SQLite namespaces.
- Can quarantine unrecognized shapes without data loss.
- Can author, test, and activate adapters that normalize shapes into relational tables.
- Can replay quarantined rows transactionally after adapter activation.
- Custom API App can query the same normalized tables independently.
