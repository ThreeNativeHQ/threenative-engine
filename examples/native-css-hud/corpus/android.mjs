#!/usr/bin/env node
/**
 * The Core HUD corpus on an Android device or emulator, through the playtest runner.
 *
 * The desktop harness (`desktop.mjs`) packages one host per fixture. An Android package is a Gradle
 * build, and every fixture would recompile the same runtime, so this takes the runtime once — the
 * HUD's own APK, built from a runtime source checkout with the CSS UI linked — and swaps in each
 * subject's game bundle and `ui-css` directory (`assets/scripts/main.js`, `assets/ui/`), re-aligns
 * and re-signs it with the debug key, installs it, and runs a playtest `--target android`. Captures
 * are compared with the Chromium screenshot `shared.mjs` renders from the same fixture data, with the
 * oracle's own SSIM arithmetic and bars: this changes the subject, never the measure.
 *
 * Viewports. Android's WindowManager clamps a forced display size to at least 200 px per edge, and
 * the HUD APK is locked to landscape, so a subject with an edge under 200 px or a portrait or square
 * viewport (a square display stays at rotation 0, where the landscape app is inset below the status
 * bar) runs ENLARGED: at least 240 wide and 200 high, and wider than high. The Chromium reference (or, for
 * an interaction, the oracle's expected list, via `interaction-at-size.mjs`) is produced at that same
 * enlarged viewport, because layout depends on it. Every enlarged subject is named in the report.
 * dpr != 1 is skipped by name: the runner presents density 160 only.
 *
 * System bars. The game runs immersive, but Android may reveal transient bars over it after a display
 * change, and `screencap` photographs the whole display. The status bar's clock and icons and the
 * navigation handle are disabled for the run (`cmd statusbar send-disable-flag`), so a transient bar
 * paints nothing over the app; the flags are cleared at the end. The display is fixed to the user
 * rotation for the run too (`wm fixed-to-user-rotation`), so the rotation lock alone decides the
 * display's orientation and each run waits until the display is in its viewport (`settleDisplay`).
 *
 * Interactions. The steps are `interactions-desktop.mjs`'s own translation: a key with its
 * modifiers, a mouse as `pointerPosition`, a finger as `pointers`, a wheel at its point and an
 * environment as `media` all reach this host the way they reach desktop, over the device mailbox
 * into `playtestInput`. The observations are compared the same way, with the oracle's tolerances.
 *
 * The host's UI clock and its state trace. Both are read by the native host from its own environment
 * (`getenv` in `src/platform/ui_overlay.cpp`), and an Android app launched by `am start` inherits
 * none, so the driver hands the two to the launch as intent extras and the native entry sets them
 * before the overlay attaches (`SDL_main` in `src/platform/android_main.cpp`). So the fixed clock is
 * on and the state line is written here exactly as on desktop, and the run proves it from the host's
 * own `TN_CSS_UI_CLOCK` line. `TN_CSS_UI_STATE` reaches this harness through logcat rather than the
 * runner's console: the native entry pipes its own stdout into logcat, and the runner clears logcat
 * on every launch.
 *
 * Each run asserts the identity from the app's own logcat lines: the native-css backend line, the
 * attach marker, no web view, no rejected mutation batch.
 *
 * Usage: node corpus/android.mjs --apk <hud.apk> [--device emulator-5554] [name ...]
 * Output: artifacts/corpus-android/ (gitignored) + report.json
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { FIXTURES, FONT } from "./fixtures.mjs";
import {
  CLOCK_STEP_MS,
  PIXEL_TOLERANCE,
  PIXEL_TOLERANCE_AA,
  cssStateAt,
  focusCandidates,
  focusedFrom,
  hostIdsOf,
  pixelAt,
  prefixFor,
  resourceAt,
  scenarioBoxes,
  scenarioJson,
  translate,
} from "./interactions-desktop.mjs";
import { INTERACTIONS } from "./interactions.mjs";
import { writeProject } from "./project.mjs";
import {
  CHROMIUM_ARGS,
  IMAGE_FILES,
  bar,
  example,
  here,
  imageDir,
  luminance,
  renderChromiumFixture,
  ssim,
} from "./shared.mjs";

const repo = join(example, "..", "..");
const threenative = join(repo, "packages", "create-threenative", "dist", "threenative.js");
const playtestCli = join(repo, "packages", "playtest", "dist", "runner", "cli.js");
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk");
const adb = join(sdk, "platform-tools", "adb");
const buildTools = join(sdk, "build-tools", "36.0.0");
const out = join(example, "artifacts", "corpus-android");
const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args.splice(index, 2)[1];
};
const apk = resolve(
  take("--apk") ?? join(example, "dist-native", "threenative-native-css-hud.apk"),
);
const device = take("--device") ?? "emulator-5554";
const only = args;
const packageName = "com.threenative.nativecsshud";
/** The font sheet `interaction.mjs` puts in front of a scenario's own CSS, as `desktop.mjs` uses. */
const INTERACTION_FONT =
  "@font-face{font-family:Noto;font-weight:400;src:url(NotoSans-Regular.ttf)}@font-face{font-family:Noto;font-weight:700;src:url(NotoSans-Bold.ttf)}";

