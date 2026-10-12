// Input on the V8 player with a UI (PRD-554), through the playtest mailbox a runner drives: a pointer
// press inside a hit region the page published reaches the page, one outside it does not, and any
// held key reaches the game by code (KeyW, not only the arrows). Needs an X11 display (offscreen
// WebKitGTK); ctest runs it under scripts/xvfb.sh.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-ui-input.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-ui-input-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(
  entry,
  `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
globalThis.__tnUiGameReceive = (frame) => globalThis.tn.log("UI_RECEIVED " + frame);
globalThis.tn.onUpdate(() => {
  const codes = globalThis.__tnHeldCodes();
  if (codes.length > 0) globalThis.tn.log("HELD " + codes.join(","));
});
`,
);
await bundleNativeEngine({ entry, outfile, boot: false });
mkdirSync(resolve(work, "ui"));
// One UI island, the left half; every press the page sees comes back as an intent naming its side.
await writeFile(
  resolve(work, "ui/index.html"),
  `<!doctype html><html><body style="margin:0;height:100vh"><script>
  const send = (frame) => window.webkit.messageHandlers.tnHost.postMessage(JSON.stringify(frame));
  send({ type: "tn:hit-regions", regions: [{ x: 0, y: 0, width: 0.5, height: 1 }] });
  document.addEventListener("pointerdown", (event) =>
    send({ type: "tn:intent", name: "press", side: event.clientX < innerWidth / 2 ? "inside" : "outside" }));
  setInterval(() => send({ type: "tn:intent", name: "ready" }), 200);
</script></body></html>`,
);
const mailbox = resolve(work, "mailbox");
mkdirSync(mailbox);
const request = resolve(mailbox, "tn-playtest-request.json");
const response = resolve(mailbox, "tn-playtest-response.json");
const env = { ...process.env, SDL_VIDEODRIVER: "x11", SDL_AUDIO_DRIVER: "dummy", TN_PLAYTEST_MAILBOX_ROOT: mailbox };
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const read = (chunk) => {
  output += chunk;
};
child.stdout.on("data", read);
child.stderr.on("data", read);
const exited = new Promise((done) => child.once("exit", done));

const answer = async (id, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) {
    if (existsSync(response)) {
      const text = readFileSync(response, "utf8");
      if (text.includes(`"id":"${id}"`)) {
        unlinkSync(response);
        return JSON.parse(text);
      }
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  return undefined;
};
let next = 0;
const call = async (method, argument) => {
  const id = String(++next);
  writeFileSync(request, JSON.stringify({ id, method, argument }));
  const reply = await answer(id, 30_000);
  assert(reply && reply.error === undefined, `${method} failed: ${JSON.stringify(reply)}\n${output.slice(-2000)}`);
  return reply.result;
};
const press = async (x) => {
  await call("input.pointer", { type: "down", x, y: 360, buttons: 1 });
  await call("advance", 2);
  await call("input.pointer", { type: "up", x, y: 360, buttons: 0 });
  await call("advance", 2);
};
const presses = () => [...output.matchAll(/UI_RECEIVED [^\n]*"name":"press"[^\n]*/gu)].map((match) => match[0]);
try {
  assert(await answer("ready", 30_000), `no mailbox handshake:\n${output.slice(-2000)}`);
  // The page is ready once its intents arrive, and its hit region applied before them.
  for (let i = 0; i < 200 && !/"name":"ready"/u.test(output); ++i) await call("advance", 1);
  assert.match(output, /TN_UI_HIT_REGIONS:\{"count":1/u, `the page's hit region never applied:\n${output.slice(-2000)}`);
  await press(320); // inside the left-half island
  await press(960); // outside it: the game's
  for (let i = 0; i < 60 && presses().length === 0; ++i) await call("advance", 1);
  for (let i = 0; i < 20; ++i) await call("advance", 1); // any late press would land by now
  const seen = presses();
  assert.equal(seen.length, 1, `the page saw ${seen.length} presses: ${seen.join(" | ")}`);
  assert.match(seen[0], /"side":"inside"/u, `the page's press was not the inside one: ${seen[0]}`);
  await call("input.keyDown", { key: "KeyW" });
  await call("advance", 2);
  assert.match(output, /HELD [^\n]*KeyW/u, `a held W never reached the game by code:\n${output.slice(-2000)}`);
} finally {
  child.kill();
  await exited;
}
console.log("PASS the UI takes the press on its island, the game keeps the rest and every held key code");
