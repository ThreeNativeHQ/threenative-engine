// A playtest bridge answer that is a promise settles on a later frame, as it does in a page: core's
// describe() releases a held start and waits for the scene the game then enters. The V8 player keeps
// running the game's frame callbacks before it publishes a scene, holds the request, and answers it
// once the promise settles, a sound decoded meanwhile included (Midway's boot on the native engine,
// PRD-545).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-async-bridge.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-async-bridge-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
// The scene is published from the tenth frame callback (requestAnimationFrame runs on tn.onFrame), as
// a loader that adds in slices per frame does.
let frames = 0;
let published;
const sceneReady = new Promise((done) => { published = done; });
globalThis.tn.onUpdate(() => {}); // the runner drives ticks; this proof needs none
globalThis.tn.onFrame(() => {
  if (++frames !== 10) return;
  globalThis.tn.scene = new Scene();
  globalThis.tn.camera = new PerspectiveCamera();
  published();
});
// A sound decoded while loading, as a game's boot does: a page settles it on its event loop, not on
// a simulation tick, and a runner holds every tick until describe() is answered.
const wav = new DataView(new ArrayBuffer(44 + 16));
const ascii = (at, text) => [...text].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
ascii(0, "RIFF"); wav.setUint32(4, 36 + 16, true); ascii(8, "WAVEfmt ");
wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
wav.setUint32(24, 44100, true); wav.setUint32(28, 88200, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
ascii(36, "data"); wav.setUint32(40, 16, true);
const decoded = new AudioContext().decodeAudioData(wav.buffer);
globalThis.__THREENATIVE_PLAYTEST_BRIDGE__ = {
  describe: async () => {
    await sceneReady;
    const sound = await decoded;
    return { name: "async-bridge", frames, samples: sound.length, capabilities: [] };
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
const exited = new Promise((done) => child.once("exit", done));

// Reads the response file once it holds the frame for `id`, then clears it for the next one.
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
    if (child.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  return undefined;
};
try {
  assert(await answer("ready", 30_000), `no mailbox handshake:\n${output.slice(-2000)}`);
  writeFileSync(request, JSON.stringify({ id: "1", method: "describe" }));
  const described = await answer("1", 30_000);
  assert(described, `describe was never answered:\n${output.slice(-2000)}`);
  assert.equal(described.error, undefined, `describe failed: ${JSON.stringify(described.error)}`);
  assert.equal(described.result?.name, "async-bridge");
  assert(described.result.frames >= 10, `describe answered before the scene: ${JSON.stringify(described.result)}`);
  assert.equal(described.result.samples, 8, `the decode settled with the wrong data: ${JSON.stringify(described.result)}`);
} finally {
  child.kill();
  await exited;
}
console.log("PASS a pending bridge answer settles on a later frame and is answered then");
