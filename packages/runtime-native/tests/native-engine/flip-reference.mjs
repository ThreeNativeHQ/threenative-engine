// Texture orientation through ImageBitmapLoader, native V8 player against upstream three on WebGPU.
// A quadrant marker (top-left red, top-right green, bottom-left blue, bottom-right white) is drawn
// on two planes: Midway's way (imageOrientation "flipY", texture.flipY = false) and the plain way
// (no orientation option, texture.flipY left true). Each plane's four quadrant colours must match
// the web frame. Needs a display and a real adapter, like the render goldens:
//   sh scripts/xvfb.sh node packages/runtime-native/tests/native-engine/flip-reference.mjs \
//     packages/runtime-native/build/tn-linux/tn-native-engine-player-v8
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(native, "../..");
const executable = process.argv[2];
assert(executable, "Usage: flip-reference.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/flip-reference-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const require = createRequire(resolve(native, "package.json"));
const { build } = require("esbuild");
const { PNG } = createRequire(resolve(repo, "packages/assets/package.json"))("pngjs");
const { chromium } = createRequire(resolve(repo, "packages/playtest/package.json"))("playwright");

const WIDTH = 1280;
const HEIGHT = 720;
const QUADRANTS = { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 255] };
const marker = new PNG({ width: 8, height: 8 });
for (let y = 0; y < 8; y++)
  for (let x = 0; x < 8; x++)
    marker.data.set([...QUADRANTS[(y < 4 ? "t" : "b") + (x < 4 ? "l" : "r")], 255], (y * 8 + x) * 4);
const markerPng = PNG.sync.write(marker);

// One scene for both renderers: two planes on black under an orthographic camera.
const scene = (loaderModule) => `
import * as THREE from "three";
${loaderModule}
export async function buildScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-${WIDTH / HEIGHT}, ${WIDTH / HEIGHT}, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const plane = async (x, orientation, flipY) => {
    const loader = new THREE.ImageBitmapLoader();
    if (orientation) loader.setOptions({ imageOrientation: "flipY" });
    const texture = new THREE.Texture(await loader.loadAsync(MARKER_URL));
    if (flipY !== undefined) texture.flipY = flipY;
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial();
    material.map = texture;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), material);
    mesh.position.x = x;
    scene.add(mesh);
  };
  await plane(-0.8, true, false);
  await plane(0.8, false, undefined);
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  return { scene, camera };
}
`;

/** Each plane's quadrant colours: the planes' centres sit at x = ±0.8 in a 2-unit-high frame. */
function quadrants(png) {
  const image = PNG.sync.read(png);
  const at = (u, v) => {
    const x = Math.round(((u / (WIDTH / HEIGHT)) * 0.5 + 0.5) * (image.width - 1));
    const y = Math.round((0.5 - v * 0.5) * (image.height - 1));
    const i = (y * image.width + x) * 4;
    const [r, g, b] = image.data.subarray(i, i + 3);
    // Orientation, not colour management: the nearest marker colour names the quadrant, and black
    // (the background) names none, so a plane that is missing or shifted fails.
    if (r + g + b < 60) return `rgb(${r},${g},${b})`;
    const distance = (c) => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    return Object.entries(QUADRANTS).sort(([, a], [, z]) => distance(a) - distance(z))[0][0];
  };
  const plane = (cx) => ({ tl: at(cx - 0.3, 0.3), tr: at(cx + 0.3, 0.3), bl: at(cx - 0.3, -0.3), br: at(cx + 0.3, -0.3) });
  return { midway: plane(-0.8), plain: plane(0.8) };
}

// The web frame: upstream three's WebGPURenderer and ImageBitmapLoader in headed Chromium.
const threeBuild = dirname(require.resolve("three/webgpu"));
const webScene = await build({ stdin: { contents: `${scene("const MARKER_URL = '/marker.png';")}
  const { scene, camera } = await buildScene();
  const renderer = new THREE.WebGPURenderer({ canvas: document.querySelector("#c") });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  renderer.render(scene, camera);
  window.done = true;`, resolveDir: native, loader: "js" }, bundle: true, write: false, format: "esm",
  external: ["three"], logLevel: "silent" });
