# sendwhatever

Send any JSON to `/ingest`. An LLM writes the adapters, and you query clean Postgres tables. See `prd.md`.

## Setup

You need Node 22 (`nvm use`), Docker with Compose, and a C++ toolchain in case `isolated-vm` has to compile. Then run:

```bash
npm run setup
```

This one command takes a fresh checkout to Postgres running, migrations applied, and tests passing. It's safe to re-run. It adds any missing variables to `.env`, generating the database passwords, and never changes existing values.

Set `FIREWORKS_API_KEY` in `.env` yourself. Nothing needs it yet. `FIREWORKS_MODEL` is optional and has a default in `src/config.ts`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | Runs the demo webinar site (see below) |
| `npm run migrate` | Applies new migrations to `sw_app` |
| `npm test` | Type-checks, then runs the tests (Postgres must be running) |
| `npm run typecheck` | Type-checks without emitting files |
| `docker compose up -d --wait` | Starts Postgres |
| `docker compose down -v` | Stops Postgres and **deletes its data** |

If you delete `.env` but keep the volume, the new passwords won't match the existing roles. Run `docker compose down -v` and then `npm run setup`.

If port 5433 is taken, for example by another worktree, change `POSTGRES_PORT` in `.env`.

## Demo site

A fake webinar site, Beacon Live, that sends its activity to `/ingest`. It's the demo and the end-to-end testbed, and needs no `.env` or Postgres:

```bash
npm run demo
```

Then open http://127.0.0.1:3100. With no `INGEST_URL` set, it sends to a built-in stub that follows the status codes in PRD §13.1 and stores nothing. To send to a real service, set `INGEST_URL` and `INGEST_API_KEY` in `.env` or the environment:

```bash
INGEST_URL=http://localhost:3000/ingest INGEST_API_KEY=your-key ACCOUNT_SLUG=your-account npm run demo
```

| Variable | Default | What it does |
| --- | --- | --- |
| `INGEST_URL` | built-in stub | The ingest route. It must not contain a query or credentials, because it's shown in the request log. |
| `INGEST_API_KEY` | none | Sent as `Authorization: Bearer`. Required with `INGEST_URL`. It stays on the server and is masked in the request log. |
| `ACCOUNT_SLUG` | `demo` | Sent as `X-Account-Slug`, as in development without Caddy. Set it empty to leave the header out when a subdomain names the account. |
| `DEMO_PORT` | `3100` | Port for the site. |
| `DEMO_HOST` | `127.0.0.1` | Address for the site. It has no login, so think before exposing it. |

The panel on every page shows each request and its response. The site's own data lives in memory and is gone on restart. If ingest rejects a request or can't be reached, the action still happens on the site and the panel shows the failure.

Each action sends one request, with no envelope and no path unless noted:

| Action | Request | What it exercises |
| --- | --- | --- |
| Create a session | `POST` the session | Nested speakers, agenda, and tags; timestamps with an offset |
| Go live, end, or cancel a session | `PATCH { id, status, started_at }` | Partial update to the same record |
| Register | `POST` the registration with the session embedded | One event writing to several tables; optional fields that are sometimes absent |
| Watch or leave | `PATCH { id, attendance_status, ... }` | Partial update to the same record |
| Comment | `POST { session_id, sent_at, comments: [...] }` | Append-only child rows |
| Remove a comment | The same shape, with `deleted: true` on the item | A per-item delete sent by `POST` |
| Cancel a registration | `DELETE` with `{ id, ... }` in the body | Soft delete |
| Add a speaker or sponsor | `POST { id, name }` | Lookalikes that share a fingerprint (PRD §6.1). A checkbox sends them to `/ingest/speakers` and `/ingest/sponsors` instead. |
| Simulate viewers | All of the above except lookalikes and session create | Volume, and a batch that mixes normal and deleted comments |

`npm test` includes the demo's tests, but also tests that need Postgres. To run just the demo's, use `npx vitest run demo`.

## Layout

| Path | Contents |
| --- | --- |
| `migrations/app/` | `sw_app` schema, as numbered `.sql` files |
| `src/contracts/` | Shared types, exported from `index.ts` |
| `src/fingerprint/` | Structural fingerprint |
| `src/config.ts` | Loads config from `.env` |
| `demo/` | Fake webinar site that writes to `/ingest` |
| `scripts/` | Setup and migration entry points |
| `test/` | Integration tests |
| `docker/postgres/init/` | Creates the roles and databases when the volume is first created |

Any process that loads `isolated-vm` must run with `node --no-node-snapshot`, as its docs require on Node 20 and later. `vitest.config.ts` already sets this for tests, and `src/sandbox` sets it on the child process it runs adapters in, so its callers don't need it.

Put unit tests next to the code as `src/**/*.test.ts`.

Migrations run in filename order, so use the next number, such as `0002_app_schema.sql`, with `-- Up Migration` and `-- Down Migration` sections. `sw_data` has no migrations because `provision` creates a database for each store at runtime.
