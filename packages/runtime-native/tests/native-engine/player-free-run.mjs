// A V8 game with no playtest runner attached still advances: the player's fixed-step clock follows
// real time, as the web loop follows requestAnimationFrame, instead of re-rendering one frozen tick,
// and it turns before the game has published a scene.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-free-run.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-free-run-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
// The scene arrives on tick 10, as an async boot publishes it: the loop turns before it exists.
let ticks = 0;
globalThis.tn.onUpdate(() => {
  if (++ticks === 10) { globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); }
  if (ticks === 30) globalThis.tn.log("FREE_RUN_TICKS 30");
});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const reached = await new Promise((done) => {
  const timer = setTimeout(() => done(false), 60_000);
  const read = (chunk) => {
    output += chunk;
    if (output.includes("FREE_RUN_TICKS 30")) { clearTimeout(timer); done(true); }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => { clearTimeout(timer); done(output.includes("FREE_RUN_TICKS 30")); });
});
child.kill();
assert(reached, `the game never reached 30 ticks without a runner:\n${output.slice(-2000)}`);
console.log("PASS the V8 player advances its clock in real time without a runner");
