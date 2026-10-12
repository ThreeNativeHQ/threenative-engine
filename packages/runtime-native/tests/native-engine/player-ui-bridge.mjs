// A game's UI on the V8 player (PRD-554): a `ui/` page beside the game bundle is attached through
// the legacy host's own overlay seam. The game's `tn:state` frames reach the page, and the intent
// the page posts reaches the game's `__tnUiGameReceive` with `__tnUiOverlayAttached()` true. Needs
// an X11 display (the web view is offscreen WebKitGTK); ctest runs it under scripts/xvfb.sh.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-ui-bridge.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-ui-bridge-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
globalThis.tn.onUpdate(() => {});
globalThis.__tnUiGameReceive = (frame) => {
  globalThis.tn.log("UI_RECEIVED " + frame + " attached=" + globalThis.__tnUiOverlayAttached?.());
};
// Game state to the page, as core's publishUiState posts it: the page echoes it back as an intent.
globalThis.tn.onFrame(() => globalThis.__tnUiPost(JSON.stringify({ type: "tn:state", state: { score: 7 } })));
`);
await bundleNativeEngine({ entry, outfile, boot: false });
mkdirSync(resolve(work, "ui"));
// The page posts its intent until the game has had time to connect, as core's ui-bridge retries.
await writeFile(
  resolve(work, "ui/index.html"),
  `<!doctype html><html><body><script>
  const send = (frame) => window.webkit.messageHandlers.tnHost.postMessage(JSON.stringify(frame));
  let score;
  window.__tnUiReceive = (frame) => {
    const message = JSON.parse(frame);
    if (message.type === "tn:state") score = message.state.score;
  };
  setInterval(() => send({ type: "tn:intent", name: score === undefined ? "start" : "echo", score }), 200);
</script></body></html>`,
);
const env = { ...process.env, SDL_VIDEODRIVER: "x11", SDL_AUDIO_DRIVER: "dummy" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const verdict = await new Promise((done) => {
  const timer = setTimeout(() => done("timeout"), 60_000);
  const read = (chunk) => {
    output += chunk;
    const match = output.match(/UI_RECEIVED ([^\n]*"echo"[^\n]*)/u);
    if (match) {
      clearTimeout(timer);
      done(match[1]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done("exited");
  });
});
child.kill();
assert.match(verdict, /"type":"tn:intent"/u, `no intent reached the game (${verdict}):\n${output.slice(-3000)}`);
assert.match(verdict, /"score":7/u, `the page never received the game's state: ${verdict}`);
assert.match(verdict, /attached=true/u, `the overlay did not report attached: ${verdict}`);
console.log("PASS state reaches the UI page and its intents reach the V8 game through the overlay");
