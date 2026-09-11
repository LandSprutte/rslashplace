#!/usr/bin/env bash
# One-time provisioning for a fresh Scaleway Ubuntu/Debian instance.
# Run as root on the instance:  bash setup.sh
set -euo pipefail

APP_USER=rslashplace
APP_DIR=/opt/rslashplace
DATA_DIR=/var/lib/rslashplace

if [[ $EUID -ne 0 ]]; then
	echo "Run this as root (sudo bash setup.sh)" >&2
	exit 1
fi

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip debian-keyring debian-archive-keyring apt-transport-https ca-certificates rsync

echo "==> Installing Bun to /usr/local/bin"
if ! command -v bun >/dev/null 2>&1; then
	# The official installer drops Bun in $HOME/.bun; symlink it somewhere
	# systemd can see regardless of which user runs the service.
	curl -fsSL https://bun.sh/install | bash
	ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
/usr/local/bin/bun --version

echo "==> Installing Caddy (TLS + reverse proxy)"
if ! command -v caddy >/dev/null 2>&1; then
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
		| tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
	apt-get update -qq
	apt-get install -y -qq caddy
fi

echo "==> Creating service user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" /var/log/caddy
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"
chown -R caddy:caddy /var/log/caddy

echo "==> Firewall: allow SSH + HTTP + HTTPS only"
if command -v ufw >/dev/null 2>&1; then
	ufw allow OpenSSH
	ufw allow 80/tcp
	ufw allow 443/tcp
	ufw --force enable
fi

echo
echo "Provisioning done. Next:"
echo "  1. Put your domain in deploy/Caddyfile (replace place.example.com)"
echo "  2. From your laptop:  ./deploy/deploy.sh <user>@<instance-ip>"
