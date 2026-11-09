# Deploy runbook

One DigitalOcean droplet runs everything (PRD §21). It's disposable, and the local testbed is the fallback.

| | |
|---|---|
| Box | `138.197.96.138`, Ubuntu 24.04, 1 vCPU, 2 GB plus 2 GB swap |
| SSH | `ssh -i ~/.ssh/sendwhatever -o IdentitiesOnly=yes root@138.197.96.138` |
| `app.sendwhatever.lol` | Ingest, admin, and the read API (`/tables*`). Everything else returns 404, including `/accounts`, `/adapters` and `/quarantine`. |
| `demo.sendwhatever.lol` | Demo site behind basic auth, user `demo` |
| `db.sendwhatever.lol:5432` | Direct SQL with a store's read-only login, TLS only (`?sslmode=require`) |
| Checkout | `/opt/sendwhatever/app`, owned by the `sw` user |
| Secrets | `/opt/sendwhatever/app/.env`, and `/etc/sendwhatever/` for Postgres TLS and the demo password |

## Files

| File | What it does |
|---|---|
| `provision.sh` | One-time base setup: swap, Docker, Caddy, Node 22, `psql`, the `sw` user, and ufw (22, 80, 443, 5432) |
| `bootstrap.sh` | Clones the repo, writes `.env` with new secrets, starts Postgres, migrates, runs `npm run seed` (which creates the demo account and writes `.demo-seed.json`), copies that key into `.env` as `INGEST_API_KEY` and only then sets `INGEST_URL`, installs and starts the services, and configures Caddy |
| `update.sh` | Takes a lock (a second run is refused), checks the box is on `main` (or `DEPLOY_BRANCH`), pulls it, creates the Postgres certificate if `server.key` or `server.crt` is missing and installs `pg_hba.conf`, starts Postgres and reloads `pg_hba.conf`, then `npm ci`, migrates, restarts the services, waits for `/healthz`, re-renders Caddy, and checks the services (see Checks after a deploy) |
| `lib.sh` | Shared by both. `bootstrap.sh` does the same Postgres steps as `update.sh` but does not run the service check. |
| `systemd/*.service` | `sw-server`, `sw-worker`, `sw-generator`, `sw-demo`: `node --import tsx`, `Restart=always`, run as `sw` |
| `docker-compose.deploy.yml` | Postgres override: restart policy, public 5432, TLS, `pg_hba.conf`, pinned bridge subnet. The box's `.env` sets `COMPOSE_FILE` so plain `docker compose` uses it. |
| `pg_hba.conf` | Accepts a password (scram-sha-256) from the bridge gateway, which the services' connections come from, and trusts only connections inside the container. From outside, `sw_app`, `sw_data`, `postgres` and their databases are refused, and everything else needs TLS. |
| `Caddyfile` | Template. The domain and the demo password's bcrypt hash are filled in on the box. There are no access logs. |

Neither script runs `npm run setup` or the tests on the box: the suite writes to the live `sw_app`.

## New box

```bash
scp -i ~/.ssh/sendwhatever deploy/provision.sh root@HOST:
ssh ... root@HOST 'bash provision.sh'
ssh ... root@HOST 'curl -fsSL https://raw.githubusercontent.com/brettfischl/sendwhatever/main/deploy/bootstrap.sh | BRANCH=main bash'
```

Then add the Fireworks key without printing it. Until then, the generator restarts in a loop:

```bash
grep '^FIREWORKS_API_KEY=' .env | ssh ... root@HOST 'cat >> /opt/sendwhatever/app/.env && systemctl restart sw-generator'
```

Caddy gets certificates once the A records for `app.`, `demo.` and `db.` point at the box.

## Secrets

These commands read them on the box. Don't paste them anywhere.

- Admin: `grep -E '^ADMIN_(EMAIL|PASSWORD)=' /opt/sendwhatever/app/.env`
- Demo basic auth: `cat /etc/sendwhatever/demo-basic-auth.password`, user `demo`
- `/opt/sendwhatever/app/.demo-seed.json`: written by `npm run seed` (mode 0600) with the demo API key, the `sw_app` database URL and a read-only login. It is as sensitive as `.env`. Bootstrap copies the key into `.env`, and `.env` is what the demo uses on the box; the seed file is only how the key gets there.
- Re-running `bootstrap.sh` on a box that has no `.demo-seed.json` (one set up before bootstrap used seed) makes seed create a second demo API key and puts it in `.env`. The old key stays active until you revoke it on the account's Credentials page.

## Releasing

