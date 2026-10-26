// First visit at 20 Mbit/s / 40 ms: per-second received bytes split by kind, plus marker times.
// usage: node waterfall.mjs <url> <fresh profile dir> <out.json>
import { chromium } from "/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd-743/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";

const [url, profile, out] = process.argv.slice(2);
const bytesPerSecond = (20_000 * 1000) / 8;
const context = await chromium.launchPersistentContext(profile, {
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--disable-gpu-sandbox", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
  headless: false,
  viewport: { width: 1280, height: 720 },
});
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", {
  connectionType: "cellular3g", downloadThroughput: bytesPerSecond, latency: 40, offline: false, uploadThroughput: bytesPerSecond,
});
const kind = (u) =>
  /\.(glb|ktx2|hdr|jpg|jpeg|png|ogg|wav)(\?|$)/u.test(u) && !u.includes("/node_modules/") && !u.includes("/src/") ? "asset"
  : /\.wasm(\?|$)/u.test(u) ? "wasm" : "code";
const reqs = new Map();
let t0;
cdp.on("Network.requestWillBeSent", (e) => {
  t0 ??= e.timestamp;
  reqs.set(e.requestId, { url: e.request.url, kind: kind(e.request.url), start: e.timestamp - t0, chunks: [] });
});
cdp.on("Network.dataReceived", (e) => {
  const r = reqs.get(e.requestId);
  if (r) r.chunks.push([e.timestamp - t0, e.encodedDataLength || e.dataLength]);
});
cdp.on("Network.loadingFinished", (e) => {
  const r = reqs.get(e.requestId);
  if (r) { r.end = e.timestamp - t0; r.bytes = e.encodedDataLength; }
});
const markers = [];
const navStart = Date.now();
page.on("console", (m) => {
  const text = m.text();
  if (/^TN_(VALLEY|LOAD_ALL|FRAME_HITCH|STARTUP_WARMUP|AUDIO)/u.test(text)) markers.push([(Date.now() - navStart) / 1000, text.slice(0, 120)]);
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
await page.waitForFunction(() => globalThis.__TN_WORLD_REVEALED__ === true, undefined, { polling: 50, timeout: 300_000 });
const timing = await page.evaluate(() => ({ revealMs: performance.now(), startup: globalThis.__TN_PLAYTEST__?.observations?.startup ?? null }));
const bins = {};
for (const r of reqs.values()) for (const [t, b] of r.chunks) {
  const s = Math.floor(t);
  bins[s] ??= { asset: 0, code: 0, wasm: 0 };
  bins[s][r.kind] += b;
}
const totals = { asset: 0, code: 0, wasm: 0 }, counts = { asset: 0, code: 0, wasm: 0 };
for (const r of reqs.values()) { totals[r.kind] += r.bytes ?? 0; counts[r.kind] += 1; }
const firstAsset = Math.min(...[...reqs.values()].filter((r) => r.kind === "asset").map((r) => r.start));
const lastCode = Math.max(...[...reqs.values()].filter((r) => r.kind !== "asset").map((r) => r.end ?? 0));
writeFileSync(out, `${JSON.stringify({ url, timing, totals, counts, firstAsset, lastCode, markers, bins }, null, 1)}\n`);
console.log(JSON.stringify({ revealMs: timing.revealMs, totals, counts, firstAsset, lastCode }));
await context.close();
