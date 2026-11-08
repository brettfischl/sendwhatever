#!/usr/bin/env bash
# Takes a provisioned droplet (deploy/provision.sh) to the live service (PRD §21). Run as root.
# Safe to re-run, and it never prints values. It adds missing .env variables and re-syncs INGEST_API_KEY with
# the key `npm run seed` reports, so a hand-set INGEST_API_KEY is replaced. While .demo-seed.json holds an
# active key, seed reuses it and .env isn't rewritten. With no seed file, seed mints a new key and the old one
# stays active. It stops if seed refuses (for example, the demo account is disabled).
# BRANCH applies to the first clone only; later runs pull whatever branch is checked out.
#
#   curl -fsSL https://raw.githubusercontent.com/brettfischl/sendwhatever/main/deploy/bootstrap.sh | bash
#   or: bash /opt/sendwhatever/app/deploy/bootstrap.sh
#
# Never runs `npm run setup` or the tests: the suite writes to the live sw_app.
set -euo pipefail

main() {
  local branch="${BRANCH:-main}"
  DOMAIN="${DOMAIN:-sendwhatever.lol}"
  REPO_URL="${REPO_URL:-https://github.com/brettfischl/sendwhatever.git}"

  # Inline rather than require_root: lib.sh isn't on disk until the clone below, which needs root.
  if [ "$(id -u)" -ne 0 ]; then echo "Run this as root." >&2; exit 1; fi

  if [ ! -d /opt/sendwhatever/app/.git ]; then
    runuser -u sw -- git clone --branch "$branch" "$REPO_URL" /opt/sendwhatever/app
  else
    runuser -u sw -- git -C /opt/sendwhatever/app pull --ff-only
  fi
  # shellcheck source=deploy/lib.sh
  source /opt/sendwhatever/app/deploy/lib.sh

  write_env
  install_postgres_config
  # Validate the new rules before anything else can fail, so a later error (npm ci, migrate) can't
  # leave an unchecked pg_hba.conf installed and unreloaded.
  postgres_up
  reload_postgres_config
  in_app "npm ci --include=dev --no-audit --no-fund"
  in_app "npm run migrate"
  in_app "npm run seed"
  configure_demo_ingest

  install_units
  systemctl restart sw-server
  wait_for_server
  systemctl restart sw-worker sw-generator sw-demo

  ensure_demo_basic_auth
  render_caddyfile

  echo
  echo "Live: https://app.$DOMAIN/admin and https://demo.$DOMAIN"
  echo "Admin email:    grep ^ADMIN_EMAIL= $APP_DIR/.env"
  echo "Admin password: grep ^ADMIN_PASSWORD= $APP_DIR/.env"
  echo "Demo password:  cat $STATE_DIR/demo-basic-auth.password   (user: demo)"
}

ensure_var() {
  grep -q "^$1=" "$APP_DIR/.env" || printf '%s=%s\n' "$1" "$2" >> "$APP_DIR/.env"
}
random_password() { openssl rand -hex 24; }

write_env() {
  local env="$APP_DIR/.env"
  ( umask 077; touch "$env" )
  chown sw:sw "$env"
  chmod 600 "$env"
  if [ -s "$env" ] && [ -n "$(tail -c1 "$env")" ]; then echo >> "$env"; fi

  # The compose override adds the restart policy, public 5432 with TLS, and pg_hba (§21.4).
  ensure_var COMPOSE_FILE docker-compose.yml:deploy/docker-compose.deploy.yml
  ensure_var POSTGRES_PORT 5433
  ensure_var POSTGRES_SUPERUSER_PASSWORD "$(random_password)"
  ensure_var SW_APP_DB_PASSWORD "$(random_password)"
  ensure_var SW_DATA_DB_PASSWORD "$(random_password)"
  ensure_var SW_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  ensure_var INTERNAL_API_TOKEN "$(random_password)"
  ensure_var ADMIN_EMAIL "admin@$DOMAIN"
  ensure_var ADMIN_PASSWORD "$(random_password)"
  ensure_var PUBLIC_BASE_URL "https://app.$DOMAIN"
  ensure_var PUBLIC_DB_HOST "db.$DOMAIN"
  ensure_var PUBLIC_DB_PORT 5432
  # INGEST_URL is set later by configure_demo_ingest, once the API key is in place.
  ensure_var ACCOUNT_SLUG demo
  local app_password pg_port
  app_password="$(grep '^SW_APP_DB_PASSWORD=' "$env" | cut -d= -f2-)"
  pg_port="$(grep '^POSTGRES_PORT=' "$env" | cut -d= -f2-)"
  ensure_var DEMO_APP_DATABASE_URL "postgres://sw_app:$app_password@localhost:$pg_port/sw_app"
  # FIREWORKS_API_KEY is added by hand (deploy/README.md). Until then the generator restarts in a loop.
}

# `npm run seed` is the only thing that creates the demo account, because it also writes
# .demo-seed.json and a second path would leave the two disagreeing. Its API key can't be read back
# from the database, so it's copied from that file into .env. A rebuilt volume gives a new key, so any
# old line is replaced. INGEST_URL is set only after the key is in place: the demo refuses to start
# with INGEST_URL and no INGEST_API_KEY, and Restart=always would loop on that.
configure_demo_ingest() {
  local env="$APP_DIR/.env" key old
  # Read as sw and never printed. The key reaches .env through a shell builtin, not a command line.
  key="$(as_sw node -e '
    try {
      const k = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).apiKey;
      if (typeof k === "string") process.stdout.write(k);
    } catch {}
  ' "$APP_DIR/.demo-seed.json")" || key=""
  if [ -z "$key" ]; then
    echo "npm run seed left no usable apiKey in $APP_DIR/.demo-seed.json. Fix any seed error above, or run 'npm run seed' as sw in $APP_DIR, then re-run bootstrap." >&2
    exit 1
  fi
  # Rewritten only when it differs, so a re-run leaves .env byte-for-byte alone. Both values stay in
  # shell variables: grep -F with the key would put it in a command line.
  old="$(grep '^INGEST_API_KEY=' "$env" | cut -d= -f2- || true)"
  if [ "$old" != "$key" ]; then
    sed -i '/^INGEST_API_KEY=/d' "$env"
    printf 'INGEST_API_KEY=%s\n' "$key" >> "$env"
  fi
  # The demo sends through Caddy, so its request log shows the public endpoint.
  ensure_var INGEST_URL "https://app.$DOMAIN/ingest"
}

# Anyone who reaches the demo can spend LLM credits, so it sits behind basic auth (§21.2).
ensure_demo_basic_auth() {
  local password_file="$STATE_DIR/demo-basic-auth.password" hash_file="$STATE_DIR/demo-basic-auth.hash"
  install -d -m 0700 "$STATE_DIR"
  if [ ! -s "$password_file" ]; then
    ( umask 077; openssl rand -hex 16 > "$password_file" )
    rm -f "$hash_file"
  fi
  if [ ! -s "$hash_file" ]; then
    ( umask 077; caddy hash-password --plaintext "$(cat "$password_file")" > "$hash_file" )
  fi
}

main "$@"
exit
