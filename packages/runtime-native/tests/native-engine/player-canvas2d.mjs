// The player answers document.createElement("canvas").getContext("2d") with the host's Skia canvas, so a
// game's procedural textures (Midway's gun steel, paint and brass) draw instead of falling back to a bare
// material colour. Without it the rear-gunner guns rendered flat near-white. The check draws a dark fill,
// reads it back, and builds the same MeshStandardMaterial with `map` and `bumpMap` on one CanvasTexture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-canvas2d.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-canvas2d-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshStandardMaterial, CanvasTexture, SRGBColorSpace } from "three";
import { WebGPURenderer } from "three/webgpu";
const scene = new Scene();
const camera = new PerspectiveCamera();
camera.position.z = 5;
const renderer = new WebGPURenderer({ canvas: {} });
globalThis.tn.onUpdate(() => {});
globalThis.tn.scene = scene;
globalThis.tn.camera = camera;
const probe = () => {
  if (typeof document === "undefined") return { document: false };
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext("2d");
  if (!ctx) return { document: true, context: false };
  const gradient = ctx.createRadialGradient(0, 0, 0, 1, 1, 1);
  gradient.addColorStop(0, "#fff");
  ctx.fillStyle = "#202428";
  ctx.fillRect(0, 0, 16, 16);
  const pixel = Array.from(ctx.getImageData(5, 5, 1, 1).data);
  const image = ctx.createImageData(2, 2);
  image.data.fill(255);
  ctx.putImageData(image, 0, 0);
  const put = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  const t = document.createElement("canvas");
  t.width = 128;
  t.height = 64;
  const tc = t.getContext("2d");
  tc.clearRect(0, 0, 128, 64);
  tc.fillStyle = "#c0baa1";
  tc.font = "600 24px monospace";
  tc.textAlign = "center";
  tc.textBaseline = "middle";
  tc.fillText("NO STEP", 64, 32);
  const inked = Array.from(tc.getImageData(0, 0, 128, 64).data).filter((v, i) => i % 4 === 3 && v > 0).length;
  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  const material = new MeshStandardMaterial({ map, bumpMap: map, metalness: 0.84, roughness: 0.38, bumpScale: 0.0035 });
  scene.add(new Mesh(new BoxGeometry(), material));
  return { document: true, context: true, gradient: typeof gradient.addColorStop, inked, pixel, put, canvasTexture: map.isCanvasTexture === true };
};
globalThis.__THREENATIVE_PLAYTEST_BRIDGE__ = {
  describe: async () => ({ name: "canvas2d", canvas: probe(), capabilities: [] }),
};
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const mailbox = resolve(work, "mailbox");
mkdirSync(mailbox);
const request = resolve(mailbox, "tn-playtest-request.json");
const response = resolve(mailbox, "tn-playtest-response.json");
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy", TN_PLAYTEST_MAILBOX_ROOT: mailbox };
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const read = (chunk) => {
  output += chunk;
};
child.stdout.on("data", read);
child.stderr.on("data", read);
const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));

const answer = async (id, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(response)) {
      const text = readFileSync(response, "utf8");
      if (text.includes(`"id":"${id}"`)) {
        unlinkSync(response);
        return JSON.parse(text);
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  return undefined;
};
try {
  assert(await answer("ready", 30_000), `no mailbox handshake:\n${output.slice(-2000)}`);
  writeFileSync(request, JSON.stringify({ id: "1", method: "describe" }));
  const described = await answer("1", 60_000);
  assert(described, `describe was never answered (player exit ${child.exitCode} ${child.signalCode}):\n${output.slice(-2000)}`);
  assert.equal(described.error, undefined, `describe failed: ${JSON.stringify(described.error)}`);
  const canvas = described.result?.canvas;
  assert.equal(canvas?.document, true, `the player has no document: ${JSON.stringify(canvas)}`);
  assert.equal(canvas.context, true, `canvas.getContext("2d") answered null: ${JSON.stringify(canvas)}`);
  assert.equal(canvas.gradient, "function", "createRadialGradient returns a gradient with addColorStop");
  assert(canvas.inked > 100, `fillText drew ${canvas.inked} pixels (labels and placards need text)`);
  assert.deepEqual(canvas.pixel, [0x20, 0x24, 0x28, 255], "fillRect pixels read back through getImageData");
  assert.deepEqual(canvas.put, [255, 255, 255, 255], "putImageData pixels read back through getImageData");
  assert.equal(canvas.canvasTexture, true, "a CanvasTexture over the canvas builds");
} finally {
  child.kill();
  await exited;
}
console.log("PASS the player draws a 2D canvas into a CanvasTexture used as map and bumpMap");
