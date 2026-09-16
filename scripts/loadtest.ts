// Load test for the pixel server.
//
// Opens N WebSocket clients against a running server and drives them the way the
// real page does: a throttled cursor stream plus (optionally) pixel placements.
// The point is the broadcast fan-out -- the server relays every cursor move to
// every other client, so outbound message volume grows with N^2 and that, not
// the canvas itself, is what falls over first.
//
//   bun run loadtest                              # 100 clients, 20s, localhost
//   bun run loadtest --clients 250 --seconds 30
//   bun run loadtest --vps                        # the deployed instance, read-only
//   bun run loadtest --vps --clients 40 --yes     # skip the countdown
//   bun run loadtest --url ws://host:3000/ws --dry-run
//
// --vps targets a LIVE server other people may be using. It is deliberately
// awkward: it warns, counts down, defaults to a small client count, and does not
// paint. Painting there would scribble random pixels onto the real canvas, so it
// takes an explicit --paint on top of everything else.

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(Bun.argv.slice(2));

// Where --vps points. Override without editing this file:
//   VPS_HOST=1.2.3.4 bun run loadtest --vps
const VPS_HOST = process.env.VPS_HOST ?? "51.159.117.204";
const VPS_PORT = process.env.VPS_PORT ?? "3000";
const VPS_SCHEME = process.env.VPS_SCHEME ?? "ws"; // "wss" once it is behind Caddy

const TARGET_VPS = Boolean(args.vps);
const LOCAL_URL = "ws://127.0.0.1:3000/ws";
const URL_ = args.url
  ? String(args.url)
  : TARGET_VPS
    ? `${VPS_SCHEME}://${VPS_HOST}:${VPS_PORT}/ws`
    : LOCAL_URL;
// A --url pointing anywhere but loopback is remote too, and gets the same gate.
const REMOTE = TARGET_VPS || !/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(URL_);

// Smaller default against a live box: enough to see the curve, not enough to
// wreck it for whoever is drawing.
const CLIENTS = Number(args.clients ?? (REMOTE ? 40 : 100));
const SECONDS = Number(args.seconds ?? (REMOTE ? 15 : 20));
// The client scales its cursor rate with the roster (setCursorRate in
// index.html); mirror that formula so a run models what the room would really
// send. Override to model an older or misbehaving client.
const cursorRateFor = (n: number) => Math.min(80, Math.max(40, Math.ceil((n * n) / 125)));
const CURSOR_MS = Number(args["cursor-ms"] ?? cursorRateFor(CLIENTS));
const PAINT_MS = Number(args["paint-ms"] ?? 2000);
const RAMP_MS = Number(args["ramp-ms"] ?? 2000);
const SEND_CURSORS = !args["no-cursors"];
// Writes are opt-in anywhere remote, since they land on a canvas people can see.
const SEND_PAINTS = args.paint ? true : !REMOTE && !args["no-paint"];
// Learned from the server's init message, so paints land in bounds whichever
// build is deployed. Older servers send a square `grid`; newer ones gridW/gridH.
// Anything outside is silently dropped server-side, which would look like packet
// loss rather than what it is.
let gridW = Number(args["grid-w"] ?? 0);
let gridH = Number(args["grid-h"] ?? 0);
let gridSource = gridW && gridH ? "--grid-w/--grid-h" : "pending";

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

console.log(bold("\nload test configuration"));
console.log(`  target        ${URL_}${REMOTE ? red("  [REMOTE]") : dim("  [local]")}`);
console.log(`  clients       ${CLIENTS}`);
console.log(`  duration      ${SECONDS}s (after a ${RAMP_MS}ms ramp)`);
console.log(`  cursors       ${SEND_CURSORS ? `every ${CURSOR_MS}ms${args["cursor-ms"] ? "" : ` (the client's rate for ${CLIENTS} users)`}` : "off"}`);
console.log(`  paints        ${SEND_PAINTS ? `every ~${PAINT_MS}ms per client` : "off (read-only)"}`);
if (SEND_CURSORS) {
  const perSec = Math.round((CLIENTS * (CLIENTS - 1) * 1000) / CURSOR_MS);
  console.log(`  ${dim(`projected fan-out ~${perSec.toLocaleString()} outbound msgs/s at full rate`)}`);
}

if (args["dry-run"]) { console.log(dim("\n--dry-run: not connecting.\n")); process.exit(0); }

if (REMOTE) {
  console.log(red(bold("\n  ⚠  This is a live server other people may be using.")));
  console.log(red(`     ${CLIENTS} synthetic clients will appear in the roster and compete for CPU.`));
  if (SEND_PAINTS) {
    console.log(red(bold("     --paint is ON: this will write random pixels onto the real canvas.")));
  } else {
    console.log(dim("     Read-only: cursors only, no pixels written."));
  }
  if (!args.yes) {
    process.stdout.write(dim("\n  starting in "));
    for (let i = 5; i > 0; i--) { process.stdout.write(dim(`${i}… `)); await Bun.sleep(1000); }
    process.stdout.write(dim("go\n"));
  }
}
console.log("");

