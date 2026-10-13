// PRD-117 desktop arms. Both engines ship a native desktop binary, and both print the §5.1 run
// report between two markers because a native process has no `window` for the collector to read.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { FOX_RELATIVE_PATH, FOX_SHA256 } from "../../examples/engine-load-test/src/ladder.js";
import type { IWorkloadAxes } from "../../examples/engine-load-test/src/workload.js";

import { HostCpuRecorder, procCpuSource, withHostCpu } from "./host-cpu.js";

const BEGIN = "ENGINE_LOAD_TEST_JSON_BEGIN";
const END = "ENGINE_LOAD_TEST_JSON_END";

export interface IDesktopLadder {
  axes: IWorkloadAxes;
  frames: number;
  /** The host surface both engines are given, and therefore both engines' `display`. */
  height: number;
  ladder: string;
  modes: string;
  repeats: number;
  /** Stated by the operator, stamped into the bundle so the report names its own build. */
  sourceSha?: string;
  warmup: number;
  width: number;
}

/** The display every desktop arm runs on; "" means each arm provisions its own Xvfb. One resolver, so a pair never splits across displays. */
export function benchDisplay(env: NodeJS.ProcessEnv = process.env): string {
  return env.TN_BENCH_DISPLAY ?? env.DISPLAY ?? "";
}

// The native host talks to X11 and this machine's session is Wayland, so the run is wrapped in a
// virtual X server. `SDL_VIDEODRIVER=x11` is required as well: with `WAYLAND_DISPLAY` still set,
// SDL picks Wayland, the host reports "X11 display not available", and the arm never starts.
export function x11Environment(): NodeJS.ProcessEnv {
  const { WAYLAND_DISPLAY: _dropped, ...rest } = process.env;
  return { ...rest, SDL_VIDEODRIVER: "x11" };
}

/**
 * How long a killed group is given to die politely before it is sent the signal it cannot ignore.
 * The Godot desktop binary tears down a Vulkan swapchain and its shadow atlas on the way out; the
 * observation is that it did it on SIGTERM and never on SIGKILL, and a run that leaves a grey
 * window and a spinning process behind is a worse failure than a slow teardown.
 */
export const KILL_GRACE_MS = 3_000;

/**
 * Every process group this module has started and not yet reaped. The desktop arms are spawned
 * `detached`, which is what makes a group signal reach a host behind an `xvfb-run` wrapper — and
 * also what makes them survive the parent: a scoreboard run interrupted, a Ctrl-C, or a thrown
 * error all leave the child running, reparented to init, holding a window and a GPU context for as
 * long as it likes. This set is what a process that is going down takes with it.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` for the ordinary path and the three signals for the ones that do not run exit handlers.
  const take = (): void => killAllLiveGroups("SIGKILL");
  process.once("exit", take);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      take();
      process.exit(1);
    });
}

/** SIGTERM the whole group, then SIGKILL whatever is left after `KILL_GRACE_MS`. */
export function killProcessGroup(pid: number | undefined, graceMs = KILL_GRACE_MS): void {
  if (pid === undefined) return;
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone, or never a group leader: the direct signal still reaches the child.
      try {
        process.kill(pid, signal);
      } catch {
        /* nothing left to signal */
      }
    }
  };
  signalGroup("SIGTERM");
  setTimeout(() => {
    liveGroups.delete(pid);
    signalGroup("SIGKILL");
  }, graceMs).unref();
}

function killAllLiveGroups(signal: NodeJS.Signals): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* nothing left to signal */
      }
    }
  }
  liveGroups.clear();
}

/**
 * Spawns a desktop arm, waits for its report marker and takes the whole process group down on
 * every exit: the marker, an error, a timeout, or this process going away.
 *
 * Exported for the regression test that pins "returns on the marker, not on process exit" and the
 * one that pins "a timed-out arm leaves nothing running".
 */
