import { chromium } from "/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd-743/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5202/";
const profile = process.argv[3] ?? "/tmp/prd743-profile";
const out = process.argv[4] ?? "/tmp/prd743-return-visit.json";

const args = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
];

const isAsset = (u) =>
  /\.(?:glb|ktx2|hdr|jpg|jpeg|png|wav|ogg)(?:\?|$)/u.test(u) &&
  !u.includes("/node_modules/") &&
  !u.includes("/@vite") &&
  !u.includes("/src/") &&
  !u.includes("/shared/astc") &&
  !u.includes("/basis/");

const context = await chromium.launchPersistentContext(profile, {
  args,
  headless: false,
  viewport: { width: 1280, height: 720 },
});
const page = context.pages()[0] ?? (await context.newPage());

let requests = [];
let markers = [];
let markerTimes = new Map();
let consoleErrors = 0;
let errorTexts = [];
page.on("request", (request) => requests.push(request.url()));
page.on("pageerror", (error) => { consoleErrors += 1; errorTexts.push(String(error)); });
page.on("console", (message) => {
  const text = message.text();
  if (message.type() === "error") { consoleErrors += 1; errorTexts.push(text); }
  if (text.startsWith("TN_VALLEY_")) {
    markers.push(text);
    markerTimes.set(text.split(" ")[0], Date.now());
  }
});

async function waitForMarker(prefix, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const found = markers.find((line) => line.startsWith(prefix));
    if (found !== undefined) return found;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${prefix}`);
    await page.waitForTimeout(250);
  }
}

async function quietAssetWindow(ms) {
  let last = -1;
  let quietSince = Date.now();
  const started = Date.now();
  for (;;) {
    const count = requests.filter(isAsset).length;
    if (count !== last) {
      last = count;
      quietSince = Date.now();
    }
    if (Date.now() - quietSince >= ms) return;
    if (Date.now() - started > 180_000) return;
    await page.waitForTimeout(250);
  }
}

async function visit(label) {
  requests = [];
  markers = [];
  markerTimes = new Map();
  consoleErrors = 0;
  errorTexts = [];
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => globalThis.__TN_WORLD_REVEALED__ === true, undefined, {
    timeout: 180_000,
  });
  const cacheLine = await waitForMarker("TN_VALLEY_ASSET_CACHE", 180_000);
  await waitForMarker("TN_VALLEY_DETAIL_DONE", 180_000);
  await quietAssetWindow(4_000);
  const assets = requests.filter(isAsset);
  const prefetchedAt = markerTimes.get("TN_VALLEY_DETAIL_PREFETCHED");
  const doneAt = markerTimes.get("TN_VALLEY_DETAIL_DONE");
  return {
    label,
    cache: JSON.parse(cacheLine.slice("TN_VALLEY_ASSET_CACHE ".length)),
    consoleErrors,
    errorTexts,
    fillMs: prefetchedAt !== undefined && doneAt !== undefined ? doneAt - prefetchedAt : undefined,
    markers: [...markers],
    assetRequests: assets,
    allRequests: requests.length,
  };
}

const first = await visit("first");
const second = await visit("second");

writeFileSync(out, JSON.stringify({ first, second }, null, 2));
console.log(JSON.stringify({
  first: { assetRequests: first.assetRequests.length, cache: first.cache },
  second: { assetRequests: second.assetRequests.length, cache: second.cache, urls: second.assetRequests },
}, null, 2));

await context.close();
