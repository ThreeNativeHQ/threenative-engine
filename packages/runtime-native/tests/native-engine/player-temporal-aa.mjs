// PRD-636 on the V8 player: temporal anti-aliasing through the facade and the real player (headless GPU). A lit sphere
// on a floor draws for 20 frames with no post graph, and then through pass() -> traa(). The player must report what
// the frame did: no temporal pass and 4x multisampling before the graph, then an active pass with history, a moving
// sub-pixel jitter and 1 sample (the pass replaces multisampling) after it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-temporal-aa.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-temporal-aa-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { AmbientLight, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SphereGeometry } from "three";
import { convertToTexture, pass } from "three/tsl";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { traa } from "three/addons/tsl/display/TRAANode.js";

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
const renderer = new WebGPURenderer({ canvas: { width: 1280, height: 720 }, antialias: true });

const read = () => ({ samples: renderer.info.engine.samples, temporal: renderer.info.engine.temporal });
const seen = {};
let frame = 0;
let pipeline;
const step = () => {
  frame += 1;
  if (frame === 20) seen.plain = read();
  if (frame === 21) {
    const scenePass = pass(scene, camera);
    pipeline = new RenderPipeline(renderer, traa(convertToTexture(scenePass.getTextureNode()), scenePass.getTextureNode("depth"), scenePass.getTextureNode("velocity"), camera));
  }
  if (pipeline !== undefined) pipeline.render();
  else renderer.render(scene, camera);
  if (frame === 140) {
    seen.temporal = read();
    globalThis.tn.log("TEMPORAL_AA " + JSON.stringify(seen));
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
  const find = () => output.match(/TEMPORAL_AA (\{[^\n]*\})/u)?.[1];
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
const { plain, temporal } = JSON.parse(verdict);
// Before the graph: the plain frame, with the scene multisampled and no temporal pass to report.
assert.equal(plain.temporal.active, false, verdict);
assert.equal(plain.samples, 4, verdict);
// Through traa(): the pass is live, has history, jitters, and replaced the multisampling.
assert.equal(temporal.temporal.active, true, verdict);
assert.equal(temporal.temporal.historyValid, true, verdict);
assert(temporal.temporal.frame >= 60, verdict);
assert(temporal.temporal.jitter.some((offset) => offset !== 0), verdict);
assert.equal(temporal.samples, 1, verdict);
assert.doesNotMatch(output, /TN_TRAA_[A-Z_]*UNSUPPORTED/u, output.slice(-2000));
console.log("PASS temporal anti-aliasing runs live on the V8 player and replaces multisampling");