export async function runCapturing(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** Every complete output line, as it arrives: the runner's hook for reading the host's CPU time at a marker. */
    onLine?: (line: string) => void;
    /** The new process group's id, once the child exists. */
    onStart?: (group: number) => void;
    timeoutMs?: number;
  },
): Promise<unknown> {
  installExitHook();
  const output: string[] = [];
  const partial = { stdout: "", stderr: "" };
  const lines = (stream: "stdout" | "stderr", chunk: unknown): void => {
    if (options.onLine === undefined) return;
    const parts = (partial[stream] + String(chunk)).split("\n");
    partial[stream] = parts.pop() ?? "";
    for (const line of parts) options.onLine(line);
  };
  const code = await new Promise<number>((resolve, reject) => {
    // Its own process group: the desktop arms run behind `xvfb-run`, so signalling the child only
    // reaches the wrapper and leaves the host it spawned running. The group reaches both.
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: true,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined) {
      liveGroups.add(child.pid);
      options.onStart?.(child.pid);
    }
    const stop = (): void => killProcessGroup(child.pid);
    // The report is complete at the END marker, so that is what this waits for — not process exit.
    // The native desktop host currently spins instead of exiting once its script finishes (it
    // reaches `_exit` and never leaves userspace), and waiting on `close` turned a finished
    // benchmark into a silent hang with the answer already sitting in the buffer. The Android
    // runner has always read its marker and then stopped the app; this now matches it.
    let settled = false;
    const finish = (value: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      stop();
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // A spawn that failed, or a host that never reached its marker, must not leave a group
      // behind either: the failure is the moment the orphan would otherwise be created.
      stop();
      reject(error);
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () =>
              fail(
                new Error(
                  `TN_BENCH_DESKTOP_TIMEOUT: ${command} ran past ${options.timeoutMs} ms without a run report.`,
                ),
              ),
            options.timeoutMs,
          );
    const collect = (chunk: unknown, stream: "stdout" | "stderr"): void => {
      lines(stream, chunk);
      output.push(String(chunk));
      // The page's own failure line: the owned player keeps running after its script throws, so waiting for
      // the timeout would turn a named error into a ten-minute hang.
      const failure = /ENGINE_LOAD_TEST_FAILED (.*)/u.exec(String(chunk));
      if (failure !== null) {
        fail(new Error(`TN_BENCH_PAGE_FAILED: ${failure[1]}`));
        return;
      }
      if (!settled && output.join("").includes(END)) {
        // Let the host print whatever trails the marker, then take the process down.
        setTimeout(() => finish(0), 1_000);
      }
    };
    child.stdout?.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => collect(chunk, "stderr"));
    child.once("error", (error) =>
      fail(new Error(`TN_BENCH_DESKTOP_SPAWN:${command} (${error.message})`)),
    );
    child.once("close", (value) => {
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      finish(value ?? 1);
    });
  });
  const text = output.join("");
  const start = text.indexOf(BEGIN);
  const stop = text.indexOf(END);
  if (start === -1 || stop === -1) {
    throw new Error(
      `TN_BENCH_NO_REPORT: ${command} exited ${code} without a run report.\n${text.slice(-2_000)}`,
    );
  }
  // The payload is emitted in `TNJSON:` chunks so Android's ~1 KB logcat line cap cannot cut it;
  // a desktop run emits the same chunks and rejoins identically.
  const body = text.slice(start + BEGIN.length, stop);
  const chunks = body
    .split("\n")
    .map((line) => {
      const marker = line.indexOf("TNJSON:");
      return marker === -1 ? "" : line.slice(marker + "TNJSON:".length);
    })
    .join("");
  return JSON.parse((chunks.trim().length > 0 ? chunks : body).trim());
}

/**
 * PRD-464 R3's character, checked once per run against the digest
 * `benchmark/engine-load-test/sources.lock.json` pins. The bytes live in the git-ignored artifact
 * tree, so a missing or substituted file has to fail here — before either engine spends a run on it —
 * rather than as a count mismatch in the report half an hour later. Returns undefined when no
 * ladder rung was asked for, so an L-only run never needs the asset to exist.
 */
