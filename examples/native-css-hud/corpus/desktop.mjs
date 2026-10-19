#!/usr/bin/env node
/**
 * The Core HUD corpus on the REAL desktop host, through the playtest runner.
 *
 * For every fixture in `fixtures.mjs` (dpr 1 only) this generates a tiny native-css game project,
 * builds it, packages it against the checkout-built host, runs it under
 * `packages/playtest --target desktop --executable`, and compares the host's own capture with the
 * Chromium screenshot `corpus/shared.mjs` renders from the same fixture data. The bars, the SSIM
 * arithmetic, the tree numbering and the asset staging are the oracle's own, imported from
 * `shared.mjs`: this changes the subject, never the measure.
 *
 * Per run it also asserts the backend identity from the host's log — the native-css backend line,
 * `TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}`, no web view, and no rejected mutation
 * batch — because a host that logged the backend and dropped every frame would otherwise pass.
 *
 * Interaction scenarios from `interactions.mjs` run the same way, as playtests over the grammar the
 * runner really has (keys with modifiers, mouse and touch pointers, wheels, media, screenshots) on the
 * host's fixed UI clock; `interactions-desktop.mjs` translates the scripts and names what the host
 * still cannot report.
 *
 * Usage: node corpus/desktop.mjs [fixture ...]    Output: corpus/out-desktop/ (gitignored) + report.json
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, relative } from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { FIXTURES, FONT } from "./fixtures.mjs";
import {
  CLOCK_STEP_MS,
  PIXEL_TOLERANCE,
  PIXEL_TOLERANCE_AA,
  chromiumExpected,
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
  EDGE_PX,
  FONT_FILES,
  IMAGE_FILES,
  SSIM_MIN,
  SSIM_MIN_GLYPHS,
  bar,
  example,
  fontDir,
  here,
  imageDir,
  luminance,
  renderChromiumFixture,
  ssim,
} from "./shared.mjs";

const repo = join(example, "..", "..");
const runtime = join(repo, "packages", "runtime-native", "build", "tn-linux", "mystral");
const packager = join(repo, "packages", "runtime-native", "scripts", "package-desktop.mjs");
const threenative = join(repo, "packages", "create-threenative", "dist", "threenative.js");
const playtestCli = join(repo, "packages", "playtest", "dist", "runner", "cli.js");
const out = join(here, "out-desktop");
/**
 * Where one generated project lives.
 *
 * Under a `dist/` directory on purpose: the repo's Biome config ignores that name, and a generated
 * project is a mirror of a browser page — a fixture's own CSS bytes, an `<img>` with no `alt`, a
 * click handler on a fixture control — none of which is application code and none of which may be
 * rewritten to satisfy a lint rule. `biome.json` itself is outside this corpus's remit, so the
 * generated tree is kept where the existing config already says build output goes.
 */
const projectDir = (name) => join(out, name, "dist");
/**
 * The font sheet `corpus/interaction.mjs` puts in front of a scenario's own CSS, byte for byte: the
 * interaction scenarios declare no @font-face of their own, so this is what their expected pixels
 * were rendered with.
 */
const INTERACTION_FONT =
  "@font-face{font-family:Noto;font-weight:400;src:url(NotoSans-Regular.ttf)}@font-face{font-family:Noto;font-weight:700;src:url(NotoSans-Bold.ttf)}";

const only = process.argv.slice(2);
/** Every fixture except the ones the desktop host cannot express, named in the report. */
const skips = [];
const fixtures = FIXTURES.filter((f) => {
  if (only.length > 0 && !only.includes(f.name)) return false;
  if ((f.dpr ?? 1) !== 1) {
    skips.push({
      name: f.name,
      why: "dpr is not 1: the desktop host attaches the overlay at scale 1.0 and offers no scale input",
    });
    return false;
  }
  return true;
});
const scenarios = INTERACTIONS.filter((s) => only.length === 0 || only.includes(s.name));
if (fixtures.length === 0 && scenarios.length === 0)
  throw new Error("TN_DESKTOP_NO_SUBJECT: no fixture or scenario matches the names given");

