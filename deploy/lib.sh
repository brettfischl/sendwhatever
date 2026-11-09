# shellcheck shell=bash
# Shared by bootstrap.sh and update.sh. Sourced, not run. Never prints secret values.

DOMAIN="${DOMAIN:-sendwhatever.lol}"
REPO_URL="${REPO_URL:-https://github.com/brettfischl/sendwhatever.git}"
APP_DIR=/opt/sendwhatever/app
# Root-only state that lives outside the checkout: Postgres TLS and pg_hba, the demo password.
STATE_DIR=/etc/sendwhatever
UNITS=(sw-server sw-worker sw-generator sw-demo)

as_sw() { runuser -u sw -- "$@"; }
in_app() { as_sw bash -c "cd $APP_DIR && $1"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then echo "Run this as root." >&2; exit 1; fi
}

# The pg_hba rules are committed; the certificate is generated here once. Postgres in the
# alpine image runs as uid 70 and refuses a key anyone else can read.
install_postgres_config() {
  local dir="$STATE_DIR/postgres"
  install -d -m 0750 "$dir"
  if [ ! -f "$dir/server.key" ]; then
    # Some clients, such as Go's, ignore the CN and need a SAN. libpq accepts either. Existing certs are left as they are.
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=db.$DOMAIN" \
      -addext "subjectAltName=DNS:db.$DOMAIN" \
      -keyout "$dir/server.key" -out "$dir/server.crt" 2>/dev/null
  fi
  install -m 0640 "$APP_DIR/deploy/pg_hba.conf" "$dir/pg_hba.conf"
  chown -R 70:70 "$dir"
  chmod 0600 "$dir/server.key"
}

# update.sh pulls whatever branch is checked out, so a push-to-main deploy on a box that is still on a
# feature branch would deploy that branch while the workflow goes green. Fails unless the box is on
# DEPLOY_BRANCH (default main); a detached HEAD has no branch name and fails too. The box's current
# update.sh predates this function, so its first run after this lands does not run the guard.
require_deploy_branch() {
  local want="${DEPLOY_BRANCH:-main}" have
  have="$(as_sw git -C "$APP_DIR" branch --show-current)"
  if [ "$have" != "$want" ]; then
    echo "The box is on '${have:-detached HEAD}', but deploys follow $want. Set DEPLOY_BRANCH=<branch> to deploy this branch deliberately." >&2
    exit 1
  fi
}

install_units() {
  local unit
  for unit in "${UNITS[@]}"; do
    install -m 0644 "$APP_DIR/deploy/systemd/$unit.service" "/etc/systemd/system/$unit.service"
  done
  systemctl daemon-reload
  systemctl enable "${UNITS[@]/%/.service}" >/dev/null
}

# The bcrypt hash only exists on the box, so the committed Caddyfile has a placeholder.
render_caddyfile() {
  local hash
  hash="$(cat "$STATE_DIR/demo-basic-auth.hash")"
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__DEMO_BASIC_AUTH_HASH__|$hash|" \
    "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile.new
  chmod 0640 /etc/caddy/Caddyfile.new
  chgrp caddy /etc/caddy/Caddyfile.new
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null 2>&1 \
    || { caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new 2>&1 | grep -v -i hash | tail -5; exit 1; }
  mv -f /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl reload caddy
}

postgres_up() {
  in_app "docker compose up -d --wait postgres"
}

# Postgres re-reads pg_hba.conf only on SIGHUP, and `compose up -d` doesn't recreate the container when
# the compose config is unchanged, so a changed rule would otherwise sit unused. The skip when the
# container isn't running is for callers that haven't started Postgres; update.sh and bootstrap.sh both
# start it first. The in-container `local all all trust` rule is what lets psql in without a password.
# A file with an error is not reloaded and the old rules stay active, but the bad file would still be
# on disk for the next container restart to choke on. So a file Postgres accepted is copied to
# pg_hba.conf.last-good, and on an error that copy is put back and reloaded and the deploy fails so it
# shows up. The copy is only ever made from a file that passed the check; backing up the on-disk file
# before the check could save a bad file from an earlier run that died before checking. With no
# .last-good (never validated) the file is left alone and the deploy only fails.
reload_postgres_config() {
  local bad dir="$STATE_DIR/postgres"
  if [ -z "$(in_app "docker compose ps --status running -q postgres")" ]; then return 0; fi
  in_app "docker compose exec -T postgres psql -U postgres -tAc 'select pg_reload_conf()'" >/dev/null
  bad="$(in_app "docker compose exec -T postgres psql -U postgres -tAc 'select count(*) from pg_hba_file_rules where error is not null'")"
  if [ "$bad" = 0 ]; then
    install -m 0640 "$dir/pg_hba.conf" "$dir/pg_hba.conf.last-good"
    chown 70:70 "$dir/pg_hba.conf.last-good"
    return 0
  fi
  echo "pg_hba.conf has $bad rule(s) Postgres can't use. Check: select * from pg_hba_file_rules where error is not null" >&2
  if [ -f "$dir/pg_hba.conf.last-good" ]; then
    install -m 0640 "$dir/pg_hba.conf.last-good" "$dir/pg_hba.conf"
    chown 70:70 "$dir/pg_hba.conf"
    in_app "docker compose exec -T postgres psql -U postgres -tAc 'select pg_reload_conf()'" >/dev/null
    echo "The last validated pg_hba.conf rules were restored and reloaded." >&2
  fi
  return 1
}

wait_for_server() {
  for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "The server didn't answer /healthz within 60 seconds. See: journalctl -u sw-server" >&2
  return 1
}
