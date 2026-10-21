// The `tn-engine-desktop` arm (PRD-573 v1.10): the same load-test harness, bundled for the owned engine player
// (`tn-native-engine-v8`, built with TN_ENGINE_ONLY + TN_ENGINE_PLAYER) instead of the legacy host. It
// mirrors `runTnDesktop`: build the bundle, launch the binary on a display, wait for the report markers.
// Anything the engine cannot draw fails the bundle or the run by name; it is never skipped.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  bundleNativeEngine,
  cookNativeEngineAssets,
} from "../../packages/runtime-native/scripts/bundle-native-engine.mjs";
import { HostCpuRecorder, procCpuSource, withHostCpu } from "./host-cpu.js";
import { BenchError } from "./report.js";
import {
  type IDesktopLadder,
  benchDisplay,
  desktopTimeoutMs,
  metricsEnvironment,
  resolveFoxAsset,
  runCapturing,
  x11Environment,
} from "./run-desktop.js";

/** Where `cmake --preset tn-linux -B build/tn-engine -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON` puts the player. */
export const ENGINE_PLAYER = "packages/runtime-native/build/tn-engine/tn-native-engine-player-v8";
const FOX_ASSET = "Fox.glb";

/**
 * The build-time constants `vite.config.ts` stamps for the legacy bundle, spelled as esbuild `define`s. They
 * are the same values from the same options, so the two arms are configured by one description of the run.
 */
export function engineDefines(
  options: IDesktopLadder,
  fox: string | undefined,
): Record<string, string> {
  const raw = (value: unknown): string => JSON.stringify(value);
  return {
    __TN_PLATFORM__: raw("engine-desktop"),
    // Read by the legacy bundle's `GLTFLoader` path only; the engine arm reads the cooked package.
    __TN_BENCH_FOX_URL__: raw(fox === undefined ? "" : `file://${fox}`),
    __TN_BENCH_CONFIG__: raw({
      animate: process.env.TN_BENCH_ANIMATE !== "off",
      axes: {
        geometry: options.axes.geometry,
        hierarchyDepth: String(options.axes.hierarchyDepth),
        material: options.axes.material,
        mutationRate: String(options.axes.mutationRate),
        passCount: String(options.axes.passCount),
        shadowCasterShare: String(options.axes.shadowCasterShare),
        visibleFraction: String(options.axes.visibleFraction),
      },
      frames: options.frames,
      height: options.height,
      ladder: options.ladder.split(",").map(Number),
      modes: options.modes.split(","),
      phases: process.env.TN_BENCH_PHASES === "1",
      ...(process.env.TN_BENCH_PROJECTION === "js" ? { projection: "js" } : {}),
      refreshHz: Number(process.env.TN_BENCH_REFRESH_HZ ?? 60),
      repeats: options.repeats,
      ...(options.sourceSha === undefined ? {} : { sourceSha: options.sourceSha }),
      warmup: options.warmup,
      width: options.width,
    }),
  };
}

/** The player's environment for a measured run: its window is the drawing buffer, presented uncapped. */
export function engineEnvironment(
  options: IDesktopLadder,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...env,
    TN_PLAYER_HEIGHT: String(options.height),
    TN_PLAYER_VSYNC: env.TN_BENCH_VSYNC === "on" ? "1" : "0",
    TN_PLAYER_WIDTH: String(options.width),
    // Per-frame thread CPU is opt-in, and a pair turns it on for both arms: each prints the same line per frame.
    ...metricsEnvironment(env),
    // The crossing histogram costs a lock and a hash per crossing, so it is its own opt-in beside the phases.
    ...(env.TN_BENCH_CROSSINGS === "1" ? { TN_PLAYER_CROSSINGS: "1" } : {}),
  };
}

/** The surface the player says it opened, `[Playtest] ... <w>x<h>, ...`; the drawing buffer is that size. */
export function playerSurface(text: string): { height: number; width: number } | undefined {
  const match = /threenative-native-engine ready: .*?, (\d+)x(\d+), mailbox/u.exec(text);
  return match === null ? undefined : { height: Number(match[2]), width: Number(match[1]) };
}

export async function runTnEngineDesktop(
  repoRoot: string,
  options: IDesktopLadder,
): Promise<unknown> {
  const binary = path.join(repoRoot, ENGINE_PLAYER);
  const fox = resolveFoxAsset(repoRoot, options.modes);
  const out = path.join(repoRoot, "examples/engine-load-test/dist/engine");
  const bundle = path.join(out, "engine-load-test-engine.js");
  await mkdir(out, { recursive: true });
  await bundleNativeEngine({
    boot: false,
    define: engineDefines(options, fox),
    entry: path.join(repoRoot, "examples/engine-load-test/src/native-engine.ts"),
    host: true,
    outfile: bundle,
  });
  if (fox !== undefined) {
    // The Fox the legacy arm decodes from its file, cooked into the package the player reads beside the bundle.
    const project = path.join(out, "cook");
    const source = path.join(project, "source");
    await rm(project, { force: true, recursive: true });
    await mkdir(source, { recursive: true });
    await copyFile(fox, path.join(source, FOX_ASSET));
    // The player's glTF loader decodes images embedded in the model and has no reader for the cook's shared
    // image files, which the native package does not carry: the Fox ships with its texture inside it.
    await writeFile(
      path.join(project, "threenative.config.ts"),
      "export default { assets: { models: { sharedImages: false } } };\n",
    );
    await cookNativeEngineAssets({ outfile: bundle, project, source });
  }
  let surface = "";
  let source: ReturnType<typeof procCpuSource> | undefined;
  const recorder = new HostCpuRecorder({ read: () => source?.read() });
  const display = benchDisplay();
  const env = engineEnvironment(options, {
    ...x11Environment(),
    ...(display === "" ? {} : { DISPLAY: display }),
  });
  const args = [bundle];
  const capture = {
    cwd: repoRoot,
    env,
    onLine: (line: string) => {
      if (line.includes("threenative-native-engine ready")) surface = line;
      recorder.line(line);
    },
    onStart: (group: number) => {
      source = procCpuSource(group, binary);
    },
    timeoutMs: desktopTimeoutMs(options),
  };
  const report =
    display === ""
      ? await runCapturing("sh", [path.join(repoRoot, "scripts/xvfb.sh"), binary, ...args], {
          ...capture,
          env: { ...env, TN_XVFB_SCREEN: `${options.width}x${options.height + 180}x24` },
        })
      : await runCapturing(binary, args, capture);
  const seen = playerSurface(surface);
  if (seen === undefined)
    throw new BenchError(
      "TN_BENCH_ENGINE_SURFACE",
      "the player never reported the surface it opened",
    );
  if (seen.width !== options.width || seen.height !== options.height)
    throw new BenchError(
      "TN_BENCH_ENGINE_SURFACE",
      `the player opened ${seen.width}x${seen.height}, not the requested ${options.width}x${options.height}`,
    );
  return withHostCpu(report, recorder, env.TN_PLAYER_METRICS === "1");
}
