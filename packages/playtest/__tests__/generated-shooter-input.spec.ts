import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  workspacePackageArchives,
  workspacePackageSourceFlag,
} from "../../../scripts/workspace-packages.js";
import { WEBGPU_BROWSER_ARGS } from "../src/runner/browser.js";
import { exitCodeForReport } from "../src/runner/cli.js";
import { runStandalonePlaytest } from "../src/runner/runner.js";
import type { IStandalonePlaytestConfig } from "../src/runner/config.js";

// End-to-end proof for the generated shooter's mouse path: relative pointer look, right-button
// aim hold/release, and left-button fire through the real input bridge of a scaffolded project.
//
// This is the integration arm the unit suites cannot stand in for: it packs the local framework
// packages, scaffolds the shooter template like a user's machine would (tarballs, no workspace),
// boots its dev server, and drives the committed `input-control.playtest.json` against it. The
// negative control mutates a copy — right-button delivery removed — and demands a semantic red,
// not a parse error.

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SCENARIO_PATH = path.join(
  REPO_ROOT,
  "packages/create-threenative/templates/shooter/playtests/input-control.playtest.json",
);
const SCAFFOLDER_ENTRY = path.join(REPO_ROOT, "packages/create-threenative/dist/index.js");

// Every package is packed from the workspace manifests so a generated project cannot silently
// miss a newly added framework package.
const LOCAL_PACKAGES = workspacePackageArchives(path.join(REPO_ROOT, "packages"));

const PACKAGE_FLAG_BY_NAME = Object.fromEntries(
  LOCAL_PACKAGES.map(([name]) => [name, workspacePackageSourceFlag(name)]),
);

// WebGPU under Chromium needs a real display server on Linux; the focused gate wraps this spec
// in `sh scripts/xvfb.sh`. Without one the run cannot execute at all, so it is skipped with that
// prerequisite named rather than failed — the wrapper command is the fix, not a code change.
const needsDisplay =
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

let workspaceRoot: string | undefined;
let projectPath: string | undefined;

