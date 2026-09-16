#!/usr/bin/env bash
# Push the app to the instance and restart it.
# Usage:  ./deploy/deploy.sh root@51.15.x.x
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
	echo "Usage: $0 <ssh-target>   e.g. $0 root@51.15.12.34" >&2
	exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/rslashplace

echo "==> Syncing app files to $TARGET:$APP_DIR"
# Only the two files the server actually needs at runtime.
# No --chown: macOS ships openrsync, which does not support that flag and fails
# the whole transfer. Set ownership over ssh after the copy instead, which works
# with both openrsync and GNU rsync.
rsync -avz "$REPO_ROOT/server.ts" "$REPO_ROOT/index.html" "$TARGET:$APP_DIR/"
ssh "$TARGET" "chown rslashplace:rslashplace '$APP_DIR/server.ts' '$APP_DIR/index.html' \
	&& chmod 644 '$APP_DIR/server.ts' '$APP_DIR/index.html'"

echo "==> Installing systemd unit"
rsync -avz "$REPO_ROOT/deploy/rslashplace.service" "$TARGET:/etc/systemd/system/rslashplace.service"

# Decide by the mode recorded on the host, not by whether Caddy is installed --
# a box provisioned proxied once still has Caddy, and pushing a proxy config in
# direct mode breaks Caddy for a domain that is not in use.
# /etc/default/rslashplace is written by setup.sh and left alone here, so
# redeploys never change the mode.
REMOTE_HOST_BIND="$(ssh "$TARGET" '. /etc/default/rslashplace 2>/dev/null; echo "${HOST:-}"')"
if [[ $REMOTE_HOST_BIND == "127.0.0.1" ]]; then
	if grep -q 'place\.example\.com' "$REPO_ROOT/deploy/Caddyfile"; then
		echo "ERROR: deploy/Caddyfile still has the placeholder domain." >&2
		echo "       Replace place.example.com with your real domain." >&2
		exit 1
	fi
	echo "==> Proxied mode -- updating Caddy config"
	rsync -avz "$REPO_ROOT/deploy/Caddyfile" "$TARGET:/etc/caddy/Caddyfile"
else
	echo "==> Direct mode (HOST=${REMOTE_HOST_BIND:-unset}) -- skipping proxy config"
fi

echo "==> Restarting services"
ssh "$TARGET" bash -euo pipefail <<'REMOTE'
systemctl daemon-reload
systemctl enable --now rslashplace
systemctl restart rslashplace
. /etc/default/rslashplace 2>/dev/null || true
if [[ ${HOST:-} == "127.0.0.1" ]] && command -v caddy >/dev/null 2>&1; then
	caddy validate --config /etc/caddy/Caddyfile
	systemctl reload caddy || systemctl restart caddy
fi
sleep 1
systemctl --no-pager --lines=15 status rslashplace
echo
echo "Listening on: $(grep -h . /etc/default/rslashplace | tr '\n' ' ')"
REMOTE

echo
echo "==> Deployed. Logs:  ssh $TARGET journalctl -u rslashplace -f"