// Deterministic PRNG so two runs drive the same traffic and stay comparable.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

type Client = {
  id: number;
  ws: WebSocket;
  recv: number;
  sent: number;
  closed?: { code: number; reason: string };
};

const clients: Client[] = [];
const connectLatency: number[] = [];
// Round-trip samples: a message leaves one client, arrives at another.
const paintLatency: number[] = [];
const cursorLatency: number[] = [];
const paintsInFlight = new Map<string, number>();
const cursorsInFlight = new Map<string, number>();
let errors = 0;
let initBytes = 0;
let initPixels = 0;
let firstError = "";

function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const ms = (n: number) => (Number.isNaN(n) || !Number.isFinite(n) ? "n/a" : `${n.toFixed(1)}ms`);

function connect(id: number): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    let ws: WebSocket;
    try { ws = new WebSocket(URL_); } catch (e) {
      errors++; firstError ||= String(e); resolve(); return;
    }
    const c: Client = { id, ws, recv: 0, sent: 0 };
    clients.push(c);

    const settle = setTimeout(() => resolve(), 15_000); // never hang the ramp
    ws.onopen = () => { connectLatency.push(performance.now() - started); clearTimeout(settle); resolve(); };
    ws.onerror = (e: any) => {
      errors++; firstError ||= String(e?.message ?? e ?? "unknown");
      clearTimeout(settle); resolve();
    };
    ws.onclose = (e) => { c.closed = { code: e.code, reason: String(e.reason ?? "") }; };
    ws.onmessage = (ev) => {
      c.recv++;
      const raw = String(ev.data);
      let m: any;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "init") {
        initBytes = Math.max(initBytes, raw.length);
        initPixels = Math.max(initPixels, (m.pixels?.length ?? 0) / 2);
        if (gridSource === "pending") {
          const w = Number(m.gridW ?? m.grid), h = Number(m.gridH ?? m.grid);
          if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) {
            gridW = w; gridH = h;
            gridSource = m.gridW ? "server (gridW/gridH)" : "server (legacy square grid)";
          }
        }
      } else if (m.type === "pixel") {
        const t = paintsInFlight.get(`${m.x},${m.y},${m.color}`);
        if (t !== undefined) { paintLatency.push(performance.now() - t); paintsInFlight.delete(`${m.x},${m.y},${m.color}`); }
      } else if (m.type === "cursor" && m.x != null) {
        // Cursor echoes give a latency signal without writing anything, which is
        // the only signal available on a read-only remote run.
        const k = `${m.x},${m.y}`;
        const t = cursorsInFlight.get(k);
        if (t !== undefined) { cursorLatency.push(performance.now() - t); cursorsInFlight.delete(k); }
      }
    };
  });
}

console.log(`Connecting ${CLIENTS} clients to ${URL_}`);
const rampStart = performance.now();
const gap = CLIENTS > 1 ? RAMP_MS / CLIENTS : 0;
for (let i = 0; i < CLIENTS; i++) {
  connect(i);
  if (gap >= 1) await Bun.sleep(gap);
}
await Bun.sleep(REMOTE ? 3000 : 1500); // remote handshakes need longer
const live = () => clients.filter((c) => c.ws.readyState === WebSocket.OPEN).length;
console.log(`Connected ${live()}/${CLIENTS} in ${((performance.now() - rampStart) / 1000).toFixed(1)}s`);
if (live() === 0) {
  console.error(red(`\nNo clients connected to ${URL_}`));
  if (firstError) console.error(dim(`  first error: ${firstError}`));
  console.error(dim(REMOTE
    ? "  Check the host is up, the port is open in the Scaleway security group, and the scheme matches (ws vs wss)."
    : "  Is the server running?  bun run dev"));
  process.exit(1);
}

// ---- Drive traffic ----
if (SEND_PAINTS && !(gridW && gridH)) {
  console.error(red("Server never reported its grid size; cannot paint in bounds."));
  console.error(dim("  Pass --grid-w / --grid-h explicitly, or run without --paint."));
  process.exit(1);
}
if (SEND_PAINTS) console.log(dim(`Painting within ${gridW}x${gridH}  [${gridSource}]`));

const timers: ReturnType<typeof setInterval>[] = [];
let paintsSent = 0;

