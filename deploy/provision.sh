#!/usr/bin/env bash
# One-time base setup for a new Ubuntu 24.04 droplet (PRD §21.1). Run as root. Safe to re-run.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git build-essential python3 openssl \
  docker.io docker-compose-v2 caddy postgresql-client ufw

if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -y -q nodejs
fi

id sw >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/sendwhatever --shell /bin/bash sw
usermod -aG docker sw
systemctl enable --now docker caddy

# Docker's published ports bypass ufw, so this covers sshd and Caddy. Postgres publishes only
# 5432 publicly (deploy/docker-compose.deploy.yml); the services' port stays on 127.0.0.1.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 5432/tcp
ufw --force enable

echo "provisioned: node $(node --version), $(docker --version | cut -d, -f1), caddy $(caddy version | cut -d' ' -f1)"
