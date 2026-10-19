#!/usr/bin/env node
/**
 * Prove the native-css renderer on a real desktop host: build the game, package it against the
 * checkout-built host, run the playtest (a real pointer click on the native-painted button), then
 * read the host's own log for the backend identity and for the absence of any web view.
 *
 * The host must have been built with the backend: `TN_ENABLE_CSS_UI=1 pnpm native:build`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

// `verify:desktop` proves the Tailwind arm; `verify:desktop plain` proves `plain/`, the same game
// styled with hand-written CSS and no Tailwind in its build.
const plain = process.argv[2] === "plain";
const hud = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(hud, "..", "..");
const example = plain ? join(hud, "plain") : hud;
const name = plain ? "native-css-plain" : "native-css-hud";
const runtime = join(repo, "packages", "runtime-native", "build", "tn-linux", "mystral");
const tools = join(repo, "packages", "runtime-native", "build", "tn-linux", "mystral-tools");
const executable = join(example, "dist-native", name);
// The CLI by path, not `pnpm exec`: pnpm resolves the nearest package.json, which for `plain/` is the
// Tailwind arm's, and would build that project while claiming to build this one.
const cli = join(repo, "packages", "create-threenative", "dist", "threenative.js");
const playtest = join(repo, "packages", "playtest", "dist", "runner", "cli.js");

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: example, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`TN_NATIVE_CSS_VERIFY_FAILED: ${label} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

for (const [label, file] of [
  ["the CSS-enabled host (TN_ENABLE_CSS_UI=1 pnpm native:build)", runtime],
  ["the packager helper (cmake --target mystral-tools)", tools],
  ["the playtest runner (pnpm --filter @threenative/playtest build)", playtest],
]) {
  if (!existsSync(file)) {
    console.error(`TN_NATIVE_CSS_VERIFY_MISSING: ${label} is not built: ${file}`);
    process.exit(1);
  }
}

// The consumer build bundles game.js and the stylesheet-only ui dir, then installs the published
// prebuilt host to package against. That host has no CSS backend, so packaging must refuse it by
// name: this is the negative control. A build that passes here has packaged a host that cannot
// start its own UI, and the proof below would not be about the shipped path.
const consumer = spawnSync(process.execPath, [cli, "build", "--target", "desktop"], {
  cwd: example,
  encoding: "utf8",
});
if (!`${consumer.stdout}${consumer.stderr}`.includes("TN_CSS_UI_HOST_MISSING")) {
  console.error(
    `TN_NATIVE_CSS_VERIFY_FAILED: the consumer build against the prebuilt host must refuse with TN_CSS_UI_HOST_MISSING (exit ${consumer.status}).`,
  );
  process.exit(1);
}
console.log(
  "consumer build refused the prebuilt host by name (TN_CSS_UI_HOST_MISSING), as designed",
);
rmSync(join(example, "dist-native"), { force: true, recursive: true });
rmSync(join(example, "artifacts"), { force: true, recursive: true });

if (plain) {
  // The arm's claim is "no Tailwind in the pipeline", so the stylesheet the engine receives must
  // be the hand-written one and nothing else: it carries `.panel`, and no Tailwind banner/layers.
  const dir = join(example, ".threenative", "build", "ui-css");
  const css = readdirSync(dir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
  if (!css.includes(".panel") || /tailwindcss|@layer|--tw-/u.test(css)) {
    console.error(
      "TN_NATIVE_CSS_VERIFY_FAILED: the plain arm's stylesheet is not plain hand-written CSS.",
    );
    process.exit(1);
  }
  console.log(`plain arm stylesheet verified: ${css.length} bytes, no Tailwind markers`);
}
run(
  process.execPath,
  [
    join(repo, "packages", "runtime-native", "scripts", "package-desktop.mjs"),
    ...["--bundle", ".threenative/build/game.js", "--ui", ".threenative/build/ui-css"],
    ...["--config", ".threenative/build/config.json", "--runtime", runtime],
    ...["--output", executable],
  ],
  "package-desktop",
);
run(
  process.execPath,
  [playtest, `playtests/${name}.playtest.json`, "--target", "desktop", "--executable", executable],
  "desktop playtest",
);
// The keyboard half, and only for the Tailwind arm (the plain arm's panel is not the PRD component):
// one Tab and an Enter must activate Close with no pointer, and the key the HUD never claims must
// still reach the game.
if (!plain) {
  run(
    process.execPath,
    [
      playtest,
      "playtests/native-css-input.playtest.json",
      "--target",
      "desktop",
      "--executable",
      executable,
    ],
    "desktop keyboard playtest",
  );
  console.log("keyboard activation verified: closeClicks 0 -> 1 with no pointer, gameKeys 1");
}

const console_ = JSON.parse(
  readFileSync(join(example, "artifacts", "playtest", "console.json"), "utf8"),
);
const lines = console_.map((entry) => String(entry.text));
const backend = lines.find((line) => line.startsWith("ui overlay: native-css backend=blitz-dom"));
const attached = lines.some((line) =>
  line.startsWith('TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}'),
);
const webView = lines.filter(
  (line) =>
    /webkit|webview|wry|chromium process|TN_UI_LOAD_FAILED/iu.test(line) &&
    !line.includes("no WebView"),
);
if (backend === undefined || !attached || webView.length > 0) {
  console.error(
    "TN_NATIVE_CSS_VERIFY_FAILED: the host log does not show the native-css backend with no web view.",
  );
  console.error(JSON.stringify({ backend, attached, webView }, null, 2));
  process.exit(1);
}
console.log(`native-css verified: ${backend}`);

/**
 * The log proves the host linked the backend; only pixels prove it painted. A host that logged the
 * backend and dropped every frame passes the log check, so both captures are decoded and the two
 * regions the HUD is made of are counted: the Close button's blue fill, and the panel behind it,
 * which must not be the clear colour.
 */
