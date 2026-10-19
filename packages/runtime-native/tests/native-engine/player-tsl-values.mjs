// PRD-547 on the V8 player: three's uniform and constant values through the player's TSL (the shared
// tsl-uniforms.ts, as on Wasm). A write replaces a uniform's value and the getter returns it; a Vector3
// written to a vec2 uniform is refused by name; float(2).value and vec3(1, 2, 3).value answer as r185's
// ConstNode does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-tsl-values.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-tsl-values-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { PerspectiveCamera, Scene, Vector2, Vector3 } from "three";
import { float, uniform, vec2, vec3 } from "three/tsl";

globalThis.tn.onUpdate(() => {
  if (globalThis.tn.scene !== undefined) return;
  globalThis.tn.scene = new Scene();
  globalThis.tn.camera = new PerspectiveCamera();
  const faults = [];
  const offset = uniform(new Vector2(1, 2));
  const next = new Vector2(7, 8);
  offset.value = next;
  if (offset.value !== next) faults.push("getter");
  let refused = "";
  try { offset.value = new Vector3(1, 2, 3); } catch (error) { refused = String(error); }
  if (!refused.includes("TN_TSL_UNIFORM_VALUE") || offset.value !== next) faults.push("refusal " + refused);
  const three = vec3(1, 2, 3).value;
  if (float(2).value !== 2 || !(three instanceof Vector3) || three.z !== 3 || vec2(4).value?.y !== 4) faults.push("const");
  globalThis.tn.log(faults.length === 0 ? "TSL_VALUES_OK" : "TSL_VALUES_BAD " + faults.join(", "));
});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const verdict = await new Promise((done) => {
  const timer = setTimeout(() => done("timeout"), 60_000);
  const read = (chunk) => {
    output += chunk;
    const match = output.match(/TSL_VALUES_(OK|BAD[^\n]*|ERROR[^\n]*)/u);
    if (match) {
      clearTimeout(timer);
      done(match[0]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done(output.match(/TSL_VALUES_(OK|BAD[^\n]*|ERROR[^\n]*)/u)?.[0] ?? "exited");
  });
});
child.kill();
assert.equal(verdict, "TSL_VALUES_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS uniform and constant values on the V8 player keep r185's semantics");
