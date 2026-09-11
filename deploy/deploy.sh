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
rsync -avz --chown=rslashplace:rslashplace \
	"$REPO_ROOT/server.ts" "$REPO_ROOT/index.html" \
	"$TARGET:$APP_DIR/"

echo "==> Installing systemd unit"
rsync -avz "$REPO_ROOT/deploy/rslashplace.service" "$TARGET:/etc/systemd/system/rslashplace.service"

# Only push the proxy config if setup.sh actually installed Caddy. In direct
# mode there is no Caddy and nothing to configure. /etc/default/rslashplace is
# written by setup.sh and left alone here, so redeploys never change the mode.
if ssh "$TARGET" 'command -v caddy >/dev/null 2>&1'; then
	echo "==> Caddy present -- updating proxy config"
	rsync -avz "$REPO_ROOT/deploy/Caddyfile" "$TARGET:/etc/caddy/Caddyfile"
else
	echo "==> No Caddy on host (direct mode) -- skipping proxy config"
fi

echo "==> Restarting services"
ssh "$TARGET" bash -euo pipefail <<'REMOTE'
systemctl daemon-reload
systemctl enable --now rslashplace
systemctl restart rslashplace
if command -v caddy >/dev/null 2>&1; then
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
