import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";
import { createWebEnginePlugin } from "../../packages/create-threenative/src/web-engine.ts";

// The native arm is one import-free ESM file, the same contract `examples/native-smoke` asserts.
// The ladder is compiled in rather than read from a query string: a native host has no URL.
const native = process.env.TN_BENCH_TARGET === "native";
// The `tn-engine-web` arm (PRD-573 slice 7): the same page as `tn-web`, with every `three` import bound
// to the Wasm engine (`packages/runtime-native/build/web`) instead of upstream three.
const webEngine = process.env.TN_BENCH_TARGET === "web-engine";
const WASM_ENGINE = resolve(
  import.meta.dirname,
  "../../packages/runtime-native/build/web/tn-native-engine-web.mjs",
);

/**
 * PRD-464 R3's character, as a URL the arm fetches rather than as bytes inlined in the bundle.
 *
 * The Khronos Fox is pinned by `benchmark/engine-load-test/sources.lock.json` and kept in the
 * git-ignored artifact tree, so it is read at run time rather than vendored, and the runner
 * (`scripts/engine-load-test/run-desktop.ts`) checks the digest against that lock before a build
 * ever sees it. The two runtimes read the same file in their own way: the native host's `fetch` is a
 * local file read, and the web arm's dev server serves the same absolute path under `/@fs/`. Inlining
 * the bytes instead would need a base64 decoder the host does not have — it has no `atob`.
 */
// Spelled out rather than imported from `src/ladder.ts`: this config is loaded by esbuild, which
// will not follow the source-tree module specifier. `FOX_RELATIVE_PATH` there is the same value, and
// the runner resolves the path for the Godot arm from that copy.
const DEFAULT_FOX = resolve(
  import.meta.dirname,
  "../../artifacts/engine-load-test/prd-449/bevy/src/assets/models/animated/Fox.glb",
);

function foxUrl(): string {
  const file = process.env.TN_BENCH_FOX ?? DEFAULT_FOX;
  return native ? `file://${file}` : `/@fs${file}`;
}

/** A production web build has no `/@fs/`, so it ships the pinned Fox beside the page when it exists. */
const SERVED_FOX = "bench-assets/Fox.glb";
function servedFox(): Plugin {
  const file = process.env.TN_BENCH_FOX ?? DEFAULT_FOX;
  return {
    name: "engine-load-test-served-fox",
    apply: "build",
    config: () => ({ define: { __TN_BENCH_FOX_URL__: JSON.stringify(`/${SERVED_FOX}`) } }),
    generateBundle() {
      if (existsSync(file))
        this.emitFile({ type: "asset", fileName: SERVED_FOX, source: readFileSync(file) });
    },
  };
}

function integers(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${name} must be a comma-separated list of non-negative integers.`);
    return value;
  });
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer, received '${raw}'.`);
  return value;
}

function modes(): string[] {
  const raw = process.env.TN_BENCH_MODES ?? "L1,L2,L3";
  return raw.split(",").map((part) => {
    // L4 is the per-cube-material rung and R1-R5 are PRD-464's realistic-scene ladder; both lists
    // are spelled out here because this config is loaded by esbuild, which will not follow a
    // `./src/workload.js` specifier.
    if (part !== "L1" && part !== "L2" && part !== "L3" && part !== "L4" && !/^R[1-5]$/u.test(part))
      throw new Error(`TN_BENCH_MODES holds an unknown mode '${part}'.`);
    return part;
  });
}

// Shipped as raw strings: the runtime resolves them through `parseAxesRecord`, the same parser the
// web entry uses, so an unset axis and a defaulted one cannot diverge between the runtimes.
function axesEnvironment(): Record<string, string | undefined> {
  return {
    geometry: process.env.TN_BENCH_GEOMETRY,
    hierarchyDepth: process.env.TN_BENCH_HIERARCHY_DEPTH,
    material: process.env.TN_BENCH_MATERIAL,
    mutationRate: process.env.TN_BENCH_MUTATION_RATE,
    passCount: process.env.TN_BENCH_PASSES,
    shadowCasterShare: process.env.TN_BENCH_SHADOW_CASTER_SHARE,
    visibleFraction: process.env.TN_BENCH_VISIBLE_FRACTION,
  };
}

export default defineConfig({
  plugins: native
    ? []
    : [
        servedFox(),
        ...(webEngine ? [createWebEnginePlugin({ engine: "threenative", wasm: WASM_ENGINE })] : []),
      ],
  build: native
    ? {
        lib: {
          entry: resolve(import.meta.dirname, "src/native.ts"),
          // Per-target filename: the desktop and Android arms build from the same source, and a
          // shared name means one arm's rebuild silently replaces the bundle the other is running.
          fileName: () => `engine-load-test-${process.env.TN_BENCH_PLATFORM ?? "desktop"}.js`,
          formats: ["es"],
        },
        minify: false,
        rollupOptions: { output: { codeSplitting: false } },
        target: "es2022",
      }
    : webEngine
      ? {
          outDir: "dist-engine",
          rollupOptions: { input: { loadTest: resolve(import.meta.dirname, "index.html") } },
        }
      : {
          rollupOptions: {
            input: {
              loadTest: resolve(import.meta.dirname, "index.html"),
              // The plain-Three control is a second entry on the same build, so both arms are served
              // from one `dist` out of one `vite build` and differ only in their module graph.
              plain: resolve(import.meta.dirname, "plain.html"),
              projectionConformance: resolve(import.meta.dirname, "projection-conformance.html"),
            },
          },
        },
  define: {
    // The native host has no `navigator`, so the target is stamped at build time. `--arm` on the
    // collector never sets it: the arm a report claims comes from the binary that ran.
    __TN_PLATFORM__: JSON.stringify(process.env.TN_BENCH_PLATFORM ?? "desktop"),
    __TN_WEB_ARM__: JSON.stringify(webEngine ? "tn-engine-web" : "tn-web"),
    __TN_BENCH_FOX_URL__: JSON.stringify(foxUrl()),
    __TN_BENCH_CONFIG__: JSON.stringify({
      animate: process.env.TN_BENCH_ANIMATE !== "off",
      axes: axesEnvironment(),
      // Stated by the operator, because the host does not expose it. The Pixel 8 used for PRD-117
      // runs at 120 Hz; a desktop under xvfb is 60.
      refreshHz: integer("TN_BENCH_REFRESH_HZ", 60),
      // The host surface the run was given, recorded on the report as `display`, and the
      // resolution every rung draws at: the runner runs R1-R4 in a 1280x720 window and R5 in a
      // 1920x1080 one, and `ladder.resolution` is read back off the drawing buffer to confirm it.
      width: integer("TN_BENCH_WIDTH", 1280),
      height: integer("TN_BENCH_HEIGHT", 720),
      frames: integer("TN_BENCH_FRAMES", 600),
      ladder: integers("TN_BENCH_LADDER", [256, 1024, 4096, 16384]),
      modes: modes(),
      // Per-frame phase telemetry (`src/phases.ts`), on for a `--pair` run and off for a shipped build.
      phases: process.env.TN_BENCH_PHASES === "1",
      repeats: integer("TN_BENCH_REPEATS", 3),
      // Stated by the operator, the same way `refreshHz` is: the native host has no URL to carry
      // `--source-sha` in, so without this a desktop report cannot name the build that produced it,
      // which is the one field a paired before/after needs to be readable as evidence.
      sourceSha: process.env.TN_BENCH_SOURCE_SHA,
      warmup: integer("TN_BENCH_WARMUP", 120),
    }),
  },
});
