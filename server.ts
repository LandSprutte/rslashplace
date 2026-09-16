import type { ServerWebSocket } from "bun";
import { dirname, join, resolve } from "node:path";

// The canvas is a GRID_W x GRID_H array of cells. Each pixel is addressed by
// index = y * GRID_W + x. Keep these in sync with the client.
const GRID_W = 150;
const GRID_H = 180;
// Snapshots written before the board could be non-square are bare pair lists on
// an implicit 100x100 grid; their indices need remapping rather than replaying.
const LEGACY_GRID_W = 100;
// Hard ceiling on concurrent clients. Cursor relay cost grows with the square of
// this number, so it is the figure the client's cursor rate is tuned against --
// raising it means re-checking that tuning, not just this constant.
const MAX_USERS = 100;

// ---- Deployment config ----
// PORT/HOST are set by systemd on the server; the defaults are for local dev.
// HOST defaults to 0.0.0.0 so Docker/LAN use works out of the box; the systemd
// unit pins it to 127.0.0.1 so only the reverse proxy can reach the app.
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
// Canvas is kept in memory and mirrored to disk so a restart/redeploy does not
// wipe everyone's pixels.
const DATA_FILE = process.env.DATA_FILE ?? "./canvas.json";

// index.html lives next to server.ts when running from source, but a compiled
// binary resolves import.meta.url inside its virtual bundle filesystem, where
// the file does not exist. Try each location and keep the one that works.
async function resolveIndex(): Promise<string> {
  const candidates = [
    new URL("./index.html", import.meta.url).pathname,
    join(dirname(process.execPath), "index.html"),
    resolve("index.html"),
  ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }
  throw new Error(
    `index.html not found. Looked in:\n  ${candidates.join("\n  ")}`,
  );
}
const INDEX_PATH = await resolveIndex();

type Client = { id: string; name: string; x: number | null; y: number | null };

// ---- Funny farting-animal name generator ----
const FART = [
  "Farting", "Tooting", "Windy", "Squeaky", "Gassy", "Blasting", "Rumbling",
  "Whiffy", "Trumpeting", "Sputtering", "Bubbly", "Honking", "Backfiring",
  "Poot-Powered", "Silent-But-Deadly", "Puffy", "Breezy", "Wheezy",
];
const ANIMAL = [
  "Wombat", "Llama", "Hedgehog", "Penguin", "Walrus", "Platypus", "Narwhal",
  "Otter", "Sloth", "Capybara", "Meerkat", "Alpaca", "Pug", "Hippo", "Ferret",
  "Manatee", "Quokka", "Armadillo", "Gecko", "Moose", "Pangolin", "Axolotl",
];
const usedNames = new Set<string>();
function makeName(): string {
  const base =
    FART[Math.floor(Math.random() * FART.length)] +
    " " +
    ANIMAL[Math.floor(Math.random() * ANIMAL.length)];
  let name = base;
  let n = 2;
  while (usedNames.has(name)) name = `${base} ${n++}`;
  usedNames.add(name);
  return name;
}

let nextId = 1;
const clients = new Set<ServerWebSocket<Client>>();

// Current canvas state: pixel index -> color. Late joiners get a full snapshot.
const pixels = new Map<number, string>();

