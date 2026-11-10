// The window a packaged desktop game opens follows the config the packager embeds. This runs the
// real binary: stage a game with `stageDesktopFiles`, bundle it with `mystral compile`, launch it
// under a private Xvfb and read the window the X server reports. It needs the `mystral` binary,
// Xvfb and xwininfo/xprop, so the default repository gate skips it (`pnpm native:verify:desktop`
// requires them).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { test } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { desktopBuildDirectory, nativeTestExecutable } from "../scripts/native-test-lane.mjs";
import { stageDesktopFiles } from "../scripts/package-desktop.mjs";

const mystral = process.env.TN_NATIVE_MYSTRAL_BIN ?? nativeTestExecutable(desktopBuildDirectory(), "mystral");
const xvfb = fileURLToPath(new URL("../../../scripts/xvfb.sh", import.meta.url));
const have = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
// The probe reads the window the X server reports, so only the Linux lane can run it: macOS and
// Windows have no Xvfb, xwininfo or xprop to demand, and the verify lane runs on all three.
const linux = process.platform === "linux";
const available = linux && existsSync(mystral) && ["Xvfb", "xwininfo", "xprop", "xdotool"].every(have);
if (linux && process.env.npm_lifecycle_event === "native:verify:desktop") {
  assert.ok(available, `the desktop verify lane needs ${mystral}, Xvfb, xwininfo, xprop and xdotool`);
}
const hostTest = available ? test : test.skip;
const scratch = makeTempDirSync("tn-host-window-");

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
    ${JSON.stringify(game)} ${extraArgs.join(" ")} >${JSON.stringify(`${game}.log`)} 2>&1 &
    pid=$!
    for i in $(seq 1 60); do
      sleep 0.1
      xwininfo -root -tree | grep -q '("game" "game")' && break
    done
    xwininfo -root -tree | grep '("game" "game")'
    id=$(xwininfo -root -tree | grep '("game" "game")' | awk '{print $1}' | head -1)
    xprop -id "$id" WM_NORMAL_HINTS WM_NAME _NET_WM_NAME _NET_WM_ICON
    kill $pid
    wait $pid 2>/dev/null
    cat ${JSON.stringify(`${game}.log`)}
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

/** The resolved window mode the host asked SDL for, from its TN_WINDOW_MODE line. */
function mode(out) {
  const line = out.split("\n").find((entry) => entry.startsWith("TN_WINDOW_MODE:"));
  assert.ok(line, `no TN_WINDOW_MODE line\n${out.slice(-600)}`);
  return JSON.parse(line.slice("TN_WINDOW_MODE:".length));
}

// No window manager is needed: the host prints the mode it passes to SDL after resolving the
// embedded config, the command-line override and the fullscreen-wins rule.
hostTest("embedded fullscreen, maximized and resizable keys reach the window mode", () => {
  const win = (window) => mode(launch(`mode-${JSON.stringify(window)}`, { window: { height: 300, width: 300, ...window } }));
  assert.deepEqual(win({}), { fullscreen: false, maximized: false, resizable: true });
  assert.deepEqual(win({ fullscreen: true }), { fullscreen: true, maximized: false, resizable: true });
  assert.deepEqual(win({ maximized: true }), { fullscreen: false, maximized: true, resizable: true });
  assert.deepEqual(win({ resizable: false }), { fullscreen: false, maximized: false, resizable: false });
  // Fullscreen is authoritative when both are configured.
  assert.deepEqual(win({ fullscreen: true, maximized: true }), {
    fullscreen: true,
    maximized: false,
    resizable: true,
  });
});

hostTest("--windowed, --maximized and --fullscreen override the embedded window mode", () => {
  const forced = (flag) =>
    mode(launch(`flag${flag}`, { window: { fullscreen: true, height: 300, width: 300 } }, [flag]));
  assert.deepEqual(forced("--windowed"), { fullscreen: false, maximized: false, resizable: true });
  assert.deepEqual(forced("--maximized"), { fullscreen: false, maximized: true, resizable: true });
  assert.deepEqual(forced("--fullscreen"), { fullscreen: true, maximized: false, resizable: true });
  // And a flag beats an embedded maximized the other way round.
  const windowed = mode(
    launch("flagwin2", { window: { height: 300, maximized: true, width: 300 } }, ["--windowed"]),
  );
  assert.deepEqual(windowed, { fullscreen: false, maximized: false, resizable: true });
});