const files = {
  "/": [`<!doctype html><canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>
<script type="importmap">{"imports":{"three":"/build/three.webgpu.js"}}</script>
<script type="module" src="/scene.js"></script>`, "text/html"],
  "/scene.js": [webScene.outputFiles[0].text, "text/javascript"],
  "/marker.png": [markerPng, "image/png"],
};
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  if (url.startsWith("/build/")) {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(readFileSync(join(threeBuild, url.slice(7))));
    return;
  }
  const file = files[url];
  if (!file) return void response.writeHead(404).end();
  response.writeHead(200, { "content-type": file[1] });
  response.end(file[0]);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const browser = await chromium.launch({ headless: false, args: ["--ozone-platform=x11", "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox", "--ignore-gpu-blocklist", "--enable-features=Vulkan"] });
let web;
try {
  const tab = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const errors = [];
  tab.on("pageerror", (error) => errors.push(String(error)));
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  await tab.waitForFunction(() => window.done === true, null, { timeout: 60_000 }).catch(() => {
    throw new Error(`FLIP_REFERENCE_WEB: the page did not render: ${errors.join("; ")}`);
  });
  await tab.waitForTimeout(500);
  web = quadrants(await tab.locator("#c").screenshot());
} finally {
  await browser.close();
  server.close();
}

// The native frame: the same scene through the bundler, the V8 facade and the player's renderer.
const { writeNativePackage } = await (async () => {
  const writer = resolve(work, "package-writer.mjs");
  await build({ entryPoints: [resolve(native, "../assets/src/native-package.ts")], outfile: writer,
    bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  return import(writer);
})();
const header = Buffer.alloc(12);
header.writeUInt32LE(8, 0); header.writeUInt32LE(8, 4); header.writeUInt32LE(18, 8);
const packagePath = resolve(work, "assets.tnpk");
await writeFile(packagePath, writeNativePackage([
  { name: "/marker.png", kind: 2, data: Buffer.concat([header, marker.data]), uploadSize: 256 },
]));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `${scene("const MARKER_URL = '/marker.png';")}
globalThis.tn.onUpdate(() => {});
globalThis.tn.__startupError = "FLIP_REFERENCE_NATIVE: the scene did not build";
buildScene().then(({ scene, camera }) => {
  globalThis.tn.scene = scene; globalThis.tn.camera = camera; globalThis.tn.__startupError = undefined;
}).catch((error) => { globalThis.tn.__startupError = String(error.stack ?? error); });
globalThis.tn.scene = new THREE.Scene(); globalThis.tn.camera = new THREE.PerspectiveCamera();
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const scenario = resolve(work, "flip.playtest.json");
await writeFile(scenario, JSON.stringify({ schemaVersion: 1, name: "flip-reference", target: "desktop",
  viewport: { width: WIDTH, height: HEIGHT }, warmupFrames: 8,
  steps: [{ label: "settled", waitTicks: 4, release: true, screenshot: "flip" }] }));
const artifacts = resolve(work, "artifacts");
spawnSync(process.execPath, [resolve(repo, "packages/playtest/dist/runner/cli.js"), scenario, "--target", "desktop",
  "--executable", resolve(executable), "--host-arg", outfile, "--artifacts", artifacts],
{ encoding: "utf8", env: { ...process.env, TN_NATIVE_ASSET_PACKAGE: packagePath } });
assert((await readdir(artifacts)).includes("flip.png"), "FLIP_REFERENCE_NATIVE: no native frame was captured");
const ours = quadrants(readFileSync(join(artifacts, "flip.png")));

console.log(JSON.stringify({ web, native: ours }));
for (const quadrant of Object.values(web.midway).concat(Object.values(web.plain)))
  assert(quadrant in QUADRANTS, `FLIP_REFERENCE_WEB: an unrecognised quadrant ${quadrant}`);
assert.deepEqual(ours, web, "native texture orientation differs from upstream three");
console.log("PASS native ImageBitmapLoader orientation matches upstream three");