const NEAR = 8;
const BLUE = [37, 99, 235];
const CLEAR = [24, 24, 27];
// Both arms' hover rule is `rgb(37 99 235 / 80%)` over the HUD's own background, so the capture
// after the click must show that blend and not BLUE: a hover rule that never applied would leave
// BLUE and fail here. The Tailwind arm reaches it through `transition-colors`, so this also is the
// proof that the host feeds the animation clock — without a moving clock the transition never left
// its first frame and this stayed BLUE.
const HOVER = [37, 87, 196];

function countNear(image, box, colour, tolerance) {
  let count = 0;
  for (let y = box.top; y <= box.bottom; y++) {
    for (let x = box.left; x <= box.right; x++) {
      const index = (image.width * y + x) << 2;
      if (
        Math.abs(image.data[index] - colour[0]) <= tolerance &&
        Math.abs(image.data[index + 1] - colour[1]) <= tolerance &&
        Math.abs(image.data[index + 2] - colour[2]) <= tolerance
      ) {
        count++;
      }
    }
  }
  return count;
}

function countDifferent(image, box, colour, tolerance) {
  return (
    (box.right - box.left + 1) * (box.bottom - box.top + 1) -
    countNear(image, box, colour, tolerance)
  );
}

const BUTTON = { left: 45, right: 130, top: 626, bottom: 676 };
const PANEL = { left: 24, right: 344, top: 470, bottom: 695 };
const painted = {};
for (const capture of ["hud-before", "hud-after-click"]) {
  const file = join(example, "artifacts", "playtest", `${capture}.png`);
  if (!existsSync(file)) {
    console.error(`TN_NATIVE_CSS_VERIFY_FAILED: ${capture}.png is missing: ${file}`);
    process.exit(1);
  }
  const image = PNG.sync.read(readFileSync(file));
  const button = countNear(image, BUTTON, capture === "hud-after-click" ? HOVER : BLUE, NEAR);
  const panel = countDifferent(image, PANEL, CLEAR, NEAR);
  painted[capture] = { button, panel };
  const failed = [];
  if (button < 1500) failed.push(`Close button pixels ${button} < 1500`);
  if (panel <= 6000) failed.push(`panel pixels off the clear colour ${panel} <= 6000`);
  if (failed.length > 0) {
    console.error(
      `TN_NATIVE_CSS_VERIFY_FAILED: ${capture}.png is not painted: ${failed.join("; ")}`,
    );
    process.exit(1);
  }
}
console.log(`native-css pixels verified: ${JSON.stringify(painted)}`);

/**
 * Keyboard focus has to be visible, and "visible" is a pixel claim: the Close button is brand blue
 * until a Tab focuses it, and amber (`#f59e0b`) after. A scenario that asserted the click reached
 * the game without this would pass on a HUD whose focus ring never painted.
 */
if (!plain) {
  const FOCUS = [245, 158, 11];
  const focusFile = join(example, "artifacts", "playtest", "input-after-tab.png");
  if (!existsSync(focusFile)) {
    console.error(`TN_NATIVE_CSS_VERIFY_FAILED: the focus capture is missing: ${focusFile}`);
    process.exit(1);
  }
  const focused = PNG.sync.read(readFileSync(focusFile));
  const ring = countNear(focused, BUTTON, FOCUS, NEAR);
  if (ring < 1500) {
    console.error(
      `TN_NATIVE_CSS_VERIFY_FAILED: the Close button shows no keyboard focus after Tab (${ring} px of ${FOCUS}).`,
    );
    process.exit(1);
  }
  console.log(`focus-visible pixels verified: ${ring} px of ${FOCUS} inside the Close button`);
}
