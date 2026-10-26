// Reveal time on a first and a second visit in one browser profile, at 20 Mbit/s and 40 ms, the
// same CDP throttle the playtest `network` field applies. Runs on either arm: the reveal signal is
// the game's own `__TN_WORLD_REVEALED__`, and the page clock at that moment is the reveal time.
// usage: node prd743-return-reveal.mjs <url> <fresh profile dir> <out.json>
import { chromium } from "/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd-743/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";

const [url, profile, out] = process.argv.slice(2);
if (!url || !profile || !out) throw new Error("usage: <url> <profile dir> <out.json>");
const bytesPerSecond = (20_000 * 1000) / 8;

const context = await chromium.launchPersistentContext(profile, {
  args: [
    "--ozone-platform=x11",
    "--enable-unsafe-webgpu",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
  ],
  headless: false,
  viewport: { width: 1280, height: 720 },
});
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", {
  connectionType: "cellular3g",
  downloadThroughput: bytesPerSecond,
  latency: 40,
  offline: false,
  uploadThroughput: bytesPerSecond,
});

let reveal = "";
let errors = [];
page.on("console", (message) => {
  const text = message.text();
  if (text.startsWith("TN_VALLEY_REVEAL")) reveal = text;
  if (message.type() === "error") errors.push(text);
});
page.on("pageerror", (error) => errors.push(String(error)));

async function visit(label) {
  reveal = "";
  errors = [];
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => globalThis.__TN_WORLD_REVEALED__ === true, undefined, {
    polling: 50,
    timeout: 240_000,
  });
  const revealMs = await page.evaluate(() => performance.now());
  const adapter = await page.evaluate(async () => {
    const gpu = navigator.gpu;
    const info = gpu ? (await gpu.requestAdapter())?.info : undefined;
    return info ? `${info.vendor} ${info.architecture}` : "none";
  });
  return { adapter, errors: [...errors], label, reveal, revealMs };
}

const first = await visit("first");
const second = await visit("second");
writeFileSync(out, `${JSON.stringify({ first, second, url }, null, 2)}\n`);
console.log(JSON.stringify({ first, second }));
await context.close();