describe.skipIf(needsDisplay)("generated shooter input proof", () => {
  beforeAll(async () => {
    workspaceRoot = await makeTempDir("generated-shooter-input-");
    const packageDirectory = path.join(workspaceRoot, "packages");
    await mkdir(packageDirectory, { recursive: true });
    const packageSources: Record<string, string> = {};
    for (const [name, prefix] of LOCAL_PACKAGES) {
      await execFileAsync(
        "pnpm",
        ["--filter", name, "pack", "--pack-destination", packageDirectory],
        { cwd: REPO_ROOT },
      );
      const archive = (await readdir(packageDirectory)).find(
        (file) => file.startsWith(prefix) && file.endsWith(".tgz"),
      );
      if (archive === undefined) throw new Error(`local pack for ${name} produced no tarball`);
      packageSources[name] = path.join(packageDirectory, archive);
    }
    projectPath = path.join(workspaceRoot, "shooter-input-proof");
    const flags = Object.entries(packageSources).flatMap(([name, archive]) => {
      const flag = PACKAGE_FLAG_BY_NAME[name];
      return flag === undefined ? [] : [flag, archive];
    });
    await execFileAsync(
      process.execPath,
      [SCAFFOLDER_ENTRY, projectPath, "--template", "shooter", ...flags],
      { cwd: REPO_ROOT },
    );
    await warmDevServer(projectPath);
  }, 900_000);

  /** First vite boot optimizes dependencies and can reload the page mid-scenario; get that
   * reload out of the way here so both scenario runs meet an already-warm server. */
  async function warmDevServer(directory: string): Promise<void> {
    const port = 49_000 + (process.pid % 1_000);
    const server = spawn(
      "pnpm",
      ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: directory, detached: process.platform !== "win32", stdio: "ignore" },
    );
    try {
      const deadline = Date.now() + 120_000;
      while (true) {
        if (Date.now() > deadline) throw new Error("warm dev server never became ready");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.ok) {
            await response.text();
            // The optimization pass can trigger one page reload; let that window close.
            await new Promise((resolve) => setTimeout(resolve, 4_000));
            await fetch(`http://127.0.0.1:${port}/`);
            return;
          }
        } catch {
          // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      if (server.pid !== undefined && process.platform !== "win32") {
        process.kill(-server.pid, "SIGTERM");
      } else {
        server.kill();
      }
    }
  }

  afterAll(async () => {
    if (workspaceRoot !== undefined) {
      const root = workspaceRoot;
      workspaceRoot = undefined;
      await rm(root, { force: true, recursive: true }).catch(() => undefined);
    }
  });


  /** The scaffolded project directory; every test depends on the beforeAll having run. */
  function projectDirectory(): string {
    if (projectPath === undefined) throw new Error("scaffold did not produce a project");
    return projectPath;
  }

  async function runScenario(
    scenarioPath: string,
    artifactDirectory: string,
  ): Promise<Awaited<ReturnType<typeof runStandalonePlaytest>>> {
    if (projectPath === undefined) throw new Error("scaffold did not produce a project");
    const config: IStandalonePlaytestConfig = {
      allowSoftwareAdapter: false,
      artifactDirectory,
      browserArgs: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      // Port 0 asks the runner for a free managed port; the URL must carry no port of its own
      // or that placeholder would win over the dynamic one.
      port: 0,
      projectPath,
      scenarioPath,
      server: {
        command: "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
        cwd: projectPath,
        // Generous because this spec often runs while the rest of pnpm test loads the machine.
        timeoutMs: 240_000,
      },
      timeoutMs: 150_000,
      trace: false,
      url: "http://127.0.0.1/",
    };
    return runStandalonePlaytest(config);
  }

  test("should turn, aim, and fire the generated shooter", async () => {
    expect(projectPath).toBeDefined();
    const report = await runScenario(SCENARIO_PATH, path.join(projectDirectory(), "artifacts-positive"));

    if (!report.pass) {
      // Forensics survive the temp-project cleanup only through this output.
      const observations = (report as { observations?: { resourceSeries?: Array<{ label: string; snapshots: { state: Record<string, number> } }> } }).observations;
      console.info(
        "positive-run diagnostics:",
        JSON.stringify(report.diagnostics),
      );
      console.info(
        "positive-run series:",
        JSON.stringify(
          (observations?.resourceSeries ?? []).map(({ label, snapshots }) => [
            label,
            snapshots.state.playerYaw,
            snapshots.state.aiming,
            snapshots.state.shots,
          ]),
        ),
      );
    }
    for (const a of (report as unknown as { assertionResults?: Array<Record<string, unknown>> }).assertionResults ?? []) {
      if ((a as { pass: boolean }).pass === false) console.info("PROBE-FAILED-ASSERTION:", JSON.stringify(a).slice(0, 600));
    }
    expect(report.pass).toBe(true);
    expect(exitCodeForReport(report)).toBe(0);
    // The adapter must be named hardware: the runner fails TN_PLAYTEST_SOFTWARE_ADAPTER otherwise.
    const capture = JSON.parse(
      await readFile(path.join(projectDirectory(), "artifacts-positive", "capture.json"), "utf8"),
    ) as { adapter?: Record<string, string>; rendererKind?: string };
    console.info(`webgpu adapter: ${JSON.stringify(capture.adapter ?? {})}`);
    expect(capture.rendererKind).toBe("webgpu");

    const results = new Map((report.assertionResults ?? []).map(({ id, pass }) => [id, pass]));
    for (const id of [
      "resource.state.aiming.atSteps",
      "resource.state.playerYaw",
      "resource.state.shots.atSteps",
      "resource.state.ammo.atSteps",
      "component.rifle.barrelAxisErrorDeg.value",
      "component.rifle.opticScreen.x",
    ]) {
      expect(results.get(id), `${id} must be evaluated`).toBeDefined();
      expect(results.get(id), `${id} must pass`).toBe(true);
    }
    const after = report.after as
      | { resources?: { state?: Record<string, number> } }
      | undefined;
    console.info(
      "raw observations:",
      JSON.stringify({
        ammo: after?.resources?.state?.ammo,
        shots: after?.resources?.state?.shots,
        playerYaw: after?.resources?.state?.playerYaw,
      }),
    );
  }, 600_000);

  test("negative control: removing right-button delivery leaves the input state unchanged", async () => {
    expect(projectPath).toBeDefined();
    const scenario = JSON.parse(await readFile(SCENARIO_PATH, "utf8")) as {
      steps: Array<{
        label?: string;
        pointerPosition?: { buttons?: number; x: number; y: number };
        press?: string;
      }>;
    };
    // The named mutation: strip every way this scenario can engage the sights — the right button
    // on `aim-down` and the `KeyF` hold on `aim-key` — so aim can never engage while the trigger
    // still fires. Everything else stays byte-identical.
    //
    // Both have to go. The scenario aims twice on purpose: once with the mouse, to prove the
    // right button, and once with a key, because the trigger is pressed alone. A chorded press
    // never reaches the page, so left-while-right-held would prove nothing about either.
    type PointerStep = NonNullable<
      Array<{ label?: string; pointerPosition?: { buttons?: number; x: number; y: number } }>
    >[number];
    const byLabel = new Map(scenario.steps.map((step) => [step.label ?? "", step]));
    const aimStep = byLabel.get("aim-down") as PointerStep | undefined;
    const fireStep = byLabel.get("fire-while-aiming") as PointerStep | undefined;
    expect(aimStep?.pointerPosition?.buttons).toBe(2);
    expect(fireStep?.pointerPosition?.buttons).toBe(1);
    const mutatedSteps: Array<Record<string, unknown>> = scenario.steps.map((step) => {
      if (step.label === "aim-down" && step.pointerPosition !== undefined) {
        const position = { x: step.pointerPosition.x, y: step.pointerPosition.y };
        return { ...step, pointerPosition: position };
      }
      // The aim key becomes a key the game binds to nothing. Deleting the press outright would
      // leave a step with no input at all, which the schema rejects before the run starts — the
      // control has to change what is delivered, not whether anything is.
      if (step.label === "aim-key") return { ...step, press: "KeyM" };
      return step;
    });
    const mutatedPath = path.join(projectDirectory(), "input-control-negative.playtest.json");
    await writeFile(mutatedPath, JSON.stringify({ ...scenario, steps: mutatedSteps }));

    const report = await runScenario(mutatedPath, path.join(projectDirectory(), "artifacts-negative"));

    console.info("RED observed: generated shooter input state unchanged");
    console.info(
      "failed assertions:",
      JSON.stringify(
        (report.assertionResults ?? []).filter(({ pass }) => !pass).map(({ id }) => id),
      ),
    );
    expect(report.pass).toBe(false);
    expect(exitCodeForReport(report)).toBe(1);
    const failed = new Set(
      (report.assertionResults ?? []).filter(({ pass }) => !pass).map(({ id }) => id),
    );
    // The red must name the input state itself, not a transport or parse failure.
    expect(failed.has("resource.state.aiming.atSteps")).toBe(true);
    expect(failed.has("component.rifle.opticScreen.x")).toBe(true);
  }, 600_000);

  test("scenario keeps a no-input control ahead of every input step", async () => {
    const scenario = JSON.parse(await readFile(SCENARIO_PATH, "utf8")) as {
      assert?: {
        components?: Array<{
          atSteps?: Array<{ equals: unknown; label: string }>;
          component: string;
          lte?: number;
        }>;
        resources?: Array<{ atSteps?: Array<{ equals: unknown; label: string }> }>;
      };
      steps: Array<{ kind?: string; label?: string }>;
    };
    expect(scenario.steps[0]).toMatchObject({ kind: "wait", label: "no-input-control" });
    // The aiming row's engaged leg pins a value only real input can produce, evaluated after a
    // settle drain so the scenario cannot pass from initial state or from event skew.
    const aiming = scenario.assert?.resources?.find((row) =>
      row.atSteps?.some(({ label }) => label === "aim-settle"),
    );
    expect(aiming?.atSteps).toContainEqual({ label: "aim-settle", equals: true });
    // And the shot is the crosshair's: the barrel converges onto the camera axis, which a
    // weapon firing down its own muzzle cannot satisfy.
    const barrel = scenario.assert?.components?.find(
      ({ component }) => component === "barrelAxisErrorDeg",
    );
    expect(barrel?.lte).toBe(0.5);
  });
});