hostTest("display.maxFps reaches the presentation cap", () => {
  const cap = (display) =>
    /Presentation cap: (\d+) fps/u.exec(launch(`fps-${display?.maxFps}`, { display, window: { height: 300, width: 300 } }))?.[1];
  assert.equal(cap({ maxFps: 30 }), "30");
  assert.equal(cap({ maxFps: 144 }), "144");
  assert.equal(cap(undefined), "60", "a game that states nothing gets the 60 fps default");
});

// The pump-silence observer stamps every `pollEvents()` entry, including the ones that return early
// because the window is hidden and the loop is paused. If the stamp sat after that early return, a
// 1.5 s hide would read as one 1.5 s silence. X unmap pauses the loop without a window manager.
hostTest("the pump keeps stamping while the loop is paused, so a hidden window is no silence", () => {
  const game = packageGame("paused-pump", { window: { height: 300, width: 300 } }, "setTimeout(() => process.exit(0), 6000);");
  const script = `
    ${JSON.stringify(game)} >${JSON.stringify(`${game}.log`)} 2>&1 &
    pid=$!
    for i in $(seq 1 60); do
      sleep 0.1
      xwininfo -root -tree | grep -q '("game" "game")' && break
    done
    sleep 1
    id=$(xwininfo -root -tree | grep '("game" "game")' | awk '{print $1}' | head -1)
    xdotool windowunmap "$id"
    sleep 1.5
    xdotool windowmap "$id"
    wait $pid
    cat ${JSON.stringify(`${game}.log`)}
  `;
  const out = spawnSync("sh", [xvfb, "sh", "-c", script], { encoding: "utf8", timeout: 90_000 }).stdout;
  assert.match(out, /TN_LIFECYCLE:\{"event":"paused"[^\n]*"applied":true/u, "hiding the window pauses the loop");
  assert.match(out, /TN_LIFECYCLE:\{"event":"resumed"/u, "showing it resumes the loop");
  const line = out.split("\n").find((entry) => entry.startsWith("TN_PUMP_SILENCE:"));
  assert.ok(line, `no TN_PUMP_SILENCE line\n${out.slice(-600)}`);
  const pump = JSON.parse(line.slice("TN_PUMP_SILENCE:".length));
  assert.equal(pump.observed, true);
  assert.ok(pump.maxGapMs < 250, `the paused 1.5 s read as a ${pump.maxGapMs} ms pump silence`);
});

// The playtest runner takes desktop screenshots through a file mailbox: it writes the destination
// path into `tn-playtest-screenshot-request.txt` under TN_PLAYTEST_MAILBOX_ROOT, and the host saves
// the next presented frame there after the present. A game that clears the canvas to magenta each
// frame must come back as a magenta PNG, and the request file must be consumed.
hostTest("a screenshot request in the playtest mailbox saves the presented frame", () => {
  const source = `
    (async () => {
      const canvas = document.getElementById("canvas") ?? document.createElement("canvas");
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const context = canvas.getContext("webgpu");
      context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque" });
      function frame() {
        const encoder = device.createCommandEncoder();
        encoder.beginRenderPass({ colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 1, g: 0, b: 1, a: 1 }, loadOp: "clear", storeOp: "store" }] }).end();
        device.queue.submit([encoder.finish()]);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    })();
    setTimeout(() => process.exit(0), 20000);
  `;
  const game = packageGame("shot", { window: { height: 64, width: 64 } }, source);
  const mailbox = join(scratch, "mailbox");
  mkdirSync(mailbox, { recursive: true });
  const request = join(mailbox, "tn-playtest-screenshot-request.txt");
  const png = join(scratch, "shot.png");
  const script = `
    TN_PLAYTEST_MAILBOX_ROOT=${JSON.stringify(mailbox)} ${JSON.stringify(game)} >${JSON.stringify(`${game}.log`)} 2>&1 &
    pid=$!
    sleep 3
    printf '%s' ${JSON.stringify(png)} > ${JSON.stringify(request)}
    for i in $(seq 1 100); do [ -s ${JSON.stringify(png)} ] && break; sleep 0.1; done
    kill $pid
    wait $pid 2>/dev/null
    cat ${JSON.stringify(`${game}.log`)}
  `;
  const log = spawnSync("sh", [xvfb, "sh", "-c", script], { encoding: "utf8", timeout: 90_000 }).stdout;
  assert.ok(existsSync(png), `no screenshot was saved\n${log.slice(-800)}`);
  assert.equal(existsSync(request), false, "the host consumes the request file");
  const { data, height, width } = PNG.sync.read(readFileSync(png));
  assert.ok(width > 0 && height > 0);
  assert.deepEqual([...data.subarray(0, 4)], [255, 0, 255, 255], "the saved frame is the game's magenta clear");
});
