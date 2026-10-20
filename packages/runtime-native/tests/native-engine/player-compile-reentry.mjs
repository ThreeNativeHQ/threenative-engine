// A compileAsync promise whose continuation calls compileAsync again settles inside the player's own
// pending-compile list: V8 runs a continuation as the resolving call returns, so the list can grow
// (and move) under the poll that is erasing the settled entry. Midway's boot chains compiles this way
// and crashed the player in vector::erase; the player now settles after the list is final.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-compile-reentry.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-compile-reentry-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshStandardMaterial } from "three";
import { WebGPURenderer } from "three/webgpu";
const scene = new Scene();
scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
const camera = new PerspectiveCamera();
camera.position.z = 5;
const renderer = new WebGPURenderer({ canvas: {} });
globalThis.tn.onUpdate(() => {});
globalThis.tn.scene = scene;
globalThis.tn.camera = camera;
let settled = 0;
const compile = () => renderer.compileAsync(scene, camera).then(() => { settled += 1; });
// The first settles at a safe point; its continuation starts three more while the player is still erasing it.
const chain = compile().then(() => Promise.all([compile(), compile(), compile()]));
globalThis.__THREENATIVE_PLAYTEST_BRIDGE__ = {
  describe: async () => {
    await chain;
    return { name: "compile-reentry", settled, capabilities: [] };
  },
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
  assert.equal(described.result?.settled, 4, `every chained compile settles: ${JSON.stringify(described.result)}`);
} finally {
  child.kill();
  await exited;
}
console.log("PASS a compileAsync continuation that compiles again settles every promise");
