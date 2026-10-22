// PRD-644 and PRD-652 on the V8 player: the GPU stage times that GIBudget and ShadowFilterBudget read. A render-to-texture
// pass labelled "SSGI" draws for 120 frames. The player must publish, as the Wasm engine does, the frame's GPU time as
// `info.render.timestamp`, the labelled pass's time as `info.engine.gpuStages.SSGI`, and the frame the sample belongs to
// as the last `backend.getTimestampFrames("render")` entry, so core's `stageGpuReading` returns a reading. Timing stays off
// until a reader asks, so the first read of `getTimestampFrames` is what starts it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-gpu-stages.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-gpu-stages-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { AmbientLight, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SphereGeometry } from "three";
import { rtt, screenUV, vec4 } from "three/tsl";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { stageGpuReading } from "@threenative/core";

const scene = new Scene();
const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
camera.position.set(0, 1.5, 4);
camera.lookAt(0, 0.6, 0);
const floor = new Mesh(new PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x808080 }));
const ball = new Mesh(new SphereGeometry(0.8, 48, 24), new MeshStandardMaterial({ color: 0xb03030 }));
ball.position.y = 0.8;
const sun = new DirectionalLight(0xffffff, 3);
sun.position.set(2, 4, 3);
scene.add(floor, ball, sun, new AmbientLight(0xffffff, 0.4));
globalThis.tn.scene = scene;
globalThis.tn.camera = camera;
const renderer = new WebGPURenderer({ canvas: { width: 1280, height: 720 } });

const seen = { before: stageGpuReading(renderer) ?? null };
let frame = 0;
let pipeline;
const step = () => {
  frame += 1;
  renderer.info.frame = frame;
  if (frame === 3) {
    const gather = rtt(vec4(0.2, 0.4, 0.6, 1), 256, 144, { type: 1016, gpuStage: "SSGI" });
    pipeline = new RenderPipeline(renderer, gather.sample(screenUV));
  }
  if (pipeline !== undefined) pipeline.render();
  if (frame === 10) renderer.backend.getTimestampFrames("render");
  if (frame === 120) {
    seen.frames = renderer.backend.getTimestampFrames("render");
    seen.timestamp = renderer.info.render.timestamp;
    seen.stages = renderer.info.engine.gpuStages;
    seen.reading = stageGpuReading(renderer) ?? null;
    seen.enabled = globalThis.tn.renderInfo().gpuTiming.enabled;
    globalThis.tn.log("GPU_STAGES " + JSON.stringify(seen));
    return;
  }
  requestAnimationFrame(step);
};
requestAnimationFrame(step);
`);
await bundleNativeEngine({ entry, outfile, boot: false, host: true });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const verdict = await new Promise((done) => {
  const timer = setTimeout(() => done("timeout"), 90_000);
  const find = () => output.match(/GPU_STAGES (\{[^\n]*\})/u)?.[1];
  const read = (chunk) => {
    output += chunk;
    const found = find();
    if (found) {
      clearTimeout(timer);
      done(found);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done(find() ?? "exited");
  });
});
child.kill();
assert.doesNotMatch(verdict, /^(timeout|exited)$/u, `${verdict}\n${output.slice(-2000)}`);
const seen = JSON.parse(verdict);
// Nothing is timed before the first reader asks.
assert.equal(seen.before, null, verdict);
if (!seen.enabled) {
  console.log("SKIP this device has no timestamp-query: nothing to time");
  process.exit(0);
}
assert.equal(seen.frames.length, 1, verdict);
assert(seen.timestamp > 0, verdict);
assert(seen.stages.SSGI > 0, verdict);
assert(seen.stages.SSGI < seen.timestamp, verdict);
// The sample belongs to a frame the game has already presented, and core reads the same numbers.
assert(seen.frames[0] > 0 && seen.frames[0] <= 120, verdict);
assert.equal(seen.reading?.frame, seen.frames[0], verdict);
assert.equal(seen.reading?.stages.SSGI, seen.stages.SSGI, verdict);
assert.equal(seen.reading?.total, seen.timestamp, verdict);
console.log(`PASS the V8 player publishes GPU stage times through info.engine.gpuStages: SSGI ${seen.stages.SSGI.toFixed(3)} ms of ${seen.timestamp.toFixed(3)} ms, frame ${seen.frames[0]}`);
