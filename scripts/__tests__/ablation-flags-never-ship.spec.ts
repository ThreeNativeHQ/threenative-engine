import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PRD-226's ablation arms deliberately render the wrong picture: `TN_ABLATE_BACKEND` no-ops the hot
 * backend command entry points so the frame can be decomposed by subtraction. A build carrying it is
 * a measurement build and must never reach a user, a preset, a CI lane or a shipped Android config.
 *
 * The mutation that reddens this file: set the option's default to `ON` in
 * `packages/runtime-native/CMakeLists.txt`, or add `"TN_ABLATE_BACKEND": "ON"` to any preset's
 * `cacheVariables`.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const runtimeNative = join(repoRoot, "packages", "runtime-native");

const ABLATION_FLAGS = ["TN_ABLATE_BACKEND"] as const;
const OBSOLETE_MEASUREMENT_FLAGS = ["TN_WEBGPU_BATCHED_PASS", "threenativeBatchedPass"] as const;

interface ICMakePresets {
  readonly configurePresets?: ReadonlyArray<{
    readonly name: string;
    readonly cacheVariables?: Readonly<Record<string, unknown>>;
  }>;
}

describe("PRD-226 ablation flags never ship", () => {
  it("declares every ablation flag OFF by default", () => {
    const cmake = readFileSync(join(runtimeNative, "CMakeLists.txt"), "utf8");
    for (const flag of ABLATION_FLAGS) {
      const declaration = new RegExp(`option\\(${flag}\\s+"[^"]*"\\s+(\\w+)\\)`).exec(cmake);
      expect(declaration, `${flag} must be declared with option()`).not.toBeNull();
      expect(declaration?.[1], `${flag} must default to OFF`).toBe("OFF");
    }
  });

  it("enables no ablation flag in any CMake preset", () => {
    const presets = JSON.parse(
      readFileSync(join(runtimeNative, "CMakePresets.json"), "utf8"),
    ) as ICMakePresets;
    const configurePresets = presets.configurePresets ?? [];
    expect(configurePresets.length).toBeGreaterThan(0);

    for (const preset of configurePresets) {
      for (const flag of ABLATION_FLAGS) {
        expect(
          preset.cacheVariables?.[flag],
          `preset ${preset.name} must not set ${flag}`,
        ).toBeUndefined();
      }
    }
  });

  it("enables no ablation flag in the shipped Android build", () => {
    const gradle = readFileSync(join(runtimeNative, "android", "app", "build.gradle.kts"), "utf8");
    for (const flag of ABLATION_FLAGS) {
      expect(gradle.includes(flag), `build.gradle.kts must not name ${flag}`).toBe(false);
    }
  });

  it("ships no obsolete pass-only measurement switch or implementation", () => {
    const productionFiles = [
      join(runtimeNative, "CMakeLists.txt"),
      join(runtimeNative, "android", "app", "build.gradle.kts"),
      join(runtimeNative, "src", "webgpu", "bindings.cpp"),
      join(runtimeNative, "src", "webgpu", "bindings_state.h"),
    ];
    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      for (const flag of OBSOLETE_MEASUREMENT_FLAGS) {
        expect(source.includes(flag), `${file} must not name ${flag}`).toBe(false);
      }
    }
    expect(() =>
      readFileSync(join(runtimeNative, "src", "runtime-scripts", "batched-pass-encoder.js")),
    ).toThrow();
  });

  it("guards the ablation header behind its flag", () => {
    const header = readFileSync(join(runtimeNative, "src", "webgpu", "ablation.h"), "utf8");
    // Every redefinition lives inside the flag's #if; nothing leaks into a default build.
    const guarded = header.slice(header.indexOf("#if defined(TN_ABLATE_BACKEND)"));
    for (const line of header.split("\n")) {
      if (!line.startsWith("#define wgpu")) continue;
      expect(guarded.includes(line), `${line} must sit inside the TN_ABLATE_BACKEND guard`).toBe(
        true,
      );
    }
    expect(header).toContain("#endif  // TN_ABLATE_BACKEND");
  });
});

