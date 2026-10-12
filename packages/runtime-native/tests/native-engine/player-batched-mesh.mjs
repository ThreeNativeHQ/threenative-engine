// PRD-552 on the V8 player: an engine BatchedMesh through the facade and the real player (headless
// GPU). Three unit quads on the columns of a 4x1 render target, tinted red, green and blue; the blue
// one is hidden, so columns 2 and 3 keep the clear colour.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-batched-mesh.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-batched-mesh-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { BatchedMesh, Color, Matrix4, OrthographicCamera, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene, UnsignedByteType } from "three";
import { MeshBasicNodeMaterial, WebGPURenderer } from "three/webgpu";

let ticks = 0;
globalThis.tn.onUpdate(() => {
  ticks += 1;
  if (ticks === 1) { globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); }
  if (ticks !== 10) return;
  const renderer = new WebGPURenderer({ canvas: { width: 8, height: 8 } });
  renderer.setClearColor(0x000000, 1);
  const batch = new BatchedMesh(4, 64, 64, new MeshBasicNodeMaterial());
  const quad = batch.addGeometry(new PlaneGeometry(1, 1).toNonIndexed());
  const ids = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(([r, g, b], column) => {
    const id = batch.addInstance(quad);
    batch.setMatrixAt(id, new Matrix4().makeTranslation(column + 0.5, 0.5, 0));
    batch.setColorAt(id, new Color().setRGB(r, g, b));
    return id;
  });
  batch.setVisibleAt(ids[2], false);
  const scene = new Scene();
  scene.add(batch);
  const target = new RenderTarget(4, 1, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera(0, 4, 1, 0, -1, 1));
  renderer.setRenderTarget(null);
  renderer.readRenderTargetPixelsAsync(target, 0, 0, 4, 1)
    .then((pixels) => {
      const got = Array.from(pixels).join(",");
      globalThis.tn.log(got === "255,0,0,255,0,255,0,255,0,0,0,255,0,0,0,255" ? "BATCHED_MESH_OK" : "BATCHED_MESH_BAD " + got);
    })
    .catch((error) => globalThis.tn.log("BATCHED_MESH_ERROR " + error.message));
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
    const match = output.match(/BATCHED_MESH_(OK|BAD[^\n]*|ERROR[^\n]*)/u);
    if (match) {
      clearTimeout(timer);
      done(match[0]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done(output.match(/BATCHED_MESH_(OK|BAD[^\n]*|ERROR[^\n]*)/u)?.[0] ?? "exited");
  });
});
child.kill();
assert.equal(verdict, "BATCHED_MESH_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS a BatchedMesh draws its visible instances on the V8 player");
