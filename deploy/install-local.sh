#!/usr/bin/env bash
# Install and start the app FROM the VPS, using this checkout.
# Use this when you cloned the repo onto the instance instead of pushing from
# a laptop with deploy.sh.
#
#   sudo bash deploy/install-local.sh --direct          # http://<ip>:3000
#   sudo bash deploy/install-local.sh --direct --port 80
#   sudo bash deploy/install-local.sh                   # proxied (Caddy)
set -euo pipefail

APP_USER=rslashplace
APP_DIR=/opt/rslashplace
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
	echo "Run as root: sudo bash deploy/install-local.sh $*" >&2
	exit 1
fi

# Provision first if this is a fresh box (installs Bun, user, dirs, firewall,
# and writes /etc/default/rslashplace). Safe to re-run.
echo "==> Provisioning"
bash "$REPO_ROOT/deploy/setup.sh" "$@"

echo "==> Installing app files to $APP_DIR"
install -o "$APP_USER" -g "$APP_USER" -m 644 "$REPO_ROOT/server.ts"  "$APP_DIR/server.ts"
install -o "$APP_USER" -g "$APP_USER" -m 644 "$REPO_ROOT/index.html" "$APP_DIR/index.html"

echo "==> Installing systemd unit"
install -m 644 "$REPO_ROOT/deploy/rslashplace.service" /etc/systemd/system/rslashplace.service

# Decide by MODE, not by whether Caddy happens to be installed. A box that was
# once provisioned proxied still has Caddy on it; pushing a proxy config there
# in direct mode breaks Caddy for a domain you are not even using.
# shellcheck disable=SC1091
. /etc/default/rslashplace
if [[ ${HOST:-} == "127.0.0.1" ]]; then
	if grep -q 'place\.example\.com' "$REPO_ROOT/deploy/Caddyfile"; then
		echo "ERROR: deploy/Caddyfile still has the placeholder domain." >&2
		echo "       Replace place.example.com with your real domain, or use --direct." >&2
		exit 1
	fi
	echo "==> Proxied mode -- installing Caddy config"
	install -m 644 "$REPO_ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile
	caddy validate --config /etc/caddy/Caddyfile
	systemctl reload caddy || systemctl restart caddy
elif systemctl list-unit-files caddy.service >/dev/null 2>&1 \
	&& systemctl is-enabled caddy >/dev/null 2>&1; then
	# Direct mode: a leftover Caddy would fail on the placeholder domain and
	# squat ports 80/443. Stop it; the app is served directly.
	echo "==> Direct mode -- disabling leftover Caddy"
	systemctl disable --now caddy || true
fi

echo "==> Starting service"
systemctl daemon-reload
systemctl enable --now rslashplace
systemctl restart rslashplace
sleep 1
systemctl --no-pager --lines=15 status rslashplace || true

# shellcheck disable=SC1091
. /etc/default/rslashplace
echo
if [[ ${HOST:-} == "0.0.0.0" ]]; then
	# hostname -I reports the interface address, which on some Scaleway instance
	# types is a private NAT address -- use the public IP from the console if
	# this one does not respond.
	IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
	echo "==> Running on port ${PORT:-3000}."
	echo "    Try http://${IP:-<instance-ip>}:${PORT:-3000}"
	echo "    If that address is private, use the instance's public IP instead."
	echo "    Either way, open TCP ${PORT:-3000} in the Scaleway security group."
else
	echo "==> Running on ${HOST}:${PORT} behind Caddy."
fi
echo "    Logs: journalctl -u rslashplace -f"