/** The viewport Android can present for `size`, and whether it had to be enlarged. */
function presented([width, height]) {
  if (Math.min(width, height) >= 200 && height < width) return { size: [width, height] };
  let w = Math.max(width, 240);
  const h = Math.max(height, 200);
  if (h >= w) w = h + 40;
  return { size: [w, h], enlarged: { from: [width, height], to: [w, h] } };
}

const skips = [];
const fixtures = FIXTURES.filter((fixture) => {
  if (only.length > 0 && !only.includes(fixture.name)) return false;
  if ((fixture.dpr ?? 1) === 1) return true;
  skips.push({ name: fixture.name, why: "dpr is not 1: the runner presents density 160 only" });
  return false;
});
const scenarios = INTERACTIONS.filter((s) => only.length === 0 || only.includes(s.name));
if (fixtures.length === 0 && scenarios.length === 0)
  throw new Error("TN_ANDROID_CORPUS_NO_SUBJECT: nothing matches");
if (!existsSync(apk)) throw new Error(`TN_ANDROID_CORPUS_APK_MISSING: ${apk}`);

// The runner reads the SDK from the environment and calls `adb` by name.
process.env.ANDROID_HOME = sdk;
process.env.PATH = `${join(sdk, "platform-tools")}:${process.env.PATH}`;