/** The playtest that photographs one frame once the UI has had the hud's own settling window. */
function frameScenario(name, [width, height]) {
  return {
    schemaVersion: 1,
    name: `corpus-${name}`,
    target: "desktop",
    viewport: { width, height },
    warmupFrames: 0,
    steps: [{ label: "ui-ready", waitTicks: 120, screenshot: "frame" }],
    artifacts: { console: true, screenshots: true },
    assert: {
      resources: [
        // The run reached its assertions and the loop ran: a host that never ticked has observed
        // nothing, which is not a fixture that painted nothing.
        { id: "GameState", path: "frames", changed: true, gte: 100 },
        { id: "GameState", path: "mounted", atSteps: [{ label: "ui-ready", equals: true }] },
      ],
    },
  };
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/**
 * Build, package and run one generated project.
 *
 * Only a build that produced no bundle, or a packager that wrote no executable, is a `fail` here; the
 * playtest's own verdict travels back as `played` so each caller can weigh it against the pixels it
 * is about to compare.
 */
function runProject(subject, scenario, listen = [], fontCss = FONT, env = undefined) {
  const built = buildProject(subject, scenario, listen, fontCss);
  return built.fail === undefined ? play(built.dir, built.executable, scenario, env) : built;
}

/** Generate, build and package one project; the executable is reusable for several playtests. */
function buildProject(subject, scenario, listen, fontCss) {
  const dir = projectDir(subject.name);
  writeProject(dir, subject, { fontCss, listen, scenario });
  const build = run(process.execPath, [threenative, "build", "--target", "desktop"], dir);
  // The consumer build installs the published prebuilt host, which has no CSS backend and refuses
  // this game by name (`TN_CSS_UI_HOST_MISSING`), or fails because no prebuilt release exists. Both
  // are the packaging step, not the build: the bundle, the config and the stylesheets are already
  // written, which is all `package-desktop.mjs` reads. Anything else missing below is a real build
  // failure and is reported as one.
  const built = ["game.js", "config.json"].every((file) =>
    existsSync(join(dir, ".threenative", "build", file)),
  );
  const sheets = join(dir, ".threenative", "build", "ui-css");
  if (!built || !existsSync(sheets))
    return { dir, fail: `the consumer build produced no bundle: ${build.output.slice(-600)}` };
  // An image a fixture's *tree* names travels the same way the oracle stages it (flat, by name,
  // beside the stylesheet), because the engine serves one packaged directory and only knows about
  // the assets a stylesheet `url()` declared. `extractUiStylesheets` cannot see an `<img src>`, so
  // without this the whole mutation batch is refused by name and the fixture paints nothing.
  for (const image of IMAGE_FILES) {
    copyFileSync(join(imageDir, image), join(sheets, image));
  }
  const executable = join(dir, "dist-native", `tn-corpus-${subject.name.replaceAll(/-/gu, "")}`);
  const packaged = run(
    process.execPath,
    [
      packager,
      "--bundle",
      ".threenative/build/game.js",
      "--ui",
      ".threenative/build/ui-css",
      "--config",
      ".threenative/build/config.json",
      "--runtime",
      runtime,
      "--output",
      executable,
    ],
    dir,
  );
  if (!existsSync(executable))
    return { dir, fail: `packaging failed: ${packaged.output.slice(-600)}` };
  return { dir, executable };
}

/** Run one playtest against a packaged project, with `env` reaching the host through the runner. */
function play(dir, executable, scenario, env) {
  writeFileSync(join(dir, "playtest.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  const artifacts = join(dir, "artifacts", "playtest");
  rmSync(artifacts, { force: true, recursive: true });
  const played = run(
    process.execPath,
    [
      playtestCli,
      "playtest.json",
      "--target",
      "desktop",
      "--executable",
      executable,
      "--artifacts",
      artifacts,
    ],
    dir,
    env,
  );
  const consolePath = join(artifacts, "console.json");
  const console_ = existsSync(consolePath) ? JSON.parse(readFileSync(consolePath, "utf8")) : [];
  const lines = console_.map((entry) => String(entry.text));
  const identity = hostIdentity(lines);
  return { dir, executable, lines, identity, artifacts, played };
}

/**
 * The backend identity, from the host's own log.
 *
 * Same assertions `scripts/verify-desktop.mjs` makes, because they are the whole claim that no web
 * view is involved: the backend line naming the rasteriser, the attach marker, and no line that
 * mentions a web view or a Chromium process. A rejected mutation batch is a silent half-tree, and
 * its absence is an assertion rather than an observation.
 */
function hostIdentity(lines) {
  const backend = lines.find((line) => line.startsWith("ui overlay: native-css backend=blitz-dom"));
  const attached = lines.some((line) =>
    line.startsWith('TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}'),
  );
  const webView = lines.filter(
    (line) =>
      /webkit|webview|wry|chromium process|TN_UI_LOAD_FAILED/iu.test(line) &&
      !line.includes("no WebView"),
  );
  const rejected = lines.filter((line) => line.includes("TN_CSS_UI_POST_REJECTED"));
  const adapter = lines.find((line) => line.startsWith("[WebGPU] Adapter:"))?.split(": ")[1];
  const vendor = lines.find((line) => line.startsWith("[WebGPU] Vendor:"))?.split(": ")[1];
  const backendName = lines.find((line) => line.startsWith("[WebGPU] Backend:"))?.split(": ")[1];
  const window = lines
    .find((line) => line.startsWith("[Window] Actual window size:"))
    ?.split(": ")[1];
  const version = lines.find((line) => line.startsWith("Version: "))?.slice("Version: ".length);
  const composites = lines.filter((line) => line.startsWith("TN_UI_COMPOSITE:"));
  const uploads =
    composites.length === 0
      ? 0
      : Math.max(...composites.map((line) => Number(JSON.parse(line.slice(16)).uploads)));
  const errors = lines.filter((line) => /^\[(?:error|Error)\]/u.test(line.trimStart()));
  const problems = [];
  if (backend === undefined) problems.push("no native-css backend line");
  if (!attached) problems.push('no TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}');
  if (webView.length > 0) problems.push(`web view mentioned: ${webView[0].slice(0, 120)}`);
  if (rejected.length > 0) problems.push(`${rejected.length} TN_CSS_UI_POST_REJECTED line(s)`);
  if (errors.length > 0) problems.push(`host error: ${errors[0].slice(0, 160)}`);
  return {
    backend,
    attached,
    webView: webView.length,
    rejected: rejected.length,
    uploads,
    composites: composites.length,
    adapter,
    vendor,
    gpuBackend: backendName,
    window,
    version,
    problems,
    tail: lines.slice(-8).join(" | ").slice(0, 600),
    ok: problems.length === 0,
  };
}

/**
 * The harness's blank-capture guard, re-applied here so a tripped guard is reported rather than
 * hidden.
 *
 * `assertCaptureNotBlank` refuses a capture with fewer than 8 distinct colours. That floor is written
 * for a game frame, where lighting and gradients always produce many; a CSS corpus fixture is flat
 * by construction (`breakpoints-narrow` is two colours: the page background and one box), so the
 * floor rejects correct captures and stops the run before its assertions. This driver re-applies the
 * guard's other two conditions in full — a frame with no luminance variance, or with no bright pixels
 * and no dark-frame variation, is blank here exactly as it is there — and reports the colour count
 * instead of enforcing it. The colour floor is the one condition that is not enforced, because the
 * SSIM comparison against Chromium is a stronger statement about the same pixels than any count of
 * them: a capture that lost its UI scores far below the bar rather than passing quietly.
 */
const GUARD_COLOUR_FLOOR = 8;
function captureStats(png) {
  const colors = new Set();
  let visible = 0;
  let bright = 0;
  let total = 0;
  let squared = 0;
  let max = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    colors.add(
      ((png.data[i] << 24) | (png.data[i + 1] << 16) | (png.data[i + 2] << 8) | png.data[i + 3]) >>>
        0,
    );
    if (png.data[i + 3] === 0) continue;
    const luminance =
      (0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]) / 255;
    visible += 1;
    if (luminance > 0.05) bright += 1;
    max = Math.max(max, luminance);
    total += luminance;
    squared += luminance * luminance;
  }
  const mean = visible === 0 ? 0 : total / visible;
  const stats = {
    distinctColors: colors.size,
    brightPixelRatio: png.data.length === 0 ? 0 : bright / (png.data.length / 4),
    luminanceStdDev: Math.sqrt(Math.max(0, squared / visible - mean * mean)),
    maxLuminance: max,
  };
  const darkFrameVariation =
    stats.distinctColors >= 32 && stats.luminanceStdDev >= 0.02 && stats.maxLuminance <= 0.5;
  return {
    ...stats,
    uniform: stats.luminanceStdDev < 0.01 || (stats.brightPixelRatio < 0.05 && !darkFrameVariation),
  };
}

/**
 * One interaction scenario: the oracle's expected observations, a playtest that walks the script over
 * the grammar the desktop runner has, and a comparison of every observation.
 *
 * The host runs on its fixed UI clock (`TN_CSS_UI_FIXED_STEP_MS`), which the run proves from the
 * host's own `TN_CSS_UI_CLOCK` line rather than assuming the variable arrived. An observation the
 * host cannot be asked for is a named failure of the scenario, never a skip.
 */
async function runInteraction(scenario, browser) {
  const entry = {
    name: scenario.name,
    kind: "interaction",
    size: scenario.size,
    mismatches: [],
    comparedObservations: [],
    skippedObservations: [],
  };
  const expected = chromiumExpected([scenario.name]).get(scenario.name);
  const { boxes } = await scenarioBoxes(browser, scenario);
  const translated = translate(scenario, expected);
  entry.observations = translated.observations.length;
  entry.skipped = translated.observations.filter((item) => item.why !== undefined).length;
  entry.maxClockSkewMs = Math.max(
    0,
    ...translated.observations.map((item) => item.clockSkewMs ?? 0),
  );
  const listen = scenario.listen ?? [];
  // The host's own focus and scroll answers, written to its log under `TN_CSS_UI_STATE_TRACE=1`
  // (`traceCssState` in `src/platform/ui_overlay.cpp`). The fixed clock is what makes a cut run
  // reach the same frame the whole script would have.
  // biome-ignore lint/style/useNamingConvention: TN_CSS_UI_FIXED_STEP_MS is the host's own variable name.
  const env = { TN_CSS_UI_FIXED_STEP_MS: String(CLOCK_STEP_MS), TN_CSS_UI_STATE_TRACE: "1" };
  const built = buildProject(
    scenario,
    scenarioJson(scenario, translated, expected),
    listen,
    INTERACTION_FONT,
  );
  if (built.fail !== undefined) return { ...entry, pass: false, compared: 0, why: built.fail };
  const playOnce = (playtest) => {
    const played = play(built.dir, built.executable, playtest, env);
    const clock = played.lines.find((line) => line.startsWith("TN_CSS_UI_CLOCK:"));
    if (clock === undefined || JSON.parse(clock.slice(16)).stepMs !== CLOCK_STEP_MS)
      played.identity.problems.push(
        `the host did not run the fixed UI clock: ${clock ?? "no TN_CSS_UI_CLOCK line"}`,
      );
    played.identity.ok = played.identity.problems.length === 0;
    return played;
  };
  let run_ = playOnce(scenarioJson(scenario, translated, expected));
  entry.playtestExit = run_.played.status;
  entry.identity = {
    backend: run_.identity.backend,
    attached: run_.identity.attached,
    webView: run_.identity.webView,
    rejected: run_.identity.rejected,
    problems: run_.identity.problems,
  };
  entry.wheelRoutes = run_.lines
    .filter((line) => line.startsWith("TN_UI_WHEEL_ROUTE:"))
    .map((line) => JSON.parse(line.slice(18)));
  // Every capture this run has to compare, copied out before a later run reuses the directory.
  const captures = new Map();
  const keep = (artifacts, name) => {
    const file = join(artifacts, `${name}.png`);
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
  for (const name of labels) keep(run_.artifacts, name);
  const parses = (output) => {
    try {
      return JSON.parse(output.slice(output.indexOf("{")));
    } catch {
      return undefined;
    }
  };
  let runnerReport = parses(run_.played.output);
  // The runner refuses a capture with fewer than eight distinct colours, which a flat corpus scenario
  // cannot have, and the refusal aborts the whole run — including the report its observations would
  // have been in. The file is written before the guard reads it, so the frame survives; every later
  // capture comes from the same script cut at it (the fixed clock makes the cut reach the same frame),
  // and the state observations from a run of the whole script with no screenshot at all.
  const tripped = run_.played.status !== 0 && run_.played.output.includes("TN_CAPTURE_BLANK");
  if (tripped) {
    const stats = captureStats(captures.get("baseline") ?? new PNG({ width: 1, height: 1 }));
    if (stats.uniform)
      return {
        ...entry,
        pass: false,
        compared: 0,
        why: "the runner's blank-capture guard fired and the frame is uniform in luminance: nothing painted",
      };
    entry.obstruction = `the runner's blank-capture guard (${stats.distinctColors} distinct colours, floor ${GUARD_COLOUR_FLOOR})`;
    entry.prefixRuns = [];
    const needed = [
      ...new Set(
        translated.observations
          .filter(
            (item) =>
              item.why === undefined &&
              item.fromState !== true &&
              (item.obs === "pixel" || item.obs === "focus"),
          )
          .map((item) => item.label),
      ),
    ];
    if (translated.observations.some((item) => item.obs === "focus")) needed.unshift("baseline");
    for (const label of needed.filter((name) => !captures.has(name))) {
      const cut = playOnce(scenarioJson(scenario, prefixFor(translated, label), expected));
      entry.prefixRuns.push({ label, exit: cut.played.status, problems: cut.identity.problems });
      if (!cut.identity.ok)
        entry.identity.problems.push(
          ...cut.identity.problems.map((problem) => `${label}: ${problem}`),
        );
      keep(cut.artifacts, label);
    }
    const second = playOnce(
      scenarioJson(scenario, translate(scenario, expected, { screenshots: false }), expected),
    );
    entry.rerunExit = second.played.status;
    if (second.played.status !== 0)
      return {
        ...entry,
        pass: false,
        compared: 0,
        why: `the rerun without screenshots exited ${second.played.status}: ${second.played.output.slice(-400)}`,
      };
    if (!second.identity.ok) entry.identity.problems.push(...second.identity.problems);
    run_ = second;
    runnerReport = parses(second.played.output);
  } else if (
    run_.played.status !== 0 &&
    !(run_.played.status === 1 && runnerReport !== undefined)
  ) {
    // Exit 1 is the run's own click-ledger assertion failing: its report is complete, and the
    // comparison below names the observation that differs rather than stopping here.
    return {
      ...entry,
      pass: false,
      compared: 0,
      why: `the playtest exited ${run_.played.status}: ${run_.played.output.slice(-400)}`,
    };
  }
  const baseline = captures.get("baseline");
  // Every state observation — a scroll offset, or focus a click gave — is read from a run cut at its
  // own step, because the host's `TN_CSS_UI_STATE` log records the state and not the step that was
  // running: the last line of a cut run is the state that run ended in, which is the state this
  // observation's step was waiting for. Reading the last line of the whole run instead would answer
  // only the last state observation and would be wrong for the ones before it.
  const states = new Map();
  entry.stateRuns = [];
  for (const item of translated.observations.filter(
    (entry_) => entry_.fromState === true && entry_.why === undefined,
  )) {
    const cut = playOnce(scenarioJson(scenario, prefixFor(translated, item.label), expected));
    if (!cut.identity.ok)
      entry.identity.problems.push(
        ...cut.identity.problems.map((problem) => `${item.label}: ${problem}`),
      );
    const state = cut.played.status === 0 ? cssStateAt(cut.lines) : undefined;
    entry.stateRuns.push({
      label: item.label,
      obs: item.obs,
      element: item.n,
      exit: cut.played.status,
      state: state?.line,
    });
    if (state !== undefined) states.set(item.index, state);
  }
  const candidates = focusCandidates(scenario.tree);
  const hostIds = hostIdsOf(scenario.tree);
  const numberOf = new Map([...hostIds].map(([n, id]) => [id, n]));
  let compared = 0;
  for (const item of translated.observations) {
    const want = expected[item.index];
    if (item.why !== undefined) {
      entry.skippedObservations.push({
        index: item.index,
        obs: item.obs,
        expected: want,
        why: item.why,
      });
      continue;
    }
    let actual;
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
        entry.mismatches.push({
          index: item.index,
          obs: item.obs,
          expected: want,
          actual: null,
          why: `no capture at ${item.label}${item.obs === "focus" ? " or baseline" : ""}`,
        });
        continue;
      }
      if (item.obs === "focus") {
        const decoded = focusedFrom(baseline, capture, boxes, candidates);
        actual = decoded.focused;
        why = decoded.why;
      } else actual = pixelAt(capture, item.at[0], item.at[1]);
    } else {
      const ledger = resourceAt(runnerReport, item.label, "clicks");
      if (ledger === undefined) why = `the runner recorded no GameState.clicks at ${item.label}`;
      actual = ledger === undefined ? null : ledger.split(",").filter(Boolean).map(Number);
    }
    compared += 1;
    entry.comparedObservations.push({
      index: item.index,
      obs: item.obs,
      expected: want,
      actual,
      clockSkewMs: item.clockSkewMs,
    });
    const same =
      item.obs === "pixel"
        ? Array.isArray(actual) &&
          actual.every((value, i) => Math.abs(value - want[i]) <= PIXEL_TOLERANCE)
        : actual !== null && JSON.stringify(actual) === JSON.stringify(want);
    if (same) continue;
    const wider =
      item.obs === "pixel" &&
      Array.isArray(actual) &&
      actual.every((value, i) => Math.abs(value - want[i]) <= PIXEL_TOLERANCE_AA);
    entry.mismatches.push({
      index: item.index,
      obs: item.obs,
      at: item.at,
      expected: want,
      actual,
      ...(wider
        ? {
            note: `within the ${PIXEL_TOLERANCE_AA} anti-aliased-edge tolerance, not the ${PIXEL_TOLERANCE} one`,
          }
        : {}),
      ...(why === undefined ? {} : { why }),
    });
  }
  entry.compared = compared;
  const identityOk = entry.identity.problems.length === 0;
  entry.pass = entry.mismatches.length === 0 && entry.skipped === 0 && identityOk;
  const reasons = [];
  if (!identityOk) reasons.push(`host identity: ${entry.identity.problems.join("; ")}`);
  if (entry.mismatches.length > 0)
    reasons.push(`${entry.mismatches.length} observation(s) differ from Chromium`);
  if (entry.skipped > 0)
    reasons.push(
      `${entry.skipped} observation(s) not observable: ${[...new Set(entry.skippedObservations.map((item) => item.why))].join("; ")}`,
    );
  if (reasons.length > 0) entry.why = reasons.join("; ");
  return entry;
}