export function resolveFoxAsset(repoRoot: string, modes: string): string | undefined {
  // Any realistic rung resolves it: R1 and R2 build nothing, but the runner cannot know that the
  // ladder's own factory will not be constructed for them, and a missing file must be reported
  // here rather than as a rung that failed to draw characters.
  if (!modes.split(",").some((mode) => /^R[1-5]$/u.test(mode.trim()))) return undefined;
  const file = path.resolve(repoRoot, process.env.TN_BENCH_FOX ?? FOX_RELATIVE_PATH);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error(
      `TN_BENCH_FOX_MISSING: ${file} could not be read (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== FOX_SHA256)
    throw new Error(`TN_BENCH_FOX_HASH: ${file} is ${digest}, not the pinned ${FOX_SHA256}.`);
  return file;
}

/**
 * How long a desktop arm may take before it is killed. The same budget the browser and device lanes
 * use, and the same one the desktop arms used to have none of: a rung that never reaches its
 * marker used to leave its host running for as long as the host felt like it, which is how an
 * interrupted scoreboard ends up with grey windows and a machine that is not idle for the next run.
 */
export function desktopTimeoutMs(options: IDesktopLadder): number {
  const cells =
    options.ladder.split(",").length * options.modes.split(",").length * options.repeats;
  // Budget half a second per frame at the top rung; the arm reports long before this fires.
  return Math.max(600_000, cells * options.frames * 500);
}

/**
 * Per-frame thread CPU is opt-in (`TN_BENCH_ENGINE_METRICS=1`, which `--pair` sets): each host then prints one
 * `TN_PLAYER_FRAME` line per frame with `cpuFrameCpuMs` and `presentCpuMs`, on the same clock in both arms.
 */
export function metricsEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.TN_BENCH_ENGINE_METRICS === "1" ? { TN_PLAYER_METRICS: "1" } : {};
}

export async function runTnDesktop(repoRoot: string, options: IDesktopLadder): Promise<unknown> {
  const example = path.join(repoRoot, "examples/engine-load-test");
  const fox = resolveFoxAsset(repoRoot, options.modes);
  await mkdir(path.join(example, "dist"), { recursive: true });
  const buildEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(fox === undefined ? {} : { TN_BENCH_FOX: fox }),
    TN_BENCH_FRAMES: String(options.frames),
    TN_BENCH_GEOMETRY: options.axes.geometry,
    TN_BENCH_HIERARCHY_DEPTH: String(options.axes.hierarchyDepth),
    TN_BENCH_LADDER: options.ladder,
    TN_BENCH_MATERIAL: options.axes.material,
    TN_BENCH_MODES: options.modes,
    TN_BENCH_MUTATION_RATE: String(options.axes.mutationRate),
    TN_BENCH_PASSES: String(options.axes.passCount),
    TN_BENCH_REPEATS: String(options.repeats),
    TN_BENCH_SHADOW_CASTER_SHARE: String(options.axes.shadowCasterShare),
    // Stamped into the bundle so the report names the build. The web arm carries the same value in
    // its URL; this one has no URL.
    TN_BENCH_SOURCE_SHA: options.sourceSha,
    TN_BENCH_TARGET: "native",
    TN_BENCH_VISIBLE_FRACTION: String(options.axes.visibleFraction),
    TN_BENCH_WARMUP: String(options.warmup),
    TN_BENCH_HEIGHT: String(options.height),
    TN_BENCH_WIDTH: String(options.width),
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["vite", "build"], {
      cwd: example,
      env: buildEnvironment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`TN_BENCH_NATIVE_BUILD_FAILED: exit ${code}`)),
    );
  });

  const binary = path.join(repoRoot, "packages/runtime-native/build/tn-linux/mystral");
  const bundle = path.join(example, "dist/engine-load-test-desktop.js");
  const hostArgs = [
    "run",
    bundle,
    "--width",
    String(options.width),
    "--height",
    String(options.height),
  ];
  // Godot's desktop arm reports `vsync off`, so the host has to present uncapped too or the two
  // arms are not comparable: pinned to a 60 Hz display ThreeNative reads 16.6 ms at every rung and
  // its real cost is unknowable. The host refuses to fall back to FIFO, so this fails loudly.
  if (process.env.TN_BENCH_VSYNC !== "on") hostArgs.push("--no-vsync");
  // The runner reads the host's CPU at the page's window markers (`host-cpu.ts`).
  let source: ReturnType<typeof procCpuSource> | undefined;
  const recorder = new HostCpuRecorder({ read: () => source?.read() });
  const metrics = metricsEnvironment(process.env);
  const capture = {
    cwd: repoRoot,
    onLine: (line: string) => recorder.line(line),
    onStart: (group: number) => {
      source = procCpuSource(group, binary);
    },
    timeoutMs: desktopTimeoutMs(options),
  };
  // Use Godot's display by default. A caller may explicitly select another display; with no
  // display at all, the headless lane still provisions Xvfb below.
  const display = benchDisplay();
  if (display.length > 0) {
    return withHostCpu(
      await runCapturing(binary, hostArgs, {
        ...capture,
        env: { ...x11Environment(), ...metrics, DISPLAY: display },
      }),
      recorder,
      metrics.TN_PLAYER_METRICS === "1",
    );
  }
  // `scripts/xvfb.sh`, never `xvfb-run`: the wrapper's cleanup kill can replace the run's own status.
  return withHostCpu(
    await runCapturing("sh", [path.join(repoRoot, "scripts/xvfb.sh"), binary, ...hostArgs], {
      ...capture,
      env: {
        ...x11Environment(),
        ...metrics,
        TN_XVFB_SCREEN: `${options.width}x${options.height + 180}x24`,
      },
    }),
    recorder,
    metrics.TN_PLAYER_METRICS === "1",
  );
}

export async function runGodotDesktop(repoRoot: string, options: IDesktopLadder): Promise<unknown> {
  const godot = process.env.GODOT_BIN ?? "godot";
  const exportDir = path.join(repoRoot, "artifacts/engine-load-test/godot-desktop");
  await mkdir(exportDir, { recursive: true });
  const binary = path.join(exportDir, "load_test.x86_64");
  installExitHook();
  const fox = resolveFoxAsset(repoRoot, options.modes);
  // R3's characters have to reach Godot's *importer*, not this arm: reading the glTF at run time
  // with `GLTFDocument` corrupts the heap in this Godot build and the arm dies with its report
  // unflushed. So the pinned bytes are staged inside the project for the export and removed after,
  // whatever happens — a throw here must not leave a third-party asset sitting in a tracked tree.
  if (fox !== undefined) await copyFile(fox, path.join(repoRoot, FOX_PROJECT_ASSET));
  try {
    return await exportAndRunGodot(repoRoot, godot, binary, options, fox);
  } finally {
    if (fox !== undefined) {
      const staged = path.join(repoRoot, FOX_PROJECT_ASSET);
      await rm(staged, { force: true });
      await rm(`${staged}.import`, { force: true });
    }
  }
}

/** Where the pinned character is staged inside the Godot project, and read from as `res://`. */
export const FOX_PROJECT_ASSET = "benchmark/godot-load-test/fox.glb";

async function exportAndRunGodot(
  repoRoot: string,
  godot: string,
  binary: string,
  options: IDesktopLadder,
  fox: string | undefined,
): Promise<unknown> {
  await new Promise<void>((resolve, reject) => {
    // Grouped and bounded for the same reason the arms are: an export that never returns is a Godot
    // process holding the run rather than a run that failed cleanly.
    const child = spawn(
      godot,
      [
        "--headless",
        "--path",
        path.join(repoRoot, "benchmark/godot-load-test"),
        "--export-release",
        "Linux",
        binary,
      ],
      { detached: true, stdio: ["ignore", "inherit", "inherit"] },
    );
    if (child.pid !== undefined) liveGroups.add(child.pid);
    const timer = setTimeout(() => {
      killProcessGroup(child.pid);
      reject(new Error(`TN_BENCH_GODOT_EXPORT_TIMEOUT: ${godot} exported for over 10 minutes.`));
    }, 600_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      killProcessGroup(child.pid);
      reject(new Error(`TN_BENCH_GODOT_MISSING: could not run \`${godot}\` (${error.message})`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      if (code !== 0) {
        killProcessGroup(child.pid);
        reject(new Error(`TN_BENCH_GODOT_EXPORT_FAILED: exit ${code}`));
        return;
      }
      resolve();
    });
  });

  // The window size is the surface both engines are given, so it travels on the same query the
  // rest of the ladder does. The 3D viewport inside it is a per-rung decision (PRD-464's R5 is the
  // rung that draws at 1920x1080), and the rung records that separately.
  const query = new URLSearchParams({
    frames: String(options.frames),
    height: String(options.height),
    ladder: options.ladder,
    modes: options.modes,
    repeats: String(options.repeats),
    warmup: String(options.warmup),
    width: String(options.width),
    ...(fox === undefined ? {} : { fox }),
  }).toString();
  return runCapturing(binary, ["--rendering-driver", "vulkan", "--", `--query=${query}`], {
    cwd: repoRoot,
    timeoutMs: desktopTimeoutMs(options),
  });
}
