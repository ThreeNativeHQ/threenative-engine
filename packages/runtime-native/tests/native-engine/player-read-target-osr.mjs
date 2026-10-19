// A render-target read settles from the GPU event drain, outside every frame callback. The promise
// continuation runs JavaScript there, so the player must have the isolate entered: a hot loop in the
// continuation reaches on-stack replacement, which asks V8 for the current isolate and crashed on a
// null one (the engine load test's structure check, after its first probe read).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-read-target-osr.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-read-target-osr-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { PerspectiveCamera, RenderTarget, Scene, UnsignedByteType } from "three";
import { vec4 } from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";

let ticks = 0;
globalThis.tn.onUpdate(() => {
  ticks += 1;
  if (ticks === 1) { globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); }
  if (ticks !== 10) return;
  const renderer = new WebGPURenderer({ canvas: { width: 8, height: 8 } });
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(0.25, 0.5, 0.75, 1);
  const quad = new QuadMesh(material);
  const target = new RenderTarget(4, 4, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  quad.render(renderer);
  renderer.setRenderTarget(null);
  renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1).then(() => {
    let sum = 0;
    for (let i = 0; i < 3e8; i += 1) sum += i % 7;
    globalThis.tn.log("READ_OSR_OK " + sum);
  }).catch((error) => globalThis.tn.log("READ_OSR_ERROR " + error.message));
});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const verdict = await new Promise((done) => {
  const timer = setTimeout(() => done("timeout"), 90_000);
  const read = (chunk) => {
    output += chunk;
    const match = output.match(/READ_OSR_(OK|ERROR)[^\n]*/u);
    if (match) {
      clearTimeout(timer);
      done(match[0]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    done(output.match(/READ_OSR_(OK|ERROR)[^\n]*/u)?.[0] ?? `exited ${code ?? signal}`);
  });
});
child.kill();
assert(verdict.startsWith("READ_OSR_OK"), `${verdict}\n${output.slice(-2000)}`);
console.log("PASS a hot loop in a render-target read continuation runs with the isolate entered");
