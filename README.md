# r/place clone

A 150×180 collaborative pixel canvas (1200×1440px at 8px per cell). Bun WebSocket server, single-file HTML client.

## Local

```sh
bun run dev     # http://localhost:3000, restarts on change
```

## Load testing

```sh
bun run loadtest                      # 100 clients, 20s, against localhost
bun run loadtest --clients 250 --seconds 30
bun run loadtest --vps                # the deployed instance, read-only
bun run loadtest --vps --yes          # skip the countdown
bun run loadtest --dry-run            # print the resolved config, connect to nothing
```

The server relays every cursor move to every other client, so outbound volume
grows with the square of the room size -- that fan-out, not the canvas, is what
saturates first. Pixels are almost free by comparison: at 200 clients, paints
alone cost 14% of a core while cursors at 40ms cost 100%.

The room is capped at `MAX_USERS` (100) in `server.ts`; a client arriving at a
full room gets a `full` message and a `1013` close, and the page says so rather
than reporting a generic disconnect.

Because the cost is quadratic, the client scales its cursor rate with the roster
instead of using one fixed interval (`setCursorRate` in `index.html`): 40ms up to
70 users, easing to 80ms at the 100-user cap. That holds outbound traffic at
~123k msg/s across the whole range -- the deployed box carried 199k at 24% of a
core -- while keeping a two-person room as responsive as it ever was. Remote
cursors are interpolated between samples, so the motion stays smooth even at the
slower end. `--cursor-ms` overrides the mirrored formula in the load test.

`--vps` points at `VPS_HOST` (default `51.159.117.204`, override with the
`VPS_HOST` / `VPS_PORT` / `VPS_SCHEME` env vars). Because that is a live server:

- it warns and counts down before connecting (`--yes` skips the countdown),
- it defaults to a smaller client count and a shorter run,
- **it does not paint.** Writes would scribble random pixels onto the real
  canvas, so they need an explicit `--paint`. Read-only runs still report
  latency, measured from cursor echoes instead of paint echoes.

Any `--url` that is not loopback gets the same treatment.

## Deploying to a Scaleway instance

The server holds live WebSocket connections and in-memory state, so it needs a
real always-on VM — a DEV1-S (or any shared-CPU instance) is plenty. Ubuntu 24.04.

There are two modes. Direct is the quick one; proxied is what you want once
other people are using it.

### Direct: just an IP and a port

No domain, no proxy, no certificates. The app binds `0.0.0.0` and you open
`http://<instance-ip>:3000`.

```sh
scp deploy/setup.sh root@<instance-ip>:/tmp/
ssh root@<instance-ip> bash /tmp/setup.sh --direct        # or --direct --port 80
./deploy/deploy.sh root@<instance-ip>
```

Then open `http://<instance-ip>:3000`. The client derives its WebSocket URL from
whatever host you loaded, so `ws://<instance-ip>:3000/ws` connects with no
config.

**Two firewalls, not one.** `setup.sh` opens the port in ufw on the host, but
Scaleway filters separately — open the same TCP port in the instance's
**security group** in the Scaleway console or nothing will reach it.

Trade-offs, since there's no TLS here:

- Traffic is plaintext — pixels, cursors, and generated names are readable on
  the wire. Fine for a sandbox or a handful of friends; not for a public link.
- Browsers treat `http://` origins as insecure contexts. This app doesn't use
  any API that requires a secure context, so everything works — but anything you
  add later that does (clipboard, geolocation, service workers) won't.
- Using `--port 80` drops the `:3000` from the URL. The unit already grants
  `CAP_NET_BIND_SERVICE`, so the non-root service user can bind it.

### Proxied: a domain with automatic HTTPS

```sh
scp deploy/setup.sh root@<instance-ip>:/tmp/
ssh root@<instance-ip> bash /tmp/setup.sh                 # installs Caddy
# put your domain in deploy/Caddyfile (replace place.example.com)
./deploy/deploy.sh root@<instance-ip>
```

Point a DNS A record at the instance first. Caddy issues and renews the
certificate on first request. Caddy v2 passes WebSocket upgrades through
untouched, so `/ws` needs no special config.

```
direct:   browser ──http/ws──▶ bun server.ts :3000 (0.0.0.0)
proxied:  browser ──https/wss─▶ Caddy :443 ──▶ bun server.ts :3000 (127.0.0.1)
```

### Switching modes later