// ---- Disk persistence ----
// Load whatever the last run left behind. A missing or corrupt file just means
// we start from a blank canvas -- never fatal.
try {
  const saved = await Bun.file(DATA_FILE).json();
  // Two on-disk shapes: the legacy bare array, and {w, h, pixels} which records
  // the grid it was written against.
  const sourceWidth = Array.isArray(saved) ? LEGACY_GRID_W : Number(saved?.w);
  const entries = Array.isArray(saved) ? saved : saved?.pixels;
  if (Array.isArray(entries) && Number.isInteger(sourceWidth) && sourceWidth > 0) {
    let dropped = 0;
    for (const [index, color] of entries) {
      // Re-derive the coordinates under the width that wrote them, then re-index
      // for the current one. Anything off the edge of a shrunken board is lost.
      const x = index % sourceWidth;
      const y = Math.floor(index / sourceWidth);
      if (x >= GRID_W || y >= GRID_H) { dropped++; continue; }
      pixels.set(y * GRID_W + x, color);
    }
    const note = sourceWidth === GRID_W ? "" : ` (remapped from a ${sourceWidth}-wide grid)`;
    console.log(`Restored ${pixels.size} pixels from ${DATA_FILE}${note}`);
    if (dropped) console.warn(`Dropped ${dropped} pixels outside the ${GRID_W}x${GRID_H} board`);
  }
} catch {
  // No snapshot yet, or it was unreadable. Start empty.
}

// Writes are bursty (one per brush stroke), so debounce rather than saving on
// every pixel.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
async function save() {
  saveTimer = null;
  try {
    await Bun.write(DATA_FILE, JSON.stringify({ w: GRID_W, h: GRID_H, pixels: [...pixels] }));
  } catch (err) {
    console.error("Failed to save canvas:", err);
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(save, 2000);
}

// Flush on shutdown so a `systemctl restart` keeps the last few seconds.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (saveTimer) clearTimeout(saveTimer);
    await save();
    process.exit(0);
  });
}

function broadcast(message: string, except?: ServerWebSocket<Client>) {
  for (const client of clients) {
    if (client !== except) client.send(message);
  }
}

function broadcastRoster() {
  const users = [...clients].map((c) => ({ id: c.data.id, name: c.data.name }));
  broadcast(JSON.stringify({ type: "roster", users }));
}

const server = Bun.serve<Client, {}>({
  port: PORT,
  hostname: HOST,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const data: Client = { id: String(nextId++), name: makeName(), x: null, y: null };
      if (server.upgrade(req, { data })) return; // handled by the websocket handler
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(INDEX_PATH), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (clients.size >= MAX_USERS) {
        // The name was reserved during the upgrade; hand it back before dropping.
        usedNames.delete(ws.data.name);
        ws.send(JSON.stringify({ type: "full", max: MAX_USERS }));
        ws.close(1013, "room full"); // 1013 = try again later
        return;
      }
      clients.add(ws);
      // Tell the newcomer who they are.
      ws.send(JSON.stringify({ type: "welcome", id: ws.data.id, name: ws.data.name }));
      // Send the full canvas snapshot as a flat [index, color, ...] list.
      const snapshot: (number | string)[] = [];
      for (const [index, color] of pixels) snapshot.push(index, color);
      ws.send(JSON.stringify({ type: "init", gridW: GRID_W, gridH: GRID_H, pixels: snapshot }));
      broadcastRoster();
    },
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }

      if (data.type === "pixel") {
        const { x, y, color } = data;
        if (
          Number.isInteger(x) && Number.isInteger(y) &&
          x >= 0 && x < GRID_W && y >= 0 && y < GRID_H &&
          typeof color === "string"
        ) {
          pixels.set(y * GRID_W + x, color);
          scheduleSave();
          broadcast(text, ws); // relay to everyone else
        }
      } else if (data.type === "cursor") {
        // x/y are canvas coordinates (0..1200 / 0..1440), or null to hide.
        ws.data.x = data.x;
        ws.data.y = data.y;
        broadcast(
          JSON.stringify({
            type: "cursor",
            id: ws.data.id,
            name: ws.data.name,
            x: data.x,
            y: data.y,
          }),
          ws,
        );
      } else if (data.type === "clear") {
        pixels.clear();
        scheduleSave();
        broadcast(text); // relay to everyone, including sender
      }
    },
    close(ws) {
      clients.delete(ws);
      usedNames.delete(ws.data.name);
      broadcast(JSON.stringify({ type: "left", id: ws.data.id }));
      broadcastRoster();
    },
  },
});

console.log(`🎨 Place a pixel at http://${server.hostname}:${server.port}`);
