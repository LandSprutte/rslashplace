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

echo "==> Installing systemd unit and Caddy config"
rsync -avz "$REPO_ROOT/deploy/rslashplace.service" "$TARGET:/etc/systemd/system/rslashplace.service"
rsync -avz "$REPO_ROOT/deploy/Caddyfile" "$TARGET:/etc/caddy/Caddyfile"

echo "==> Restarting services"
ssh "$TARGET" bash -euo pipefail <<'REMOTE'
systemctl daemon-reload
systemctl enable --now rslashplace
systemctl restart rslashplace
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
sleep 1
systemctl --no-pager --lines=15 status rslashplace
REMOTE

echo
echo "==> Deployed. Logs:  ssh $TARGET journalctl -u rslashplace -f"
