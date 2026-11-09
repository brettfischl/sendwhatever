#!/usr/bin/env bash
# Pulls the checked-out branch and restarts the services (PRD §21.5). Run as root.
# Fails unless the box is on main; set DEPLOY_BRANCH=<branch> to deploy another branch by hand.
# The GitHub Actions deploy key can run only this script (deploy/README.md).
#
# Everything is inside main(), so bash has read the whole script before `git pull` replaces it.
set -euo pipefail

main() {
  # shellcheck source=deploy/lib.sh
  source /opt/sendwhatever/app/deploy/lib.sh
  require_root

  # Through the deploy key, `ssh ... status` reports without changing anything. It is before the lock
  # so it still answers while an update is running, which is when it is most useful.
  if [ "${SSH_ORIGINAL_COMMAND:-}" = status ]; then
    echo "Running $(as_sw git -C "$APP_DIR" log -1 --format='%h %s')"
    systemctl is-active "${UNITS[@]}" | paste -sd' '
    exit 0
  fi

  exec 9>/run/sendwhatever-update.lock
  flock -n 9 || { echo "Another update is running." >&2; exit 1; }

  require_deploy_branch
  as_sw git -C "$APP_DIR" pull --ff-only
  # Re-source in case the pull changed it.
  # shellcheck source=deploy/lib.sh
  source "$APP_DIR/deploy/lib.sh"
  echo "Deploying $(as_sw git -C "$APP_DIR" log -1 --format='%h %s')"

  install_postgres_config
  # Validate the new rules before anything else can fail, so a later error (npm ci, migrate) can't
  # leave an unchecked pg_hba.conf installed and unreloaded.
  postgres_up
  reload_postgres_config
  in_app "npm ci --include=dev --no-audit --no-fund"
  in_app "npm run migrate"
  install_units
  systemctl restart "${UNITS[@]}"
  wait_for_server
  render_caddyfile
  check_services
}

main "$@"
exit
