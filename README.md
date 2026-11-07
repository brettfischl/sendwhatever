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
| `npm run migrate` | Applies new migrations to `sw_app` |
| `npm test` | Type-checks, then runs the tests (Postgres must be running) |
| `npm run typecheck` | Type-checks without emitting files |
| `docker compose up -d --wait` | Starts Postgres |
| `docker compose down -v` | Stops Postgres and **deletes its data** |

If you delete `.env` but keep the volume, the new passwords won't match the existing roles. Run `docker compose down -v` and then `npm run setup`.

If port 5433 is taken, for example by another worktree, change `POSTGRES_PORT` in `.env`.

## Layout

| Path | Contents |
| --- | --- |
| `migrations/app/` | `sw_app` schema, as numbered `.sql` files |
| `src/contracts/` | Shared types, exported from `index.ts` |
| `src/fingerprint/` | Structural fingerprint |
| `src/config.ts` | Loads config from `.env` |
| `scripts/` | Setup and migration entry points |
| `test/` | Integration tests |
| `docker/postgres/init/` | Creates the roles and databases when the volume is first created |

Any process that loads `isolated-vm` must run with `node --no-node-snapshot`, as its docs require on Node 20 and later. `vitest.config.ts` already sets this for tests, and `src/sandbox` sets it on the child process it runs adapters in, so its callers don't need it.

Put unit tests next to the code as `src/**/*.test.ts`.

Migrations run in filename order, so use the next number, such as `0002_app_schema.sql`, with `-- Up Migration` and `-- Down Migration` sections. `sw_data` has no migrations because stores create its schemas at runtime.
