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
| `npm run dev` | Runs the server and worker together (see below) |
| `npm start` | Runs just the server |
| `npm run worker` | Runs just the worker |
| `npm run demo` | Runs the demo webinar site (see below) |
| `npm run migrate` | Applies new migrations to `sw_app` |
| `npm test` | Type-checks, then runs the tests (Postgres must be running) |
| `npm run typecheck` | Type-checks without emitting files |
| `docker compose up -d --wait` | Starts Postgres |
| `docker compose down -v` | Stops Postgres and **deletes its data** |

If you delete `.env` but keep the volume, the new passwords won't match the existing roles. Run `docker compose down -v` and then `npm run setup`.

If you set up before the move to Postgres 18, run `docker compose down -v` and then `npm run setup`. That deletes this checkout's local data.

If port 5433 is taken, for example by another worktree, change `POSTGRES_PORT` in `.env`.

## Running the service

With Postgres up and migrations applied (`npm run setup` does both), run the server and worker with one command:

```bash
npm run dev
```

Ctrl-C stops both. If either one exits by itself, the other is stopped too and the command exits with an error. On shutdown the worker stops claiming jobs and lets running ones finish, for up to 30 seconds. A job cut off at that limit runs again once its lease expires. With `npm run worker` on its own, Ctrl-C also reaches any adapter running at that moment, so that job runs again after a short wait instead of finishing. SIGTERM doesn't have this problem.

Stop this before running `npm test`. It uses the same queue as the tests, so it would take their jobs.

`npm start`, `npm run worker` and `npm run dev` use `node --import tsx` rather than the `tsx` command. Under load, that wrapper kills a process with SIGKILL if it doesn't confirm a signal within about 60 ms, which would skip the clean shutdown.

To try it, create an account, then send it a payload. The first response is the only time you see the API key, and it also holds the read-only database login:

```bash
curl -X POST localhost:3000/accounts \
  -H "authorization: Bearer $(grep '^INTERNAL_API_TOKEN=' .env | cut -d= -f2-)" \
  -H 'content-type: application/json' -d '{"slug":"demo"}'

curl -X POST localhost:3000/ingest -H 'X-Account-Slug: demo' -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'content-type: application/json' -d '{"id":"c1","name":"Ada"}'
```

The worker processes the event within a second. Nothing writes adapters yet, so a new shape lands in the `quarantine` table with the reason `unknown_fingerprint`. Once an active row in `adapters` matches the shape, its events reach tables in the account's own database.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port for the server. |
| `HOST` | `127.0.0.1` | Address for the server. Internal routes have no auth, so think before exposing it. |
| `WORKER_ACCOUNT_ID` | every account | Limits the worker to one account's jobs. `test/entrypoints.test.ts` uses it, because test files share a queue. |

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
| `DEMO_APP_DATABASE_URL` | none | Turns on the live tables panel against a real service: a `postgres://` URL for `sw_app` on localhost, used read-only for event progress and to find the store. It needs `SW_ENCRYPTION_KEY` to open the store's read-only login, and `DEMO_HOST` must stay on loopback, or the demo won't start. |

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

### Console

http://127.0.0.1:3100/console is for showing the platform off (PRD §20). Arbitrary JSON mode sends any JSON you write, with any method, path, and headers, and shows the request and response. Invalid JSON is caught before sending, and **Send anyway** sends it regardless to show the `400`. Requests go through the demo server, which adds the API key and `X-Account-Slug`, so the key never reaches the browser. It also works against the stub.

`npm test` includes the demo's tests, but also tests that need Postgres. To run just the demo's, use `npx vitest run demo`.

## Layout

| Path | Contents |
| --- | --- |
| `migrations/app/` | `sw_app` schema, as numbered `.sql` files |
| `src/contracts/` | Shared types, exported from `index.ts` |
| `src/fingerprint/` | Structural fingerprint |
| `src/config.ts` | Loads config from `.env` |
| `demo/` | Fake webinar site that writes to `/ingest` |
| `src/http/main.ts`, `src/worker/main.ts` | Server and worker entry points |
| `scripts/` | Setup, migration, and `npm run dev` entry points |
| `test/` | Integration tests |
| `docker/postgres/init/` | Creates the roles and databases when the volume is first created |

Any process that loads `isolated-vm` must run with `node --no-node-snapshot`, as its docs require on Node 20 and later. `vitest.config.ts` already sets this for tests, and `src/sandbox` sets it on the child process it runs adapters in, so its callers don't need it.

Put unit tests next to the code as `src/**/*.test.ts`.

Migrations run in filename order, so use the next number, such as `0002_app_schema.sql`, with `-- Up Migration` and `-- Down Migration` sections. `sw_data` has no migrations because `provision` creates a database for each store at runtime.