for (const c of clients) {
  if (c.ws.readyState !== WebSocket.OPEN) continue;
  let x = rand() * 1200, y = rand() * 1440;
  let dx = (rand() - 0.5) * 30, dy = (rand() - 0.5) * 30;

  if (SEND_CURSORS) {
    timers.push(setInterval(() => {
      if (c.ws.readyState !== WebSocket.OPEN) return;
      x += dx; y += dy;
      if (x < 0 || x > 1200) { dx = -dx; x = Math.max(0, Math.min(1200, x)); }
      if (y < 0 || y > 1440) { dy = -dy; y = Math.max(0, Math.min(1440, y)); }
      // Sample only some sends: the map lookup on every echo is the hot path.
      if (cursorsInFlight.size < 64) cursorsInFlight.set(`${x},${y}`, performance.now());
      c.ws.send(JSON.stringify({ type: "cursor", x, y }));
      c.sent++;
    }, CURSOR_MS));
  }

  if (SEND_PAINTS) {
    timers.push(setInterval(() => {
      if (c.ws.readyState !== WebSocket.OPEN) return;
      const px = Math.floor(rand() * gridW);
      const py = Math.floor(rand() * gridH);
      // Unique colour per send so the round-trip key cannot collide.
      const color = "#" + ((paintsSent * 2654435761) % 0xffffff).toString(16).padStart(6, "0");
      paintsInFlight.set(`${px},${py},${color}`, performance.now());
      c.ws.send(JSON.stringify({ type: "pixel", x: px, y: py, color }));
      c.sent++; paintsSent++;
    }, PAINT_MS + rand() * PAINT_MS));
  }
}

const t0 = performance.now();
const recv0 = clients.reduce((a, c) => a + c.recv, 0);
let peakRate = 0, lastRecv = recv0, lastT = t0;
const sampler = setInterval(() => {
  const now = performance.now();
  const total = clients.reduce((a, c) => a + c.recv, 0);
  const rate = ((total - lastRecv) / (now - lastT)) * 1000;
  peakRate = Math.max(peakRate, rate);
  lastRecv = total; lastT = now;
  const lat = SEND_PAINTS ? paintLatency : cursorLatency;
  process.stdout.write(
    `\r  ${live()} live | ${Math.round(rate).toLocaleString()} msg/s in | ` +
      `${SEND_PAINTS ? "paint" : "cursor"} p50 ${ms(pct(lat, 50))} p99 ${ms(pct(lat, 99))}   `,
  );
}, 1000);

await Bun.sleep(SECONDS * 1000);
clearInterval(sampler);
for (const t of timers) clearInterval(t);
process.stdout.write("\n");

const elapsed = (performance.now() - t0) / 1000;
const totalRecv = clients.reduce((a, c) => a + c.recv, 0) - recv0;
const totalSent = clients.reduce((a, c) => a + c.sent, 0);
const dropped = clients.filter((c) => c.closed).length;

console.log(bold("\n--- results ---"));
console.log(`target           ${URL_}`);
console.log(`clients          ${live()} live, ${dropped} dropped, ${errors} errors`);
console.log(`connect latency  p50 ${ms(pct(connectLatency, 50))}  p99 ${ms(pct(connectLatency, 99))}  max ${ms(Math.max(...connectLatency))}`);
console.log(`init snapshot    ${initPixels} pixels, ${(initBytes / 1024).toFixed(1)} KB per joining client`);
console.log(`server grid      ${gridW || "?"}x${gridH || "?"}  ${dim(`[${gridSource}]`)}`);
console.log(`sent             ${totalSent.toLocaleString()} msgs (${Math.round(totalSent / elapsed).toLocaleString()}/s)`);
console.log(`received         ${totalRecv.toLocaleString()} msgs (${Math.round(totalRecv / elapsed).toLocaleString()}/s avg, ${Math.round(peakRate).toLocaleString()}/s peak)`);
console.log(`fan-out ratio    ${(totalRecv / Math.max(1, totalSent)).toFixed(1)}x  ${dim(`(healthy is ~${CLIENTS - 1}x; lower means the server is shedding)`)}`);
if (cursorLatency.length) {
  console.log(`cursor rtt       p50 ${ms(pct(cursorLatency, 50))}  p95 ${ms(pct(cursorLatency, 95))}  p99 ${ms(pct(cursorLatency, 99))}  ${dim(`(${cursorLatency.length} samples)`)}`);
}
if (paintLatency.length || SEND_PAINTS) {
  console.log(`paint rtt        p50 ${ms(pct(paintLatency, 50))}  p95 ${ms(pct(paintLatency, 95))}  p99 ${ms(pct(paintLatency, 99))}  ${dim(`(${paintLatency.length} samples, ${paintsInFlight.size} never echoed)`)}`);
}
if (dropped) {
  const sample = clients.find((c) => c.closed)!.closed!;
  console.log(`first close      code ${sample.code} ${sample.reason || "(no reason)"}`);
}
console.log("");

for (const c of clients) { try { c.ws.close(); } catch {} }
await Bun.sleep(REMOTE ? 800 : 300);
process.exit(0);
