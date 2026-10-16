import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildEngineTestsThenSelect,
  coverageConfigurationBlocker,
  engineTestExecutable,
  instrumentedFilesFromLcov,
  mergeInstrumentedFiles,
  requireCoverageProfile,
  requireEngineCoverageSources,
  requireInvocationProfiles,
  requireSelectedEngineTests,
  selectEngineCoverageTests,
  summarizeNativeCoverage,
} from "../scripts/measure-native-coverage.mjs";

const cmake = readFileSync(join(import.meta.dirname, "..", "CMakeLists.txt"), "utf8");
const nativeEngineCore = readFileSync(
  join(import.meta.dirname, "..", "cmake", "NativeEngineCore.cmake"),
  "utf8",
);

describe("native coverage reporting", () => {
  it("reports zero-hit files instead of omitting them", () => {
    const report = summarizeNativeCoverage({
      blockedTargets: [],
      compiledSourceFiles: ["src/webgpu/bindings.cpp", "src/http/http_client.cpp"],
      configuration: "tn-linux",
      instrumentedFiles: [
        { covered: 4, lines: 8, path: "src/webgpu/bindings.cpp" },
        { covered: 0, lines: 6, path: "src/http/http_client.cpp" },
      ],
      sourceFiles: ["src/webgpu/bindings.cpp", "src/http/http_client.cpp"],
    });

    expect(report.compiled).toContainEqual({
      covered: 0,
      lines: 6,
      path: "src/http/http_client.cpp",
      percent: 0,
    });
    expect(report.subsystems).toContainEqual({
      covered: 0,
      lines: 6,
      name: "http",
      percent: 0,
    });
  });

  it("unions executable lines and hits across per-binary LCOV reports", () => {
    expect(
      instrumentedFilesFromLcov([
        "SF:/repo/src/runtime.cpp\nDA:10,1\nDA:11,0\nend_of_record\n",
        "SF:/repo/src/runtime.cpp\nDA:10,0\nDA:11,2\nend_of_record\n",
      ]),
    ).toEqual([]);

    const runtimePath = join(import.meta.dirname, "..", "src", "runtime.cpp");
    expect(
      instrumentedFilesFromLcov([
        `SF:${runtimePath}\nDA:10,1\nDA:11,0\nend_of_record\n`,
        `SF:${runtimePath}\nDA:10,0\nDA:11,2\nend_of_record\n`,
      ]),
    ).toEqual([{ covered: 2, lines: 2, path: "src/runtime.cpp" }]);
  });

  it("fails when profile data is missing", () => {
    expect(() => requireCoverageProfile("/missing/merged.profdata", () => false)).toThrow(
      /coverage profile data is missing.*merged\.profdata/u,
    );
  });

  it("names uncompiled files separately from zero-percent files", () => {
    const report = summarizeNativeCoverage({
      blockedTargets: [],
      compiledSourceFiles: ["src/http/http_client.cpp"],
      configuration: "tn-linux",
      instrumentedFiles: [{ covered: 0, lines: 6, path: "src/http/http_client.cpp" }],
      sourceFiles: ["src/http/http_client.cpp", "src/raytracing/bindings.cpp"],
    });

    expect(report.compiled.map(({ path }) => path)).toEqual(["src/http/http_client.cpp"]);
    expect(report.notCompiled).toEqual(["src/raytracing/bindings.cpp"]);
  });

  it("fails if llvm-cov omits a file proven compiled by compile_commands", () => {
    expect(() =>
      summarizeNativeCoverage({
        blockedTargets: [],
        compiledSourceFiles: ["src/http/http_client.cpp", "src/runtime.cpp"],
        configuration: "tn-linux",
        instrumentedFiles: [{ covered: 1, lines: 1, path: "src/runtime.cpp" }],
        sourceFiles: ["src/http/http_client.cpp", "src/runtime.cpp"],
      }),
    ).toThrow(/llvm-cov omitted compiled source files: src\/http\/http_client\.cpp/u);
  });

  it("preserves every target that failed to build", () => {
    const report = summarizeNativeCoverage({
      blockedTargets: [
        {
          reason: "native physics library is disabled",
          target: "threenative-physics-actuation-bindings-test",
        },
      ],
      configuration: "tn-linux",
      compiledSourceFiles: ["src/runtime.cpp"],
      instrumentedFiles: [{ covered: 1, lines: 1, path: "src/runtime.cpp" }],
      sourceFiles: ["src/runtime.cpp"],
    });

    expect(report.blockedTargets).toEqual([
      {
        reason: "native physics library is disabled",
        target: "threenative-physics-actuation-bindings-test",
      },
    ]);
  });

  it("allows only targets excluded by the accepted configuration to be blocked", () => {
    expect(coverageConfigurationBlocker("threenative-physics-actuation-bindings-test")).toMatch(
      /TN_ENABLE_NATIVE_PHYSICS=OFF/u,
    );
    expect(coverageConfigurationBlocker("threenative-video-recorder-state-test")).toMatch(
      /TN_ENABLE_VIDEO=OFF/u,
    );
    expect(
      coverageConfigurationBlocker("threenative-render-pass-class-table-test"),
    ).toBeUndefined();
  });

  it("fails when any native invocation profile is missing", () => {
    expect(() =>
      requireInvocationProfiles(["render-0-", "compute-0-"], ["render-0-123.profraw"]),
    ).toThrow(/invocation profiles are missing: compute-0-/u);
  });

  it("keeps instrumentation opt-in", () => {
    expect(cmake).toMatch(/option\(TN_ENABLE_COVERAGE[^\n]*OFF\)/u);
    expect(cmake).toMatch(/if\(TN_ENABLE_COVERAGE\)/u);
  });

  it("merges owned and legacy measurements into one report", () => {
    const report = summarizeNativeCoverage({
      blockedTargets: [],
      compiledSourceFiles: ["src/runtime.cpp", "src/engine/renderer.cpp"],
      configuration: "tn-linux",
      instrumentedFiles: mergeInstrumentedFiles(
        [{ covered: 3, lines: 4, path: "src/runtime.cpp" }],
        [{ covered: 2, lines: 6, path: "src/engine/renderer.cpp" }],
      ),
      sourceFiles: ["src/runtime.cpp", "src/engine/renderer.cpp"],
    });

    expect(report.compiled.map(({ path }) => path)).toEqual([
      "src/engine/renderer.cpp",
      "src/runtime.cpp",
    ]);
    expect(report.total).toEqual({ covered: 5, lines: 10, percent: 50 });
  });

  it("keeps a source shared by both trees once, with its larger line and hit count", () => {
    const merged = mergeInstrumentedFiles(
      [
        { covered: 2, lines: 10, path: "src/webgpu/context.cpp" },
        { covered: 1, lines: 4, path: "src/http/http_client.cpp" },
      ],
      [
        { covered: 3, lines: 10, path: "src/webgpu/context.cpp" },
        { covered: 5, lines: 8, path: "src/engine/renderer.cpp" },
      ],
    );

    expect(merged).toEqual([
      { covered: 5, lines: 8, path: "src/engine/renderer.cpp" },
      { covered: 1, lines: 4, path: "src/http/http_client.cpp" },
      { covered: 3, lines: 10, path: "src/webgpu/context.cpp" },
    ]);
    expect(merged.filter(({ path }) => path === "src/webgpu/context.cpp")).toHaveLength(1);
  });

  it("fails when the engine tree compiled or instrumented no owned source", () => {
    expect(() =>
      requireEngineCoverageSources({
        compiledSourceFiles: [],
        instrumentedFiles: [{ covered: 1, lines: 1, path: "src/engine/renderer.cpp" }],
      }),
    ).toThrow(/engine coverage compiled zero owned engine source files/u);
    expect(() =>
      requireEngineCoverageSources({
        compiledSourceFiles: ["src/engine/renderer.cpp"],
        instrumentedFiles: [],
      }),
    ).toThrow(/engine coverage instrumented zero owned engine source files/u);
    // A legacy-only tree is not an engine tree: src/runtime.cpp is not owned.
    expect(() =>
      requireEngineCoverageSources({
        compiledSourceFiles: ["src/runtime.cpp"],
        instrumentedFiles: [{ covered: 1, lines: 1, path: "src/runtime.cpp" }],
      }),
    ).toThrow(/engine coverage compiled zero owned engine source files/u);
  });

  it("requires each compiled owned source to have an owned measurement", () => {
    // A compiled owned source without a measurement fails even when another owned source is measured.
    expect(() =>
      requireEngineCoverageSources({
        compiledSourceFiles: ["src/engine/renderer.cpp", "src/engine/scene.cpp"],
        instrumentedFiles: [{ covered: 2, lines: 3, path: "src/engine/renderer.cpp" }],
      }),
    ).toThrow(/engine coverage omitted owned engine source files: src\/engine\/scene\.cpp/u);
    // A fully measured owned tree passes, even with shared sources beside it.
    expect(() =>
      requireEngineCoverageSources({
        compiledSourceFiles: ["src/engine/renderer.cpp", "src/webgpu/context.cpp"],
        instrumentedFiles: [
          { covered: 2, lines: 3, path: "src/engine/renderer.cpp" },
          { covered: 0, lines: 4, path: "src/webgpu/context.cpp" },
        ],
      }),
    ).not.toThrow();
  });

  it("fails when a compiled owned source has no measurement in either tree", () => {
    expect(() =>
      summarizeNativeCoverage({
        blockedTargets: [],
        compiledSourceFiles: ["src/runtime.cpp", "src/engine/renderer.cpp"],
        configuration: "tn-linux",
        instrumentedFiles: mergeInstrumentedFiles([
          { covered: 1, lines: 1, path: "src/runtime.cpp" },
          { covered: 2, lines: 3, path: "src/other.cpp" },
        ]),
        sourceFiles: ["src/runtime.cpp", "src/engine/renderer.cpp"],
      }),
    ).toThrow(/llvm-cov omitted compiled source files: src\/engine\/renderer\.cpp/u);
  });

  it("selects native-engine executable tests, including wrapped executables", () => {
    const build = join(import.meta.dirname, "..", "build", "tn-linux-coverage-engine");
    const pacing = join(build, "tn-native-engine-pacing-test");
    const presentation = join(build, "tn-native-engine-presentation-test");
    const renderDriver = join(build, "tn-native-engine-render-driver");
    const executables = new Set([pacing, presentation, renderDriver]);
    const isExecutable = (path) => executables.has(path);
    const inventory = [
      {
        command: [pacing],
        name: "native_engine_pacing",
        properties: [{ name: "LABELS", value: ["native-engine"] }],
      },
      {
        command: ["sh", "/repo/scripts/xvfb.sh", presentation, "resizes"],
        name: "native_engine_present_resize",
        properties: [{ name: "LABELS", value: ["native-engine"] }],
      },
      {
        command: [
          "/usr/bin/cmake",
          `-DGRAPH=${join(build, "native-engine-target-graph.txt")}`,
          "-P",
          "CheckNativeEngineGraph.cmake",
        ],
        name: "native_engine_target_graph",
        properties: [{ name: "LABELS", value: ["native-engine"] }],
      },
      {
        // A pnpm wrapper that spawns the instrumented render driver through --driver.
        command: [
          "/usr/local/bin/pnpm",
          "--filter",
          "@threenative/three-native",
          "exec",
          "tsx",
          "tests/compatibility/run-native.ts",
          "--driver",
          renderDriver,
          "--renders",
          "--out",
          join(build, "render_lit.json"),
        ],
        name: "native_engine_render_lit",
        properties: [{ name: "LABELS", value: ["native-engine"] }],
      },
      {
        // A pnpm reference check that spawns no binary.
        command: [
          "/usr/local/bin/pnpm",
          "--workspace-root",
          "exec",
          "tsx",
          "model-lod-reference.ts",
          "--check",
        ],
        name: "native_engine_model_lod_reference_current",
        properties: [{ name: "LABELS", value: ["native-engine"] }],
      },
      {
        command: ["/usr/bin/node", "other.mjs"],
        name: "some_other_test",
        properties: [{ name: "LABELS", value: ["tn-known-red"] }],
      },
    ];

    const { selected, unprofiled } = selectEngineCoverageTests(inventory, build, isExecutable);

    expect(selected).toEqual([
      { executable: pacing, name: "native_engine_pacing" },
      { executable: presentation, name: "native_engine_present_resize" },
      { executable: renderDriver, name: "native_engine_render_lit" },
    ]);
    expect(unprofiled).toEqual([
      "native_engine_target_graph",
      "native_engine_model_lod_reference_current",
    ]);
    expect(engineTestExecutable(["sh", "-c", "run", "--", pacing], build, isExecutable)).toBe(pacing);
  });

  it("routes a labelled inspection test that only reads a binary to unprofiled correctness", () => {
    const build = join(import.meta.dirname, "..", "build", "tn-linux-coverage-engine");
    const inspected = join(build, "tn-native-engine-world-cells-test");
    const renderDriver = join(build, "tn-native-engine-render-driver");
    const executables = new Set([inspected, renderDriver]);
    const isExecutable = (path) => executables.has(path);
    const nativeEngine = { name: "LABELS", value: ["native-engine"] };
    const inventory = [
      {
        // Reads the executable artifact through --binary but never launches it: no profile exists.
        command: [
          "/usr/bin/node",
          join(import.meta.dirname, "..", "scripts", "inspect-js-free.mjs"),
          "--binary",
          inspected,
          "--native-world",
        ],
        name: "native_engine_strict_artifact_inspect",
        properties: [{ name: "LABELS", value: ["native-engine", "coverage-inspection"] }],
      },
      {
        // The same built executable behind a wrapper's --driver is launched, so it stays measurable.
        command: ["/usr/local/bin/pnpm", "exec", "tsx", "run-native.ts", "--driver", renderDriver],
        name: "native_engine_render_lit",
        properties: [nativeEngine],
      },
      {
        command: ["/usr/bin/cmake", "-P", "CheckNativeEngineGraph.cmake"],
        name: "native_engine_target_graph",
        properties: [nativeEngine],
      },
    ];

    const { selected, unprofiled } = selectEngineCoverageTests(inventory, build, isExecutable);

    expect(selected).toEqual([{ executable: renderDriver, name: "native_engine_render_lit" }]);
    expect(unprofiled).toEqual([
      "native_engine_strict_artifact_inspect",
      "native_engine_target_graph",
    ]);
    // The guard for a launched executable is untouched: its missing profile still fails.
    expect(() => requireInvocationProfiles(["native_engine_render_lit-0-"], [])).toThrow(
      /invocation profiles are missing/u,
    );
  });

  it("labels the world artifact inspector for coverage in CMake", () => {
    expect(nativeEngineCore).toMatch(
      /native_engine_strict_artifact_inspect PROPERTIES\s+LABELS "native-engine;coverage-inspection"/u,
    );
  });

  it("collects the CTest inventory after building the engine aggregate on a fresh tree", () => {
    const build = join(import.meta.dirname, "..", "build", "tn-linux-coverage-engine");
    const pacing = join(build, "tn-native-engine-pacing-test");
    const built = new Set();
    const isExecutable = (path) => built.has(path);
    const label = { name: "LABELS", value: ["native-engine"] };
    // A fresh configure registers the test's metadata only; the command naming the built executable
    // appears after the aggregate build. This mirrors a real fresh-tree CTest probe.
    const metadataOnly = [{ name: "native_engine_pacing", properties: [label] }];
    const withCommand = [
      { command: [pacing], name: "native_engine_pacing", properties: [label] },
    ];
    const order = [];
    const inventory = () => {
      order.push("inventory");
      return built.has(pacing) ? withCommand : metadataOnly;
    };

    // Metadata without a command is not measurable, so a pre-build read finds no engine test.
    expect(selectEngineCoverageTests(metadataOnly, build, isExecutable)).toEqual({
      selected: [],
      unprofiled: ["native_engine_pacing"],
    });
    const { selected, unprofiled } = buildEngineTestsThenSelect({
      build: () => {
        order.push("build");
        built.add(pacing);
      },
      buildDirectory: build,
      inventory,
      isExecutable,
    });
    // The build must run before the inventory is read, or the command is still absent.
    expect(order).toEqual(["build", "inventory"]);
    expect(selected).toEqual([{ executable: pacing, name: "native_engine_pacing" }]);
    expect(unprofiled).toEqual([]);
  });

  it("fails when no native-engine executable test is selectable", () => {
    expect(() => requireSelectedEngineTests([])).toThrow(
      /no measurable native-engine executable test/u,
    );
  });
});
