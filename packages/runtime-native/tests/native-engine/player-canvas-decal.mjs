// A decal is a transparent, polygon-offset MeshBasicMaterial plane with a fillText CanvasTexture, a hair in
// front of an opaque panel (Midway's "NO STEP" and "SBD-3" placards). The check renders panel and decal into
// a render target, reads the pixels back, and fails when the text never reaches the panel.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-canvas-decal.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-canvas-decal-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { CanvasTexture, ClampToEdgeWrapping, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene, SRGBColorSpace, UnsignedByteType } from "three";
import { WebGPURenderer } from "three/webgpu";

const SIZE = 64;
let ticks = 0;
globalThis.tn.onUpdate(() => {
  ticks += 1;
  if (ticks === 1) { globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); }
  if (ticks !== 10) return;
  const renderer = new WebGPURenderer({ canvas: { width: SIZE, height: SIZE } });
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0, 2);
  scene.add(new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial({ color: 0x102030 })));
  // Midway label: text, then a wear pass that scratches the ink away with destination-out, then the
  // canvas is copied into a second canvas that becomes the texture.
  const draw = () => {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 256;
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff";
    x.font = "120px monospace";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText("MMMM", 512, 128, 1000);
    x.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 2000; i += 1) {
      x.fillStyle = "rgba(0,0,0," + ((i * 37) % 55) / 100 + ")";
      x.fillRect((i * 7919) % 1024, (i * 104729) % 256, 3, 2);
    }
    x.globalCompositeOperation = "source-over";
    const out = document.createElement("canvas");
    out.width = 1024;
    out.height = 256;
    out.getContext("2d").drawImage(c, 0, 0);
    const map = new CanvasTexture(out);
    map.colorSpace = SRGBColorSpace;
    map.wrapS = map.wrapT = ClampToEdgeWrapping;
    return map;
  };
  const decal = new Mesh(new PlaneGeometry(3.6, 0.9), new MeshBasicMaterial({
    map: draw(), transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  decal.position.z = 0.002;
  scene.add(decal);
  const target = new RenderTarget(SIZE, SIZE, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE).then((px) => {
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 0x50) lit += 1;
    globalThis.tn.log("DECAL_RESULT " + JSON.stringify({ lit, panel: Array.from(px.slice(0, 4)) }));
  }).catch((error) => globalThis.tn.log("DECAL_RESULT " + JSON.stringify({ error: error.message })));
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
    const match = output.match(/DECAL_RESULT (\{[^\n]*\})/u);
    if (match) {
      clearTimeout(timer);
      done(match[1]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    done(output.match(/DECAL_RESULT (\{[^\n]*\})/u)?.[1] ?? `exited ${code ?? signal}`);
  });
});
child.kill();
let result;
try {
  result = JSON.parse(verdict);
} catch {
  assert.fail(`${verdict}\n${output.slice(-2000)}`);
}
assert.equal(result.error, undefined, `read failed: ${result.error}`);
assert(result.lit > 60, `the decal text reached ${result.lit} of 4096 pixels (panel ${result.panel}); the text plane is missing`);
console.log(`PASS a transparent polygon-offset fillText decal draws over an opaque panel (${result.lit} lit pixels)`);
