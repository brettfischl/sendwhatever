#!/usr/bin/env bash
# Takes a provisioned droplet (deploy/provision.sh) to the live service (PRD §21). Run as root.
# Safe to re-run: it only adds missing .env variables and never changes or prints values.
#
#   curl -fsSL https://raw.githubusercontent.com/brettfischl/sendwhatever/develop/deploy/bootstrap.sh | bash
#   or: bash /opt/sendwhatever/app/deploy/bootstrap.sh
#
# Never runs `npm run setup` or the tests: the suite writes to the live sw_app.
set -euo pipefail

main() {
  local branch="${BRANCH:-develop}"
  DOMAIN="${DOMAIN:-sendwhatever.lol}"
  REPO_URL="${REPO_URL:-https://github.com/brettfischl/sendwhatever.git}"

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
  in_app "npm ci --include=dev --no-audit --no-fund"
  postgres_up
  in_app "npm run migrate"
  if has_npm_script seed; then in_app "npm run seed"; fi

  install_units
  systemctl restart sw-server
  wait_for_server
  ensure_demo_account
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
  # The demo sends through Caddy, so its request log shows the public endpoint.
  ensure_var INGEST_URL "https://app.$DOMAIN/ingest"
  ensure_var ACCOUNT_SLUG demo
  local app_password
  app_password="$(grep '^SW_APP_DB_PASSWORD=' "$env" | cut -d= -f2-)"
  ensure_var DEMO_APP_DATABASE_URL "postgres://sw_app:$app_password@localhost:5433/sw_app"
  # FIREWORKS_API_KEY is added by hand (deploy/README.md). Until then the generator restarts in a loop.
}

# Until `npm run seed` exists (sw-ddd.7), create the demo account through the internal route.
# Its API key is shown once, so it goes straight into .env.
ensure_demo_account() {
  local env="$APP_DIR/.env" token response key
  if grep -q '^INGEST_API_KEY=.' "$env"; then return 0; fi
  token="$(grep '^INTERNAL_API_TOKEN=' "$env" | cut -d= -f2-)"
  response="$(curl -sS -X POST http://127.0.0.1:3000/accounts \
    -H "Authorization: Bearer $token" -H 'content-type: application/json' -d '{"slug":"demo"}')"
  key="$(printf '%s' "$response" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).api_key??"")}catch{}})')"
  if [ -z "$key" ]; then
    echo "Couldn't create the demo account, so the demo site uses its stub. It may already exist without a saved key." >&2
    return 0
  fi
  sed -i '/^INGEST_API_KEY=/d' "$env"
  printf 'INGEST_API_KEY=%s\n' "$key" >> "$env"
  echo "Created the demo account and saved its API key to .env."
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
