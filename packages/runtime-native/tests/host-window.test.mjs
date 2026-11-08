// The window a packaged desktop game opens follows the config the packager embeds. This runs the
// real binary: stage a game with `stageDesktopFiles`, bundle it with `mystral compile`, launch it
// under a private Xvfb and read the window the X server reports. It needs the `mystral` binary,
// Xvfb and xwininfo/xprop, so the default repository gate skips it (`pnpm native:verify:desktop`
// requires them).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";

import { desktopBuildDirectory, nativeTestExecutable } from "../scripts/native-test-lane.mjs";
import { stageDesktopFiles } from "../scripts/package-desktop.mjs";

const mystral = process.env.TN_NATIVE_MYSTRAL_BIN ?? nativeTestExecutable(desktopBuildDirectory(), "mystral");
const xvfb = fileURLToPath(new URL("../../../scripts/xvfb.sh", import.meta.url));
const have = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const available = process.platform === "linux" && existsSync(mystral) && ["Xvfb", "xwininfo", "xprop"].every(have);
if (process.env.npm_lifecycle_event === "native:verify:desktop") {
  assert.ok(available, `the desktop verify lane needs ${mystral}, Xvfb, xwininfo and xprop`);
}
const hostTest = available ? test : test.skip;
const scratch = mkdtempSync(join(tmpdir(), "tn-host-window-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

/** Stages and compiles a one-file game with this config; returns the path of its executable. */
function packageGame(name, config, source = "setTimeout(() => process.exit(0), 8000);") {
  const root = join(scratch, name);
  const bundle = join(scratch, `${name}.js`);
  writeFileSync(bundle, source);
  const entry = stageDesktopFiles(bundle, undefined, join(root, "staging"), {
    app: { build: 1, id: "dev.threenative.test", name: "Window Test", version: "1.0.0" },
    display: { maxFps: 60 },
    ...config,
  });
  const game = join(root, "game");
  const compiled = spawnSync(
    mystral,
    ["compile", entry, "--root", join(root, "staging"), "--include", join(root, "staging"), "--out", game],
    { encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  return game;
}

/** Packages a game with this window config, launches it, and returns what the X server shows. */
function launch(name, config, extraArgs = []) {
  const game = packageGame(name, config);
  // The host retitles an idle window ("no frames presented") after a few seconds, so poll for the
  // configured title while the window is young, then read its size and size hints.
  const script = `
    ${JSON.stringify(game)} ${extraArgs.join(" ")} >/dev/null 2>&1 &
    pid=$!
    for i in $(seq 1 60); do
      sleep 0.1
      xwininfo -root -tree | grep -q '("game" "game")' && break
    done
    xwininfo -root -tree | grep '("game" "game")'
    id=$(xwininfo -root -tree | grep '("game" "game")' | awk '{print $1}' | head -1)
    xprop -id "$id" WM_NORMAL_HINTS WM_NAME _NET_WM_NAME _NET_WM_ICON
    kill $pid
  `;
  const run = spawnSync("sh", [xvfb, "sh", "-c", script], { encoding: "utf8", timeout: 90_000 });
  return run.stdout;
}

hostTest("the embedded window config sets the opened window's title, size and resizability", () => {
  const out = launch("sized", {
    window: { height: 333, maximized: false, resizable: false, title: 'Fox "Deluxe"', width: 777 },
  });
  assert.match(out, /777x333\+/u, out);
  assert.match(out, /_NET_WM_NAME\(UTF8_STRING\) = "Fox \\"Deluxe\\""/u, out);
  // A fixed-size window pins min == max in the size hints.
  assert.match(out, /minimum size: 777 by 333/u, out);
  assert.match(out, /maximum size: 777 by 333/u, out);
});

hostTest("a resizable window leaves the size range open", () => {
  const out = launch("resizable", { window: { height: 400, resizable: true, title: "Free", width: 600 } });
  assert.match(out, /600x400\+/u, out);
  assert.doesNotMatch(out, /maximum size: 600 by 400/u, out);
});

// A 3x2 RGBA PNG whose pixels are all distinct, so a swapped or dropped icon cannot pass.
const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAGElEQVR4nGP4z8DwHwwZ/v8HI4b//8EsAKpvDvIyaXo8AAAAAElFTkSuQmCC",
  "base64",
);

hostTest("the embedded brand icon becomes the window icon", () => {
  const icon = join(scratch, "brand.png");
  writeFileSync(icon, ICON_PNG);
  const out = launch("icon", {
    app: { build: 1, icon, id: "dev.threenative.test", name: "Icon Test", version: "1.0.0" },
    window: { height: 300, title: "Icon", width: 300 },
  });
  // xprop decodes _NET_WM_ICON and prints its size; 3 x 2 is the staged brand icon, not a default.
  assert.match(out, /_NET_WM_ICON\(CARDINAL\) =\s+Icon \(3 x 2\)/u, out);
});

// The packager flattens `ui.renderer` into the embedded config as `uiRenderer`, and the host reads
// that key: "web" needs a staged UI directory beside the executable and refuses to start without
// it, while any other value is the native renderer and needs none.
hostTest("the embedded uiRenderer decides whether the host requires a UI bundle", () => {
  const source = "console.log('TN_GAME_RAN'); process.exit(0);";
  const run = (name, config) =>
    spawnSync(packageGame(name, config, source), ["--no-sdl", "--quiet"], { cwd: scratch, encoding: "utf8", timeout: 60_000 });

  const web = run("ui-web", { ui: { renderer: "web" } });
  assert.equal(web.status, 1, web.stdout + web.stderr);
  assert.match(web.stderr, /TN_UI_BUNDLE_MISSING/u);

  const native = run("ui-native", {});
  assert.equal(native.status, 0, native.stdout + native.stderr);
  assert.match(native.stdout, /TN_GAME_RAN/u);
});
