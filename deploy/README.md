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
| `update.sh` | Pulls the checked-out branch, `npm ci`, migrates, restarts the services, and re-renders Caddy |
| `lib.sh` | Shared by both |
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

## Releasing

`main` is the release branch. Brett merges `develop` into `main`, and `.github/workflows/deploy.yml` SSHes in and runs `update.sh`. It triggers only on `push` to `main`, never on `pull_request`, because the repo is public.

The deploy key's `authorized_keys` entry on the box is `command="/opt/sendwhatever/app/deploy/update.sh",no-pty,no-port-forwarding,...`, so it can only run `update.sh`. That script executes whatever is on the checked-out branch as root, so the key is as trusted as that branch's write access. The repo secrets are `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` and `DEPLOY_HOST`. `update.sh` pulls whichever branch the box has checked out, so the box must be on `main`. To switch it:

```bash
ssh ... root@HOST 'runuser -u sw -- git -C /opt/sendwhatever/app checkout main && bash /opt/sendwhatever/app/deploy/update.sh'
```

To check what's running without changing anything, use the deploy key with the command `status`.

To deploy by hand, run `ssh ... root@HOST bash /opt/sendwhatever/app/deploy/update.sh`.

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

  Bootstrap runs `npm run seed` again, which creates a new demo account and key and replaces `INGEST_API_KEY` in `.env`. If the seed fails, bootstrap stops rather than leave the demo without a key.
