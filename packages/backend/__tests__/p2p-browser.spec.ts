/**
 * PRD-100 AC-4 and AC-5: two real Chromium pages in one room, over real WebRTC, on one origin
 * served by `workerd` (through Miniflare) running `handleBackend` + `BackendRoom` over a real D1.
 *
 * The page imports the package's own client modules, transpiled file by file and served as ES
 * modules: the spec drives the code a game gets, not whatever `dist` last held. That matters here
 * because a bundler artifact would prove a build, and the browser API surface (`transport`,
 * `deliveries`, `rtc`) is exactly what this spec is about.
 *
 * Both arms count deliveries over the data channel rather than trusting timing: AC-4 requires the
 * messages to have travelled on the channel, AC-5 requires that none did.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, type Page, chromium } from "@playwright/test";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transpiledModules, workerModules } from "./worker.js";

const GAME = "project-1";
/** The 50 messages each way AC-4 and AC-5 promise, sent in two paced batches. */
const MESSAGES = 50;
/** `iceServers: []` plus `iceTransportPolicy: "relay"` has no TURN to relay through, so ICE fails. */
const FORCED_FAILURE = {
  iceServers: [],
  iceTransportPolicy: "relay",
  connectTimeoutMs: 3_000,
} as const;

/** What the page exposes to the spec; `driver.js` below defines it. */
interface ITestDriver {
  create(rtc: unknown): Promise<string>;
  join(code: string, rtc: unknown): Promise<string>;
  self(): string;
  peer(): string | null;
  transport(peerId: string): string;
  deliveries(peerId: string): { readonly p2p: number; readonly relay: number };
  received(): { readonly i: number }[];
  send(count: number): Promise<void>;
}

declare global {
  interface Window {
    readonly tn: ITestDriver;
  }
}

/** The one page both players load: a module driver, so relative imports resolve from the origin. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>tn room</title>
<script type="module" src="/page/driver.js"></script>`;

/**
 * The driver has to live in a module for `import` to resolve against the served origin, and it has
 * to keep every value the spec asserts on inside the page: a room handle cannot cross the boundary.
 */
const DRIVER = `
import { createBackend } from "/page/client.js";

const received = [];
const state = { room: null };

function open(rtc) {
  return createBackend(rtc === null ? { storage: null } : { storage: null, rtc });
}

function watch(room) {
  room.on("message", (data) => received.push(data));
  state.room = room;
}

window.tn = {
  async create(rtc) {
    const room = await open(rtc).rooms.create({ max: 2 });
    watch(room);
    return room.code;
  },
  async join(code, rtc) {
    const room = await open(rtc).rooms.join(code);
    watch(room);
    return room.peerId;
  },
  self: () => state.room.peerId,
  peer: () => state.room.peers[0] ?? null,
  transport: (peerId) => state.room.transport(peerId),
  deliveries: (peerId) => state.room.deliveries(peerId),
  received: () => received.slice(),
  async send(count) {
    for (let index = 0; index < count; index += 1) {
      state.room.send({ i: index });
      // The relay's budget is 30 frames a second per socket; two frames a beat stays well under.
      if (index % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
  },
};
`;

type MiniflareD1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;

let miniflare: Miniflare;
let db: MiniflareD1;
/** The origin Miniflare serves the room, the handler and the page on: one origin, as a share host is. */
let base: string;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  // `src/client.js` and everything it imports, served as modules: the browser half of the package.
  const client = await transpiledModules(["src/client.js"]);
  const pageModules = Object.fromEntries(
    Object.entries(client).map(([name, contents]) => [path.posix.basename(name), contents]),
  );
  pageModules["driver.js"] = DRIVER;
  const entry = `
import { handleBackend } from "./src/cloudflare.js";
import { BackendRoom } from "./src/room-do.js";
export { BackendRoom };

const PAGE = ${JSON.stringify(PAGE)};
const PAGE_MODULES = ${JSON.stringify(pageModules)};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname.startsWith("/page/")) {
      const source = PAGE_MODULES[pathname.slice("/page/".length)];
      if (source === undefined) return new Response("not found", { status: 404 });
      return new Response(source, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    return handleBackend(request, {
      db: env.BACKEND_DB,
      gameId: "project-1",
      playerId: "player-1",
      rooms: env.ROOMS,
      maxPlayers: 4,
    });
  },
};
`;
  miniflare = new Miniflare({
    port: 0,
    workers: [
      {
        config: {
          name: "backend",
          compatibilityDate: "2026-11-01",
          manifest: { mainModule: "worker.js", modules: await workerModules(entry) },
          env: {
            BACKEND_DB: { type: "d1", id: "backend" },
            ROOMS: { type: "durable-object", worker: "backend", exportName: "BackendRoom" },
          },
          exports: { BackendRoom: { type: "durable-object", storage: "sqlite" } },
        },
      },
    ],
  });
  base = (await miniflare.ready).origin;
  db = await miniflare.getD1Database("BACKEND_DB", "backend");
  for (const name of ["0001_backend.sql", "0002_rooms.sql"]) await applyMigration(name);

  // Headless Chromium serves WebRTC from host candidates on this machine, and both players are
  // pages of the same browser on the same origin, which is the worst case for a local pair.
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await miniflare?.dispose();
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM kv"),
    db.prepare("DELETE FROM docs"),
    db.prepare("DELETE FROM rooms"),
  ]);
  page = await browser.newPage();
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.tn !== undefined);
});

