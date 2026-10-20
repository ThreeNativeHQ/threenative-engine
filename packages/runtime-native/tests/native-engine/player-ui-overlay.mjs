// A game's web HUD is drawn and takes input on the V8 player's window (PRD-554), proven by the frame a
// player sees: the presented frame read back through the playtest runner, the page composited over it.
// The page paints a green block and publishes a button's hit region. The first shot must hold the
// block, a pointer press on the button must reach the page (it turns the block blue and posts an
// intent the game logs), and the second shot must hold the blue block. A player built without the
// overlay (TN_ENGINE_PLAYER_UI_OVERLAY off) logs TN_UI_LOAD_FAILED and its frame stays black: red.
// Runs on the runner's own Xvfb (COMPOSITE and SHAPE), like the render goldens:
//   node packages/runtime-native/tests/native-engine/player-ui-overlay.mjs <tn-native-engine-player-v8>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(native, "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-ui-overlay.mjs <tn-native-engine-player-v8>");
const { PNG } = createRequire(resolve(repo, "packages/assets/package.json"))("pngjs");
const work = await mkdtemp(resolve(native, "build/player-ui-overlay-"));
process.once("exit", (code) => {
  if (code === 0 && !process.env.TN_UI_SNAPSHOT_TRACE) rmSync(work, { recursive: true, force: true });
  else console.error(`UI diagnostic artifacts retained: ${work}`);
});

// A gradient strip along the bottom keeps the capture clear of the runner's blank-frame check.
// The block: x 10..30 %, y 10..30 % of the window. The button: x 40..60 %, y 70..90 %.
const BLOCK = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
const BUTTON = { x: 0.4, y: 0.7, width: 0.2, height: 0.2 };
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
globalThis.tn.onUpdate(() => {});
globalThis.__tnUiGameReceive = (frame) => globalThis.tn.log("UI_RECEIVED " + frame);
`);
await bundleNativeEngine({ entry, outfile, boot: false });
mkdirSync(resolve(work, "ui"));
const percent = (rect) => `left:${rect.x * 100}%;top:${rect.y * 100}%;width:${rect.width * 100}%;height:${rect.height * 100}%`;
await writeFile(resolve(work, "ui/index.html"), `<!doctype html><html><body style="margin:0;background:transparent">
<div id="block" style="position:fixed;${percent(BLOCK)};background:#00ff00"></div>
<div style="position:fixed;left:0;top:92%;width:100%;height:8%;background:linear-gradient(90deg,#ff0000,#ffff00,#0000ff)"></div>
<button id="button" style="position:fixed;${percent(BUTTON)};border:0;background:#ff00ff"></button>
<script>
  const send = (frame) => window.webkit.messageHandlers.tnHost.postMessage(JSON.stringify(frame));
  document.getElementById("button").addEventListener("click", () => {
    document.getElementById("block").style.background = "#0000ff";
    send({ type: "tn:intent", name: "hud-click" });
  });
  setTimeout(() => send({ type: "tn:hit-regions", regions: [${JSON.stringify(BUTTON)}] }), 200);
</script></body></html>`);

const scenario = resolve(work, "ui.playtest.json");
const centre = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, buttons: 1 });
await writeFile(scenario, JSON.stringify({
  schemaVersion: 1, name: "player-ui-overlay", target: "desktop", warmupFrames: 8,
  steps: [
    { label: "hud-drawn", waitTicks: 180, release: true, screenshot: "before" },
    { label: "press", pointerPosition: centre(BUTTON), release: true, waitTicks: 30 },
    { label: "hud-clicked", waitTicks: 180, release: true, screenshot: "after" },
  ],
}));
const artifacts = resolve(work, "artifacts");
const run = spawnSync(process.execPath, [resolve(repo, "packages/playtest/dist/runner/cli.js"), scenario,
  "--target", "desktop", "--executable", resolve(executable), "--host-arg", outfile, "--artifacts", artifacts],
{ encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, SDL_AUDIO_DRIVER: "dummy" } });
writeFileSync(resolve(work, "runner.stdout.json"), run.stdout);
writeFileSync(resolve(work, "runner.stderr.log"), run.stderr);
let report = {};
try { report = JSON.parse(run.stdout); } catch { /* reported below */ }
const logged = (report.observations?.console ?? []).map((entry) => entry.text).join("\n");
const why = `runner exit ${run.status}; diagnostics ${JSON.stringify(report.diagnostics ?? run.stderr.slice(-800))}\n${logged.slice(-1200)}`;
assert.doesNotMatch(logged, /TN_UI_LOAD_FAILED/u, `the overlay could not attach: ${why}`);
assert.match(logged, /TN_UI_OVERLAY:\{"attached":true\}/u, `the overlay never reported attached: ${why}`);

// The share of a rectangle's pixels within 40 of `colour` on every channel.
const share = (png, rect, colour) => {
  let hits = 0;
  let total = 0;
  for (let y = Math.floor((rect.y + 0.02) * png.height); y < (rect.y + rect.height - 0.02) * png.height; y++) {
    for (let x = Math.floor((rect.x + 0.02) * png.width); x < (rect.x + rect.width - 0.02) * png.width; x++) {
      const at = (y * png.width + x) * 4;
      total++;
      if (colour.every((value, channel) => Math.abs(png.data[at + channel] - value) <= 40)) hits++;
    }
  }
  return hits / total;
};
const shot = (name) => {
  const file = join(artifacts, `${name}.png`);
  assert(existsSync(file), `no ${name} frame was captured (${existsSync(artifacts) ? readdirSync(artifacts) : "no artifacts"}): ${why}`);
  return PNG.sync.read(readFileSync(file));
};
const before = shot("before");
const after = shot("after");
assert(share(before, BLOCK, [0, 255, 0]) > 0.95, `the HUD block is not in the presented frame (green share ${share(before, BLOCK, [0, 255, 0])})`);
assert(share(before, BUTTON, [255, 0, 255]) > 0.95, "the HUD button is not in the presented frame");
assert(share(before, { x: 0.7, y: 0.1, width: 0.2, height: 0.2 }, [0, 0, 0]) > 0.95, "the frame outside the HUD is not the game's");
assert.match(logged, /UI_RECEIVED [^\n]*"name":"hud-click"/u, `the press never reached the page's button: ${why}`);
assert(share(after, BLOCK, [0, 0, 255]) > 0.95, `the page's reaction to the press is not in the presented frame (blue share ${share(after, BLOCK, [0, 0, 255])})`);
console.log("PASS the web HUD is drawn over the V8 player's frame and takes a press");
