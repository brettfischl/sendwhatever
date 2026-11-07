#!/usr/bin/env bash
# Takes a fresh checkout to Postgres running, migrations applied, and tests passing.
# Safe to re-run. It only adds missing variables to .env and never changes or prints values.
set -euo pipefail
cd "$(dirname "$0")/.."

umask 077
touch .env
chmod 600 .env
if [ -n "$(tail -c1 .env)" ]; then echo >> .env; fi

ensure_var() {
  grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env
}
random_password() {
  node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
}

ensure_var POSTGRES_PORT 5433
ensure_var POSTGRES_SUPERUSER_PASSWORD "$(random_password)"
ensure_var SW_APP_DB_PASSWORD "$(random_password)"
ensure_var SW_DATA_DB_PASSWORD "$(random_password)"
ensure_var FIREWORKS_API_KEY ""

npm ci
docker compose up -d --wait
npm run migrate
npm test
