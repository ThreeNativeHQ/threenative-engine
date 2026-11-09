// A synchronous render-target draw waits for the render thread only, not for the GPU thread's present of the
// previous frame (PRD-854). A probe bake or a cube capture draws into targets from the game's update; on a slow
// present (Xvfb copies each frame, about 30 ms) each such draw used to cost that present. Runs on a virtual X
// display, so the window and its present are real, at 1920x1080 so the present stays slow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-target-draw-present.mjs <tn-native-engine-player-v8>");
delete process.env.DISPLAY;
const work = await mkdtemp(resolve(native, "build/player-target-draw-present-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene } from "three";
import { WebGPURenderer } from "three/webgpu";

const scene = new Scene();
scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: 0xff8000 })));
const camera = new PerspectiveCamera();
camera.position.z = 2;
globalThis.tn.scene = scene;
globalThis.tn.camera = camera;
const now = () => (globalThis.__tnWallMs ?? (() => Date.now()))();
let renderer;
let target;
let ticks = 0;
let last = 0;
const draws = [];
const frames = [];
const frame = () => {
  requestAnimationFrame(frame);
  ticks += 1;
  const begin = now();
  if (ticks > 1) frames.push(begin - last);
  last = begin;
  if (ticks === 30) {
    renderer = new WebGPURenderer({ canvas: { width: 8, height: 8 } });
    target = new RenderTarget(64, 64);
  }
  if (ticks <= 40) return;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  draws.push(now() - begin);
  if (draws.length < 60) return;
  const median = (list) => [...list].sort((a, b) => a - b)[list.length >> 1];
  globalThis.tn.log("TARGET_DRAW " + JSON.stringify({ draw: median(draws), frame: median(frames.slice(40)) }));
  draws.length = 0;
};
requestAnimationFrame(frame);
`);
await bundleNativeEngine({ entry, outfile, boot: false, host: true });
const script = `
"$PLAYER" "$GAME" > "$LOG" 2>&1 &
P=$!
for i in $(seq 1 300); do grep -q TARGET_DRAW "$LOG" 2>/dev/null && break; sleep 0.2; done
kill $P
`;
const log = resolve(work, "player.log");
const run = spawnSync("sh", [resolve(native, "scripts/xvfb.sh"), "sh", "-c", script], {
  encoding: "utf8",
  env: { ...process.env, PLAYER: resolve(executable), GAME: outfile, LOG: log, TN_PLAYER_WIDTH: "1920", TN_PLAYER_HEIGHT: "1080" },
  timeout: 120_000,
});
const output = existsSync(log) ? readFileSync(log, "utf8") : "";
const line = output.match(/TARGET_DRAW (\{[^\n]*\})/u);
assert(line, `no TARGET_DRAW line (exit ${run.status})\n${output.slice(-2000)}${run.stderr ?? ""}`);
const { draw, frame } = JSON.parse(line[1]);
console.log(`target draw median ${draw.toFixed(2)} ms, frame median ${frame.toFixed(2)} ms`);
// The claim needs a slow present: on a frame of 12 ms or less the two cases cannot be told apart.
assert(frame > 12, `the present is too fast to tell a wait from none (frame median ${frame.toFixed(2)} ms)`);
assert(draw < frame / 4, `a target draw waited for the present: ${draw.toFixed(2)} ms of a ${frame.toFixed(2)} ms frame`);
console.log("PASS a synchronous target draw does not wait for the previous frame's present");
