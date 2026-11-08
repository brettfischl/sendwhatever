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
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=db.$DOMAIN" \
      -keyout "$dir/server.key" -out "$dir/server.crt" 2>/dev/null
  fi
  install -m 0640 "$APP_DIR/deploy/pg_hba.conf" "$dir/pg_hba.conf"
  chown -R 70:70 "$dir"
  chmod 0600 "$dir/server.key"
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

wait_for_server() {
  for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "The server didn't answer /healthz within 60 seconds. See: journalctl -u sw-server" >&2
  return 1
}
