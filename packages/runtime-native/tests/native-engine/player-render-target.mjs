// PRD-551 on the V8 player: three's render targets through the facade and the real player (headless
// GPU). A QuadMesh draws a flat colour into a HalfFloat and an UnsignedByte RenderTarget, and
// readRenderTargetPixelsAsync returns them typed as three types them: the half bits as a Uint16Array,
// bytes as a Uint8Array, and a FloatType target keeps float32 (1 + 2^-12 is not a half float). The pinned three's DataUtils is the oracle for the half bits.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-render-target.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-render-target-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const three = createRequire(resolve(native, "package.json"))("three");
const halves = [0.25, 0.5, 0.75, 1].map((value) => three.DataUtils.toHalfFloat(value));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { FloatType, HalfFloatType, PerspectiveCamera, RenderTarget, Scene, UnsignedByteType } from "three";
import { vec4 } from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";

const expectedHalves = ${JSON.stringify(halves)};
let ticks = 0;
globalThis.tn.onUpdate(() => {
  ticks += 1;
  if (ticks === 1) { globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); }
  if (ticks !== 10) return;
  const renderer = new WebGPURenderer({ canvas: { width: 8, height: 8 } });
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(0.25, 0.5, 0.75, 1);
  const fine = new MeshBasicNodeMaterial();
  fine.colorNode = vec4(1 + 2 ** -12, 0.5, 0.75, 1);
  const fineQuad = new QuadMesh(fine);
  const float = new RenderTarget(4, 4, { type: FloatType });
  const quad = new QuadMesh(material);
  const half = new RenderTarget(4, 4, { type: HalfFloatType });
  const bytes = new RenderTarget(4, 4, { type: UnsignedByteType });
  for (const target of [half, bytes]) {
    renderer.setRenderTarget(target);
    quad.render(renderer);
  }
  renderer.setRenderTarget(float);
  fineQuad.render(renderer);
  renderer.setRenderTarget(null);
  if (renderer.getRenderTarget() !== null) throw new Error("getRenderTarget after setRenderTarget(null)");
  Promise.all([renderer.readRenderTargetPixelsAsync(half, 1, 1, 2, 2), renderer.readRenderTargetPixelsAsync(bytes, 0, 0, 1, 1), renderer.readRenderTargetPixelsAsync(float, 1, 1, 2, 2)])
    .then(([h, b, f]) => {
      const halfOk = h instanceof Uint16Array && h.length === 16 && expectedHalves.every((bits, i) => h[i] === bits);
      const bytesOk = b instanceof Uint8Array && [64, 128, 191, 255].every((value, i) => b[i] === value);
      const floatOk = f instanceof Float32Array && f.length === 16 && f[0] === 1 + 2 ** -12 && f[1] === 0.5 && f[2] === 0.75;
      globalThis.tn.log(halfOk && bytesOk && floatOk ? "RENDER_TARGET_OK" : "RENDER_TARGET_BAD " + Array.from(h.slice(0, 4)) + " / " + Array.from(b) + " / " + Array.from(f.slice(0, 4)));
    })
    .catch((error) => globalThis.tn.log("RENDER_TARGET_ERROR " + error.message));
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
    const match = output.match(/RENDER_TARGET_(OK|BAD[^\n]*|ERROR[^\n]*)/u);
    if (match) {
      clearTimeout(timer);
      done(match[0]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done(output.match(/RENDER_TARGET_(OK|BAD[^\n]*|ERROR[^\n]*)/u)?.[0] ?? "exited");
  });
});
child.kill();
assert.equal(verdict, "RENDER_TARGET_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS QuadMesh draws into HalfFloat and UnsignedByte render targets, read back typed as three types them");
