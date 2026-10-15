// A person's keyboard and mouse reach the game on the V8 player's window. The playtest runner injects
// input through the mailbox, which skips the window entirely, so this test sends real X11 events
// (XTEST, by xdotool) to the window under a virtual display and expects the game's canvas listeners
// (where core reads input) to fire: a held key, a tap shorter than a tick, the mouse buttons and
// motion core's right-mouse look reads, and the wheel. With `--ui` the same run has the web HUD
// overlay attached (a player built with TN_ENGINE_PLAYER_UI_OVERLAY), which must not take the focus
// or the events the page has no use for.
//   node packages/runtime-native/tests/native-engine/player-real-input.mjs <tn-native-engine-player-v8> [--ui]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-real-input.mjs <tn-native-engine-player-v8> [--ui]");
const withUi = process.argv.includes("--ui");
const work = await mkdtemp(resolve(native, "build/player-real-input-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { canvas } from ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
const log = (line) => globalThis.tn.log("REAL_INPUT " + line);
for (const type of ["keydown", "keyup"]) canvas.addEventListener(type, (e) => log(type + " " + e.code + " " + e.key));
for (const type of ["pointerdown", "pointerup"])
  canvas.addEventListener(type, (e) => log(type + " button=" + e.button + " buttons=" + e.buttons));
canvas.addEventListener("mousemove", (e) => log("mousemove " + Math.round(e.clientX) + "," + Math.round(e.clientY)));
canvas.addEventListener("wheel", (e) => log("wheel " + Math.sign(e.deltaY)));
let ticks = 0;
globalThis.tn.onUpdate(() => { if (++ticks === 30) log("ready"); });
`);
await bundleNativeEngine({ entry, outfile, boot: false });
if (withUi) {
  mkdirSync(resolve(work, "ui"));
  writeFileSync(resolve(work, "ui/index.html"), "<!doctype html><body style='margin:0;background:transparent'><button style='position:fixed;left:70%;top:70%;width:20%;height:20%'>hud</button></body>");
}
const logFile = resolve(work, "player.log");
// xdotool addresses the X server the player's window is on; xvfb.sh exports DISPLAY to this script.
// TN_TEST_WM names a window manager to start first (kwin_x11): focus rules differ from a bare X server's.
const script = `
if [ -n "$TN_TEST_WM" ]; then $TN_TEST_WM > "$LOG.wm" 2>&1 & sleep 3; fi
"$PLAYER" "$GAME" > "$LOG" 2>&1 &
PLAYER_PID=$!
for i in $(seq 1 150); do grep -q "REAL_INPUT ready" "$LOG" 2>/dev/null && break; sleep 0.2; done
sleep 1
xdotool mousemove 200 150
sleep 0.3
xdotool keydown w; sleep 0.3; xdotool keyup w
xdotool key Down
xdotool key F1
xdotool mousemove 220 160
sleep 0.2
xdotool mousedown 3; sleep 0.2; xdotool mouseup 3
xdotool click 4
sleep 0.5
kill $PLAYER_PID
wait $PLAYER_PID
[ -z "$TN_TEST_WM" ] || kill %1 2>/dev/null
`;
const env = { ...process.env, PLAYER: resolve(executable), GAME: outfile, LOG: logFile };
delete env.DISPLAY;
delete env.SDL_VIDEODRIVER;
spawnSync("sh", [resolve(native, "scripts/xvfb.sh"), "sh", "-c", script], {
  env,
  encoding: "utf8",
  timeout: 120_000,
});
const log = readFileSync(logFile, "utf8");
const seen = log.split("\n").filter((line) => line.includes("REAL_INPUT")).map((line) => line.slice(line.indexOf("REAL_INPUT") + 11));
const context = `${seen.join("\n")}\n--- player output tail ---\n${log.slice(-1500)}`;
for (const want of [
  "keydown KeyW w", "keyup KeyW w", "keydown ArrowDown ArrowDown", "keyup ArrowDown ArrowDown", "keydown F1 F1",
  "pointerdown button=2 buttons=2", "pointerup button=2 buttons=0", "wheel -1",
])
  assert(seen.includes(want), `the game never saw "${want}":\n${context}`);
assert(seen.some((line) => line.startsWith("mousemove ")), `the game never saw a mousemove:\n${context}`);
console.log(`PASS real window keys, mouse and wheel reach the game's listeners${withUi ? " with the HUD overlay attached" : ""}`);
