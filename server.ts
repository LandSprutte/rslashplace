import type { ServerWebSocket } from "bun";
import { dirname, join, resolve } from "node:path";

// The canvas is a GRID x GRID array of cells. Each pixel is addressed by
// index = y * GRID + x. Keep this in sync with the client.
const GRID = 100;

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
  if (Array.isArray(saved)) {
    for (const [index, color] of saved) pixels.set(index, color);
    console.log(`Restored ${pixels.size} pixels from ${DATA_FILE}`);
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
    await Bun.write(DATA_FILE, JSON.stringify([...pixels]));
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
      clients.add(ws);
      // Tell the newcomer who they are.
      ws.send(JSON.stringify({ type: "welcome", id: ws.data.id, name: ws.data.name }));
      // Send the full canvas snapshot as a flat [index, color, ...] list.
      const snapshot: (number | string)[] = [];
      for (const [index, color] of pixels) snapshot.push(index, color);
      ws.send(JSON.stringify({ type: "init", grid: GRID, pixels: snapshot }));
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
          x >= 0 && x < GRID && y >= 0 && y < GRID &&
          typeof color === "string"
        ) {
          pixels.set(y * GRID + x, color);
          scheduleSave();
          broadcast(text, ws); // relay to everyone else
        }
      } else if (data.type === "cursor") {
        // x/y are canvas coordinates (0..800), or null to hide.
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
