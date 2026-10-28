// core's canvas layer on the V8 player: renderer.renderOverlay draws over the world frame with the overlay renderer
// (no post, no temporal step), as the Wasm engine draws it over the canvas, and is never published as tn.scene.
// The game calls the facade the way core's loop does: info.frame advances once per frame, the world renders, then the
// overlay. A green overlay covers the left half; the world is a blue plane over the whole view. Before any world is
// published the overlay is still presented, and a frame with the overlay alone (a held loader frame) draws no world.
import assert from "node:assert/strict";
import { runComputeGame } from "./compute-harness.mjs";

const executable = process.argv[2];
assert(executable, "Usage: player-overlay.mjs <tn-native-engine-player-v8>");

const { verdict, output } = await runComputeGame(executable, `
import { Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene, Vector2 } from "three";
import { WebGPURenderer } from "three/webgpu";

const view = () => new OrthographicCamera(-1, 1, 1, -1, 0, 10);
const world = new Scene();
const worldCamera = view();
worldCamera.position.z = 5;
const worldPlane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ color: 0x0000ff }));
world.add(worldPlane);
const overlay = new Scene();
const overlayCamera = view();
overlayCamera.position.z = 5;
const cover = new Mesh(new PlaneGeometry(1, 2), new MeshBasicMaterial({ color: 0x00ff00 }));
cover.position.x = -0.5;
overlay.add(cover);
const renderer = new WebGPURenderer();
// core's renderOverlayFrame: the backend's renderOverlay when it has one, else a render() that keeps the frame.
const drawOverlay = () => (renderer.renderOverlay ?? renderer.render).call(renderer, overlay, overlayCamera);
const reads = {};
const read = (name) => globalThis.tn.readFrame().then((pixels) => {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const at = (x) => Array.from(pixels.slice((Math.floor(size.y / 2) * size.x + Math.floor(x * size.x)) * 4, (Math.floor(size.y / 2) * size.x + Math.floor(x * size.x)) * 4 + 3));
  reads[name] = { left: at(0.25), right: at(0.75) };
});
const near = (seen, want) => seen.length === 3 && want.every((value, i) => Math.abs(value - seen[i]) <= 3);
let frame = 0;
globalThis.tn.onUpdate(() => {});
globalThis.tn.onFrame(() => {
  frame += 1;
  renderer.info.frame = frame;
  // 1..5: a loading screen before the game publishes a world.
  if (frame === 6) { globalThis.tn.scene = world; globalThis.tn.camera = worldCamera; }
  // 6..12: the world and the overlay over it. 13..20: a held loader frame, the overlay alone.
  if (frame >= 6 && frame <= 12) renderer.render(world, worldCamera);
  if (frame === 13) worldPlane.material.color.setHex(0xffff00);
  drawOverlay();
  if (frame === 5) read("loading");
  if (frame === 12) read("world");
  if (frame === 20) read("held").then(() => {
    const faults = [];
    if (!near(reads.loading.left, [0, 255, 0])) faults.push("loading screen not presented before the world: " + reads.loading.left);
    if (!near(reads.world.left, [0, 255, 0])) faults.push("overlay missing over the world: " + reads.world.left);
    if (!near(reads.world.right, [0, 0, 255])) faults.push("world replaced by the overlay frame: " + reads.world.right);
    if (near(reads.held.right, [255, 255, 0])) faults.push("held loader frame drew the world: " + reads.held.right);
    if (globalThis.tn.scene !== world) faults.push("the overlay was published as tn.scene");
    globalThis.tn.log(faults.length === 0 ? "COMPUTE_OK" : "COMPUTE_BAD " + faults.join(" | "));
  }, (error) => globalThis.tn.log("COMPUTE_ERROR " + error.message));
});
`);
assert.equal(verdict, "COMPUTE_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS renderOverlay composites over the world frame, presents before the world and draws no world when held");