const report = [];
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

rmSync(out, { force: true, recursive: true });
mkdirSync(join(out, "chromium"), { recursive: true });
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const chromiumVersion = browser.version();
try {
  for (const fixture of fixtures) {
    const [width, height] = fixture.size;
    const dir = join(out, "chromium", fixture.name);
    mkdirSync(dir, { recursive: true });
    const { chrome } = await renderChromiumFixture(browser, fixture, dir, FONT);
    const run_ = runProject(fixture, frameScenario(fixture.name, fixture.size));
    if (run_.fail !== undefined) {
      report.push({ name: fixture.name, kind: "fixture", pass: false, why: run_.fail });
      console.log(`FAIL ${fixture.name}: ${run_.fail.split("\n")[0].slice(0, 200)}`);
      continue;
    }
    const capturePath = join(run_.artifacts, "frame.png");
    if (!existsSync(capturePath)) {
      const why = `the run left no capture (playtest exit ${run_.played.status}): ${run_.identity.tail}`;
      report.push({ name: fixture.name, kind: "fixture", pass: false, why });
      console.log(`FAIL ${fixture.name}: ${why.split(" | ")[0].slice(0, 200)}`);
      continue;
    }
    if (run_.played.status !== 0 && !run_.played.output.includes("TN_CAPTURE_BLANK")) {
      const why = `the playtest failed (exit ${run_.played.status}): ${run_.played.output.slice(-600)}`;
      report.push({ name: fixture.name, kind: "fixture", pass: false, why });
      console.log(`FAIL ${fixture.name}: ${why.split("\n")[0].slice(0, 200)}`);
      continue;
    }
    const capture = PNG.sync.read(readFileSync(capturePath));
    const expected = PNG.sync.read(readFileSync(chrome));
    const stats = captureStats(capture);
    const entry = {
      name: fixture.name,
      kind: "fixture",
      size: fixture.size,
      captureSize: [capture.width, capture.height],
      ssimMin: bar(fixture),
      playtestExit: run_.played.status,
      capture: { distinctColors: stats.distinctColors, uniform: stats.uniform },
      identity: {
        backend: run_.identity.backend,
        attached: run_.identity.attached,
        webView: run_.identity.webView,
        rejected: run_.identity.rejected,
        uploads: run_.identity.uploads,
        version: run_.identity.version,
        adapter: run_.identity.adapter,
        vendor: run_.identity.vendor,
        gpuBackend: run_.identity.gpuBackend,
        window: run_.identity.window,
        problems: run_.identity.problems,
      },
    };
    if (capture.width !== width || capture.height !== height) {
      entry.why = `the capture is ${capture.width}x${capture.height}, not the fixture's ${width}x${height}`;
      entry.pass = false;
    } else {
      const score = ssim(luminance(expected), luminance(capture), width, height);
      entry.ssim = Number(score.toFixed(4));
      // Where `corpus/oracle.mjs` has already rendered this fixture through the crate's own `oracle`
      // example, the same comparison against that raster separates "the desktop host integration" from
      // "the engine": a host frame identical to the crate's is a difference the engine already had.
      const crateRaster = join(here, "out", fixture.name, "native.png");
      if (existsSync(crateRaster)) {
        const crateImage = PNG.sync.read(readFileSync(crateRaster));
        if (crateImage.width === width && crateImage.height === height)
          entry.engineCrossCheck = {
            source: crateRaster,
            ssim: Number(ssim(luminance(capture), luminance(crateImage), width, height).toFixed(4)),
          };
      }
      // The runner refused the capture only when its own blank-capture guard tripped. The guard's
      // colour floor is the one condition this corpus cannot satisfy by construction; every other
      // condition is re-applied above, and a capture that really lost its UI is caught by them and
      // by the SSIM bar together.
      const obstruction =
        run_.played.status !== 0 && stats.distinctColors < GUARD_COLOUR_FLOOR && !stats.uniform
          ? `the runner's blank-capture guard (${stats.distinctColors} distinct colours, floor ${GUARD_COLOUR_FLOOR})`
          : undefined;
      if (obstruction !== undefined) entry.obstruction = obstruction;
      entry.pass =
        score >= bar(fixture) &&
        run_.identity.ok &&
        (run_.played.status === 0 || obstruction !== undefined);
      if (!run_.identity.ok) entry.why = `host identity: ${run_.identity.problems.join("; ")}`;
      else if (score < bar(fixture))
        entry.why = `SSIM ${entry.ssim} is below the ${bar(fixture)} bar`;
      else if (stats.uniform) entry.why = "the capture is uniform in luminance: nothing painted";
      else if (run_.played.status !== 0 && obstruction === undefined)
        entry.why = `the playtest exited ${run_.played.status}`;
    }
    report.push(entry);
    console.log(
      `${entry.pass ? "PASS " : "FAIL "} ${fixture.name}  ${fixture.size.join("x")}  ssim=${entry.ssim ?? "-"} bar=${entry.ssimMin} colours=${entry.capture.distinctColors}${entry.obstruction === undefined ? "" : "  (guard)"}`,
    );
  }

  for (const scenario of scenarios) {
    const entry = await runInteraction(scenario, browser);
    report.push(entry);
    console.log(
      `${entry.pass ? "PASS " : "FAIL "} ${entry.name}  ${entry.observations} observations, ${entry.compared} compared, ${entry.skipped} not observable, ${entry.mismatches.length} mismatch(es)`,
    );
  }
} finally {
  await browser.close();
}

