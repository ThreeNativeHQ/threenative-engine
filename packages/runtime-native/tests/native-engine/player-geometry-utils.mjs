// PRD-548 on the V8 player: BufferGeometryUtils.mergeGeometries and mergeVertices over engine
// geometry (the shared merge-geometries.ts, as on Wasm) build the buffers three r185 builds. The
// pinned three and its addon, run here in Node, are the oracle.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-geometry-utils.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-geometry-utils-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const require = createRequire(resolve(native, "package.json"));
const T = await import(pathToFileURL(require.resolve("three/webgpu")).href);
const utils = await import(pathToFileURL(require.resolve("three/addons/utils/BufferGeometryUtils.js")).href);

// The same geometry code runs here over three and in the player over the engine.
const cases = `
function cases(K, utils) {
  const parts = () => {
    const box = new K.BoxGeometry(1, 2, 3);
    const sphere = new K.SphereGeometry(1, 5, 4);
    for (const g of [box, sphere]) {
      const count = g.getAttribute("position").count;
      g.morphAttributes.position = [new K.Float32BufferAttribute(new Float32Array(count * 3).map((_, i) => i / 9), 3)];
    }
    return [box, sphere];
  };
  const merged = utils.mergeGeometries(parts(), true);
  const box = new K.BoxGeometry(1, 2, 3);
  box.deleteAttribute("normal");
  box.deleteAttribute("uv");
  const count = box.getAttribute("position").count;
  box.morphAttributes.position = [new K.Float32BufferAttribute(new Float32Array(count * 3).map((_, i) => (i % 3) / 4), 3)];
  const welded = utils.mergeVertices(box, 1e-3);
  return JSON.stringify([
    Array.from(merged.index.array),
    ...["position", "normal", "uv"].map((n) => Array.from(merged.getAttribute(n).array)),
    merged.morphAttributes.position.map((a) => Array.from(a.array)),
    merged.groups,
    Array.from(welded.index.array),
    Array.from(welded.getAttribute("position").array),
    welded.morphAttributes.position.map((a) => Array.from(a.array)),
  ]);
}`;
const expected = new Function(`${cases}; return cases;`)()(T, utils);

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { BoxGeometry, Float32BufferAttribute, PerspectiveCamera, Scene, SphereGeometry } from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
${cases}
globalThis.tn.onUpdate(() => {
  if (globalThis.tn.scene !== undefined) return;
  globalThis.tn.scene = new Scene();
  globalThis.tn.camera = new PerspectiveCamera();
  const got = cases({ BoxGeometry, Float32BufferAttribute, SphereGeometry }, { mergeGeometries, mergeVertices });
  globalThis.tn.log(got === ${JSON.stringify(expected)} ? "GEOMETRY_UTILS_OK" : "GEOMETRY_UTILS_BAD " + got.slice(0, 200));
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
    const match = output.match(/GEOMETRY_UTILS_(OK|BAD[^\n]*|ERROR[^\n]*)/u);
    if (match) {
      clearTimeout(timer);
      done(match[0]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done(output.match(/GEOMETRY_UTILS_(OK|BAD[^\n]*|ERROR[^\n]*)/u)?.[0] ?? "exited");
  });
});
child.kill();
assert.equal(verdict, "GEOMETRY_UTILS_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS mergeGeometries and mergeVertices on the V8 player build three's buffers");