function run(command, argv, cwd = example, env = process.env) {
  const result = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The HUD APK with this subject's bundle and stylesheets in place of the HUD's, aligned and signed. */
function swapApk(dir) {
  const build = join(dir, ".threenative", "build");
  const ui = join(build, "ui-css");
  for (const image of IMAGE_FILES) cpSync(join(imageDir, image), join(ui, image));
  const unsigned = join(dir, "unsigned.apk");
  const swapped = run("python3", [
    "-c",
    `import os,sys,zipfile
src,dst,bundle,ui=sys.argv[1:]
with zipfile.ZipFile(src) as z, zipfile.ZipFile(dst,'w') as o:
    for info in z.infolist():
        n=info.filename
        if n.startswith('META-INF/') or n=='assets/scripts/main.js' or n.startswith('assets/ui/'): continue
        o.writestr(info, z.read(n))
    o.write(bundle,'assets/scripts/main.js',zipfile.ZIP_DEFLATED)
    for f in sorted(os.listdir(ui)): o.write(os.path.join(ui,f),'assets/ui/'+f,zipfile.ZIP_DEFLATED)`,
    apk,
    unsigned,
    join(build, "game.js"),
    ui,
  ]);
  if (swapped.status !== 0) return { fail: `apk swap failed: ${swapped.output.slice(-400)}` };
  const signed = join(dir, "fixture.apk");
  const aligned = run(join(buildTools, "zipalign"), ["-f", "-p", "4", unsigned, signed]);
  if (aligned.status !== 0) return { fail: `zipalign failed: ${aligned.output.slice(-400)}` };
  const sign = run(join(buildTools, "apksigner"), [
    "sign",
    ...["--ks", join(homedir(), ".android", "debug.keystore"), "--ks-pass", "pass:android"],
    signed,
  ]);
  if (sign.status !== 0) return { fail: `apksigner failed: ${sign.output.slice(-400)}` };
  rmSync(unsigned, { force: true });
  return { signed };
}

/** The identity claim, from the app's own logcat lines (other processes log `chromium` too). */
function identity(lines) {
  const backend = lines.find((line) => line.includes("ui overlay: native-css backend=blitz-dom"));
  const pid = backend?.match(/\(\s*(\d+)\)/u)?.[1];
  const own = lines.filter(
    (line) => pid !== undefined && new RegExp(`\\(\\s*${pid}\\)`, "u").test(line),
  );
  const problems = [];
  if (backend === undefined) problems.push("no native-css backend line");
  if (!own.some((line) => line.includes('TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}')))
    problems.push("no attach marker");
  const webView = own.filter(
    (line) =>
      /webkit|webview|chromium|cr_|TN_UI_LOAD_FAILED/iu.test(line) && !line.includes("no WebView"),
  );
  if (webView.length > 0) problems.push(`web view mentioned: ${webView[0].slice(0, 120)}`);
  const rejected = own.filter((line) => line.includes("TN_CSS_UI_POST_REJECTED"));
  if (rejected.length > 0) problems.push(`${rejected.length} TN_CSS_UI_POST_REJECTED line(s)`);
  const touches = own.filter((line) => line.includes('TN_UI_POINTER_ROUTE:{"source":"touch"'));
  return {
    pid,
    ownLines: own.length,
    webView: webView.length,
    rejected: rejected.length,
    touches: touches.length,
    problems,
    ok: problems.length === 0,
  };
}

/**
 * Put the display into the subject's viewport and wait until it is really there, before the runner
 * launches the app. The runner applies the same `wm size` / density / rotation lock (identical
 * values, so its own step changes nothing), but it checks only the size override, and the display
 * followed whichever app was in front: the portrait launcher between runs, the landscape game once
 * it started, so a rotation still in flight at the capture left the first frames of a run portrait
 * (200x320 for a 320x200 subject). With the display fixed to the user rotation for the run (set
 * below), the rotation lock alone decides, and waiting on the window manager's own current size
 * closes the race instead of retrying until a run happens to win it.
 */
function settleDisplay([width, height]) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const commands = [
    ["wm", "size", `${short}x${long}`],
    ["wm", "density", "160"],
    ["wm", "user-rotation", "lock", width > height ? "1" : "0"],
  ];
  for (const command of commands) run(adb, ["-s", device, "shell", ...command]);
  const want = `cur=${width}x${height}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const shown = run(adb, ["-s", device, "shell", "dumpsys", "window", "displays"]).output;
    if (shown.includes(want)) return undefined;
    spawnSync("sleep", ["0.5"]);
  }
  return `the display never reached ${width}x${height} (window manager: ${run(adb, ["-s", device, "shell", "dumpsys", "window", "displays"]).output.match(/cur=\d+x\d+/u)?.[0]})`;
}

/**
 * One playtest run of the project already installed at `dir`, with `scenario` as its playtest.
 *
 * Re-runnable without a rebuild: the APK carries the subject, not the scenario, so a second run of
 * the same subject only rewrites `playtest.json`. `desktop.mjs` needs that for its cut runs; the
 * blank-capture guard makes it necessary here too.
 */
function playInstalled(dir, scenario) {
  writeFileSync(join(dir, "playtest.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  const artifacts = join(dir, "artifacts", "playtest");
  const played = run(
    process.execPath,
    [
      playtestCli,
      "playtest.json",
      ...["--target", "android", "--device", device, "--package", packageName],
      ...["--activity", "com.threenative.runtime.MystralActivity", "--artifacts", artifacts],
    ],
    dir,
    // The host's fixed UI clock and its focus/scroll state line, the two knobs `desktop.mjs` sets
    // here too: the Android driver forwards them into the launch as intent extras, because an
    // Android app inherits no environment for the host to read them from.
    // biome-ignore lint/style/useNamingConvention: the host's own variable names.
    { ...process.env, TN_CSS_UI_FIXED_STEP_MS: String(CLOCK_STEP_MS), TN_CSS_UI_STATE_TRACE: "1" },
  );
  // The device log itself rather than the runner's console.json: the runner clears logcat when it
  // starts, and a flat subject that trips its blank-capture guard aborts before writing the file.
  const lines = run(adb, ["-s", device, "logcat", "-d", "-v", "brief"]).output.split("\n");
  // The runner refuses a capture with fewer than 8 distinct colours, which a flat corpus subject
  // cannot have; the frame is written before the guard reads it, and the SSIM bar or the pixel
  // comparison is the stronger statement about the same pixels.
  const guard = played.status !== 0 && played.output.includes("TN_CAPTURE_BLANK");
  let report;
  try {
    report = JSON.parse(played.output.slice(played.output.indexOf("{")));
  } catch {
    report = undefined;
  }
  // The host's own stdout lines, read off logcat the way `desktop.mjs` reads them off the host's
  // stdout: the native entry redirects both into logcat (`MystralStdio`), so the line text is the
  // part after the first `): `. That is what carries `TN_CSS_UI_STATE`, which reports the focus a
  // click gave and where a scroller moved, neither of which any pixel shows.
  const stdout = lines
    .filter((line) => line.includes("MystralStdio"))
    .map((line) => line.slice(line.indexOf("): ") + 3));
  const clock = stdout.find((line) => line.startsWith("TN_CSS_UI_CLOCK:"));
  return {
    artifacts,
    played,
    guard,
    report,
    lines: stdout,
    id: identity(lines),
    ...(clock === undefined || JSON.parse(clock.slice(16)).stepMs !== CLOCK_STEP_MS
      ? { clockProblem: clock ?? "no TN_CSS_UI_CLOCK line" }
      : {}),
  };
}

/**
 * Build, swap, install and play one generated project. The consumer build writes the Android bundle
 * and `ui-css`, then stops at packaging (this run packages by swapping); a missing bundle afterwards
 * is a real build failure.
 */
function playOnDevice(root, subject, scenario, listen, fontCss) {
  // Under `dist/` for the reason `desktop.mjs` gives: Biome ignores the name, and generated fixture
  // markup is not application code.
  const dir = join(root, "dist");
  writeProject(dir, subject, { fontCss, listen, scenario });
  const build = run(process.execPath, [threenative, "build", "--target", "android"], dir);
  if (
    !existsSync(join(dir, ".threenative", "build", "game.js")) ||
    !existsSync(join(dir, ".threenative", "build", "ui-css"))
  )
    return { fail: `build produced no bundle: ${build.output.slice(-400)}` };
  const swapped = swapApk(dir);
  if (swapped.fail !== undefined) return swapped;
  const installed = run(adb, ["-s", device, "install", "-r", swapped.signed]);
  rmSync(swapped.signed, { force: true });
  if (installed.status !== 0) return { fail: `install failed: ${installed.output.slice(-300)}` };
  const unsettled = settleDisplay([scenario.viewport.width, scenario.viewport.height]);
  if (unsettled !== undefined) return { fail: unsettled };
  return { dir, ...playInstalled(dir, scenario), play: (next) => playInstalled(dir, next) };
}

/** Viewport and settling steps shared by every scenario this harness writes. */
function scenarioShell(name, [width, height], steps, resources, screenshots) {
  return {
    schemaVersion: 1,
    name: `corpus-${name}`,
    // The scenario schema names the native runner "desktop"; `--target android` picks the device.
    target: "desktop",
    viewport: { width, height },
    warmupFrames: 0,
    steps,
    artifacts: { console: true, screenshots },
    assert: {
      resources: [{ id: "GameState", path: "frames", changed: true, gte: 100 }, ...resources],
    },
  };
}

async function runFixture(fixture, browser) {
  const { size, enlarged } = presented(fixture.size);
  const [width, height] = size;
  const subject = { ...fixture, size };
  const root = join(out, fixture.name);
  rmSync(root, { force: true, recursive: true });
  const chromeDir = join(root, "chromium");
  mkdirSync(chromeDir, { recursive: true });
  const { chrome } = await renderChromiumFixture(browser, subject, chromeDir, FONT);
  const scenario = scenarioShell(
    fixture.name,
    size,
    [{ label: "ui-ready", waitTicks: 120, screenshot: "frame" }],
    [{ id: "GameState", path: "mounted", atSteps: [{ label: "ui-ready", equals: true }] }],
    true,
  );
  const entry = {
    kind: "fixture",
    name: fixture.name,
    size,
    ...(enlarged === undefined ? {} : { enlarged }),
    ssimMin: bar(fixture),
  };
  const played = playOnDevice(root, subject, scenario, [], FONT);
  if (played.fail !== undefined) return { ...entry, pass: false, why: played.fail };
  entry.playtestExit = played.played.status;
  entry.identity = played.id;
  const capturePath = join(played.artifacts, "frame.png");
  if (!existsSync(capturePath))
    return {
      ...entry,
      pass: false,
      why: `no capture (playtest exit ${played.played.status}): ${played.played.output.slice(-400)}`,
    };
  const capture = PNG.sync.read(readFileSync(capturePath));
  const expected = PNG.sync.read(readFileSync(chrome));
  entry.captureSize = [capture.width, capture.height];
  if (capture.width !== width || capture.height !== height)
    return {
      ...entry,
      pass: false,
      why: `the capture is ${capture.width}x${capture.height}, not ${width}x${height}`,
    };
  entry.ssim = Number(ssim(luminance(expected), luminance(capture), width, height).toFixed(4));
  if (played.guard) entry.obstruction = "the runner's blank-capture colour floor";
  entry.pass =
    entry.ssim >= entry.ssimMin && played.id.ok && (played.played.status === 0 || played.guard);
  if (!played.id.ok) entry.why = `identity: ${played.id.problems.join("; ")}`;
  else if (entry.ssim < entry.ssimMin)
    entry.why = `SSIM ${entry.ssim} is below the ${entry.ssimMin} bar`;
  else if (played.played.status !== 0 && !played.guard)
    entry.why = `the playtest exited ${played.played.status}: ${(played.played.output ?? "").slice(-1800)}`;
  return entry;
}

/** The oracle's expected lists at the viewports this device presents. */
function chromiumExpectedAt(names, sizes) {
  const result = run(
    process.execPath,
    [join(here, "interaction-at-size.mjs"), ...names],
    here,
    // biome-ignore lint/style/useNamingConvention: environment variables keep their own names.
    { ...process.env, CHROMIUM_ONLY: "1", TN_INTERACTION_SIZES: JSON.stringify(sizes) },
  );
  if (result.status !== 0)
    throw new Error(`TN_ANDROID_INTERACTION_ORACLE_FAILED: ${result.output.slice(-600)}`);
  const expected = new Map();
  for (const line of result.output.split("\n")) {
    const at = line.indexOf(" [");
    if (at > 0) expected.set(line.slice(0, at), JSON.parse(line.slice(at + 1)));
  }
  return expected;
}

async function runInteraction(scenario, expected, browser) {
  const { size, enlarged } = presented(scenario.size);
  const sized = { ...scenario, size };
  const entry = {
    kind: "interaction",
    name: scenario.name,
    size,
    ...(enlarged === undefined ? {} : { enlarged }),
    mismatches: [],
    compared: [],
    unreachable: [],
  };
  // `scenarioBoxes` reads the page the oracle leaves in `out-interaction/`, which the desktop corpus
  // rewrites too; re-run the oracle for this scenario right before reading it, so another lane's run
  // cannot leave it missing.
  chromiumExpectedAt([scenario.name], { [scenario.name]: size });
  const { boxes } = await scenarioBoxes(browser, sized);
  // The desktop translation's own steps and observation list, unchanged: a key with its held
  // modifiers, a mouse as `pointerPosition`, a finger as `pointers`, a wheel at its point, an
  // environment as `media`, and the fixed UI clock every tick of those waits is counted in. Every
  // one of those reaches this host the way it reaches desktop, and the run proves the clock arrived
  // from the host's own `TN_CSS_UI_CLOCK` line rather than assuming the extra crossed.
  const translated = translate(sized, expected);
  entry.observations = translated.observations.length;
  entry.skipped = translated.observations.filter((o) => o.why !== undefined).length;
  entry.unreachable = translated.observations
    .filter((o) => o.why !== undefined)
    .map((o) => ({ index: o.index, obs: o.obs, why: o.why }));
  const reachable = translated.observations.filter((o) => o.why === undefined);
  // An observation made before any input proves nothing about interaction (the page's own first
  // paint): a scenario whose only reachable observations are those is skipped, not passed.
  const firstInput = scenario.script.findIndex((s) => s.obs === undefined);
  const obsPositions = scenario.script.flatMap((s, position) =>
    s.obs === undefined ? [] : [position],
  );
  const afterInput = reachable.filter((o) => (obsPositions[o.index] ?? -1) > firstInput);
  if (afterInput.length === 0) {
    skips.push({
      name: scenario.name,
      why: entry.unreachable[0]?.why ?? "no reachable observation follows an input",
    });
    return undefined;
  }
  const root = join(out, scenario.name);
  rmSync(root, { recursive: true, force: true });
  const prepared = playOnDevice(
    root,
    sized,
    scenarioJson(sized, translated, expected),
    scenario.listen ?? [],
    INTERACTION_FONT,
  );
  if (prepared.fail !== undefined) return { ...entry, pass: false, why: prepared.fail };
  entry.playtestExit = prepared.played.status;
  entry.identity = prepared.id;
  // Every capture this run has to compare, copied out before a later run reuses the directory.
  const captures = new Map();
  const keep = (run_, name) => {
    const file = join(run_.artifacts, `${name}.png`);
    if (existsSync(file) && !captures.has(name))
      captures.set(name, PNG.sync.read(readFileSync(file)));
  };
  const labels = [
    ...new Set([
      "baseline",
      "final",
      ...translated.observations.map((item) => item.label).filter(Boolean),
    ]),
  ];
  for (const name of labels) keep(prepared, name);
  let report = prepared.report;
  let status = prepared.played.status;
  let output = prepared.played.output;
  const problems = [...prepared.id.problems];
  if (prepared.clockProblem !== undefined)
    problems.push(`the host did not run the fixed UI clock: ${prepared.clockProblem}`);
  // The runner's blank-capture colour floor cannot be met by a flat corpus subject, and it aborts
  // the run at the first capture it refuses, so every capture still needed comes from its own run
  // cut at its own step (`prefixFor`, the desktop corpus's own reader). The click ledger lives in a
  // run's report rather than in a capture, so it comes from one run of the whole script with no
  // screenshot at all — the same two moves `desktop.mjs` makes for the same guard.
  if (prepared.guard) {
    entry.obstruction = "the runner's blank-capture colour floor";
    entry.prefixRuns = [];
    for (const label of labels.filter((name) => !captures.has(name))) {
      const cut = prepared.play(scenarioJson(sized, prefixFor(translated, label), expected));
      entry.prefixRuns.push({ label, exit: cut.played.status, problems: cut.id.problems });
      problems.push(...cut.id.problems.map((problem) => `${label}: ${problem}`));
      keep(cut, label);
    }
    const ledger = prepared.play(
      scenarioJson(sized, translate(sized, expected, { screenshots: false }), expected),
    );
    entry.rerunExit = ledger.played.status;
    problems.push(...ledger.id.problems);
    report = ledger.report;
    status = ledger.played.status;
    output = ledger.played.output;
  }
  entry.identity = { ...prepared.id, problems };
  // Every state observation — a scroll offset, or focus a click gave — is read from a run cut at its
  // own step, because the host's `TN_CSS_UI_STATE` log records the state and not the step that was
  // running: the last line of a cut run is the state that run ended in, which is the state this
  // observation's step was waiting for. The fixed clock is what makes the cut reach the same frame
  // the whole script would have.
  const states = new Map();
  entry.stateRuns = [];
  for (const item of reachable.filter((entry_) => entry_.fromState === true)) {
    const cut = prepared.play(scenarioJson(sized, prefixFor(translated, item.label), expected));
    problems.push(
      ...cut.id.problems.map((problem) => `${item.label}: ${problem}`),
      ...(cut.clockProblem === undefined ? [] : [`${item.label}: no fixed UI clock`]),
    );
    const state = cut.played.status === 0 ? cssStateAt(cut.lines) : undefined;
    entry.stateRuns.push({
      label: item.label,
      obs: item.obs,
      element: item.n,
      exit: cut.played.status,
      state: state?.line,
      ...(cut.played.status === 0 ? {} : { output: cut.played.output.slice(-1500) }),
    });
    if (state !== undefined) states.set(item.index, state);
  }
  // Exit 1 is the run's own click-ledger assertion failing: its report is complete, and the
  // comparison below names the observation that differs rather than stopping here.
  const exitOk = status === 0 || (status === 1 && report !== undefined);
  const compared = compareObservations({
    baseline: captures.get("baseline"),
    boxes,
    candidates: focusCandidates(scenario.tree),
    captures,
    expected,
    hostIds: hostIdsOf(scenario.tree),
    reachable,
    report,
    states,
  });
  entry.compared = compared.compared;
  entry.mismatches = compared.mismatches;
  entry.pass =
    entry.mismatches.length === 0 &&
    problems.length === 0 &&
    exitOk &&
    entry.skipped === 0 &&
    entry.unreachable.length === 0 &&
    entry.observations > 0 &&
    entry.compared.length === entry.observations;
  if (entry.skipped > 0 || entry.unreachable.length > 0)
    entry.why = `${Math.max(entry.skipped, entry.unreachable.length)} observation(s) not observable`;
  else if (entry.compared.length !== entry.observations)
    entry.why = `${entry.compared.length}/${entry.observations} observations compared`;
  else if (problems.length > 0) entry.why = `identity: ${problems.join("; ")}`;
  else if (entry.mismatches.length > 0)
    entry.why = `${entry.mismatches.length} observation(s) differ from Chromium`;
  else if (!exitOk) entry.why = `the playtest exited ${status}: ${output.slice(-300)}`;
  return entry;
}

/**
 * Compare every observation a device run could make, the way `desktop.mjs` compares its own.
 *
 * A `pixel` is one colour out of the capture at that observation's own step, a keyboard `focus` is
 * which focus candidate's box changed against the untouched baseline, and `clicks` is the game's own
 * click ledger at that step. The tolerance and the anti-aliased-edge fallback are the oracle's.
 * An observation with no capture, or no ledger, is a mismatch naming what was missing, never a pass.
 */
function compareObservations({
  baseline,
  boxes,
  candidates,
  captures,
  expected,
  hostIds,
  reachable,
  report,
  states,
}) {
  const numberOf = new Map([...hostIds].map(([n, id]) => [id, n]));
  const compared = [];
  const mismatches = [];
  for (const item of reachable) {
    const want = expected[item.index];
    let actual = null;
    let why;
    if (item.fromState === true) {
      const state = states.get(item.index);
      if (state === undefined) {
        actual = null;
        why = `the host wrote no TN_CSS_UI_STATE line in the run cut at ${item.label}`;
      } else
        actual =
          item.obs === "scroll"
            ? state.scrollOf(hostIds.get(item.n))
            : (numberOf.get(state.focused) ?? state.focused);
    } else if (item.obs === "focus" || item.obs === "pixel") {
      const capture = captures.get(item.label);
      if (capture === undefined || (item.obs === "focus" && baseline === undefined)) {
        mismatches.push({
          index: item.index,
          obs: item.obs,
          expected: want,
          actual: null,
          why: `no capture at ${item.label}${item.obs === "focus" ? " or baseline" : ""}`,
        });
        continue;
      }
      if (item.obs === "focus") {
        // Keyboard focus repaints the box of the control that took it, so which control holds it is
        // read off the capture against the untouched baseline: the desktop decoder, unchanged.
        const decoded = focusedFrom(baseline, capture, boxes, candidates);
        actual = decoded.focused;
        why = decoded.why;
      } else actual = pixelAt(capture, item.at[0], item.at[1]);
    } else {
      const ledger = resourceAt(report, item.label, "clicks");
      if (ledger === undefined) why = `the runner recorded no GameState.clicks at ${item.label}`;
      actual = ledger === undefined ? null : ledger.split(",").filter(Boolean).map(Number);
    }
    compared.push({ index: item.index, obs: item.obs, expected: want, actual });
    const same =
      item.obs === "pixel"
        ? Array.isArray(actual) && actual.every((v, i) => Math.abs(v - want[i]) <= PIXEL_TOLERANCE)
        : actual !== null && JSON.stringify(actual) === JSON.stringify(want);
    if (same) continue;
    const wider =
      item.obs === "pixel" &&
      Array.isArray(actual) &&
      actual.every((v, i) => Math.abs(v - want[i]) <= PIXEL_TOLERANCE_AA);
    mismatches.push({
      index: item.index,
      obs: item.obs,
      at: item.at,
      expected: want,
      actual,
      ...(wider ? { note: `within the ${PIXEL_TOLERANCE_AA} anti-aliased-edge tolerance` } : {}),
      ...(why === undefined ? {} : { why }),
    });
  }
  return { compared, mismatches };
}
const report = [];
mkdirSync(out, { recursive: true });
const disableBars = ["clock", "system-icons", "notification-icons", "home", "recents"];
const bars = run(adb, [
  "-s",
  device,
  "shell",
  "cmd",
  "statusbar",
  "send-disable-flag",
  ...disableBars,
]);
if (bars.status !== 0) throw new Error(`TN_ANDROID_CORPUS_BARS: ${bars.output}`);
// The display's rotation comes from the lock alone, not from whichever app is in front (above).
run(adb, ["-s", device, "shell", "wm", "fixed-to-user-rotation", "enabled"]);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
try {
  for (const fixture of fixtures) {
    const entry = await runFixture(fixture, browser);
    report.push(entry);
    console.log(
      `${entry.pass ? "PASS" : "FAIL"} ${entry.name} ${entry.size.join("x")}${entry.enlarged ? ` (enlarged from ${entry.enlarged.from.join("x")})` : ""} ssim=${entry.ssim ?? "-"} bar=${entry.ssimMin}${entry.why ? ` (${entry.why.slice(0, 160)})` : ""}`,
    );
  }
  const sizes = Object.fromEntries(scenarios.map((s) => [s.name, presented(s.size).size]));
  const expected =
    scenarios.length === 0 ? new Map() : chromiumExpectedAt(Object.keys(sizes), sizes);
  for (const scenario of scenarios) {
    const entry = await runInteraction(scenario, expected.get(scenario.name), browser);
    if (entry === undefined) continue;
    report.push(entry);
    console.log(
      `${entry.pass ? "PASS" : "FAIL"} ${entry.name} ${entry.size.join("x")}${entry.enlarged ? ` (enlarged from ${entry.enlarged.from.join("x")})` : ""} compared=${entry.compared.length} unreachable=${entry.unreachable.length}${entry.why ? ` (${entry.why.slice(0, 160)})` : ""}`,
    );
  }
} finally {
  await browser.close();
  run(adb, ["-s", device, "shell", "cmd", "statusbar", "send-disable-flag", "none"]);
  run(adb, ["-s", device, "shell", "wm", "fixed-to-user-rotation", "default"]);
}
const passed = report.filter((entry) => entry.pass).length;
writeFileSync(
  join(out, "report.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), device, apk, totals: `${passed}/${report.length}`, enlarged: report.filter((e) => e.enlarged).map((e) => ({ name: e.name, ...e.enlarged })), skips, report }, null, 2)}\n`,
);
console.log(`${passed}/${report.length} subjects match Chromium on ${device}`);
for (const skip of skips) console.log(`SKIP ${skip.name}: ${skip.why}`);
process.exit(passed === report.length ? 0 : 1);