/**
 * PRD-840 (H4): every TN_* environment flag the owned engine reads is declared once in `engine/foundation/flags.h`,
 * as read once per process or live (each call), and no other engine file calls getenv. A flag added without a
 * declaration here, or read around flags.h, fails.
 *
 * The mutation that reddens this file: add `std::getenv("TN_X")` to any file under `src/engine/`, or change a
 * flag's `Read::` in flags.h.
 */
const ENGINE_FLAGS: Readonly<Record<string, "Once" | "Live">> = {
  TN_JOB_WORKERS: "Live",
  TN_ANIMATION_POSE_OBSERVATION: "Live",
  TN_MATERIAL_DIAGNOSTICS: "Once",
  TN_GPU_PASSES: "Live",
  TN_SHADOW_INSTANCE_GROUPS: "Live",
  TN_SHADOW_INSTANCE_CULL: "Live",
  TN_PROGRAM_PROBES: "Once",
  TN_SHADOW_PAGE_SCAN: "Once",
  TN_PROJECTION_WALKS: "Once",
  TN_BATCH_DECISION_CACHE: "Once",
  TN_GPU_JOINT_DRAW_USE: "Once",
  TN_GAME_SPANS: "Live",
  TN_PLAYER_WIDTH: "Live",
  TN_PLAYER_HEIGHT: "Live",
  TN_PLAYER_TITLE: "Live",
  TN_PLAYER_VSYNC: "Live",
  TN_PLAYER_PRIORITY: "Live",
  TN_PLAYER_METRICS: "Live",
  TN_PLAYER_GPU_TIMING: "Live",
  TN_PLAYER_MAIN_THREAD_CPU: "Live",
  TN_RENDER_THREAD: "Live",
  TN_STABLE_PASSES: "Live",
  TN_STABLE_ROWS: "Live",
  TN_GPU_THREAD: "Live",
  TN_RENDER_PREPARE_SPLIT: "Live",
  TN_BENCH_LAUNCH_MS: "Live",
  TN_PLAYTEST_MAILBOX_ROOT: "Live",
  TN_NATIVE_ASSET_PACKAGE: "Live",
  TN_NATIVE_JS_MATH: "Live",
  TN_DEBUG: "Live",
  TN_PLAYER_CROSSINGS: "Live",
  TN_FRAME_SPANS: "Live",
  TN_UI_RENDERER: "Live",
  TN_JS_CPU_PROFILE_START_FRAME: "Once",
  TN_PS4_PAD_TRACE: "Once",
};

function engineSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return engineSources(file);
    return /\.(?:cpp|h|hpp|inl)$/u.test(entry.name) ? [file] : [];
  });
}

describe("PRD-840 engine flags are declared in flags.h", () => {
  const engine = join(runtimeNative, "src", "engine");
  const flagsHeader = join(engine, "foundation", "flags.h");
  const header = readFileSync(flagsHeader, "utf8");
  const declared = [
    ...header.matchAll(/inline constexpr Flag (\w+)\{"(TN_\w+)", Read::(Once|Live)\}/gu),
  ].map(([, id, name, read]) => ({ id: id as string, name: name as string, read }));

  it("declares exactly the enumerated flags, each read once or live", () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.fromEntries(declared.map(({ name, read }) => [name, read]))).toEqual(
      ENGINE_FLAGS,
    );
  });

  it("reads the environment nowhere in the engine but flags.h", () => {
    const sources = engineSources(engine).filter((file) => file !== flagsHeader);
    expect(sources.length).toBeGreaterThan(0);
    const readers = sources.filter((file) => /\bgetenv\s*\(/u.test(readFileSync(file, "utf8")));
    expect(readers).toEqual([]);
  });

  it("reads each declared flag through its declared kind", () => {
    const all = engineSources(engine)
      .filter((file) => file !== flagsHeader)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const { id, read } of declared) {
      const call = `flags::${read === "Once" ? "once" : "read"}<flags::${id}>()`;
      expect(all.includes(call), `${id} must be read as ${call}`).toBe(true);
    }
  });
});