const failed = report.filter((entry) => !entry.pass);
const fixtureRows = report.filter((entry) => entry.kind === "fixture");
const interactionRows = report.filter((entry) => entry.kind === "interaction");
const first = report.find((entry) => entry.identity?.backend !== undefined);

const summary = {
  generatedAt: new Date().toISOString(),
  subject: "the desktop host through packages/playtest",
  totals: {
    fixtures: `${fixtureRows.filter((entry) => entry.pass).length}/${fixtureRows.length}`,
    interactions: `${interactionRows.filter((entry) => entry.pass).length}/${interactionRows.length}`,
    failed: failed.map((entry) => entry.name),
    skipped: skips,
  },
  report,
  skips,
};
writeFileSync(join(out, "report.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest(), null, 2)}\n`);
// The two report files are the only files under `out-desktop/` the repo's own tooling reads, so they
// are written in the shape it formats to.
// Relative, because this checkout lives under `.worktrees/`, which the repo's Biome config ignores:
// an absolute path matches that pattern and Biome then processes no files at all.
run("node_modules/.bin/biome", ["check", "--write", relative(repo, out)], repo);

/** What a reader has to be able to check the numbers against: the host, the adapter, the oracle, the bars. */
function manifest() {
  const identity = first?.identity ?? {};
  return {
    generatedAt: summary.generatedAt,
    host: {
      binary: runtime,
      sha256: sha(readFileSync(runtime)),
      version: identity.version,
      cssBackend: identity.backend,
      adapter: identity.adapter,
      vendor: identity.vendor,
      gpuBackend: identity.gpuBackend,
      firstWindow: identity.window,
    },
    os: { platform: process.platform, release: os.release(), pretty: osRelease() },
    chromium: { version: chromiumVersion, args: CHROMIUM_ARGS },
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    thresholds: {
      ssim: SSIM_MIN,
      ssimGlyphs: SSIM_MIN_GLYPHS,
      edgePx: EDGE_PX,
      pixelTolerance: PIXEL_TOLERANCE,
      pixelToleranceAA: PIXEL_TOLERANCE_AA,
      blankCaptureColourFloor: GUARD_COLOUR_FLOOR,
    },
    fonts: Object.fromEntries(FONT_FILES.map((f) => [f, sha(readFileSync(join(fontDir, f)))])),
    images: Object.fromEntries(IMAGE_FILES.map((f) => [f, sha(readFileSync(join(imageDir, f)))])),
    fixtures: Object.fromEntries(
      fixtures.map((f) => [
        f.name,
        { size: f.size, dpr: f.dpr ?? 1, source: sha(JSON.stringify([f.css, f.tree])) },
      ]),
    ),
  };
}

const pad = (text, width) => String(text).padEnd(width);
/** The distribution name a reader needs to know which machine produced these numbers. */
function osRelease() {
  const file = join("/etc", "os-release");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((row) => row.startsWith("PRETTY_NAME="));
  return line?.slice("PRETTY_NAME=".length).replaceAll('"', "") ?? undefined;
}
console.log("");
console.log(
  `${pad("fixture", 30)} ${pad("size", 9)} ${pad("ssim", 7)} ${pad("bar", 5)} ${pad("colours", 8)} verdict`,
);
for (const entry of fixtureRows) {
  console.log(
    `${pad(entry.name, 30)} ${pad(entry.size.join("x"), 9)} ${pad(entry.ssim ?? "-", 7)} ${pad(entry.ssimMin, 5)} ${pad(entry.capture?.distinctColors ?? "-", 8)} ${entry.pass ? "pass" : `FAIL: ${entry.why ?? "obstruction only"}`}${entry.obstruction === undefined ? "" : " [capture-guard floor]"}`,
  );
}
console.log("");
console.log(`${pad("scenario", 34)} ${pad("obs", 4)} ${pad("cmp", 4)} ${pad("skip", 5)} verdict`);
for (const entry of interactionRows) {
  console.log(
    `${pad(entry.name, 34)} ${pad(entry.observations, 4)} ${pad(entry.compared, 4)} ${pad(entry.skipped, 5)} ${entry.pass ? "pass" : `FAIL: ${entry.why}`}`,
  );
}
console.log("");
console.log(
  `${summary.totals.fixtures} fixtures within the SSIM bars, ${summary.totals.interactions} interaction scenarios matching Chromium`,
);
for (const skip of skips) console.log(`SKIP ${skip.name}: ${skip.why}`);
process.exit(failed.length === 0 ? 0 : 1);
