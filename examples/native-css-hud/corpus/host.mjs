/**
 * The desktop host as a parity subject: one panel's own project, built, packaged and photographed.
 *
 * `corpus/desktop.mjs` runs fixtures this way and `corpus/project.mjs` writes the project; this is
 * the same machinery for a *panel*, which is the same shape (a tree, a stylesheet, a size). The host
 * binary must be the CSS-enabled one (`TN_ENABLE_CSS_UI=1 pnpm native:build`), and the backend
 * identity is asserted from the host's own log — a host that logged the backend and painted nothing
 * would otherwise pass as an empty frame.
 *
 * What this subject cannot do yet: pin an animation's clock (there is no `advance` in the host's
 * input seam), and report a per-node box (the playtest's captures are pixels). A motion panel and
 * the geometry bar are therefore refused by name rather than scored on a weaker bar.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { writeProject } from "./project.mjs";
import { IMAGE_FILES, example, here, imageDir } from "./shared.mjs";

const repo = join(example, "..", "..");
export const runtime = join(repo, "packages", "runtime-native", "build", "tn-linux", "mystral");
const packager = join(repo, "packages", "runtime-native", "scripts", "package-desktop.mjs");
const threenative = join(repo, "packages", "create-threenative", "dist", "threenative.js");
const playtestCli = join(repo, "packages", "playtest", "dist", "runner", "cli.js");
const out = join(here, "out-parity", "host");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/** The playtest that photographs one frame once the UI has had the HUD's own settling window. */
function frameScenario(name, [width, height]) {
  return {
    schemaVersion: 1,
    name: `parity-${name}`,
    target: "desktop",
    viewport: { width, height },
    warmupFrames: 0,
    steps: [{ label: "ui-ready", waitTicks: 120, screenshot: "frame" }],
    artifacts: { console: true, screenshots: true },
    assert: {
      resources: [
        { id: "GameState", path: "mounted", atSteps: [{ label: "ui-ready", equals: true }] },
      ],
    },
  };
}

/**
 * One panel on the real desktop host. Returns `{ png, identity }` or `{ refused }`, never a silent
 * crate score: a subject that could not be photographed is a reported failure of that cell's stage.
 */
export function hostPanel(panel) {
  if (!existsSync(runtime)) {
    return { refused: `the CSS-enabled host is not built: ${runtime}` };
  }
  const dir = join(out, panel.id);
  const scenario = frameScenario(panel.id, [panel.width, panel.height]);
  writeProject(
    dir,
    { name: panel.id, size: [panel.width, panel.height], css: panel.css, tree: panel.tree },
    {
      // The panel's stylesheet already carries the corpus's font and document rules: the meter builds
      // it that way so the engine and the browser page get the same bytes.
      fontCss: "",
      scenario,
    },
  );
  // The example's own config, byte for byte in the fields that decide the subject: the native-css
  // backend paints through the legacy desktop host, so the engine must be the Three.js API one — the
  // owned engine draws a *web* UI through its player overlay and refuses the native-css host by name.
  writeFileSync(
    join(dir, "threenative.config.ts"),
    `import type { IThreeNativeConfig } from "@threenative/core";

const config: IThreeNativeConfig = {
  engine: "threejs",
  app: {
    id: "com.threenative.parity.${panel.id.replaceAll(/-/gu, "")}",
    name: "tn-parity-${panel.id}",
    version: "1.0.0",
    build: 1,
  },
  display: { orientation: "landscape" },
  window: { width: ${panel.width}, height: ${panel.height} },
  nativeEntry: "src/native.tsx",
  ui: { renderer: "native-css" },
};

export default config;
`,
  );
  writeFileSync(join(dir, "playtest.json"), `${JSON.stringify(scenario, null, 2)}\n`);

  const build = run(process.execPath, [threenative, "build", "--target", "desktop"], dir);
  const bundle = join(dir, ".threenative", "build");
  const sheets = join(bundle, "ui-css");
  const built =
    existsSync(join(bundle, "game.js")) &&
    existsSync(join(bundle, "config.json")) &&
    existsSync(sheets);
  if (!built)
    return { refused: `the consumer build produced no bundle: ${build.output.slice(-400)}` };
  // The host subject is the *packaged* path, so it is bound by the build's own profile: a panel whose
  // stylesheet carries a property outside the Core profile is refused by the scanner, not by this
  // driver, and the first findings are the reason. That is the batch's subject in miniature — the
  // crate arm feeds CSS straight to the engine and measures the engine; the host arm also has to get
  // past the build, and until a family PRD lands the build says no.
  const unsupported = build.output
    .split("\n")
    .filter((line) => /^\s+assets\/.*—/u.test(line))
    .slice(0, 3);
  if (unsupported.length > 0) {
    return {
      refused: `the build refuses this panel's CSS: ${unsupported.join(" | ").slice(0, 400)}`,
    };
  }
  if (!readdirSync(sheets).some((file) => file.endsWith(".css")))
    return {
      refused: `the build extracted no stylesheet for the engine: ${build.output.slice(-400)}`,
    };
  for (const image of IMAGE_FILES) copyFileSync(join(imageDir, image), join(sheets, image));

  const executable = join(dir, "dist-native", `tn-parity-${panel.id.replaceAll(/-/gu, "")}`);
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
    return { refused: `packaging failed: ${packaged.output.slice(-400)}` };

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
  );
  const consolePath = join(artifacts, "console.json");
  const lines = existsSync(consolePath)
    ? JSON.parse(readFileSync(consolePath, "utf8")).map((entry) => String(entry.text))
    : [];
  const capturePath = join(artifacts, "frame.png");
  if (!existsSync(capturePath))
    return {
      refused: `the host left no capture (playtest ${played.status}): ${played.output.slice(-400)}`,
    };

  // The same identity assertions `corpus/desktop.mjs` and `scripts/verify-desktop.mjs` make: the
  // backend line, the attach marker, no web view (the log's own "no WebView" sentence excepted), no
  // rejected mutation batch and no host error. A host that logged the backend and dropped every
  // frame would otherwise pass as a blank capture.
  const webView = lines.filter(
    (line) =>
      /webkit|webview|wry|chromium process|TN_UI_LOAD_FAILED/iu.test(line) &&
      !line.includes("no WebView"),
  );
  const rejected = lines.filter((line) => line.includes("TN_CSS_UI_POST_REJECTED"));
  const errors = lines.filter((line) => /^\[(?:error|Error)\]/u.test(line.trimStart()));
  const problems = [
    ...(lines.some((line) => line.startsWith("ui overlay: native-css backend=blitz-dom"))
      ? []
      : ["no native-css backend line"]),
    ...(lines.some((line) =>
      line.startsWith('TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}'),
    )
      ? []
      : ["no attach marker"]),
    ...(webView.length === 0 ? [] : [`web view mentioned: ${webView[0]?.slice(0, 120)}`]),
    ...(rejected.length === 0 ? [] : [`${rejected.length} rejected mutation batch(es)`]),
    ...(errors.length === 0 ? [] : [`host error: ${errors[0]?.slice(0, 160)}`]),
  ];
  const identity = { problems, tail: lines.slice(-6).join(" | ").slice(0, 500) };
  if (problems.length > 0) {
    return { refused: `the host is not the native-css backend: ${problems.join("; ")}` };
  }
  return { png: PNG.sync.read(readFileSync(capturePath)), identity };
}

/** Make the host output directory, so a run that never reaches a panel still leaves a clean tree. */
export function prepareHostOut() {
  rmSync(out, { force: true, recursive: true });
  mkdirSync(out, { recursive: true });
}
