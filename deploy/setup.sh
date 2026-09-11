#!/usr/bin/env bash
# One-time provisioning for a fresh Scaleway Ubuntu/Debian instance.
#
#   sudo bash setup.sh --direct          # http://<instance-ip>:3000, no proxy
#   sudo bash setup.sh --direct --port 80
#   sudo bash setup.sh                   # Caddy + automatic HTTPS (needs a domain)
set -euo pipefail

APP_USER=rslashplace
APP_DIR=/opt/rslashplace
DATA_DIR=/var/lib/rslashplace

MODE=proxied
PORT=3000
while [[ $# -gt 0 ]]; do
	case "$1" in
		--direct)  MODE=direct; shift ;;
		--proxied) MODE=proxied; shift ;;
		--port)    PORT="$2"; shift 2 ;;
		*) echo "Unknown option: $1" >&2; exit 1 ;;
	esac
done

if [[ $EUID -ne 0 ]]; then
	echo "Run this as root (sudo bash setup.sh)" >&2
	exit 1
fi

echo "==> Mode: $MODE (port $PORT)"

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip ca-certificates rsync

echo "==> Installing Bun to /usr/local/bin"
if ! command -v bun >/dev/null 2>&1; then
	# The official installer drops Bun in $HOME/.bun; symlink it somewhere
	# systemd can see regardless of which user runs the service.
	curl -fsSL https://bun.sh/install | bash
	ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
/usr/local/bin/bun --version

if [[ $MODE == proxied ]]; then
	echo "==> Installing Caddy (TLS + reverse proxy)"
	apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg
	if ! command -v caddy >/dev/null 2>&1; then
		curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
			| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
		curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
			| tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
		apt-get update -qq
		apt-get install -y -qq caddy
	fi
	mkdir -p /var/log/caddy && chown -R caddy:caddy /var/log/caddy
else
	echo "==> Skipping Caddy (direct mode)"
fi

echo "==> Creating service user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

echo "==> Writing /etc/default/rslashplace"
if [[ $MODE == direct ]]; then
	printf 'HOST=0.0.0.0\nPORT=%s\n' "$PORT" > /etc/default/rslashplace
else
	printf 'HOST=127.0.0.1\nPORT=%s\n' "$PORT" > /etc/default/rslashplace
fi
cat /etc/default/rslashplace

echo "==> Firewall"
if command -v ufw >/dev/null 2>&1; then
	ufw allow OpenSSH
	if [[ $MODE == direct ]]; then
		ufw allow "${PORT}/tcp"
	else
		ufw allow 80/tcp
		ufw allow 443/tcp
	fi
	ufw --force enable
	ufw status
fi

echo
echo "Provisioning done. Next:"
if [[ $MODE == direct ]]; then
	echo "  1. Open TCP $PORT in the instance's Scaleway security group too --"
	echo "     ufw is only the host firewall; Scaleway filters separately."
	echo "  2. From your laptop:  ./deploy/deploy.sh <user>@<instance-ip>"
	echo "  3. Open http://<instance-ip>:$PORT"
else
	echo "  1. Put your domain in deploy/Caddyfile (replace place.example.com)"
	echo "  2. From your laptop:  ./deploy/deploy.sh <user>@<instance-ip>"
fi
