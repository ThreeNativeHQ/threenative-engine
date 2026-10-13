// A packaged game names its window: TN_PLAYER_TITLE reaches SDL_CreateWindow and the player reports the
// title and size it opened (Midway's `window.title` and 1280x720 from threenative.config.ts). Unset, the
// title stays the engine's own. Runs on a virtual X display: the window is real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-window-title.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-window-title-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
globalThis.tn.onUpdate(() => {});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const open = (env) => {
  const run = spawnSync("sh", [resolve(native, "scripts/xvfb.sh"), "timeout", "-s", "TERM", "6", resolve(executable), outfile], {
    encoding: "utf8",
    env: { ...process.env, TN_PLAYER_WIDTH: "800", TN_PLAYER_HEIGHT: "450", ...env },
  });
  return `${run.stdout}${run.stderr}`;
};
assert.match(open({ TN_PLAYER_TITLE: "MIDWAY — Open Pacific" }), /TN_PLAYER_WINDOW: title 'MIDWAY — Open Pacific', 800x450/u);
assert.match(open({ TN_PLAYER_TITLE: "" }), /TN_PLAYER_WINDOW: title 'ThreeNative native engine', 800x450/u);
console.log("PASS the player opens its window with the game's title and size");