afterEach(async () => {
  await page?.close();
});

/** `wrangler d1 migrations apply` runs a whole file; here each statement runs on its own. */
async function applyMigration(name: string): Promise<void> {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  for (const statement of sql.replace(/^--.*$/gmu, "").split(";")) {
    if (statement.trim().length > 0) await db.prepare(statement.trim()).run();
  }
}

/** A second player: its own page on the same origin, and its own room socket. */
async function secondPage(): Promise<Page> {
  const other = await browser.newPage();
  await other.goto(`${base}/`);
  await other.waitForFunction(() => window.tn !== undefined);
  return other;
}

/** Opens `count` pages into one room and answers both handles plus their peer ids. */
async function pair(rtc: unknown): Promise<{
  readonly host: Page;
  readonly guest: Page;
  readonly hostPeer: string;
  readonly guestPeer: string;
}> {
  const guest = await secondPage();
  const code = await page.evaluate((options) => window.tn.create(options), rtc);
  const guestPeer = await guest.evaluate(
    ([roomCode, options]) => window.tn.join(roomCode as string, options),
    [code, rtc] as const,
  );
  await page.waitForFunction(() => window.tn.peer() !== null);
  const hostPeer = await page.evaluate(() => window.tn.self());
  return { guest, host: page, guestPeer, hostPeer };
}

/** Both pages send `MESSAGES` and both must receive them in send order. */
async function exchange(host: Page, guest: Page): Promise<void> {
  await Promise.all([
    host.evaluate((count) => window.tn.send(count), MESSAGES),
    guest.evaluate((count) => window.tn.send(count), MESSAGES),
  ]);
  const expected = Array.from({ length: MESSAGES }, (_, index) => index);
  for (const side of [host, guest]) {
    await side.waitForFunction((count) => window.tn.received().length === count, MESSAGES, {
      timeout: 30_000,
    });
    const order = await side.evaluate(() => window.tn.received().map((entry) => entry.i));
    expect(order).toEqual(expected);
  }
}

describe("two browsers in one room (AC-4)", () => {
  it("reaches peer to peer and carries every message over the data channel", async () => {
    const { host, guest, hostPeer, guestPeer } = await pair(null);

    await Promise.all([
      host.waitForFunction((peer) => window.tn.transport(peer) === "p2p", guestPeer, {
        timeout: 30_000,
      }),
      guest.waitForFunction((peer) => window.tn.transport(peer) === "p2p", hostPeer, {
        timeout: 30_000,
      }),
    ]);
    expect(await host.evaluate((peer) => window.tn.transport(peer), guestPeer)).toBe("p2p");
    expect(await guest.evaluate((peer) => window.tn.transport(peer), hostPeer)).toBe("p2p");

    await exchange(host, guest);

    // The messages went over the channel, not the relay: a counter, not a stopwatch.
    expect(await host.evaluate((peer) => window.tn.deliveries(peer), guestPeer)).toEqual({
      p2p: MESSAGES,
      relay: 0,
    });
    expect(await guest.evaluate((peer) => window.tn.deliveries(peer), hostPeer)).toEqual({
      p2p: MESSAGES,
      relay: 0,
    });
  }, 120_000);
});

describe("a WebRTC that cannot connect (AC-5)", () => {
  it("stays on the relay, in order, when no candidate can be gathered", async () => {
    const { host, guest, hostPeer, guestPeer } = await pair(FORCED_FAILURE);

    // Past the connect timeout: ICE had no TURN server to relay through, so the pair is closed.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(await host.evaluate((peer) => window.tn.transport(peer), guestPeer)).toBe("relay");
    expect(await guest.evaluate((peer) => window.tn.transport(peer), hostPeer)).toBe("relay");

    await exchange(host, guest);

    for (const [side, peer] of [
      [host, guestPeer],
      [guest, hostPeer],
    ] as const) {
      const deliveries = await side.evaluate((id) => window.tn.deliveries(id), peer);
      expect(deliveries.p2p).toBe(0);
      expect(deliveries.relay).toBe(MESSAGES);
    }
  }, 120_000);
});
