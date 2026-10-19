// JS state of an attached object survives the collection of its V8 wrapper, in the real player:
// core-three's userData bags, expandos, authored attribute names and JS subclasses (audio included).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-gc.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-gc-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { Object3D, Group, Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Scene, PerspectiveCamera,
  AudioListener, PositionalAudio } from "three";
// No gc() in the player: external memory pressure forces full collections.
const collect = () => {
  for (let i = 0; i < 40; i++) new ArrayBuffer(32 << 20);
  let junk = []; for (let i = 0; i < 3e5; i++) junk.push({ i }); junk = null;
};
class Voice extends Object3D { constructor() { super(); this.kind = "voice"; } }
const parent = new Group();
let pos;
(() => {
  const child = new Object3D();
  child.name = "child"; child.userData.hp = 3; child.expando = 7;
  parent.add(child);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute("aRandom", new Float32BufferAttribute([1], 1));
  parent.add(new Mesh(geometry, new MeshBasicMaterial()));
  parent.add(new Voice());
  parent.add(new PositionalAudio(new AudioListener()));
  pos = child.position;
})();
for (let i = 0; i < 6; i++) collect();
const [child, mesh, voice, audio] = parent.children;
globalThis.tn.__startupError = "PLAYER_GC " + JSON.stringify([JSON.stringify(child.userData), child.expando,
  parent.getObjectByName("child") === child, Object.keys(mesh.geometry.attributes).join(), voice instanceof Voice,
  voice.kind, audio instanceof PositionalAudio, pos === child.position]);
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const run = spawnSync(resolve(executable), ["--check-game", outfile], { encoding: "utf8" });
const line = (run.stdout + run.stderr).match(/PLAYER_GC (.*)$/m);
assert(line, run.stdout + run.stderr);
assert.deepEqual(JSON.parse(line[1]), ['{"hp":3}', 7, true, "position,aRandom", true, "voice", true, true]);
console.log("PASS wrapper state survives collection while the engine references the object");
