# r/place clone

A 100×100 collaborative pixel canvas. Bun WebSocket server, single-file HTML client.

## Local

```sh
bun run dev     # http://localhost:3000, restarts on change
```

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

### Operating it

```sh
systemctl status rslashplace          # is it up
journalctl -u rslashplace -f          # live logs
systemctl restart rslashplace         # restart (canvas is preserved)
```

Canvas state is written to `/var/lib/rslashplace/canvas.json` — debounced 2s
while drawing, and flushed on SIGTERM — so restarts and redeploys don't wipe it.
Delete that file to reset the canvas.

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
