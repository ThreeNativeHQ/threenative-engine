// A packaged game names its window: TN_PLAYER_TITLE reaches SDL_CreateWindow and the player reports the
// title and size it opened (Midway's `window.title` and 1280x720 from threenative.config.ts). Unset, the
// title stays the engine's own. Runs on a virtual X display: the window is real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-window-title.mjs <tn-native-engine-player-v8>");
delete process.env.DISPLAY;
const work = await mkdtemp(resolve(native, "build/player-window-title-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
globalThis.tn.onUpdate(() => {});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
// A window manager shows _NET_WM_NAME (UTF-8). SDL's static X11 build leaves it unset and writes WM_NAME
// through the locale, so a title with a dash shows as "MIDWAY \u00e2 Open Pacific" in a title bar. xprop reads
// the property off the window, as the WM does.
const script = `
"$PLAYER" "$GAME" 2>&1 &
P=$!
for i in $(seq 1 100); do [ -n "$(xdotool search --onlyvisible --name . 2>/dev/null)" ] && break; sleep 0.2; done
sleep 1
for w in $(xdotool search --onlyvisible --name . 2>/dev/null); do echo "TITLE_ON_WIRE $(xprop -id $w _NET_WM_NAME)"; done
kill $P
`;
const open = (env) => {
  const run = spawnSync("sh", [resolve(native, "scripts/xvfb.sh"), "sh", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PLAYER: resolve(executable), GAME: outfile, TN_PLAYER_WIDTH: "800", TN_PLAYER_HEIGHT: "450", ...env },
    timeout: 60_000,
  });
  return `${run.stdout}${run.stderr}`;
};
const named = open({ TN_PLAYER_TITLE: "MIDWAY — Open Pacific" });
assert.match(named, /TN_PLAYER_WINDOW: title 'MIDWAY — Open Pacific', 800x450/u);
assert.match(named, /TITLE_ON_WIRE _NET_WM_NAME\(UTF8_STRING\) = "MIDWAY — Open Pacific"/u, named.slice(-800));
assert.match(open({ TN_PLAYER_TITLE: "" }), /TN_PLAYER_WINDOW: title 'ThreeNative native engine', 800x450/u);
console.log("PASS the player opens its window with the game's title and size");
