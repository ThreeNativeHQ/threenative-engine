#!/usr/bin/env node
/**
 * Prove the native-css renderer on Android: install the APK, run the HUD playtest through the
 * playtest runner `--target android` (a real touch on the native-painted Close button, injected as
 * emulator touchscreen events), then read the app's own logcat lines for the backend identity and
 * the absence of any web view, and decode the captures for the painted HUD.
 *
 * The APK must come from a runtime source build with the CSS UI linked, e.g.:
 *   THREENATIVE_RUNTIME_SOURCE=<checkout>/packages/runtime-native \
 *   THREENATIVE_GRADLE_ARGS="-PthreenativeAbis=x86_64 -PthreenativeJsEngine=quickjs" \
 *   JAVA_HOME=<jdk17> ANDROID_HOME=<sdk> pnpm exec threenative build --target android --allow-source-build
 *
 * Usage: node scripts/verify-android.mjs [--device emulator-5554] [--apk dist-native/threenative-native-css-hud.apk]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const example = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(example, "..", "..");
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const device = flag("--device", "emulator-5554");
const apk = resolve(example, flag("--apk", "dist-native/threenative-native-css-hud.apk"));
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk");
const adb = join(sdk, "platform-tools", "adb");
const playtest = join(repo, "packages", "playtest", "dist", "runner", "cli.js");
const packageName = "com.threenative.nativecsshud";
const artifacts = join(example, "artifacts", "playtest");

function fail(message) {
  console.error(`TN_NATIVE_CSS_VERIFY_FAILED: ${message}`);
  process.exit(1);
}

// The runner reads the SDK from the environment and calls `adb` by name.
process.env.ANDROID_HOME = sdk;
process.env.PATH = `${dirname(adb)}:${process.env.PATH}`;

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: example,
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`${label} exited with ${result.status}`);
}

for (const [label, file] of [
  ["the APK", apk],
  ["adb", adb],
  ["the playtest runner (pnpm --filter @threenative/playtest build)", playtest],
]) {
  if (!existsSync(file)) fail(`${label} is missing: ${file}`);
}
// The packaged runtime must carry the backend: the same literal the desktop packager checks for.
const unzip = spawnSync("python3", [
  "-c",
  "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);sys.stdout.buffer.write(b'yes' if any(b'CPU rasteriser, no WebView' in z.read(n) for n in z.namelist() if n.endswith('libmystral-runtime.so')) else b'no')",
  apk,
]);
if (String(unzip.stdout) !== "yes")
  fail(`${apk} has no libmystral-runtime.so with the CSS backend`);

rmSync(artifacts, { force: true, recursive: true });
run(adb, ["-s", device, "install", "-r", apk], "adb install");
run(
  process.execPath,
  [
    playtest,
    "playtests/native-css-hud.playtest.json",
    ...["--target", "android", "--device", device, "--package", packageName],
    ...["--activity", "com.threenative.runtime.MystralActivity"],
  ],
  "android playtest",
);

// The app's own lines only: logcat also carries other processes (Play services' Cronet logs as
// `chromium`), which say nothing about this app. The pid is the one that logged the attach.
const lines = JSON.parse(readFileSync(join(artifacts, "console.json"), "utf8")).map((entry) =>
  String(entry.text),
);
const backend = lines.find((line) => line.includes("ui overlay: native-css backend=blitz-dom"));
const pid = backend?.match(/\(\s*(\d+)\)/u)?.[1];
const own = lines.filter(
  (line) => pid !== undefined && new RegExp(`\\(\\s*${pid}\\)`, "u").test(line),
);
const attached = own.some((line) =>
  line.includes('TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}'),
);
const touched = own.find((line) =>
  line.includes('TN_UI_POINTER_ROUTE:{"source":"touch","hit":true'),
);
const webView = own.filter(
  (line) =>
    /webkit|webview|chromium|cr_|TN_UI_LOAD_FAILED|TN_CSS_UI_POST_REJECTED/iu.test(line) &&
    !line.includes("no WebView"),
);
if (backend === undefined || !attached || touched === undefined || webView.length > 0) {
  console.error(JSON.stringify({ backend, attached, touched, webView }, null, 2));
  fail("the app's logcat does not show the native-css backend, a routed touch and no web view.");
}
console.log(
  `native-css verified on ${device} (pid ${pid}, ${own.length} own lines, 0 web view lines)`,
);
console.log(`  ${backend.slice(backend.indexOf("ui overlay"))}`);
console.log(`  ${touched.slice(touched.indexOf("TN_UI"))}`);

/**
 * Pixels prove it painted. The scenario presents 1280x720 at density 160 (one CSS pixel per device
 * pixel), so these are the desktop proof's boxes. A finger is a coarse pointer with no hover, so the
 * Close button must stay brand blue after the tap: the desktop proof's hover blend appearing here
 * would mean the host told the document a mouse was used.
 */
const NEAR = 8;
const BLUE = [37, 99, 235];
const CLEAR = [24, 24, 27];
const BUTTON = { left: 45, right: 130, top: 626, bottom: 676 };
const PANEL = { left: 24, right: 344, top: 470, bottom: 695 };
function countNear(image, box, colour) {
  let count = 0;
  for (let y = box.top; y <= box.bottom; y++) {
    for (let x = box.left; x <= box.right; x++) {
      const i = (image.width * y + x) << 2;
      if (colour.every((value, c) => Math.abs(image.data[i + c] - value) <= NEAR)) count++;
    }
  }
  return count;
}
const painted = {};
for (const capture of ["hud-before", "hud-after-click"]) {
  const file = join(artifacts, `${capture}.png`);
  if (!existsSync(file)) fail(`${capture}.png is missing: ${file}`);
  const image = PNG.sync.read(readFileSync(file));
  if (image.width !== 1280 || image.height !== 720)
    fail(`${capture}.png is ${image.width}x${image.height}, not the scenario's 1280x720`);
  const button = countNear(image, BUTTON, BLUE);
  const area = (PANEL.right - PANEL.left + 1) * (PANEL.bottom - PANEL.top + 1);
  const panel = area - countNear(image, PANEL, CLEAR);
  painted[capture] = { button, panel };
  if (button < 1500) fail(`${capture}.png: Close button pixels ${button} < 1500`);
  if (panel <= 6000) fail(`${capture}.png: panel pixels off the clear colour ${panel} <= 6000`);
}
console.log(`native-css pixels verified: ${JSON.stringify(painted)}`);