The mode is just two lines in `/etc/default/rslashplace`, read by the systemd
unit:

```sh
ssh root@<ip> 'printf "HOST=0.0.0.0\nPORT=3000\n" > /etc/default/rslashplace \
  && systemctl restart rslashplace'
```

Use `HOST=127.0.0.1` for proxied, `HOST=0.0.0.0` for direct. `deploy.sh` never
overwrites this file, so redeploys keep whichever mode you chose.

### Starting it from the VPS itself

The flow above pushes from your laptop. If you'd rather clone the repo onto the
instance and work there, do it all on the box:

```sh
ssh root@<instance-ip>
apt-get update && apt-get install -y git
git clone <your-repo-url> /srv/rslashplace && cd /srv/rslashplace

bash deploy/install-local.sh --direct        # or --direct --port 80, or bare for proxied
```

That provisions (Bun, service user, firewall), copies `server.ts` + `index.html`
into `/opt/rslashplace`, installs the systemd unit, and starts the service. Safe
to re-run after a `git pull` to ship changes.

Once installed — by either route — the service is managed with systemd and
starts on boot automatically:

```sh
systemctl start rslashplace
systemctl stop rslashplace
systemctl restart rslashplace
systemctl enable rslashplace     # start at boot (install scripts already do this)
```

To run it in the foreground instead, for a quick look at what it prints:

```sh
systemctl stop rslashplace       # free the port first
cd /opt/rslashplace
HOST=0.0.0.0 PORT=3000 DATA_FILE=/var/lib/rslashplace/canvas.json bun server.ts
```

Ctrl-C stops it; the canvas is flushed to disk on the way out. Use this only for
debugging — it dies with your SSH session, which is the whole reason the systemd
unit exists.

### Operating it

```sh
systemctl status rslashplace          # is it up
journalctl -u rslashplace -f          # live logs
systemctl restart rslashplace         # restart (canvas is preserved)
```

Canvas state is written to `/var/lib/rslashplace/canvas.json` — debounced 2s
while drawing, and flushed on SIGTERM — so restarts and redeploys don't wipe it.
Delete that file to reset the canvas.

### Troubleshooting

**`status=203/EXEC`** — systemd cannot execute `/usr/local/bin/bun`. Almost
always because Bun was symlinked into `/root/.bun`: `/root` is mode 700 and the
unit sets `ProtectHome=true`, so the service user cannot resolve it. Note that
`bun --version` as root still works, which is why this slips through. Fix:

```sh
rm -f /usr/local/bin/bun
BUN_INSTALL=/usr/local bash -c 'curl -fsSL https://bun.sh/install | bash'
su -s /bin/sh -c '/usr/local/bin/bun --version' rslashplace   # must print a version
systemctl restart rslashplace
```

`/usr/local/bin/bun` must be a real file, not a symlink.

**Caddy fails to start after switching to direct mode** — a box provisioned
proxied still has Caddy installed, and it will fail trying to get a certificate
for whatever domain is in `/etc/caddy/Caddyfile`. In direct mode Caddy is not
used at all:

```sh
systemctl disable --now caddy
```

**Nothing responds on `http://<ip>:<port>`** — check in this order: the service
is running (`systemctl status rslashplace`), it is bound to `0.0.0.0` and not
`127.0.0.1` (`cat /etc/default/rslashplace`), the host firewall allows the port
(`ufw status`), and the **Scaleway security group** allows it. That last one is
a separate layer from ufw and is the most common cause.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the app listens on |
| `HOST` | `0.0.0.0` | Bind address. On the server this comes from `/etc/default/rslashplace`: `0.0.0.0` direct, `127.0.0.1` proxied |
| `DATA_FILE` | `./canvas.json` | Where the canvas snapshot is stored |

### Optional: ship a compiled binary instead of source

If you'd rather not install Bun on the server, build a self-contained binary
locally and copy that up instead of `server.ts`:

```sh
bun run build:linux-x64      # or build:linux-arm64 for an AMP/ARM instance
```

The binary does not embed `index.html`, so keep that file beside it — the
server looks next to its own executable and then in the working directory, so
`/opt/rslashplace/{rslashplace-linux-x64,index.html}` works. Point
`ExecStart=` at the binary instead of `bun` and drop the Bun install from
`setup.sh`.

The `rslashplace` binary already in this directory is a macOS arm64 build and
won't run on Linux — it's gitignored for that reason.