`main` is the release branch. Brett merges `develop` into `main`, and `.github/workflows/deploy.yml` SSHes in and runs `update.sh`. It triggers only on `push` to `main`, never on `pull_request`, because the repo is public.

The deploy key's `authorized_keys` entry on the box is `command="/opt/sendwhatever/app/deploy/update.sh",no-pty,no-port-forwarding,...`, so it can only run `update.sh`. That script executes whatever is on the checked-out branch as root, so the key is as trusted as that branch's write access. The repo secrets are `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` and `DEPLOY_HOST`. `update.sh` pulls whichever branch the box has checked out, and refuses to run unless that is `main`, so a push to `main` can't quietly deploy a feature branch. (The box's `update.sh` from before this check doesn't have it on its first run.) To switch the box to `main`:

```bash
ssh ... root@HOST 'runuser -u sw -- git -C /opt/sendwhatever/app fetch origin && runuser -u sw -- git -C /opt/sendwhatever/app checkout main && bash /opt/sendwhatever/app/deploy/update.sh'
```

Fetch first: if the box's `origin/main` is stale and has no `deploy/` yet, the checkout deletes `deploy/update.sh` and the next step fails.

To deploy another branch by hand, fetch and check it out the same way (with `<branch>` in place of `main`), then run `DEPLOY_BRANCH=<branch> bash /opt/sendwhatever/app/deploy/update.sh` on the box. The deploy key can't set it, so its deploys always require `main`.

To check what's running without changing anything, use the deploy key with the command `status`. It prints the checked-out commit and each unit's `systemctl is-active` state, and it works while an update is running because it runs before the lock is taken.

To deploy by hand, run `ssh ... root@HOST bash /opt/sendwhatever/app/deploy/update.sh`.

## Checks after a deploy

`update.sh` ends with `check_services` (in `lib.sh`). After `/healthz` answers, it polls `systemctl is-active` for `sw-server`, `sw-worker` and `sw-demo` for up to 30 seconds each. For each unit that became active it reads `NRestarts` from `systemctl show`, waits 5 seconds, and reads it again; a higher number fails the deploy, as a unit that starts and then crashes in a loop would. On failure it names the units and prints `journalctl -u <unit> -n 20 --no-pager` to run. `sw-generator` is only reported, never a failure, because it restarts in a loop until the Fireworks key is added.

This check cannot detect a unit that is up and not restarting but misbehaving, for example a worker that is stuck or a demo that is generating bad data. It looks only at `is-active` and the restart counter.

Postgres rules: `reload_postgres_config` asks Postgres whether it accepts the installed `pg_hba.conf`. If it does, the file is copied to `pg_hba.conf.last-good` next to it. If it does not, the deploy fails; if a `.last-good` exists, that file is put back and reloaded, otherwise the rejected file stays on disk and the first error message says so. The copy is made only from a file Postgres accepted, so a bad file left by a run that died before the check is never saved as the backup. If Postgres is not running, the reload is skipped.

The certificate in `/etc/sendwhatever/postgres` is generated only when `server.key` or `server.crt` is missing, into `.new` files that are moved into place when `openssl` succeeds. A complete pair is never replaced.

## Checks after a change

From outside the box, not on it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://app.sendwhatever.lol/accounts      # 404
psql "host=db.sendwhatever.lol user=sw_app dbname=postgres sslmode=require password=x"
# pg_hba.conf rejects connection for host "<your public IP>": the real source address, not 172.30.0.1
```

If that error names `172.30.0.1` instead of your address, Docker is relaying public connections through the gateway, and `pg_hba.conf`'s gateway rule (scram-sha-256, so a password is still needed) would apply to outside connections, letting platform roles in from anywhere that has their password. Stop Postgres and fix that first.

## Logs and reset

- `journalctl -u sw-server -f` (also `sw-worker`, `sw-generator`, `sw-demo`)
- `docker compose logs postgres`, run in `/opt/sendwhatever/app` as `sw`
- Reset all data while keeping secrets:

  ```bash
  systemctl stop sw-server sw-worker sw-generator sw-demo
  cd /opt/sendwhatever/app
  runuser -u sw -- docker compose down -v
  rm -f .demo-seed.json
  bash deploy/bootstrap.sh
  ```

  Bootstrap runs `npm run seed` again, which creates a new demo account and key and replaces `INGEST_API_KEY` in `.env`. If the seed fails, bootstrap stops rather than leave the demo without a key. The `rm` isn't required, because seed replaces a key that no longer works, but it makes the reset explicit.
