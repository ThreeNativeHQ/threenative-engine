import { createHash } from "node:crypto";
import fs, { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ILadderArm, MeasurementClock } from "../../examples/engine-load-test/src/driver.js";
import {
  downscaleFrame,
  drawnFrameReader,
} from "../../examples/engine-load-test/src/frame-read.js";
import {
  type ILoadTestHarness,
  countPipelineCreates,
  initInstanceMatrices,
  writeInstanceMatrices,
} from "../../examples/engine-load-test/src/game.js";
import {
  type IModuleGraphEntry,
  extractModuleSpecifiers,
  hashServedModuleGraph,
  hashWorkloadModuleGraph,
  isBenchmarkWorkloadModule,
} from "../../examples/engine-load-test/src/identity.js";
import {
  LADDER_FOX_HEIGHT,
  characterPlacement,
  expectedLadderCounts,
  foxMeasurementReason,
  foxParityReason,
  foxScale,
} from "../../examples/engine-load-test/src/ladder.js";
import {
  PHASES,
  createPhaseRecorder,
  threadCpuClock,
  topCrossings,
} from "../../examples/engine-load-test/src/phases.js";
import {
  CULLED_OFFSET_X,
  DEFAULT_AXES,
  type IWorkloadAxes,
  RENDER_MODES,
  assertRungAxesSupported,
  canonicalPlacementBytes,
  createLcg,
  createPlacements,
  culledOffsetX,
  isAuthoredRung,
  isMutated,
  isProjectedRung,
  isVisible,
  parseAxesRecord,
  positionHash,
  resolveAxes,
  uniqueMaterialColor,
} from "../../examples/engine-load-test/src/workload.js";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import {
  assertHardwareAdapter,
  assertPlainThreePilot,
  browserLaunchArgs,
} from "../engine-load-test/browser.js";
import { HostCpuRecorder, parseProcStat, withHostCpu } from "../engine-load-test/host-cpu.js";
import {
  HOST_PROJECTION_CROSSING_BUDGET,
  pairRows,
  pairVerdict,
  renderPairMarkdown,
  reportFacets,
  seriesFamilies,
} from "../engine-load-test/pair.js";
import {
  ARMS,
  type IRunReport,
  PERFORMANCE_BASELINES,
  PERFORMANCE_REGRESSION_TOLERANCE,
  checkEquivalence,
  checkPerformance,
  compare,
  knee,
  looksVsyncPinned,
  parseRunReport,
  readHostLoad,
  renderArmMarkdown,
  scoreboardRows,
  summarize,
  withHostLoad,
} from "../engine-load-test/report.js";
import { MINIMUM_BATTERY_PERCENT } from "../engine-load-test/run-android.js";
import { KILL_GRACE_MS, benchDisplay, runCapturing } from "../engine-load-test/run-desktop.js";
import { engineDefines, engineEnvironment, playerSurface } from "../engine-load-test/run-engine.js";
import {
  WEB_ENGINE_WASM,
  freshWasm,
  webArtifactBytes,
} from "../engine-load-test/run-web-engine.js";

const BEGIN_MARKER = "ENGINE_LOAD_TEST_JSON_BEGIN";
const END_MARKER = "ENGINE_LOAD_TEST_JSON_END";

function series(valueMs: number, length = 8): number[] {
  return Array.from({ length }, () => valueMs);
}

function rung(overrides: Partial<IRunReport["rungs"][number]> = {}): IRunReport["rungs"][number] {
  return {
    drawCalls: 4097,
    frameMs: series(10),
    mode: "L1",
    objectCount: 4096,
    positionHash: "aabbccdd",
    repeat: 0,
    triangles: 49_176,
    visibleObjects: 4096,
    ...overrides,
  };
}

function report(overrides: Partial<IRunReport> = {}): IRunReport {
  return {
    arm: "tn-web",
    build: { notes: "", type: "release" },
    device: { battery: null, label: "desktop-chrome-linux" },
    display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
    driver: { adapter: "test adapter", renderer: "test renderer" },
    engine: { name: "threenative", version: "workspace" },
    rungs: [rung()],
    ...overrides,
  };
}

// The ladder the knee tests read: three rungs under the 20 ms line, one over it.
function ladderReport(topP95: number, arm: IRunReport["arm"] = "tn-web"): IRunReport {
  return report({
    arm,
    engine: arm.startsWith("godot")
      ? { name: "godot", version: "4.7.1" }
      : { name: "threenative", version: "workspace" },
    rungs: [
      rung({
        drawCalls: 257,
        objectCount: 256,
        positionHash: "1111",
        triangles: 3074,
        visibleObjects: 256,
        frameMs: series(6),
      }),
      rung({
        drawCalls: 1025,
        objectCount: 1024,
        positionHash: "2222",
        triangles: 12_290,
        visibleObjects: 1024,
        frameMs: series(9),
      }),
      rung({
        drawCalls: 4097,
        objectCount: 4096,
        positionHash: "3333",
        triangles: 49_154,
        visibleObjects: 4096,
        frameMs: series(19),
      }),
      rung({
        drawCalls: 16_385,
        objectCount: 16_384,
        positionHash: "4444",
        triangles: 196_610,
        visibleObjects: 16_384,
        frameMs: series(topP95),
      }),
    ],
  });
}

describe("benchmark browser selection", () => {
  it("selects the native Wayland path when a Wayland socket is present", () => {
    expect(browserLaunchArgs("wayland-0")).toContain("--ozone-platform=wayland");
    expect(browserLaunchArgs(undefined)).not.toContain("--ozone-platform=wayland");
  });
});

describe("engine load test workload", () => {
  it("extracts executable module specifiers without reading strings or comments as imports", () => {
    const source = `
      const text = 'import "./fake-string.js"';
      // export { fake } from "./fake-comment.js";
      import /* comment */ "./side-effect.js";
      export { value } from /* comment */ "./named.js";
      const dynamic = import /* comment */ ("./dynamic.js");
      const asset = new URL("./asset.bin", import.meta.url);
      void text;
      void dynamic;
      void asset;
    `;
    expect(extractModuleSpecifiers(source)).toEqual([
      "./side-effect.js",
      "./named.js",
      "./dynamic.js",
      "./asset.bin",
    ]);
  });

  it("extracts static template imports, decodes escapes, and rejects computed imports", async () => {
    const source = ["import(`./dynamic.js`);", 'import("./escaped\\u002ejs");'].join("\n");
    expect(extractModuleSpecifiers(source)).toEqual(["./dynamic.js", "./escaped.js"]);
    for (const source of [
      "import(moduleName);",
      "const value = { promise: import(path) };",
      "const value = { promise: [0, import(path)] };",
      "const value = { promise: f(0, import(path)) };",
      "const value = { promise: (0, import(path)) };",
      "const value = { promise: 0 * import(path) };",
      "const value = { promise: 0 ** import(path) };",
      "const value = { promise: { ...import(path) } };",
      "const value = { promise: [...import(path)] };",
      "const value = { promise: f(...import(path)) };",
      "import(`./${name}.js`);",
      "import(`./static.js` + suffix);",
    ]) {
      expect(() => extractModuleSpecifiers(source)).toThrow(
        /TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:computed module specifier/u,
      );
    }
    expect(extractModuleSpecifiers("const obj = { import(value) { return value; } };")).toEqual([]);
    for (const [source, specifier] of [
      ['const value = { ...import("./object.js") };', "./object.js"],
      ['const value = [...import("./array.js")];', "./array.js"],
      ['consume(...import("./call.js"));', "./call.js"],
    ] as const) {
      expect(extractModuleSpecifiers(source)).toEqual([specifier]);
    }
    for (const source of [
      "const obj = { *import(value) { return value; } };",
      "const obj = { async *import(value) { return value; } };",
      "const template = `${{ import(value) {} }}`;",
    ]) {
      expect(extractModuleSpecifiers(source)).toEqual([]);
    }

    const module = (value: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(value),
      url: "http://127.0.0.1:5199/@fs/repo/examples/engine-load-test/src/game.ts",
    });
    const escapedQuote = String.raw`import "./a\"; import \"./b";`;
    expect(extractModuleSpecifiers(escapedQuote)).toEqual(['./a"; import "./b']);
    expect(await hashServedModuleGraph([module(escapedQuote)])).not.toBe(
      await hashServedModuleGraph([module('import "./a"; import "./b";')]),
    );
    expect(await hashServedModuleGraph([module('import("./escaped\\u002ejs");')])).toBe(
      await hashServedModuleGraph([module('import("./escaped.js");')]),
    );
  });

  it("canonicalizes observed Vite dependency cache tokens without dropping meaningful queries", async () => {
    const module = (url: string, source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const graph = (token: string, query = `?v=${token}`): IModuleGraphEntry[] => [
      module(
        "http://127.0.0.1:5199/src/game.ts",
        `import "/node_modules/.vite/deps/three_webgpu.js${query}";`,
      ),
      module("http://127.0.0.1:5199/src/workload.ts", "export const count = 16384;"),
      module(
        `http://127.0.0.1:5199/node_modules/.vite/deps/three_webgpu.js${query}`,
        "export const implementation = true;",
      ),
    ];
    const baseline = graph("11111111");
    const candidate = graph("22222222");
    const configuration = { frames: 1_800, ladder: [16_384], modes: ["L2", "L3"] };
    expect(await hashServedModuleGraph(candidate)).toBe(await hashServedModuleGraph(baseline));
    expect(
      await hashWorkloadModuleGraph(
        candidate.filter(isBenchmarkWorkloadModule),
        configuration,
        candidate,
      ),
    ).toBe(
      await hashWorkloadModuleGraph(
        baseline.filter(isBenchmarkWorkloadModule),
        configuration,
        baseline,
      ),
    );

    const meaningfulQuery = graph("11111111", "?v=11111111&raw");
    expect(await hashServedModuleGraph(meaningfulQuery)).not.toBe(
      await hashServedModuleGraph(baseline),
    );
  });

  it("keeps engine implementation modules out of benchmark workload identity", async () => {
    const module = (url: string, source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const game = module("http://127.0.0.1:5199/src/game.ts", 'import "./workload.ts";');
    const workload = module("http://127.0.0.1:5199/src/workload.ts", "export const count = 1;");
    const engine = module(
      "http://127.0.0.1:5199/@fs/home/repo/packages/core/src/renderProjection.ts",
      "export const implementation = 1;",
    );
    const changedEngine = module(engine.url, "export const implementation = 2;");
    const configuration = { frames: 1_800, ladder: [16_384], modes: ["L2", "L3"] };
    const workloadGraph = [game, workload, engine].filter(isBenchmarkWorkloadModule);
    const changedWorkloadGraph = [game, workload, changedEngine].filter(isBenchmarkWorkloadModule);
    expect(workloadGraph).toHaveLength(2);
    expect(await hashWorkloadModuleGraph(workloadGraph, configuration)).toBe(
      await hashWorkloadModuleGraph(changedWorkloadGraph, configuration),
    );
  });

  it("keeps executable template contents in the identity after statement boundaries", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/value.js",
    });
    for (const prefix of ["try {} catch {}\n", "debugger\n", "globalThis.auditValue = 1\n{}\n"]) {
      const baseline = `${prefix}/\`/.test("x"); globalThis.auditValue = \`//# sourceMappingURL=data:AAA\`;`;
      const candidate = baseline.replace("AAA", "BBB");

      expect(await hashServedModuleGraph([module(candidate)])).not.toBe(
        await hashServedModuleGraph([module(baseline)]),
      );
    }
  });

  it("keeps filtered workload identity stable across absolute engine import roots", async () => {
    const module = (url: string, source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const graph = (worktree: string): IModuleGraphEntry[] => [
      module(
        "http://127.0.0.1:5199/src/game.ts",
        `import "/@fs${worktree}/packages/core/src/renderProjection.ts"; import "/src/workload.ts";`,
      ),
      module("http://127.0.0.1:5199/src/workload.ts", "export const count = 1;"),
      module(
        `http://127.0.0.1:5199/@fs${worktree}/packages/core/src/renderProjection.ts`,
        "export const projection = 1;",
      ),
    ];
    const configuration = { frames: 1_800, ladder: [16_384], modes: ["L2", "L3"] };
    const baseline = graph("/repo/.worktrees/baseline");
    const candidate = graph("/repo/.worktrees/candidate");

    expect(
      await hashWorkloadModuleGraph(
        baseline.filter(isBenchmarkWorkloadModule),
        configuration,
        baseline,
      ),
    ).toBe(
      await hashWorkloadModuleGraph(
        candidate.filter(isBenchmarkWorkloadModule),
        configuration,
        candidate,
      ),
    );
  });

  it("wires the browser collector to the syntax-aware scanner and workload filter", async () => {
    // The served-graph walk moved to the driver both web arms share; `main.ts` is the TN arm's own
    // projection and culling wiring, and `plain.ts` reaches the same walk without the framework.
    const driverSource = await readFile(
      path.join(process.cwd(), "examples/engine-load-test/src/driver.ts"),
      "utf8",
    );
    expect(driverSource).toMatch(/extractModuleSpecifiers\(source\)/u);
    expect(driverSource).toMatch(/filter\(isBenchmarkWorkloadModule\)/u);
    expect(driverSource).toMatch(
      /hashWorkloadModuleGraph\([\s\S]*workloadModules[\s\S]*workloadGraph/u,
    );
    expect(driverSource).not.toMatch(/IMPORT_FROM_PATTERN|IMPORT_SIDE_EFFECT_PATTERN/u);
  });

  it("should produce the LCG sequence PRD-117 §3.3 specifies", () => {
    const random = createLcg();
    const first = random();
    expect(first).toBeCloseTo(((1337 * 1664525 + 1013904223) % 4294967296) / 4294967296, 12);
    expect(createLcg()()).toBe(first);
  });

  it("should place cubes identically on every call so both arms hash the same scene", () => {
    expect(positionHash(createPlacements(1024))).toBe(positionHash(createPlacements(1024)));
    expect(positionHash(createPlacements(1024))).not.toBe(positionHash(createPlacements(256)));
    expect(positionHash(createPlacements(1024))).toMatch(/^[0-9a-f]{8}$/);
  });

  it("detects a changed placement after the legacy first-eight window", () => {
    const original = createPlacements(16);
    const changed = original.map((placement) => ({ ...placement }));
    const ninth = changed[9];
    if (!ninth) throw new Error("expected the tenth placement");
    ninth.x += 1;
    expect(positionHash(changed)).toBe(positionHash(original));
    const digest = (placements: typeof original) =>
      createHash("sha256")
        .update(
          canonicalPlacementBytes(
            placements.length,
            (index) => placements[index] as (typeof original)[number],
          ),
        )
        .digest("hex");
    expect(digest(changed)).not.toBe(digest(original));
  });

  it("should reproduce the PRD-117 scene and identity at the default axes", () => {
    // The literal hashes are the identity key the Godot port is compared on (PRD-400 Phase 1). A
    // scene change that moved a cube would fail here, not silently on the next benchmark run.
    expect(positionHash(createPlacements(1024))).toBe("78812d31");
    expect(positionHash(createPlacements(16384))).toBe("3acfd9c3");
    expect(resolveAxes()).toEqual(DEFAULT_AXES);
    expect(parseAxesRecord({})).toEqual(DEFAULT_AXES);
    expect(DEFAULT_AXES).toEqual({
      geometry: "shared",
      hierarchyDepth: 0,
      material: "shared",
      mutationRate: 1,
      passCount: 1,
      shadowCasterShare: 0,
      visibleFraction: 1,
    });
    // The old scene exactly: every object dirty and every object on the lattice.
    for (let index = 0; index < 256; index += 1) {
      expect(isMutated(index, DEFAULT_AXES.mutationRate)).toBe(true);
      expect(culledOffsetX(index, DEFAULT_AXES.visibleFraction)).toBe(0);
    }
  });

  it("should move exactly its axes on a nondefault combo, deterministically", () => {
    const axes = resolveAxes({
      geometry: "unique",
      hierarchyDepth: 2,
      material: "unique",
      mutationRate: 0.1,
      passCount: 2,
      shadowCasterShare: 0.5,
      visibleFraction: 0.5,
    });
    expect(axes).toEqual({
      geometry: "unique",
      hierarchyDepth: 2,
      material: "unique",
      mutationRate: 0.1,
      passCount: 2,
      shadowCasterShare: 0.5,
      visibleFraction: 0.5,
    });
    const indices = Array.from({ length: 4096 }, (_, index) => index);
    // Deterministic: two reads over the same axis pick the same subset.
    expect(indices.map((index) => isMutated(index, 0.1))).toEqual(
      indices.map((index) => isMutated(index, 0.1)),
    );
    expect(indices.some((index) => isMutated(index, 0))).toBe(false);
    expect(indices.filter((index) => isMutated(index, 1)).length).toBe(4096);
    for (const rate of [0.01, 0.1]) {
      const count = indices.filter((index) => isMutated(index, rate)).length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(4096);
    }
    const visible = indices.filter((index) => isVisible(index, 0.5));
    expect(visible.length).toBeGreaterThan(1024);
    expect(visible.length).toBeLessThan(3072);
    // Culled objects clear the far plane; visible ones stay on the lattice.
    expect(culledOffsetX(visible[0] as number, 0.5)).toBe(0);
    const culled = indices.find((index) => !isVisible(index, 0.5)) as number;
    expect(culledOffsetX(culled, 0.5)).toBe(CULLED_OFFSET_X);
    for (const bad of [
      { geometry: "many" },
      { hierarchyDepth: 1.5 },
      { mutationRate: -1 },
      { passCount: 0 },
      { shadowCasterShare: 2 },
      { visibleFraction: 2 },
    ]) {
      expect(() => resolveAxes(bad)).toThrow(/TN_BENCH_BAD_AXIS/u);
    }
    expect(() => parseAxesRecord({ passCount: "two" })).toThrow(/TN_BENCH_BAD_AXIS:passCount/u);
  });

  it("should bake instance matrices once and only rewrite mutated instances per frame", () => {
    const placements = createPlacements(64);
    const axesAt = (mutationRate: number): IWorkloadAxes => ({ ...DEFAULT_AXES, mutationRate });
    const dummy = {
      matrix: {},
      position: { set: () => undefined },
      rotation: { set: () => undefined },
      updateMatrix: () => undefined,
    } as unknown as Parameters<typeof writeInstanceMatrices>[4];
    const makeBatch = (): {
      instanceMatrix: Parameters<typeof writeInstanceMatrices>[5];
      instanced: Parameters<typeof writeInstanceMatrices>[0];
      written: number[];
    } => {
      const written: number[] = [];
      return {
        written,
        instanced: {
          instanceMatrix: { needsUpdate: false },
          setMatrixAt: (index: number) => written.push(index),
        } as unknown as Parameters<typeof writeInstanceMatrices>[0],
        instanceMatrix: { copy: () => undefined } as unknown as Parameters<
          typeof writeInstanceMatrices
        >[5],
      };
    };

    // The base pose lands on every instance exactly once, and the upload is requested once here.
    const baked = makeBatch();
    initInstanceMatrices(baked.instanced, placements, axesAt(0), dummy, baked.instanceMatrix);
    expect(baked.written).toEqual(placements.map((_, index) => index));
    expect(baked.instanced.instanceMatrix.needsUpdate).toBe(true);

    // The old default: every instance is dirty, so every one is rewritten and an upload is asked.
    const allDirty = makeBatch();
    expect(
      writeInstanceMatrices(
        allDirty.instanced,
        placements,
        3,
        axesAt(1),
        dummy,
        allDirty.instanceMatrix,
      ),
    ).toBe(true);
    expect(allDirty.written.length).toBe(placements.length);

    // A mutation rate of 0 rewrites nothing, so the caller never marks the buffer dirty.
    const staticBatch = makeBatch();
    expect(
      writeInstanceMatrices(
        staticBatch.instanced,
        placements,
        3,
        axesAt(0),
        dummy,
        staticBatch.instanceMatrix,
      ),
    ).toBe(false);
    expect(staticBatch.written).toEqual([]);

    // A partial rate touches exactly the mutated subset.
    const partial = makeBatch();
    expect(
      writeInstanceMatrices(
        partial.instanced,
        placements,
        3,
        axesAt(0.5),
        dummy,
        partial.instanceMatrix,
      ),
    ).toBe(true);
    expect(partial.written).toEqual(
      placements.map((_, index) => index).filter((index) => isMutated(index, 0.5)),
    );
  });

  it("fails closed on L2 cells its single InstancedMesh cannot express", () => {
    // The default L2 cell is unchanged and must keep working.
    expect(() => assertRungAxesSupported("L2", DEFAULT_AXES)).not.toThrow();
    expect(() =>
      assertRungAxesSupported("L1", { ...DEFAULT_AXES, geometry: "unique" }),
    ).not.toThrow();
    // A whole-batch shadow share is expressible; visibility is not because L2 disables culling.
    expect(() =>
      assertRungAxesSupported("L2", { ...DEFAULT_AXES, shadowCasterShare: 1 }),
    ).not.toThrow();
    for (const unsupported of [
      { geometry: "unique" as const },
      { material: "unique" as const },
      { visibleFraction: 0 },
      { visibleFraction: 0.5 },
      { shadowCasterShare: 0.5 },
    ]) {
      expect(() => assertRungAxesSupported("L2", { ...DEFAULT_AXES, ...unsupported })).toThrow(
        /TN_BENCH_UNSUPPORTED_L2_AXES/u,
      );
    }
  });

  it("adds L4 as the per-cube-material rung on both arms, with the colour Godot mirrors", async () => {
    // One flag, not a new project: L4 is L3's shipped-default projection over L1's one-mesh-per-cube
    // authoring, and only the material changes. L2 stays the single batch, L1 the un-projected
    // control, and the projection still runs over L3 and L4 alone.
    // R1-R5 are PRD-464's realistic-scene ladder on top of the same list: authored and projected
    // rungs like L3, because a ladder row that quietly measured the un-projected scene would be a
    // different experiment from the one its name states.
    expect(RENDER_MODES).toEqual(["L1", "L2", "L3", "L4", "R1", "R2", "R3", "R4", "R5"]);
    expect(RENDER_MODES.map(isAuthoredRung)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(RENDER_MODES.map(isProjectedRung)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // Distinct per cube over the whole ladder, and a pure function of the index, so the two arms
    // compute the same colour and no engine has two materials it could pair.
    const colors = Array.from({ length: 16_384 }, (_, index) => uniqueMaterialColor(index));
    expect(new Set(colors).size).toBe(16_384);
    expect(uniqueMaterialColor(0)).toBe(0xff0000);
    expect(uniqueMaterialColor(0)).not.toBe(uniqueMaterialColor(1));

    // The GDScript twin builds the same three channels from the same index, and takes the L1 branch
    // both when it builds the rung and when it steps it — the two places L1's authoring is used.
    const godot = await readFile(
      path.join(process.cwd(), "benchmark/godot-load-test/load_test.gd"),
      "utf8",
    );
    expect(godot).toMatch(/Color\(\s*1\.0, float\(\(index >> 16\) & 0xff\) \/ 255\.0/u);
    expect(godot.match(/_mode == "L1" or _mode == "L4"/gu) ?? []).toHaveLength(2);

    // Both entries install the projection for L4 as they do for L3; only L3 keeps the two guards
    // that refuse to publish an un-projected frame, because a decline is L4's answer, not a fault.
    // PRD-464's R1-R5 are L3's authoring, so they keep both guards too.
    for (const entry of ["driver.ts", "native-run.ts"]) {
      const source = await readFile(
        path.join(process.cwd(), "examples/engine-load-test/src", entry),
        "utf8",
      );
      expect(source).toMatch(/if \(isProjectedRung\((rung\.)?mode\)\)/u);
      expect(source).toMatch(/if \((rung\.)?mode === "L3"( \|\| isRealisticRung\(\1?mode\))?\)/u);
    }
    const game = await readFile(
      path.join(process.cwd(), "examples/engine-load-test/src/game.ts"),
      "utf8",
    );
    expect(game).toMatch(/if \(isAuthoredRung\(rung\.mode\)\)/u);
    expect(game).toMatch(/owned\?\.color\.setHex\(uniqueMaterialColor\(index\)\)/u);
  });

  it("wires every axis through the CLI and both runtime entry points", async () => {
    const load = (relative: string): Promise<string> =>
      readFile(path.join(process.cwd(), relative), "utf8");
    const [cli, web, native, vite, game, driver] = await Promise.all([
      load("scripts/engine-load-test/cli.ts"),
      load("examples/engine-load-test/src/main.ts"),
      load("examples/engine-load-test/src/native-run.ts"),
      load("examples/engine-load-test/vite.config.ts"),
      load("examples/engine-load-test/src/game.ts"),
      load("examples/engine-load-test/src/driver.ts"),
    ]);
    expect(cli).toMatch(/parseAxesRecord\(\{/u);
    expect(cli).toMatch(/shadowCasterShare: flag\("shadow-caster-share"\)/u);
    // The axes are read where the page is, in the driver both web arms drive.
    expect(driver).toMatch(/parseAxesRecord\(Object\.fromEntries\(parameters\.entries\(\)\)\)/u);
    expect(driver).toMatch(/createLoadTestHarness\([\s\S]*arm\.createCollapse/u);
    expect(web).toMatch(/createCollapse: \(scene, options\) =>\s+new SceneRenderProjection/u);
    expect(native).toMatch(/parseAxesRecord\(config\.axes\)/u);
    expect(native).toMatch(/createLoadTestHarness\([\s\S]*axes,[\s\S]*new SceneRenderProjection/u);
    expect(vite).toMatch(/TN_BENCH_SHADOW_CASTER_SHARE/u);
    expect(vite).toMatch(/axes: axesEnvironment\(\)/u);
    // L2's unsupported cells fail closed at the one place a rung is built.
    expect(game).toMatch(/assertRungAxesSupported\(rung\.mode, axes\)/u);
  });

  it("should keep artifact identity independent of source labels and workload identity byte-sensitive", async () => {
    const module = (url: string, source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const artifactModules = [
      module("/src/main.ts", "import './game.ts';"),
      module("/src/game.ts", "import './workload.ts';"),
      module("/src/workload.ts", "export const ladder = [256, 1024];"),
    ];
    const workloadConfiguration = {
      frames: 1_800,
      ladder: [16_384],
      modes: ["L2", "L3"],
      repeats: 1,
      warmup: 120,
    };
    const artifactHash = await hashServedModuleGraph(artifactModules);
    const relabeledArtifactHash = await hashServedModuleGraph(artifactModules);
    const workloadHash = await hashWorkloadModuleGraph(
      artifactModules.slice(1),
      workloadConfiguration,
    );
    const changedWorkloadHash = await hashWorkloadModuleGraph(
      [
        ...artifactModules.slice(1, 2),
        module("/src/workload.ts", "export const ladder = [256, 1024, 4096];"),
      ],
      workloadConfiguration,
    );
    const changedConfigurationHash = await hashWorkloadModuleGraph(artifactModules.slice(1), {
      ...workloadConfiguration,
      modes: ["L2"],
    });
    expect(relabeledArtifactHash).toBe(artifactHash);
    expect(changedWorkloadHash).not.toBe(workloadHash);
    expect(changedConfigurationHash).not.toBe(workloadHash);

    const candidateIdentity = { artifactHash, sourceSha: "candidate-sha", workloadHash };
    const relabeledIdentity = {
      artifactHash: relabeledArtifactHash,
      sourceSha: "other-sha",
      workloadHash,
    };
    expect(relabeledIdentity.artifactHash).toBe(candidateIdentity.artifactHash);
    expect(relabeledIdentity.sourceSha).not.toBe(candidateIdentity.sourceSha);

    const driverSource = await readFile(
      path.join(process.cwd(), "examples/engine-load-test/src/driver.ts"),
      "utf8",
    );
    expect(driverSource).toMatch(/hashServedModuleGraph\(artifactModules\)/u);
    expect(driverSource).toMatch(
      /hashWorkloadModuleGraph\([\s\S]*workloadModules[\s\S]*workloadGraph/u,
    );
    expect(driverSource).not.toMatch(/hashServedModuleGraph\(sourceSha\)/u);
  });

  it("should recognize workload source assets emitted by the production build", () => {
    const entry = (url: string): IModuleGraphEntry => ({ bytes: new Uint8Array([1]), url });
    expect(isBenchmarkWorkloadModule(entry("http://127.0.0.1:5199/assets/game-CdxDcIvp.ts"))).toBe(
      true,
    );
    expect(
      isBenchmarkWorkloadModule(entry("http://127.0.0.1:5199/assets/workload-BGzP-H1X.ts")),
    ).toBe(true);
    expect(
      isBenchmarkWorkloadModule(entry("http://127.0.0.1:5199/assets/three.webgpu-BnCeQ44k.js")),
    ).toBe(false);
  });

  it("should keep graph identity stable across absolute worktree roots", async () => {
    const module = (url: string, source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const graph = (worktree: string): IModuleGraphEntry[] => [
      module(
        `http://127.0.0.1:5199/@fs${worktree}/examples/engine-load-test/src/main.ts`,
        `import "/@fs${worktree}/packages/core/src/renderProjection.ts";`,
      ),
      module(
        `http://127.0.0.1:5199/@fs${worktree}/packages/core/src/renderProjection.ts`,
        'export const projection = "stable";',
      ),
    ];
    const baselineGraph = graph("/home/runner/work/threenative-baseline");
    const candidateGraph = graph("/home/runner/work/threenative-candidate");
    const configuration = {
      frames: 1_800,
      ladder: [16_384],
      modes: ["L2", "L3"],
      repeats: 1,
      warmup: 120,
    };

    const baselineArtifactHash = await hashServedModuleGraph(baselineGraph);
    const candidateArtifactHash = await hashServedModuleGraph(candidateGraph);
    const baselineWorkloadHash = await hashWorkloadModuleGraph(baselineGraph, configuration);
    const candidateWorkloadHash = await hashWorkloadModuleGraph(candidateGraph, configuration);
    const changedBytesHash = await hashWorkloadModuleGraph(
      candidateGraph.map((entry, index) =>
        index === 1
          ? module(entry.url, 'export const projection = "changed served bytes";')
          : entry,
      ),
      configuration,
    );
    const changedConfigurationHash = await hashWorkloadModuleGraph(candidateGraph, {
      ...configuration,
      modes: ["L2"],
    });

    expect(candidateArtifactHash).toBe(baselineArtifactHash);
    expect(candidateWorkloadHash).toBe(baselineWorkloadHash);
    expect(changedBytesHash).not.toBe(candidateWorkloadHash);
    expect(changedConfigurationHash).not.toBe(candidateWorkloadHash);
  });

  it("should keep graph identity stable across local Vite origins and entry order", async () => {
    const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
    const graph: IModuleGraphEntry[] = [
      { url: "http://localhost:5199/src/a.js", bytes: encode("export const x=0;") },
      { url: "http://127.0.0.1:5199/src/b.js", bytes: encode("export const x=1;") },
    ];
    const reversed = [...graph].reverse();
    const configuration = { frames: 1_800, ladder: [16_384] };

    expect(await hashServedModuleGraph(graph)).toBe(await hashServedModuleGraph(reversed));
    expect(await hashWorkloadModuleGraph(graph, configuration)).toBe(
      await hashWorkloadModuleGraph(reversed, configuration),
    );
  });

  it("should keep graph identity stable for canonically distinct Unicode URLs and entry order", async () => {
    const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
    const graph: IModuleGraphEntry[] = [
      { url: "/src/caf\u00e9.js", bytes: encode("export const value = 1;") },
      { url: "/src/cafe\u0301.js", bytes: encode("export const value = 1;") },
    ];
    const reversed = [...graph].reverse();
    const configuration = { frames: 1_800, ladder: [16_384] };

    expect(await hashServedModuleGraph(graph)).toBe(await hashServedModuleGraph(reversed));
    expect(await hashWorkloadModuleGraph(graph, configuration)).toBe(
      await hashWorkloadModuleGraph(reversed, configuration),
    );
  });

  it("should normalize local Vite loopback origins in graph URLs and module references", async () => {
    const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
    const graph = (origin: string): IModuleGraphEntry[] => [
      {
        url: `${origin}/src/main.js`,
        bytes: encode(`import "${origin}/src/dependency.js";`),
      },
      { url: `${origin}/src/dependency.js`, bytes: encode("export const value = 1;") },
    ];
    const origins = [
      "http://127.0.0.1:5199",
      "http://127.0.0.1:5200",
      "http://localhost:5199",
      "http://localhost:5200",
      "http://[::1]:5199",
      "http://[::1]:5200",
    ];
    const configuration = { frames: 1_800, ladder: [16_384] };
    const baseline = graph(origins[0] ?? "");

    for (const origin of origins.slice(1)) {
      expect(await hashServedModuleGraph(graph(origin))).toBe(
        await hashServedModuleGraph(baseline),
      );
      expect(await hashWorkloadModuleGraph(graph(origin), configuration)).toBe(
        await hashWorkloadModuleGraph(baseline, configuration),
      );
    }
  });

  it("should reject conflicting duplicate module observations in either order", async () => {
    const duplicate: IModuleGraphEntry[] = [
      { url: "/src/duplicate.js", bytes: new TextEncoder().encode("export const x=0;") },
      { url: "/src/duplicate.js", bytes: new TextEncoder().encode("export const x=1;") },
    ];
    const configuration = { frames: 1_800 };

    for (const graph of [duplicate, [...duplicate].reverse()]) {
      await expect(hashServedModuleGraph(graph)).rejects.toThrow(
        /TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:conflicting duplicate module URL/u,
      );
      await expect(hashWorkloadModuleGraph(graph, configuration)).rejects.toThrow(
        /TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:conflicting duplicate module URL/u,
      );
    }
  });

  it("should strip large inline source maps without hiding executable byte changes", async () => {
    const encoder = new TextEncoder();
    const configuration = { frames: 1_800, modes: ["L2", "L3"], repeats: 1 };
    const executablePayload = "x".repeat(11_000_000);
    const graph = (worktree: string, changed = false): IModuleGraphEntry[] => {
      const executableSource = [
        `import "/@fs${worktree}/packages/core/src/index.ts";`,
        `export const payload = "${changed ? "y" : executablePayload}";`,
      ].join("\n");
      const sourceMap = {
        version: 3,
        sources: [`${worktree}/packages/core/src/index.ts`],
        sourcesContent: [`absolute checkout ${worktree}`],
        names: [],
        mappings: "AAAA",
      };
      return [
        {
          bytes: encoder.encode(
            `${executableSource}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(sourceMap)).toString("base64")}`,
          ),
          url: `http://127.0.0.1:5199/@fs${worktree}/examples/engine-load-test/src/main.ts`,
        },
      ];
    };
    const baseline = graph("/home/runner/work/threenative-baseline");
    const candidate = graph("/home/runner/work/threenative-candidate");

    const baselineArtifactHash = await hashServedModuleGraph(baseline);
    const candidateArtifactHash = await hashServedModuleGraph(candidate);
    const baselineWorkloadHash = await hashWorkloadModuleGraph(baseline, configuration);
    const candidateWorkloadHash = await hashWorkloadModuleGraph(candidate, configuration);
    const changedBytesHash = await hashWorkloadModuleGraph(
      graph("/home/runner/work/threenative-candidate", true),
      configuration,
    );

    expect(candidateArtifactHash).toBe(baselineArtifactHash);
    expect(candidateWorkloadHash).toBe(baselineWorkloadHash);
    expect(changedBytesHash).not.toBe(candidateWorkloadHash);
  });

  it("should strip only terminal inline source-map comments outside literals", async () => {
    const module = (source: string, url = "/src/main.ts"): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const lineMarker = "//# sourceMappingURL=data:application/json;base64,ZmFrZQ==";
    const blockMarker = "/*# sourceMappingURL=data:application/json;base64,ZmFrZQ==*/";
    const templateSource = [
      "export const literal = `",
      lineMarker,
      "`;",
      "export const suffix = 1;",
    ].join("\n");
    const templateChanged = templateSource.replace("suffix = 1", "suffix = 2");
    expect(await hashServedModuleGraph([module(templateChanged)])).not.toBe(
      await hashServedModuleGraph([module(templateSource)]),
    );

    const stringSource = `export const literal = ${JSON.stringify(lineMarker)};\nexport const suffix = 1;`;
    expect(await hashServedModuleGraph([module(stringSource)])).not.toBe(
      await hashServedModuleGraph([module(stringSource.replace(lineMarker, "literal"))]),
    );

    const blockSource = ["export const before = 1;", blockMarker, "export const suffix = 1;"].join(
      "\n",
    );
    const blockChanged = blockSource.replace("suffix = 1", "suffix = 2");
    expect(await hashServedModuleGraph([module(blockChanged)])).not.toBe(
      await hashServedModuleGraph([module(blockSource)]),
    );

    const sourceMap = (root: string): string =>
      `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
        JSON.stringify({ version: 3, sources: [`${root}/src/main.ts`], names: [], mappings: "" }),
      ).toString("base64")}*/`;
    const baseline = module(`export const stable = 1;\n${sourceMap("/home/baseline")}`);
    const candidate = module(`export const stable = 1;\n${sourceMap("/home/candidate")}`);
    expect(await hashServedModuleGraph([candidate])).toBe(await hashServedModuleGraph([baseline]));
  });

  it("should preserve executable bytes after line source maps separated by JS line terminators", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const lineMarker = "//# sourceMappingURL=data:application/json;base64,ZmFrZQ==";
    for (const separator of ["\u2028", "\u2029"]) {
      const baseline = module(
        `globalThis.auditValue=1;\n${lineMarker}${separator}globalThis.auditValue=1;`,
      );
      const candidate = module(
        `globalThis.auditValue=1;\n${lineMarker}${separator}globalThis.auditValue=2;`,
      );
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
    }
  });

  it("should strip a terminal inline source map after a regex literal", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const sourceMap = (root: string): string =>
      `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
        JSON.stringify({ version: 3, sources: [`${root}/src/main.ts`], names: [], mappings: "" }),
      ).toString("base64")}*/`;
    const baseline = module(`export const regex = /"/g;\n${sourceMap("/home/baseline")}`);
    const candidate = module(`export const regex = /"/g;\n${sourceMap("/home/candidate")}`);
    expect(await hashServedModuleGraph([candidate])).toBe(await hashServedModuleGraph([baseline]));
  });

  it("should preserve executable template bytes after a control-condition regex", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );
  });

  it("should preserve executable bytes after break and continue statement completion", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const separators = ["\n", "\r", "\r\n", "\u2028", "\u2029", "/* multiline comment\n */"];
    const regexLiteral = "/`/;";
    const source = (
      keyword: "break" | "continue",
      labeled: boolean,
      separator: string,
      marker: string,
    ): string => {
      const statement = labeled ? `${keyword} loop` : keyword;
      return [
        "loop: for (;;) {",
        `  ${statement}${separator}${regexLiteral}`,
        "}",
        `globalThis.auditValue = \`//# sourceMappingURL=data:${marker}\`;`,
      ].join("\n");
    };

    for (const keyword of ["break", "continue"] as const) {
      for (const labeled of [false, true]) {
        for (const separator of separators) {
          const baseline = module(source(keyword, labeled, separator, "AAA"));
          const candidate = module(source(keyword, labeled, separator, "BBB"));
          expect(await hashServedModuleGraph([candidate])).not.toBe(
            await hashServedModuleGraph([baseline]),
          );
          expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
            await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
          );
        }
      }
    }
  });

  it("should consume escaped break and continue labels across every separator", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const separators = [
      "\n",
      "\r",
      "\r\n",
      "\u2028",
      "\u2029",
      "/* comment */",
      "/* multiline comment\n */",
      "// comment\n",
    ];
    const labels = [
      "",
      "loop",
      String.raw`\u006coop`,
      String.raw`\u{6c}oop`,
      String.raw`\u{000006c}oop`,
    ];
    const source = (
      keyword: "break" | "continue",
      label: string,
      separator: string,
      marker: string,
    ): string => {
      const statement = label.length === 0 ? keyword : `${keyword} ${label}`;
      return [
        "loop: for (;;) {",
        `  ${statement}${separator}/\`/;`,
        "}",
        `globalThis.auditValue = \`//# sourceMappingURL=data:${marker}\`;`,
      ].join("\n");
    };

    for (const keyword of ["break", "continue"] as const) {
      for (const label of labels) {
        for (const separator of separators) {
          const baseline = module(source(keyword, label, separator, "AAA"));
          const candidate = module(source(keyword, label, separator, "BBB"));
          expect(await hashServedModuleGraph([candidate])).not.toBe(
            await hashServedModuleGraph([baseline]),
          );
          expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
            await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
          );
        }
      }
    }
  });

  it("should ignore only the absolute root in a terminal map after a control-condition regex", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const sourceMap = (root: string): string =>
      `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
        JSON.stringify({ version: 3, sources: [`${root}/src/main.ts`], names: [], mappings: "" }),
      ).toString("base64")}*/`;
    const baseline = module(`if (true) /"/g.test("x");\n${sourceMap("/home/baseline")}`);
    const candidate = module(`if (true) /"/g.test("x");\n${sourceMap("/home/candidate")}`);

    expect(await hashServedModuleGraph([candidate])).toBe(await hashServedModuleGraph([baseline]));
  });

  it("should preserve executable template bytes after nested control-condition regexes", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'if (true) if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'if (true) if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );
  });

  it("should preserve executable template bytes after keyword properties and contextual identifiers", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const testCases = [
      'globalThis.return / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const of = 1; of / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'function f() { return /`/.test("x"); } globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'for (const x of /`/.test("x")) {} globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of testCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should preserve control-parenthesis context through for await", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'for await (const x of []) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'for await (const x of []) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );
  });

  it("should preserve for-await context through trivia and all JavaScript line terminators", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const separators = [
      "\n",
      "/* comment */",
      "/* comment\n */",
      "// comment\n",
      "\u2028",
      "\u2029",
    ];
    const source = (separator: string, marker: string): string =>
      `for${separator}await (const x of []) /\`/.test("x"); globalThis.auditValue = \`//# sourceMappingURL=data:${marker}\`;`;

    for (const separator of separators) {
      const baseline = module(source(separator, "AAA"));
      const candidate = module(source(separator, "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should classify only the actual for-of separator and preserve an of identifier", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'for (let of = 0; of / 1;) {} if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'for (let of = 0; of / 1;) {} if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );
  });

  it("should preserve unary operand context before an of identifier", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'for (let x = typeof of / 1; false;) {} if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'for (let x = typeof of / 1; false;) {} if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );
  });

  it("should preserve prefix update operand context across trivia", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const source = (init: string, marker: string): string =>
      `let of=0; for(${init};false;){} /\`/; globalThis.auditValue=\`//# sourceMappingURL=data:${marker}\`;`;
    const separators = [
      "",
      "/* block comment */",
      "/* block comment\n */",
      "// line comment\n",
      "\n",
      "\r",
      "\r\n",
      "\u2028",
      "\u2029",
    ];

    for (const update of ["++", "--"]) {
      for (const separator of separators) {
        const baseline = module(source(`${update}${separator}of / 1`, "AAA"));
        const candidate = module(source(`${update}${separator}of / 1`, "BBB"));
        expect(await hashServedModuleGraph([candidate])).not.toBe(
          await hashServedModuleGraph([baseline]),
        );
        expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
          await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
        );
      }
    }

    for (const update of ["++", "--"]) {
      const baseline = module(source(`of${update} / 1`, "AAA"));
      const candidate = module(source(`of${update} / 1`, "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }

    const ordinaryForOf = (marker: string): IModuleGraphEntry =>
      module(
        `for (const value of []) {} /\`/; globalThis.auditValue=\`//# sourceMappingURL=data:${marker}\`;`,
      );
    const ordinaryBaseline = ordinaryForOf("AAA");
    const ordinaryCandidate = ordinaryForOf("BBB");
    expect(await hashServedModuleGraph([ordinaryCandidate])).not.toBe(
      await hashServedModuleGraph([ordinaryBaseline]),
    );
    expect(await hashWorkloadModuleGraph([ordinaryCandidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([ordinaryBaseline], { frames: 1_800 }),
    );
  });

  it("should establish restricted-production ASI boundaries only after line breaks", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const lineBreakCases = [
      'function f() { return\nfunction g() {} /`/.test("x"); } globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'function* f() { yield\nfunction g() {} /`/.test("x"); } globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of lineBreakCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }

    const sameLineBaseline = module(
      "function f() { return function g() {} / 1; } globalThis.auditValue = `//# sourceMappingURL=data:AAA`;",
    );
    const sameLineCandidate = module(
      "function f() { return function g() {} / 1; } globalThis.auditValue = `//# sourceMappingURL=data:BBB`;",
    );
    expect(await hashServedModuleGraph([sameLineCandidate])).not.toBe(
      await hashServedModuleGraph([sameLineBaseline]),
    );
    expect(await hashWorkloadModuleGraph([sameLineCandidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([sameLineBaseline], { frames: 1_800 }),
    );
  });

  it("should establish yield ASI boundaries when yield occurs inside an expression", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'function* f() {\n  const x = yield\n  function g() {} /`/.test("x");\n}\nglobalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'function* f() {\n  const x = yield\n  function g() {} /`/.test("x");\n}\nglobalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );

    const sameLineBaseline = module(
      "function* f() { const x = yield function g() {} / 1; } globalThis.auditValue = `//# sourceMappingURL=data:AAA`;",
    );
    const sameLineCandidate = module(
      "function* f() { const x = yield function g() {} / 1; } globalThis.auditValue = `//# sourceMappingURL=data:BBB`;",
    );
    expect(await hashServedModuleGraph([sameLineCandidate])).not.toBe(
      await hashServedModuleGraph([sameLineBaseline]),
    );
    expect(await hashWorkloadModuleGraph([sameLineCandidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([sameLineBaseline], { frames: 1_800 }),
    );
  });

  it("should ignore only the absolute root in a terminal map after nested control-condition regexes", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const sourceMap = (root: string): string =>
      `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
        JSON.stringify({ version: 3, sources: [`${root}/src/main.ts`], names: [], mappings: "" }),
      ).toString("base64")}*/`;
    const baseline = module(`if (true) if (true) /"/g.test("x");\n${sourceMap("/home/baseline")}`);
    const candidate = module(
      `if (true) if (true) /"/g.test("x");\n${sourceMap("/home/candidate")}`,
    );

    expect(await hashServedModuleGraph([candidate])).toBe(await hashServedModuleGraph([baseline]));
  });

  it("should preserve executable template bytes after a labeled statement boundary", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'audit: if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'audit: if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
  });

  it("should preserve executable template bytes after a switch case boundary", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'switch (true) { case true: if (true) /`/.test("x"); } globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'switch (true) { case true: if (true) /`/.test("x"); } globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
  });

  it("should preserve division after a function expression and later executable template bytes", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const baseline = module(
      'const f = function() {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'const f = function() {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );
  });

  it("should preserve statement boundary after async function and generator declarations", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const testCases = [
      'async function f() {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'async function* g() {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const x = 1\nasync function f() {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const x = 1\nasync function* g() {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const x = 1\n/* separator\n */ async function f() {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const x = 1\nif (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of testCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should preserve expression context for async function expressions and line-terminated async identifiers", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const exprCases = [
      'const f = async function() {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const f = async\nfunction f2() {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of exprCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should distinguish conditional expression colons from statement boundaries", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const conditionalCases = [
      'const f = true ? 0 : function() {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const f = a ? b ? 1 : 2 : function() {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const obj = { a: true ? 0 : function() {} / 1 }; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of conditionalCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should distinguish class expressions from class declarations", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const classCases = [
      'const F = class {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const F = class Named {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const arr = [class {} / 1]; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'class C {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of classCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should preserve class-field initializer expressions and module references", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.js",
    });
    const baseline = module(
      'class C { x = function() {} / 1; } /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    );
    const candidate = module(
      'class C { x = function() {} / 1; } /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:BBB`;',
    );

    expect(await hashServedModuleGraph([candidate])).not.toBe(
      await hashServedModuleGraph([baseline]),
    );
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );

    const baselinePath = "/@fs/repo/packages/core/src/a";
    const candidatePath = "packages/core/src/a";
    const moduleReferences: [string, string][] = [
      [
        `class C { x = import(${JSON.stringify(baselinePath)}); }`,
        `class C { x = import(${JSON.stringify(candidatePath)}); }`,
      ],
      [
        `class C { x = new URL(${JSON.stringify(baselinePath)}, import.meta.url); }`,
        `class C { x = new URL(${JSON.stringify(candidatePath)}, import.meta.url); }`,
      ],
    ];
    for (const [baselineSource, candidateSource] of moduleReferences) {
      expect(await hashServedModuleGraph([module(candidateSource)])).toBe(
        await hashServedModuleGraph([module(baselineSource)]),
      );
      expect(await hashWorkloadModuleGraph([module(candidateSource)], { frames: 1_800 })).toBe(
        await hashWorkloadModuleGraph([module(baselineSource)], { frames: 1_800 }),
      );
    }
  });

  it("should not treat property or private names as keyword syntax", async () => {
    const module = (source: string, url = "/src/main.ts"): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const propertyCases = [
      'class C extends ({ class: Object }).class {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'class C extends globalThis.function() {} /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of propertyCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }

    const checkoutUrl = "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.ts";
    const privateNameCases = (pathValue: string): string[] => [
      `class C { #import(x) { return x; } run() { return this.#import(${JSON.stringify(pathValue)}); } }`,
      `class C { #new(x) { return x; } run() { return this.#new\nURL(${JSON.stringify(pathValue)}, import.meta.url); } }`,
    ];
    const baselinePath = "/@fs/repo/packages/core/src/a";
    const candidatePath = "packages/core/src/a";
    for (const index of [0, 1]) {
      const baseline = module(privateNameCases(baselinePath)[index] ?? "", checkoutUrl);
      const candidate = module(privateNameCases(candidatePath)[index] ?? "", checkoutUrl);
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should preserve statement boundaries after declarations separated by ASI", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const testCases = [
      'const x = 1\nfunction f() {} /`/.test("x");\nglobalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const x = 1\nclass C {} /`/.test("x");\nglobalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const café = 1\u2028function f() {} /`/.test("x");\nglobalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const café = 1\u2029class C {} /`/.test("x");\nglobalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of testCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should preserve class-expression context through heritage parentheses", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const testCases = [
      'const C = class extends (Object) {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const C = class extends (class {}) {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const C = class extends ((class {})) {} / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'const C = Object.assign(class {}, {}) / 1; if (true) /`/.test("x"); globalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of testCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));

      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should consume nullish operators without recording conditional questions", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "/src/main.ts",
    });
    const testCases = [
      'const x = null ?? 1;\nlabel: if (true) /`/.test("x");\nglobalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
      'let x;\nx ??= 1;\nlabel: if (true) /`/.test("x");\nglobalThis.auditValue = `//# sourceMappingURL=data:AAA`;',
    ];
    for (const statement of testCases) {
      const baseline = module(statement);
      const candidate = module(statement.replace("AAA", "BBB"));
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should canonicalize only syntactic module references", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/a.js",
    });
    const runtimeCases: [string, string][] = [
      [
        'globalThis.auditValue = `"/@fs/repo/packages/core/src/a"`;',
        'globalThis.auditValue = `"packages/core/src/a"`;',
      ],
      [
        'globalThis.auditValue = "/@fs/repo/packages/core/src/a";',
        'globalThis.auditValue = "packages/core/src/a";',
      ],
      [
        'globalThis.auditValue = new RegExp("\\"/@fs/repo/packages/core/src/a\\"").source;',
        'globalThis.auditValue = new RegExp("\\"packages/core/src/a\\"").source;',
      ],
      [
        'globalThis.import\n"/@fs/repo/packages/core/src/a";',
        'globalThis.import\n"packages/core/src/a";',
      ],
      [
        'const obj = { from: 0 };\nexport default obj.from\n"/@fs/repo/packages/core/src/a";',
        'const obj = { from: 0 };\nexport default obj.from\n"packages/core/src/a";',
      ],
    ];
    for (const [baselineSource, candidateSource] of runtimeCases) {
      const baseline = module(baselineSource);
      const candidate = module(candidateSource);
      expect(await hashServedModuleGraph([candidate])).not.toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }

    const moduleReferenceCases: [string, string][] = [
      ['import "/@fs/repo/packages/core/src/a";', 'import "packages/core/src/a";'],
      [
        'export { value } from "/@fs/repo/packages/core/src/a";',
        'export { value } from "packages/core/src/a";',
      ],
      ['void import("/@fs/repo/packages/core/src/a");', 'void import("packages/core/src/a");'],
      [
        'new URL("/@fs/repo/packages/core/src/a", import.meta.url);',
        'new URL("packages/core/src/a", import.meta.url);',
      ],
      [
        'globalThis.auditValue = `${import("/@fs/repo/packages/core/src/a")}`;',
        'globalThis.auditValue = `${import("packages/core/src/a")}`;',
      ],
    ];
    for (const [baselineSource, candidateSource] of moduleReferenceCases) {
      const baseline = module(baselineSource);
      const candidate = module(candidateSource);
      expect(await hashServedModuleGraph([candidate])).toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }

    const lookalikeBaseline =
      'globalThis.new\nURL("/@fs/repo/packages/core/src/a", import.meta.url);';
    const lookalikeCandidate = 'globalThis.new\nURL("packages/core/src/a", import.meta.url);';
    const runtimeSpecifier = (source: string): string => {
      const match = /URL\("([^"]+)", import\.meta\.url\)/u.exec(source);
      if (match?.[1] === undefined) throw new Error("test fixture has no URL argument");
      return match[1];
    };
    expect(runtimeSpecifier(lookalikeBaseline)).toBe("/@fs/repo/packages/core/src/a");
    expect(runtimeSpecifier(lookalikeCandidate)).toBe("packages/core/src/a");
    expect(runtimeSpecifier(lookalikeBaseline)).not.toBe(runtimeSpecifier(lookalikeCandidate));
    expect(lookalikeBaseline).not.toBe(lookalikeCandidate);
    expect(await hashServedModuleGraph([module(lookalikeCandidate)])).not.toBe(
      await hashServedModuleGraph([module(lookalikeBaseline)]),
    );
    expect(await hashWorkloadModuleGraph([module(lookalikeCandidate)], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([module(lookalikeBaseline)], { frames: 1_800 }),
    );
  });

  it("should recognize new URL module references with a trailing comma and trivia", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.js",
    });
    const urlSource = (pathValue: string): string =>
      `new URL(${JSON.stringify(pathValue)}, import.meta.url, /* trailing */\n\t)`;
    const baselinePath = "/@fs/repo/packages/core/src/a";
    const candidatePath = "packages/core/src/a";
    const baseline = module(urlSource(baselinePath));
    const candidate = module(urlSource(candidatePath));

    expect(await hashServedModuleGraph([candidate])).toBe(await hashServedModuleGraph([baseline]));
    expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).toBe(
      await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
    );

    const differingValues: [string, string][] = [
      ["/@fs/repo/packages/core/src/a?one", "/@fs/repo/packages/core/src/a?two"],
      ["/@fs/repo/packages/core/src/a#one", "/@fs/repo/packages/core/src/a#two"],
      ["data:text/plain,AAA", "data:text/plain,BBB"],
    ];
    for (const [baselineValue, candidateValue] of differingValues) {
      const queryBaseline = module(urlSource(baselineValue));
      const queryCandidate = module(urlSource(candidateValue));
      expect(await hashServedModuleGraph([queryCandidate])).not.toBe(
        await hashServedModuleGraph([queryBaseline]),
      );
      expect(await hashWorkloadModuleGraph([queryCandidate], { frames: 1_800 })).not.toBe(
        await hashWorkloadModuleGraph([queryBaseline], { frames: 1_800 }),
      );
    }

    const lookalikeBaseline = module(
      `globalThis.new\nURL(${JSON.stringify(baselinePath)}, import.meta.url, /* trailing */\n\t)`,
    );
    const lookalikeCandidate = module(
      `globalThis.new\nURL(${JSON.stringify(candidatePath)}, import.meta.url, /* trailing */\n\t)`,
    );
    expect(await hashServedModuleGraph([lookalikeCandidate])).not.toBe(
      await hashServedModuleGraph([lookalikeBaseline]),
    );
    expect(await hashWorkloadModuleGraph([lookalikeCandidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([lookalikeBaseline], { frames: 1_800 }),
    );
  });

  it("should canonicalize multiline static imports through named clauses and comments", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.js",
    });
    const cases: [string, string][] = [
      ['import x\nfrom "/@fs/repo/packages/core/src/a";', 'import x\nfrom "packages/core/src/a";'],
      [
        'import { x as y, z } // keep the import open\nfrom "/@fs/repo/packages/core/src/a";',
        'import { x as y, z } // keep the import open\nfrom "packages/core/src/a";',
      ],
    ];
    for (const [baselineSource, candidateSource] of cases) {
      const baseline = module(baselineSource);
      const candidate = module(candidateSource);
      expect(await hashServedModuleGraph([candidate])).toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should canonicalize multiline named import and export clauses", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.js",
    });
    const separators = [
      "\n",
      "\r",
      "\r\n",
      "\u2028",
      "\u2029",
      "/* block comment */\n",
      "/* block comment\n */",
      "// line comment\n",
    ];
    const baselinePath = "/@fs/repo/packages/core/src/a";
    const candidatePath = "packages/core/src/a";
    for (const statement of ["export ", "import "]) {
      for (const separator of separators) {
        const source = (pathValue: string): string =>
          `${statement}{${separator}x} from ${JSON.stringify(pathValue)};`;
        const baseline = module(source(baselinePath));
        const candidate = module(source(candidatePath));
        expect(await hashServedModuleGraph([candidate])).toBe(
          await hashServedModuleGraph([baseline]),
        );
        expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).toBe(
          await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
        );
      }
    }
  });

  it("should preserve legal multiline static import and export continuations", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.js",
    });
    const cases: [string, string][] = [
      [
        'import x\n, { y } from "/@fs/repo/packages/core/src/a";',
        'import x\n, { y } from "packages/core/src/a";',
      ],
      ['export\n* from "/@fs/repo/packages/core/src/a";', 'export\n* from "packages/core/src/a";'],
      [
        'export\n{ x } from "/@fs/repo/packages/core/src/a";',
        'export\n{ x } from "packages/core/src/a";',
      ],
    ];
    for (const [baselineSource, candidateSource] of cases) {
      const baseline = module(baselineSource);
      const candidate = module(candidateSource);
      expect(await hashServedModuleGraph([candidate])).toBe(
        await hashServedModuleGraph([baseline]),
      );
      expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).toBe(
        await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
      );
    }
  });

  it("should preserve namespace static import and export continuations through binding names", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.js",
    });
    const separators = [
      "\n",
      "/* comment */\n",
      "/* comment\n */",
      "// comment\n",
      "\u2028",
      "\u2029",
    ];
    const baselinePath = "/@fs/repo/packages/core/src/a";
    const candidatePath = "packages/core/src/a";
    for (const statement of ["import * as", "export * as"]) {
      for (const separator of separators) {
        const source = (pathValue: string): string =>
          `${statement}${separator}x from ${JSON.stringify(pathValue)};`;
        const baseline = module(source(baselinePath));
        const candidate = module(source(candidatePath));
        expect(await hashServedModuleGraph([candidate])).toBe(
          await hashServedModuleGraph([baseline]),
        );
        expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).toBe(
          await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
        );
      }
    }
  });

  it("should canonicalize named clauses across every trivia boundary", async () => {
    const module = (source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url: "http://127.0.0.1:5199/@fs/repo/packages/core/src/main.js",
    });
    const separators = [
      "\n",
      "\r",
      "\r\n",
      "\u2028",
      "\u2029",
      "/* block comment */",
      "/* multiline comment\n */",
      "// line comment\n",
    ];
    const baselinePath = "/@fs/repo/packages/core/src/a";
    const candidatePath = "packages/core/src/a";
    const clauseSources = [
      (statement: string, separator: string, pathValue: string): string =>
        `${statement}{${separator}x} from ${JSON.stringify(pathValue)};`,
      (statement: string, separator: string, pathValue: string): string =>
        `${statement}{x${separator}as y} from ${JSON.stringify(pathValue)};`,
      (statement: string, separator: string, pathValue: string): string =>
        `${statement}{x${separator}} from ${JSON.stringify(pathValue)};`,
      (statement: string, separator: string, pathValue: string): string =>
        `${statement}{x as y${separator}} from ${JSON.stringify(pathValue)};`,
    ];

    for (const statement of ["export ", "import "]) {
      for (const separator of separators) {
        for (const createSource of clauseSources) {
          const baseline = module(createSource(statement, separator, baselinePath));
          const candidate = module(createSource(statement, separator, candidatePath));
          expect(await hashServedModuleGraph([candidate])).toBe(
            await hashServedModuleGraph([baseline]),
          );
          expect(await hashWorkloadModuleGraph([candidate], { frames: 1_800 })).toBe(
            await hashWorkloadModuleGraph([baseline], { frames: 1_800 }),
          );
        }
      }
    }

    const propertyBaseline = module(
      `const object = { x: 1 };\nexport {x} from ${JSON.stringify(candidatePath)};`,
    );
    const propertyCandidate = module(
      `const object = { y: 1 };\nexport {x} from ${JSON.stringify(candidatePath)};`,
    );
    expect(await hashServedModuleGraph([propertyCandidate])).not.toBe(
      await hashServedModuleGraph([propertyBaseline]),
    );
    expect(await hashWorkloadModuleGraph([propertyCandidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([propertyBaseline], { frames: 1_800 }),
    );

    const statementBaseline = module(
      `const unrelated = 1;\nexport {x} from ${JSON.stringify(candidatePath)};`,
    );
    const statementCandidate = module(
      `const unrelated = 2;\nexport {x} from ${JSON.stringify(candidatePath)};`,
    );
    expect(await hashServedModuleGraph([statementCandidate])).not.toBe(
      await hashServedModuleGraph([statementBaseline]),
    );
    expect(await hashWorkloadModuleGraph([statementCandidate], { frames: 1_800 })).not.toBe(
      await hashWorkloadModuleGraph([statementBaseline], { frames: 1_800 }),
    );
  });

  it("should preserve full paths when recognized Vite layouts repeat", async () => {
    const module = (url: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode("export const shared = true;"),
      url,
    });
    const rooted = (root: string): IModuleGraphEntry[] => [
      module(`http://127.0.0.1:5199/@fs${root}/packages/core/src/a/packages/core/src/index.ts`),
    ];
    expect(await hashServedModuleGraph(rooted("/repo-a"))).not.toBe(
      await hashServedModuleGraph(rooted("/repo-b")),
    );
  });

  it("should preserve full paths when adjacent Vite layout evidence overlaps", async () => {
    const module = (url: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode("export const shared = true;"),
      url,
    });
    const rooted = (root: string): IModuleGraphEntry[] => [
      module(`http://127.0.0.1:5199/@fs${root}/packages/core/src/packages/core/src/index.ts`),
    ];

    expect(await hashServedModuleGraph(rooted("/repo-a"))).not.toBe(
      await hashServedModuleGraph(rooted("/repo-b")),
    );
  });

  it("should preserve complete package paths in served module identity", async () => {
    const module = (url: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode("export const shared = true;"),
      url,
    });
    const graph = (path: string): IModuleGraphEntry[] => [
      module(`http://127.0.0.1:5199/@fs/repo/${path}`),
    ];
    const core = await hashServedModuleGraph(graph("packages/core/src/index.ts"));
    const physics = await hashServedModuleGraph(graph("packages/physics/src/index.ts"));
    const nestedA = await hashServedModuleGraph(
      graph("node_modules/outer/node_modules/packages/src/index.ts"),
    );
    const nestedB = await hashServedModuleGraph(
      graph("node_modules/other/node_modules/packages/src/index.ts"),
    );

    expect(physics).not.toBe(core);
    expect(nestedB).not.toBe(nestedA);

    const rooted = (root: string): IModuleGraphEntry[] => [
      module(`http://127.0.0.1:5199/@fs${root}/packages/core/src/index.ts`),
    ];
    expect(await hashServedModuleGraph(rooted("/home/packages/candidate"))).toBe(
      await hashServedModuleGraph(rooted("/home/packages/baseline")),
    );
  });

  it("should preserve ordinary external URLs and module query identity", async () => {
    const module = (url: string, source: string): IModuleGraphEntry => ({
      bytes: new TextEncoder().encode(source),
      url,
    });
    const externalUrl = (value: string): IModuleGraphEntry[] => [
      module("/src/workload.ts", `export const mesh = ${JSON.stringify(value)};`),
    ];
    const rawModule = [module("/src/shader.glsl?raw", 'export default "shader";')];
    const urlModule = [module("/src/shader.glsl?url", 'export default "shader";')];
    const localVite = (origin: string): IModuleGraphEntry[] => [
      module(`${origin}/src/workload.ts?raw#stable`, 'export const mesh = "stable";'),
    ];
    const dataUrl = (value: string): IModuleGraphEntry[] => [
      module("/src/data.ts", `export const asset = ${JSON.stringify(value)};`),
    ];
    const unrecognizedPath = (value: string): IModuleGraphEntry[] => [
      module("/src/path.ts", `export const path = ${JSON.stringify(value)};`),
    ];
    const externalAbsolute = (origin: string): IModuleGraphEntry[] => [
      module(`${origin}/@fs/repo/packages/core/src/index.ts`, "export const shared = true;"),
    ];

    expect(
      await hashWorkloadModuleGraph(externalUrl("https://a.example/mesh?quality=low"), {}),
    ).not.toBe(
      await hashWorkloadModuleGraph(externalUrl("https://b.example/mesh?quality=high"), {}),
    );
    expect(await hashServedModuleGraph(rawModule)).not.toBe(await hashServedModuleGraph(urlModule));
    expect(await hashWorkloadModuleGraph(rawModule, {})).not.toBe(
      await hashWorkloadModuleGraph(urlModule, {}),
    );
    expect(await hashServedModuleGraph(localVite("http://127.0.0.1:5199"))).toBe(
      await hashServedModuleGraph(localVite("http://127.0.0.1:5200")),
    );
    expect(await hashWorkloadModuleGraph(dataUrl("data:text/plain;base64,AAAA"), {})).not.toBe(
      await hashWorkloadModuleGraph(dataUrl("data:text/plain;base64,BBBB"), {}),
    );
    expect(await hashWorkloadModuleGraph(unrecognizedPath("/not-a-vite-module?raw"), {})).not.toBe(
      await hashWorkloadModuleGraph(unrecognizedPath("/not-a-vite-module?url"), {}),
    );
    expect(await hashServedModuleGraph(externalAbsolute("https://a.example"))).not.toBe(
      await hashServedModuleGraph(externalAbsolute("https://b.example")),
    );
  });

  it("should fail closed when a served module observation has no URL", async () => {
    const bytes = new TextEncoder().encode("export const value = 1;");
    await expect(hashServedModuleGraph([])).rejects.toThrow(
      /TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:empty graph/u,
    );

    const missingUrlEntries: readonly (readonly IModuleGraphEntry[])[] = [
      [{ bytes, url: "" }],
      [{ bytes } as unknown as IModuleGraphEntry],
      [{ bytes, url: undefined } as unknown as IModuleGraphEntry],
    ];
    for (const entries of missingUrlEntries) {
      await expect(hashServedModuleGraph(entries)).rejects.toThrow(
        /TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:missing module URL/u,
      );
    }

    const validHash = await hashServedModuleGraph([{ bytes, url: "/src/main.ts" }]);
    expect(validHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("engine load test scorer", () => {
  it("should reject a rung with an empty frame series", () => {
    expect(() => parseRunReport(report({ rungs: [rung({ frameMs: [] })] }))).toThrow(
      /TN_BENCH_EMPTY_SERIES/,
    );
  });

  it("preserves native step and projection timing series with matching frames", () => {
    const measured = rung({ collapseMs: series(2), stepMs: series(3) });
    expect(parseRunReport(report({ rungs: [measured] })).rungs[0]).toMatchObject({
      collapseMs: series(2),
      stepMs: series(3),
    });
    expect(() => parseRunReport(report({ rungs: [rung({ stepMs: series(3, 7) })] }))).toThrow(
      /TN_BENCH_BAD_SHAPE/,
    );
  });

  it("preserves the completed-work block so a saved report keeps the primary metric", () => {
    const v2 = {
      completedWorkMeanMs: 28.5,
      completedWorkReason: null,
      cpuSubmitMeanMs: 10,
      drainPolicy:
        "pre-drain:untimed,post-drain:timed,per-frame-fence:none,timing-scope:cadence-inclusive-browser-delivery",
      measuredFrames: 8,
    };
    expect(parseRunReport(report({ rungs: [rung(v2)] })).rungs[0]).toMatchObject(v2);
  });

  it("keeps a rung written before the completed-work metric existed, with no invented value", () => {
    const [legacy] = parseRunReport(report()).rungs;
    expect(legacy).toBeDefined();
    // One key list pins it: a parsed legacy rung carries exactly what it was written with, so no
    // field is invented and no legacy report is refused.
    expect(Object.keys(legacy ?? {}).sort()).toEqual([
      "drawCalls",
      "frameMs",
      "mode",
      "objectCount",
      "positionHash",
      "repeat",
      "triangles",
      "visibleObjects",
    ]);
  });

  it("keeps an unobservable completed-work metric as null plus its reason", () => {
    expect(
      parseRunReport(
        report({
          rungs: [
            rung({
              completedWorkMeanMs: null,
              completedWorkReason: "queue-completion-unavailable",
              cpuSubmitMeanMs: 10,
            }),
          ],
        }),
      ).rungs[0],
    ).toMatchObject({
      completedWorkMeanMs: null,
      completedWorkReason: "queue-completion-unavailable",
    });
  });

  it("fails closed on a completed-work record nobody could read", () => {
    for (const fields of [
      // A hole with no reason, a reason on a measurement that exists, and a half-written pair.
      { completedWorkMeanMs: null },
      { completedWorkMeanMs: 4, completedWorkReason: "queue-completion-unavailable" },
      { completedWorkReason: null },
      { completedWorkMeanMs: 4, completedWorkReason: null, cpuSubmitMeanMs: Number.NaN },
      { completedWorkMeanMs: -1, completedWorkReason: null },
      { completedWorkMeanMs: 4, completedWorkReason: null, cpuSubmitMeanMs: 1, drainPolicy: "" },
      // A declared window that disagrees with the series written beside it.
      { completedWorkMeanMs: 4, completedWorkReason: null, measuredFrames: 7 },
      { completedWorkMeanMs: 4, completedWorkReason: null, measuredFrames: 0 },
    ]) {
      expect(
        () => parseRunReport(report({ rungs: [rung(fields)] })),
        JSON.stringify(fields),
      ).toThrow(/TN_BENCH_BAD_SHAPE/u);
    }
  });

  it("should reject a report missing its driver line", () => {
    const missing = report() as unknown as Record<string, unknown>;
    // biome-ignore lint/performance/noDelete: the point of the test is an absent key.
    delete missing.driver;
    expect(() => parseRunReport(missing)).toThrow(/TN_BENCH_MISSING_DRIVER/);
    expect(() => parseRunReport(report({ driver: { adapter: "", renderer: "gl" } }))).toThrow(
      /TN_BENCH_MISSING_DRIVER/,
    );
  });

  it("should reject a report with no rungs at all", () => {
    expect(() => parseRunReport(report({ rungs: [] }))).toThrow(/TN_BENCH_NO_RUNGS/);
  });

  it("should preserve the reported axes and reject a malformed one", () => {
    // Godot reports and older reports carry no axes, so the field stays optional; a tn arm's axes
    // are the matrix cell the row belongs to and must survive parsing.
    expect(parseRunReport(report()).axes).toBeUndefined();
    expect(parseRunReport(report({ axes: DEFAULT_AXES })).axes).toEqual(DEFAULT_AXES);
    // The arm markdown names the cell; a Godot report (no axes) prints no axes line.
    expect(renderArmMarkdown(parseRunReport(report({ axes: DEFAULT_AXES })))).toMatch(
      /- axes: geometry shared, material shared, hierarchy 0, visible 1, mutation 1, shadow-casters 0, passes 1/u,
    );
    expect(renderArmMarkdown(parseRunReport(report()))).not.toMatch(/- axes:/u);
    for (const broken of [
      { ...DEFAULT_AXES, geometry: "many" },
      { ...DEFAULT_AXES, hierarchyDepth: 1.5 },
      { ...DEFAULT_AXES, passCount: 0 },
      { ...DEFAULT_AXES, visibleFraction: 2 },
    ]) {
      expect(() => parseRunReport(report({ axes: broken as IRunReport["axes"] }))).toThrow(
        /TN_BENCH_BAD_SHAPE/u,
      );
    }
  });

  it("should require a condition block on Android reports", () => {
    expect(() => parseRunReport(report({ arm: "tn-android" }))).toThrow(
      /TN_BENCH_BAD_SHAPE|TN_BENCH_MISSING_DEVICE_CONDITION/,
    );
    const parsed = parseRunReport(
      report({
        arm: "tn-android",
        deviceCondition: {
          batteryPercent: 80,
          charging: false,
          chargingSource: "NONE",
          provisional: [],
          screenOn: true,
          serial: "37251FDJH0037Z",
          thermalStatus: "NONE",
          thermalStatusCode: 0,
        },
        provisional: [],
      }),
    );
    expect(parsed.deviceCondition?.thermalStatus).toBe("NONE");
  });

  it("should require matching nested and top-level provisional arrays", () => {
    const android = report({
      arm: "tn-android",
      deviceCondition: {
        batteryPercent: 80,
        charging: false,
        chargingSource: "NONE",
        provisional: [],
        screenOn: true,
        serial: "37251FDJH0037Z",
        thermalStatus: "NONE",
        thermalStatusCode: 0,
      },
      provisional: [],
    });
    expect(parseRunReport(android).deviceCondition?.provisional).toEqual([]);

    expect(() => parseRunReport({ ...android, provisional: undefined })).toThrow(
      /TN_BENCH_BAD_SHAPE|TN_BENCH_MISSING_DEVICE_CONDITION/,
    );
    expect(() =>
      parseRunReport({
        ...android,
        deviceCondition: { ...android.deviceCondition, provisional: undefined },
      }),
    ).toThrow(/TN_BENCH_BAD_SHAPE|TN_BENCH_MISSING_DEVICE_CONDITION/);
    expect(() =>
      parseRunReport({
        ...android,
        provisional: [""],
        deviceCondition: { ...android.deviceCondition, provisional: [""] },
      }),
    ).toThrow(/TN_BENCH_BAD_SHAPE/);
    expect(() =>
      parseRunReport({
        ...android,
        provisional: [],
        deviceCondition: { ...android.deviceCondition, provisional: ["battery"] },
      }),
    ).toThrow(/TN_BENCH_BAD_SHAPE/);
  });

  it("should compute the knee as the largest rung at or below 20 ms p95", () => {
    expect(knee(summarize(ladderReport(24)), "L1")).toBe(4096);
    // Shift the top of the fixture under the line and the knee climbs a rung; shift the rung
    // below it over the line and the knee drops one.
    expect(knee(summarize(ladderReport(19)), "L1")).toBe(16_384);
    const dropped = ladderReport(24);
    dropped.rungs[2] = rung({ ...dropped.rungs[2], frameMs: series(21) });
    expect(knee(summarize(dropped), "L1")).toBe(1024);
  });

  it("should report no knee when even the first rung crosses the line", () => {
    const slow = ladderReport(99);
    slow.rungs = slow.rungs.map((entry) => ({ ...entry, frameMs: series(40) }));
    expect(knee(summarize(slow), "L1")).toBeNull();
  });
});

// PRD-464's rung gate. A ladder row is a number about a scene, so a run only publishes one when the
// scene it claims to have built is the scene it built *and* the frame it drew was not a flat fill.
// Both engines go through this one parser, so neither can pass the other.
describe("the realistic-scene ladder gate", () => {
  const OBJECT_COUNT = 4096;

  /** A rung that built exactly what its name says, with a frame that shows something. */
  function ladderRung(
    mode: "R1" | "R2" | "R3" | "R4" | "R5",
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      // L3's projection folds the 4,096 cubes into a handful of instanced draws; R3 adds one draw
      // per skinned fox on top. Anything near 4,097 would fail the L2 batch rule in `compare`.
      drawCalls: mode === "R1" || mode === "R2" ? 8 : 58,
      frameMs: series(12),
      // R1 and R2 build no characters, so a measurement on them would be a shape error below.
      ...(mode === "R1" || mode === "R2"
        ? {}
        : { foxMeasurement: { heightM: LADDER_FOX_HEIGHT, screenFraction: 0.041 } }),
      ladder: expectedLadderCounts(mode, OBJECT_COUNT),
      mode,
      objectCount: OBJECT_COUNT,
      positionHash: "aabbccdd",
      renderCheck: {
        distinctColors: 24_912,
        luminanceStdDev: 0.081,
        maxLuminance: 0.74,
        sampledPixels: 32_400,
      },
      repeat: 0,
      triangles: 49_176,
      visibleObjects: 4096,
      ...overrides,
    };
  }

  function ladderReport(
    rungOverrides: Record<string, unknown> = {},
    mode: "R1" | "R2" | "R3" | "R4" | "R5" = "R1",
  ): Record<string, unknown> {
    return {
      arm: "tn-web",
      build: { notes: "", type: "release" },
      device: { battery: null, label: "desktop-chrome-linux" },
      display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
      driver: { adapter: "test adapter", renderer: "test renderer" },
      engine: { name: "threenative", version: "workspace" },
      rungs: [ladderRung(mode, rungOverrides)],
    };
  }

  it("accepts a rung whose counts and read-back frame both say what the rung claims", () => {
    for (const mode of ["R1", "R2", "R3", "R4", "R5"] as const) {
      const parsed = parseRunReport(
        ladderReport({ mode, ladder: expectedLadderCounts(mode, OBJECT_COUNT) }, mode),
      );
      expect(parsed.rungs[0]?.ladder).toEqual(expectedLadderCounts(mode, OBJECT_COUNT));
      expect(parsed.rungs[0]?.renderCheck?.luminanceStdDev).toBe(0.081);
    }
  });

  it("refuses a rung whose counts do not match the rung it is published under", () => {
    // R1 published with R3's 50 characters in the scene is the failure this exists for.
    expect(() =>
      parseRunReport(
        ladderReport({ mode: "R1", ladder: expectedLadderCounts("R3", OBJECT_COUNT) }),
      ),
    ).toThrow(/TN_BENCH_LADDER_COUNTS.*skinnedMeshes|pointLights/u);
    // A missing count block is a hole in the measurement, not a rung that measured nothing.
    expect(() => parseRunReport(ladderReport({ ladder: undefined }))).toThrow(
      /TN_BENCH_MISSING_FIELD|TN_BENCH_BAD_SHAPE/u,
    );
    // A string where a count belongs is a wrong count, and fails the same way.
    expect(() =>
      parseRunReport(
        ladderReport({ ladder: { ...expectedLadderCounts("R1", OBJECT_COUNT), pointLights: "8" } }),
      ),
    ).toThrow(/TN_BENCH_LADDER_COUNTS/u);
  });

  it("refuses a character rung whose fox is not a fox", () => {
    // The bug this exists for: the Khronos Fox is authored in centimetres, so an unscaled import is
    // a 79 m statue. Every count still matched, the frame was still non-blank, and the published
    // number was a measurement of a camera full of overdraw rather than of skinning.
    expect(() =>
      parseRunReport(
        ladderReport({ foxMeasurement: { heightM: 79.03, screenFraction: 0.9 } }, "R3"),
      ),
    ).toThrow(/TN_BENCH_FOX_SIZE.*79/u);
    // The tolerance is 5%, so 2% off passes and 6% off does not.
    expect(() =>
      parseRunReport(
        ladderReport({ foxMeasurement: { heightM: 0.53, screenFraction: 0.04 } }, "R3"),
      ),
    ).toThrow(/TN_BENCH_FOX_SIZE/u);
    const passes = parseRunReport(
      ladderReport({ foxMeasurement: { heightM: 0.51, screenFraction: 0.04 } }, "R3"),
    );
    expect(passes.rungs[0]?.foxMeasurement?.heightM).toBe(0.51);
    // A character rung that recorded no size is unmeasured, and a size with no height is nonsense.
    expect(() => parseRunReport(ladderReport({ foxMeasurement: undefined }, "R3"))).toThrow(
      /TN_BENCH_BAD_SHAPE|TN_BENCH_MISSING_FIELD/u,
    );
    expect(() => parseRunReport(ladderReport({ foxMeasurement: { heightM: 0.5 } }, "R3"))).toThrow(
      /TN_BENCH_BAD_SHAPE.*screenFraction/u,
    );
    // A character covering none of the frame was culled or off-camera: the skinning was never drawn.
    expect(() =>
      parseRunReport(ladderReport({ foxMeasurement: { heightM: 0.5, screenFraction: 0 } }, "R3")),
    ).toThrow(/TN_BENCH_FOX_SIZE.*none of the frame/u);
    // A size on a rung with no characters is a shape error: R1 and R2 build no fox.
    expect(() =>
      parseRunReport(
        ladderReport({ foxMeasurement: { heightM: 0.5, screenFraction: 0.04 } }, "R1"),
      ),
    ).toThrow(/TN_BENCH_BAD_SHAPE/u);
  });

  it("refuses a comparison whose two engines drew different-sized foxes", () => {
    // Neither per-arm gate can see this: 0.476 m and 0.524 m are each inside the 5% band around the
    // target, and the 9.6% between them is only visible once both are in hand.
    const left = parseRunReport(
      ladderReport({ foxMeasurement: { heightM: 0.476, screenFraction: 0.04 } }, "R3"),
    );
    const agree = parseRunReport(
      ladderReport({ foxMeasurement: { heightM: 0.48, screenFraction: 0.04 }, repeat: 1 }, "R3"),
    );
    expect(checkEquivalence(left, agree)).toEqual([]);
    const apart = parseRunReport(
      ladderReport({ foxMeasurement: { heightM: 0.524, screenFraction: 0.04 } }, "R3"),
    );
    const failures = checkEquivalence(left, apart);
    expect(failures.map((failure) => failure.field).join(" ")).toMatch(/foxMeasurement/u);
    expect(() => compare(left, apart)).toThrow(/TN_BENCH_NOT_EQUIVALENT/u);
  });

  it("reads a 0.5 m character out of any import that reports its own height", () => {
    // The factor is measured, not hardcoded, so an importer that changes its units changes the
    // answer rather than quietly leaving a 79 m fox in a scene published as 0.5 m ones.
    expect(foxScale(79.028_933)).toBeCloseTo(0.5 / 79.028_933, 12);
    expect(() => foxScale(0)).toThrow(/TN_BENCH_FOX_RAW_HEIGHT/u);
    expect(() => foxScale(Number.NaN)).toThrow(/TN_BENCH_FOX_RAW_HEIGHT/u);
    expect(foxMeasurementReason({ heightM: 0.5, screenFraction: 0.04 })).toBeNull();
    expect(foxMeasurementReason(undefined)).toMatch(/no character measurement/u);
    expect(
      foxParityReason(
        { heightM: 0.5, screenFraction: 0.04 },
        { heightM: 0.51, screenFraction: 0.04 },
      ),
    ).toBeNull();
    expect(
      foxParityReason(
        { heightM: 0.5, screenFraction: 0.04 },
        { heightM: 0.6, screenFraction: 0.04 },
      ),
    ).toMatch(/apart in height/u);
  });

  it("puts the characters on the ground, on the cube grid, identically in both engines", () => {
    // The 10x5 block is spaced at `CUBE_SPACING` so a fox stands in a gap between lattice cells,
    // and its y is the ground: the old 4.5 m placement put a centimetre-authored fox at head height.
    for (const index of [0, 9, 10, 49]) {
      expect(characterPlacement(index).y).toBe(0);
    }
    expect(characterPlacement(0).x).toBe(-11.25);
    expect(characterPlacement(9).x).toBe(11.25);
    expect(characterPlacement(0).z).toBe(-5);
    expect(characterPlacement(49).z).toBe(5);
  });

  it("refuses a rung that drew nothing, and a rung that has no read-back at all", () => {
    expect(() => parseRunReport(ladderReport({ drawCalls: 0 }))).toThrow(/TN_BENCH_NOTHING_DRAWN/u);
    expect(() => parseRunReport(ladderReport({ triangles: 0 }))).toThrow(/TN_BENCH_NOTHING_DRAWN/u);
    // A rung with no read-back is unmeasured, which is not the same as measured-and-fine.
    expect(() => parseRunReport(ladderReport({ renderCheck: undefined }))).toThrow(
      /TN_BENCH_RENDER_CHECK_MISSING/u,
    );
  });

  it("refuses a uniform frame: the flat grey an unlit or unwired window renders as", () => {
    // One colour and no variation at any brightness: exactly what an empty viewport reads back.
    expect(() =>
      parseRunReport(
        ladderReport({
          renderCheck: {
            distinctColors: 1,
            luminanceStdDev: 0,
            maxLuminance: 0.3,
            sampledPixels: 32_400,
          },
        }),
      ),
    ).toThrow(/TN_BENCH_BLANK_FRAME/u);
    // A frame with plenty of colours that are all the same brightness is uniform too.
    expect(() =>
      parseRunReport(
        ladderReport({
          renderCheck: {
            distinctColors: 40_000,
            luminanceStdDev: 0,
            maxLuminance: 0.3,
            sampledPixels: 32_400,
          },
        }),
      ),
    ).toThrow(/TN_BENCH_BLANK_FRAME/u);
    // And a read-back that returned nothing at all is blank, not unmeasured.
    expect(() =>
      parseRunReport(
        ladderReport({
          renderCheck: {
            distinctColors: 0,
            luminanceStdDev: 0,
            maxLuminance: 0,
            sampledPixels: 0,
          },
        }),
      ),
    ).toThrow(/TN_BENCH_BLANK_FRAME/u);
  });

  it("refuses a ladder block on an L rung, where it would mean nothing", () => {
    expect(() =>
      parseRunReport(
        ladderReport({ mode: "L1", ladder: expectedLadderCounts("R1", OBJECT_COUNT) }),
      ),
    ).toThrow(/only meaningful on a realistic-scene rung/u);
  });
});

describe("engine load test equivalence gate", () => {
  it("should refuse a comparison whose scenes hash differently, naming the field", () => {
    const left = ladderReport(24);
    const right = ladderReport(24, "godot-web");
    right.rungs[1] = rung({ ...right.rungs[1], positionHash: "deadbeef" });
    expect(checkEquivalence(left, right).map((failure) => failure.field)).toContain("positionHash");
    expect(() => compare(left, right)).toThrow(/TN_BENCH_NOT_EQUIVALENT.*positionHash/s);
  });

  it("should refuse an initial placement mismatch beyond the legacy hash window", () => {
    const left = ladderReport(24);
    const right = ladderReport(24, "godot-web");
    left.rungs[0] = rung({ ...left.rungs[0], initialPlacementSha256: "a".repeat(64) });
    right.rungs[0] = rung({ ...right.rungs[0], initialPlacementSha256: "b".repeat(64) });
    expect(left.rungs[0]?.positionHash).toBe(right.rungs[0]?.positionHash);
    expect(checkEquivalence(left, right).map((failure) => failure.field)).toContain(
      "initialPlacementSha256",
    );
  });

  it("should refuse a nondefault matrix cell against an arm with no axes", () => {
    // `positionHash` covers only the initial placements, so these two hash alike and would publish
    // as equivalent without comparing the axis records.
    const cell = ladderReport(24);
    cell.axes = { ...DEFAULT_AXES, mutationRate: 0 };
    const godot = ladderReport(24, "godot-web");
    expect(checkEquivalence(cell, godot).map((failure) => failure.field)).toContain("axes");
    expect(() => compare(cell, godot)).toThrow(/TN_BENCH_NOT_EQUIVALENT.*axes/s);

    // A missing record is the default scene: it matches another missing record and an explicit
    // default, but never a nondefault cell.
    expect(checkEquivalence(ladderReport(24), godot)).toEqual([]);
    const explicitDefault = ladderReport(24);
    explicitDefault.axes = DEFAULT_AXES;
    expect(checkEquivalence(explicitDefault, godot).map((failure) => failure.field)).not.toContain(
      "axes",
    );
    expect(checkEquivalence(cell, explicitDefault).map((failure) => failure.field)).toContain(
      "axes",
    );
  });

  it("should refuse a hash that diverges on only one repeat of a rung", () => {
    // The first cut of the gate keyed one rung per ladder step, so every repeat but the last was
    // invisible and a single diverged scene published as if it matched.
    const left = ladderReport(24);
    const right = ladderReport(24, "godot-web");
    const second = rung({ ...right.rungs[1], positionHash: "deadbeef", repeat: 1 });
    right.rungs = [...right.rungs.slice(0, 2), second, ...right.rungs.slice(2)];
    left.rungs = [
      ...left.rungs.slice(0, 2),
      rung({ ...left.rungs[1], repeat: 1 }),
      ...left.rungs.slice(2),
    ];
    const fields = checkEquivalence(left, right).map((failure) => failure.field);
    expect(fields.some((field) => field.startsWith("positionHash"))).toBe(true);
  });

  it("should refuse an arm whose frame interval is display-pinned rather than load-following", () => {
    // Godot's Android export ignored VSYNC_DISABLED and read ~19 ms at every rung of a 16x ladder.
    // The requested `display.vsync` said false, so the flatness has to be caught in the samples.
    const pinned = ladderReport(24, "godot-web");
    pinned.rungs = pinned.rungs.map((entry) => ({ ...entry, frameMs: series(19) }));
    const fields = checkEquivalence(ladderReport(24), pinned).map((failure) => failure.field);
    expect(fields.some((field) => field.includes("display-pinned"))).toBe(true);
    // Two arms that both follow the load are comparable and must not trip it.
    expect(
      checkEquivalence(ladderReport(24), ladderReport(30, "godot-web")).some((failure) =>
        failure.field.includes("display-pinned"),
      ),
    ).toBe(false);
  });

  it("should refuse a release arm compared against a debug arm", () => {
    const right = ladderReport(24, "godot-web");
    right.build = { notes: "", type: "debug" };
    expect(checkEquivalence(ladderReport(24), right).map((failure) => failure.field)).toContain(
      "build.type",
    );
  });

  it("should refuse two arms whose displays disagree", () => {
    const right = ladderReport(24, "godot-web");
    right.display = { ...right.display, refreshHz: 120 };
    expect(checkEquivalence(ladderReport(24), right).map((failure) => failure.field)).toContain(
      "display.refreshHz",
    );
  });

  it("should refuse an L1 rung that silently auto-batched on one arm", () => {
    const right = ladderReport(24, "godot-web");
    right.rungs[3] = rung({ ...right.rungs[3], drawCalls: 1 });
    const fields = checkEquivalence(ladderReport(24), right).map((failure) => failure.field);
    expect(fields.some((field) => field.startsWith("drawCalls"))).toBe(true);
  });

  it("should refuse two arms whose triangle counts are more than 5% apart", () => {
    const right = ladderReport(24, "godot-web");
    right.rungs[0] = rung({ ...right.rungs[0], triangles: 6000 });
    const fields = checkEquivalence(ladderReport(24), right).map((failure) => failure.field);
    expect(fields.some((field) => field.startsWith("triangles"))).toBe(true);
  });

  it("should publish a comparison when both arms agree on the scene", () => {
    const comparison = compare(ladderReport(24), ladderReport(30, "godot-web"));
    expect(comparison.leftKnee.L1).toBe(4096);
    expect(comparison.rightKnee.L1).toBe(4096);
    expect(checkEquivalence(ladderReport(24), ladderReport(30, "godot-web"))).toEqual([]);
  });

  it("should publish an L4 pair at one draw per cube and refuse one that batched", () => {
    // R3's row is "nothing can batch", so the record has to survive the reader and the gate has to
    // judge it by per-cube draws rather than by the L2 batch rule.
    const l4 = (arm: IRunReport["arm"]): IRunReport =>
      report({ arm, rungs: [rung({ mode: "L4", drawCalls: 4097, visibleObjects: 4096 })] });
    expect(parseRunReport(JSON.parse(JSON.stringify(l4("tn-desktop")))).rungs[0]?.mode).toBe("L4");
    expect(() =>
      parseRunReport({ ...l4("tn-desktop"), rungs: [rung({ mode: "L5" as never })] }),
    ).toThrow(/TN_BENCH_BAD_SHAPE/u);
    expect(checkEquivalence(l4("tn-desktop"), l4("godot-desktop"))).toEqual([]);
    const batched = l4("godot-desktop");
    batched.rungs[0] = rung({ mode: "L4", drawCalls: 2, visibleObjects: 4096 });
    expect(checkEquivalence(l4("tn-desktop"), batched).map((failure) => failure.field)).toContain(
      "drawCalls (right arm auto-batched L4)",
    );
  });

  it("should refuse a provisional comparison", () => {
    const left = ladderReport(24);
    left.provisional = ["battery"];
    expect(() => compare(left, ladderReport(30, "godot-web"))).toThrow(
      /TN_BENCH_PROVISIONAL_COMPARISON/,
    );
  });

  it("should fail closed when Android comparison provisional arrays disagree", () => {
    const left = ladderReport(24, "tn-android");
    const condition = {
      batteryPercent: 80,
      charging: false,
      chargingSource: "NONE",
      provisional: [],
      screenOn: true,
      serial: "37251FDJH0037Z",
      thermalStatus: "NONE",
      thermalStatusCode: 0,
    };
    left.deviceCondition = condition;
    left.provisional = [];
    const right = ladderReport(30, "godot-android");
    right.deviceCondition = { ...condition, provisional: ["battery"] };
    right.provisional = [];
    expect(() => compare(left, right)).toThrow(/TN_BENCH_BAD_SHAPE/);
    expect(() => compare({ ...left, provisional: undefined }, right)).toThrow(/TN_BENCH_BAD_SHAPE/);
    expect(() =>
      compare(
        { ...left, provisional: ["battery"] },
        { ...right, deviceCondition: { ...condition, provisional: [] } },
      ),
    ).toThrow(/TN_BENCH_BAD_SHAPE/);
  });
});

describe("engine load test frozen-scene detection", () => {
  it("should refuse a device run below the battery floor unless it is asked for", async () => {
    // A phone under ~50% throttles, and the resulting number describes the battery. The escape hatch
    // exists because two arms at the same low charge still compare, but it has to be requested.
    const drained = { batteryPercent: 21, serial: "37251FDJH0037Z" };
    const charged = { batteryPercent: 74, serial: "37251FDJH0037Z" };
    const gate = (state: { batteryPercent: number }, allow: boolean): boolean =>
      state.batteryPercent >= MINIMUM_BATTERY_PERCENT || allow;
    expect(gate(drained, false)).toBe(false);
    expect(gate(drained, true)).toBe(true);
    expect(gate(charged, false)).toBe(true);
    expect(MINIMUM_BATTERY_PERCENT).toBe(50);
  });

  it("should read a frame interval that ignores load as the display, not the engine", () => {
    // Both a 120 Hz phone and a vsync-locked desktop host produce this shape, and it is the reason
    // an 8.2 ms mobile frame is reported as "fits inside one frame" rather than as a measured cost.
    const pinned = ladderReport(24, "godot-web");
    pinned.rungs = pinned.rungs.map((entry) => ({ ...entry, frameMs: series(8.3) }));
    expect(looksVsyncPinned(summarize(pinned), "L1")).toBe(true);
    expect(looksVsyncPinned(summarize(ladderReport(24)), "L1")).toBe(false);
  });
});

describe("engine load test desktop capture", () => {
  // The native desktop host prints its report, finishes its main loop, reaches `_exit` — and then
  // spins in userspace instead of terminating. A capture that waited for process exit therefore
  // hung forever with the finished report already sitting in its buffer, which read as "the
  // benchmark is slow" rather than "the benchmark is done". The report ends at the END marker, so
  // that is the completion signal; the process is killed after it.
  it("should return once the report marker lands, even if the host never exits", async () => {
    const report = { hello: "world" };
    const script = [
      `echo ${BEGIN_MARKER}`,
      `echo TNJSON:'${JSON.stringify(report)}'`,
      `echo ${END_MARKER}`,
      "sleep 300",
    ].join("; ");
    const started = Date.now();
    const parsed = await runCapturing("sh", ["-c", script], { cwd: process.cwd() });
    expect(parsed).toEqual(report);
    // The fixture sleeps for five minutes; anything near that means exit was waited on.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("should still fail closed when a host exits without ever emitting a report", async () => {
    await expect(
      runCapturing("sh", ["-c", "echo nothing useful"], { cwd: process.cwd() }),
    ).rejects.toThrow(/TN_BENCH_NO_REPORT/);
  }, 30_000);

  it("should kill a host that never reaches its marker, and leave nothing running", async () => {
    // The failure this exists for: a smoke run that never finished left `load_test.x86_64`
    // reparented to init and burning 75% of a core for half an hour, which showed up as a grey
    // window on the display and as load on every run after it. A timed-out arm must take its whole
    // process group down: the fixture is a shell, a background sleeper and a foreground sleep, so
    // signalling only the direct child would leave the sleeper behind — the orphan itself.
    const pidFile = path.join(os.tmpdir(), `tn-bench-orphan-${process.pid}.pid`);
    fs.rmSync(pidFile, { force: true });
    const script = `sleep 300 & echo $! > ${pidFile}; sleep 300`;
    await expect(
      runCapturing("sh", ["-c", script], { cwd: process.cwd(), timeoutMs: 1_500 }),
    ).rejects.toThrow(/TN_BENCH_DESKTOP_TIMEOUT/);
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    // Past the SIGTERM grace, so a process that ignored SIGTERM would already have been SIGKILLed.
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 2_000));
    expect(Number.isInteger(pid)).toBe(true);
    // `kill -0` on a surviving, reparented process is the orphan. It throws ESRCH only when the
    // process is gone, which is the observation this whole test exists to make.
    expect(() => process.kill(pid, 0)).toThrow();
    fs.rmSync(pidFile, { force: true });
  }, 30_000);

  it("should give a host a grace period to die before signalling it the hard way", () => {
    // Godot tears down a Vulkan swapchain and a shadow atlas on the way out, and the observation is
    // that it did it on SIGTERM and never on SIGKILL. A group stopped with SIGKILL alone skips that
    // teardown, so the grace is the difference between a clean exit and a grey window.
    expect(KILL_GRACE_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe("the performance baseline gate", () => {
  // The realistic Android regression is not drift, it is the engine default reverting: 8.34 ms to
  // 101.24 ms on the same rung. Every case below is shaped around catching that cliff without
  // becoming a false-alarm generator on ordinary device noise.
  const BASELINES = {
    "tn-android": {
      evidence: "docs/verification/prd-130-phase-6-2026-08-16.md",
      rungs: { "L2@4096": 8.27, "L3@16384": 8.34 },
    },
  } as const;

  function androidReport(
    l2Ms: number,
    l3Ms: number,
    overrides: Partial<IRunReport> = {},
  ): IRunReport {
    return report({
      arm: "tn-android",
      display: { height: 720, refreshHz: 120, vsync: true, width: 1280 },
      rungs: [
        rung({ frameMs: series(l2Ms), mode: "L2", objectCount: 4096 }),
        rung({ frameMs: series(l3Ms), mode: "L3", objectCount: 16_384 }),
      ],
      ...overrides,
    });
  }

  it("passes a run that holds its recorded numbers", () => {
    const check = checkPerformance(androidReport(8.27, 8.34), BASELINES);
    expect(check?.regressions).toEqual([]);
    expect(check?.checked).toEqual(["L2@4096", "L3@16384"]);
    expect(check?.evidence).toBe("docs/verification/prd-130-phase-6-2026-08-16.md");
  });

  it("catches the engine reverting to QuickJS, which is what it exists for", () => {
    // The measured QuickJS numbers from the same device and bundle.
    const check = checkPerformance(androidReport(20.61, 101.24), BASELINES);
    expect(check?.regressions.map((row) => row.rung)).toEqual(["L2@4096", "L3@16384"]);
    const top = check?.regressions.find((row) => row.rung === "L3@16384");
    expect(top?.measuredMs).toBeCloseTo(101.24, 2);
    expect(top?.baselineMs).toBeCloseTo(8.34, 2);
  });

  it("tolerates device noise below the threshold and fails above it", () => {
    // Set so an ordinary noisy afternoon does not cry wolf: a tight bound produces a gate people
    // learn to ignore, which is worse than no gate.
    expect(PERFORMANCE_REGRESSION_TOLERANCE).toBe(0.25);
    const justUnder = 8.34 * 1.24;
    const justOver = 8.34 * 1.26;
    expect(checkPerformance(androidReport(8.27, justUnder), BASELINES)?.regressions).toEqual([]);
    expect(
      checkPerformance(androidReport(8.27, justOver), BASELINES)?.regressions.map(
        (row) => row.rung,
      ),
    ).toEqual(["L3@16384"]);
  });

  it("fails when the run stopped measuring a rung the baseline names", () => {
    // The quiet way a regression hides: drop the expensive rung and every remaining number looks
    // fine. Skipping it would be the v1 harness defect -- an assertion set that shrank to nothing
    // and reported pass.
    const missingTopRung = report({
      arm: "tn-android",
      rungs: [rung({ frameMs: series(8.27), mode: "L2", objectCount: 4096 })],
    });
    expect(() => checkPerformance(missingTopRung, BASELINES)).toThrow(
      /TN_BENCH_BASELINE_RUNG_MISSING.*L3@16384/su,
    );
  });

  it("refuses a provisional run rather than letting it clear the bar", () => {
    // PRD-127's override writes the condition into the report. A number taken outside its declared
    // conditions cannot satisfy a budget, for the same reason `compare` refuses one.
    const provisional = androidReport(8.27, 8.34, { provisional: ["charging"] });
    expect(() => checkPerformance(provisional, BASELINES)).toThrow(
      /TN_BENCH_PROVISIONAL_BASELINE.*charging/su,
    );
  });

  it("says nothing about an arm that has no recorded baseline", () => {
    // Silence, not a pass: an arm nobody has measured must not appear to have met a budget.
    expect(checkPerformance(report({ arm: "tn-web" }), BASELINES)).toBeUndefined();
  });

  it("rejects a missing baseline when the caller marks the lane required", () => {
    expect(() =>
      checkPerformance(report({ arm: "tn-web" }), {}, undefined, { required: true }),
    ).toThrow(/TN_BENCH_BASELINE_MISSING/u);
  });

  it("rejects empty and cross-device evidence in required mode", () => {
    const empty = {
      "tn-android": {
        evidence: "docs/verification/accepted.md",
        rungs: {},
        status: "accepted" as const,
      },
    };
    expect(() =>
      checkPerformance(androidReport(8.27, 8.34), empty, undefined, { required: true }),
    ).toThrow(/TN_BENCH_BASELINE_EMPTY/u);
    const otherDevice = {
      "tn-android": {
        evidence: "docs/verification/accepted.md",
        identity: { device: "different-device" },
        rungs: { "L2@4096": 8.27, "L3@16384": 8.34 },
        status: "accepted" as const,
      },
    };
    expect(() =>
      checkPerformance(androidReport(8.27, 8.34), otherDevice, undefined, { required: true }),
    ).toThrow(/TN_BENCH_BASELINE_IDENTITY_MISMATCH/u);
  });

  it("requires every provenance field for a required baseline candidate", () => {
    const provenance = {
      architecture: "arm64",
      artifactHash: "accepted-artifact",
      browser: "none",
      device: "desktop-chrome-linux",
      graphicsBackend: "vulkan",
      gpu: "accepted-gpu",
      instrumentationRevision: "accepted-instrumentation",
      jsRuntime: "v8",
      nativeBinaryHash: "accepted-binary",
      operatingSystem: "linux",
      presentMode: "immediate",
      resolution: "1280x720",
      sourceSha: "accepted-source",
      workloadHash: "accepted-workload",
    };
    const baseline = {
      "tn-android": {
        evidence: "docs/verification/accepted.md",
        identity: provenance,
        rungs: { "L2@4096": 8.27, "L3@16384": 8.34 },
        status: "accepted" as const,
      },
    };
    for (const field of ["sourceSha", "artifactHash", "nativeBinaryHash"] as const) {
      const value = { ...provenance, [field]: undefined };
      expect(() =>
        checkPerformance(androidReport(8.27, 8.34, { identity: value }), baseline, undefined, {
          required: true,
        }),
      ).toThrow(/TN_BENCH_BASELINE_IDENTITY_(?:MISSING|MISMATCH)/u);
    }
  });

  it("evaluates a genuine candidate with fresh provenance when stable identity matches", () => {
    const baselineIdentity = {
      architecture: "arm64",
      artifactHash: "accepted-artifact",
      browser: "none",
      device: "desktop-chrome-linux",
      graphicsBackend: "vulkan",
      gpu: "accepted-gpu",
      instrumentationRevision: "accepted-instrumentation",
      jsRuntime: "v8",
      nativeBinaryHash: "accepted-binary",
      operatingSystem: "linux",
      presentMode: "immediate",
      resolution: "1280x720",
      sourceSha: "accepted-source",
      workloadHash: "accepted-workload",
    };
    const baseline = {
      "tn-android": {
        evidence: "docs/verification/accepted.md",
        identity: baselineIdentity,
        rungs: { "L2@4096": 8.27, "L3@16384": 8.34 },
        status: "accepted" as const,
      },
    };
    const candidate = {
      ...baselineIdentity,
      artifactHash: "candidate-artifact",
      nativeBinaryHash: "candidate-binary",
      sourceSha: "candidate-source",
    };
    const check = checkPerformance(
      androidReport(8.27, 8.34, { identity: candidate }),
      baseline,
      undefined,
      { required: true },
    );
    expect(check?.regressions).toEqual([]);
    expect(() =>
      checkPerformance(
        androidReport(8.27, 8.34, {
          identity: { ...candidate, gpu: "different-gpu" },
        }),
        baseline,
        undefined,
        { required: true },
      ),
    ).toThrow(/TN_BENCH_BASELINE_IDENTITY_MISMATCH/u);
  });

  it("refuses a negative tolerance instead of inverting the comparison", () => {
    expect(() => checkPerformance(androidReport(8.27, 8.34), BASELINES, -0.1)).toThrow(
      /TN_BENCH_BAD_TOLERANCE/u,
    );
  });

  it("ships a baseline for the Android arm, citing the run that produced it", () => {
    // A baseline with no evidence path is a number nobody can check the conditions of.
    const android = PERFORMANCE_BASELINES["tn-android"];
    expect(android).toBeDefined();
    expect(android?.evidence).toMatch(/^docs\/verification\/.+\.md$/u);
    expect(Object.keys(android?.rungs ?? {})).toContain("L3@16384");
    // The recorded figure is vsync-bound at 120 Hz, so it is a ceiling on V8's real cost. If this
    // ever drops materially below the frame interval, the arm stopped being display-bound and the
    // baseline should be re-derived rather than nudged.
    expect(android?.rungs["L3@16384"]).toBeLessThan(1000 / 120 + 0.5);
  });
});

describe("the emulator canary", () => {
  // Measured 2026-08-17 rather than assumed: an emulator CAN catch an engine revert, and its absolute
  // numbers are worthless as performance figures. Both halves are load-bearing.
  const EMULATOR_V8 = { "L2@4096": 75.17, "L2@16384": 204.08, "L3@4096": 48.03, "L3@16384": 65.76 };
  const PHONE_V8 = { "L2@4096": 8.27, "L2@16384": 8.21, "L3@4096": 8.29, "L3@16384": 8.34 };

  function condition(serial: string): NonNullable<IRunReport["deviceCondition"]> {
    return {
      batteryPercent: serial.startsWith("emulator-") ? 100 : 80,
      charging: serial.startsWith("emulator-"),
      chargingSource: serial.startsWith("emulator-") ? "AC" : "none",
      provisional: [],
      screenOn: true,
      serial,
      thermalStatus: "NONE",
      thermalStatusCode: 0,
    };
  }

  function androidRun(serial: string, p50s: Record<string, number>): IRunReport {
    return report({
      arm: "tn-android",
      deviceCondition: condition(serial),
      display: { height: 720, refreshHz: 120, vsync: true, width: 1280 },
      rungs: Object.entries(p50s).map(([key, ms]) => {
        const [mode, count] = key.split("@");
        return rung({
          frameMs: series(ms),
          mode: mode as IRunReport["rungs"][number]["mode"],
          objectCount: Number(count),
        });
      }),
    });
  }

  it("compares an emulator run against the emulator baseline, not the phone's", () => {
    // The phone's top rung is 8.34 ms and the emulator's is 65.76 for the same work. Crossing the two
    // would report a regression on every emulator run and a pass on nothing.
    const check = checkPerformance(androidRun("emulator-5554", EMULATOR_V8));
    expect(check?.arm).toBe("tn-android@emulator");
    expect(check?.regressions).toEqual([]);
  });

  it("still catches the engine reverting, on three rungs of four", () => {
    // The QuickJS numbers measured on the same emulator. The ratio at the top rung falls to 2.4x from
    // the phone's 12.1x, because swiftshader is a CPU rasteriser and software rendering swamps script
    // time.
    const check = checkPerformance(
      androidRun("emulator-5554", {
        "L2@4096": 87.75,
        "L2@16384": 299.19,
        "L3@4096": 70.36,
        "L3@16384": 158.0,
      }),
    );
    expect(check?.regressions.map((row) => row.rung).sort()).toEqual([
      "L2@16384",
      "L3@16384",
      "L3@4096",
    ]);

    // **And this is the canary's honest limit, asserted so nobody has to rediscover it.** L2@4096
    // moves only 75.17 -> 87.75 ms, 1.2x, which fits inside the 25% tolerance and does not trip. On
    // the phone that rung moves 2.5x and does. So the emulator is a tripwire with three working
    // strands, not four, and a subtler regression than a whole-engine revert may well cross it
    // unnoticed. That is the price of a gate that runs without a phone.
    expect(check?.regressions.map((row) => row.rung)).not.toContain("L2@4096");
  });

  it("does not let a phone report be judged against the emulator budget", () => {
    // A phone reading the emulator's numbers is an eight-fold regression and must not pass because the
    // emulator is allowed to be that slow.
    const check = checkPerformance(androidRun("37251FDJH0037Z", EMULATOR_V8));
    expect(check?.arm).toBe("tn-android");
    expect(check?.regressions.length).toBe(4);
  });

  it("holds the phone baseline for a phone serial", () => {
    const check = checkPerformance(androidRun("37251FDJH0037Z", PHONE_V8));
    expect(check?.arm).toBe("tn-android");
    expect(check?.regressions).toEqual([]);
  });
});

// PRD-449's `plain-three-webgpu` control: the same Three.js bytes and the same authored scene as
// the TN web arm, with no framework code in the graph it serves. Two things can silently rot it —
// framework code reaching the graph, and a software rasteriser answering for a hardware pilot —
// and a third, a page that reports a scene the collector cannot confirm.
describe("plain three.js control arm", () => {
  // One import statement, from `import` to its terminating semicolon, reaching into `packages/`
  // without saying `import type`. A type-only import is erased before the browser sees it; a
  // runtime one is the framework sitting inside the control.
  const RUNTIME_FRAMEWORK_IMPORT = /import\s+(?!type\b)[^;]*?["'][^"']*\/packages\//u;

  it("keeps every module the plain entry serves free of runtime framework code", async () => {
    const seen = new Set<string>();
    const pending = ["examples/engine-load-test/src/plain.ts"];
    while (pending.length > 0) {
      const file = pending.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const absolute = path.join(process.cwd(), file);
      if (!existsSync(absolute)) continue;
      const source = await readFile(absolute, "utf8");
      expect([file, RUNTIME_FRAMEWORK_IMPORT.test(source)]).toEqual([file, false]);
      // `import type` is erased before the browser sees it, so a type-only reference is not part of
      // the graph the control serves and the walk does not follow it.
      const runtime = source.replace(/import\s+type\s+[^;]*;/gu, "");
      for (const specifier of extractModuleSpecifiers(runtime)) {
        if (!specifier.startsWith(".")) continue;
        pending.push(path.join(path.dirname(file), specifier).replace(/\.js$/u, ".ts"));
      }
    }
    // A control that measures nothing is not a control: the harness it shares with the TN arm is
    // the only reason the two arms frame the same scene. `ladder.ts` is in that graph because
    // `workload.ts` imports its rung names from it; it is constants and pure functions, which is
    // why the framework-import check above passes for it too.
    expect([...seen].sort()).toEqual([
      "examples/engine-load-test/src/driver.ts",
      "examples/engine-load-test/src/game.ts",
      "examples/engine-load-test/src/identity.ts",
      "examples/engine-load-test/src/ladder.ts",
      "examples/engine-load-test/src/phases.ts",
      "examples/engine-load-test/src/plain.ts",
      "examples/engine-load-test/src/workload.ts",
    ]);
  });

  it("reads a real control report through the shared parser and refuses the rest", () => {
    // The control is a `report.ts` arm now, so the dashboard, `--check-report` and the CLI all reach
    // it through the one parser every other arm uses.
    const parsed = parseRunReport(plainReport());
    expect(parsed.arm).toBe("plain-three-webgpu");
    expect(parsed.engine).toEqual({ name: "three", version: "185" });
    // The axes are the matrix cell the number belongs to; without them a pilot is not comparable.
    expect(parsed.axes).toEqual(DEFAULT_AXES);
    // An arm is one engine, and `three` is only ever the control's: a `three` report under a TN arm
    // is a build stamp that does not match the platform, and the TN/Godot pairing is unchanged.
    expect(() => parseRunReport(plainReport({ arm: "tn-web" }))).toThrow(/is not an engine/u);
    expect(() => parseRunReport(plainReport({ arm: "godot-web" }))).toThrow(/is not an engine/u);
    expect(() =>
      parseRunReport(plainReport({ engine: { name: "threenative", version: "workspace" } })),
    ).toThrow(/is not an engine/u);
    // Fail closed on samples, as every other arm does: an empty series and a non-finite or negative
    // sample are faults, not numbers.
    const malformed = (frameMs: unknown[]): Record<string, unknown> =>
      plainReport({ rungs: [rung({ frameMs: frameMs as number[] })] });
    expect(() => parseRunReport(malformed([]))).toThrow(/TN_BENCH_EMPTY_SERIES/u);
    expect(() => parseRunReport(malformed([Number.NaN]))).toThrow(/TN_BENCH_BAD_SHAPE/u);
    expect(() => parseRunReport(malformed(["9"]))).toThrow(/TN_BENCH_BAD_SHAPE/u);
    expect(() => parseRunReport(malformed([8, -1]))).toThrow(/TN_BENCH_BAD_SHAPE/u);
    expect(() =>
      parseRunReport(
        plainReport({ rungs: [{ ...rung(), initialPlacementSha256: "not-a-sha256" }] }),
      ),
    ).toThrow(/TN_BENCH_BAD_SHAPE/u);
  });

  it("refuses a software rasteriser and a scene the collector cannot confirm", () => {
    expect(assertHardwareAdapter("nvidia / turing")).toBe("nvidia / turing");
    for (const software of ["swiftshader / google", "llvmpipe / mesa", "lavapipe / llvm"]) {
      expect(() => assertHardwareAdapter(software)).toThrow(/TN_BENCH_SOFTWARE_ADAPTER/u);
    }
    // The collector catches a false legacy positionHash; full-fixture identity, including objects
    // beyond index eight, is a separate gate before publication.
    const pilot = parseRunReport(plainReport());
    expect(assertPlainThreePilot(pilot)).toBe(pilot);
    expect(() =>
      assertPlainThreePilot(
        parseRunReport(plainReport({ rungs: [rung({ positionHash: "deadbeef" })] })),
      ),
    ).toThrow(/TN_BENCH_SCENE_MISMATCH/u);
    const objectCount = 4096;
    expect(() =>
      assertPlainThreePilot(
        parseRunReport(
          plainReport({
            rungs: [
              {
                ...rung({ objectCount, positionHash: positionHash(createPlacements(objectCount)) }),
                initialPlacementSha256: placementDigest(objectCount, 9),
              },
            ],
          }),
        ),
      ),
    ).toThrow(/TN_BENCH_PLACEMENT_MISMATCH/u);
    expect(() =>
      assertPlainThreePilot(
        parseRunReport(
          plainReport({ driver: { adapter: "google / swiftshader", renderer: "three/webgpu" } }),
        ),
      ),
    ).toThrow(/TN_BENCH_SOFTWARE_ADAPTER/u);
  });
});

function plainReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const objectCount = 4096;
  return {
    arm: "plain-three-webgpu",
    axes: DEFAULT_AXES,
    build: { notes: "vite production build, plain three/webgpu control", type: "release" },
    device: { battery: null, label: "desktop-chrome-linux" },
    display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
    driver: { adapter: "nvidia / turing", renderer: "three/webgpu WebGPURenderer" },
    engine: { name: "three", version: "185" },
    rungs: [
      {
        ...rung({ objectCount, positionHash: positionHash(createPlacements(objectCount)) }),
        initialPlacementSha256: placementDigest(objectCount),
      },
    ],
    ...overrides,
  };
}

function placementDigest(objectCount: number, mutatedIndex = -1): string {
  const placements = createPlacements(objectCount);
  return createHash("sha256")
    .update(
      canonicalPlacementBytes(objectCount, (index) => {
        const placement = placements[index] as (typeof placements)[number];
        return {
          x:
            placement.x +
            culledOffsetX(index, DEFAULT_AXES.visibleFraction) +
            (index === mutatedIndex ? 1 : 0),
          y: placement.y,
          z: placement.z,
        };
      }),
    )
    .digest("hex");
}

// PRD-449 §7.4's primary metric, on the shared driver both web arms run: the wall time for N
// *complete* rendered frames, drained once at the boundary. Summing the CPU submit spans instead
// leaves the browser's rAF waits out of the window, and a queue-backed arm is then measured by its
// submission cost rather than by how long N finished frames took — so the boundary is pinned here on
// an injected clock rather than inferred from a run.
describe("the completed-work measurement boundary", () => {
  const FRAMES = 4;
  const WARMUP = 2;
  const STEP_MS = 1;
  const RENDER_MS = 9;
  /** One vsync wait per frame: real browser cadence, and inside the wall window by definition. */
  const PRESENT_MS = 16;
  const PRE_DRAIN_MS = 3;
  const POST_DRAIN_MS = 5;
  const KNOBS = { frames: FRAMES, repeats: 1, warmup: WARMUP };
  const ARM: ILadderArm = {
    arm: "stub",
    buildNotes: "stub",
    engineName: "three",
    engineVersion: "185",
    rendererLabel: "stub",
  };

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("captures the last measured web frame after closing the completed-work window", async () => {
    const { measureRung } = await loadDriver();
    const { clock, advance } = virtualClock();
    const capture = vi.fn(async () => {
      advance(1000);
      return "fixture-png";
    });
    vi.stubGlobal("__TN_BENCH_CAPTURE__", capture);
    try {
      const result = await measureRung(
        stubHarness(
          {
            onSubmittedWorkDone: async () => {
              advance(POST_DRAIN_MS);
            },
          },
          advance,
        ),
        ARM,
        { mode: "L1", objectCount: 1 },
        0,
        KNOBS,
        clock,
      );
      expect(result.framePng).toBe("fixture-png");
      expect(capture).toHaveBeenCalledOnce();
      expect(result.completedWorkMeanMs).toBe(28.5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The driver reads the page's query string at module scope, which node has no `location` for.
  async function loadDriver(): Promise<
    typeof import("../../examples/engine-load-test/src/driver.js")
  > {
    vi.stubGlobal("location", { search: "" });
    return import("../../examples/engine-load-test/src/driver.js");
  }

  /**
   * A virtual clock: only `advance` moves time, so every millisecond in the report is one this test
   * put there. The presentation wait is charged to `nextFrame`, where a real rAF's wait belongs.
   */
  function virtualClock(presentMs = PRESENT_MS): {
    advance: (ms: number) => void;
    clock: MeasurementClock;
  } {
    let time = 0;
    return {
      advance: (ms) => {
        time += ms;
      },
      clock: {
        nextFrame: async () => {
          time += presentMs;
          return time;
        },
        now: () => time,
      },
    };
  }

  /**
   * A harness carrying only the seams the driver reads, plus the queue seam itself: `queue` is what
   * turns finished work into an observation, so its absence is the case under test.
   */
  function stubHarness(
    queue: { onSubmittedWorkDone?: () => Promise<void> } | undefined,
    advance: (ms: number) => void,
    onDrain: () => void = () => {},
  ): ILoadTestHarness {
    return {
      adapterLabel: "stub adapter",
      beginCollapse: () => {
        throw new Error("the stub arm has no projection");
      },
      collapseMovingParts: () => -1,
      collapseMs: 0,
      collapseStatus: () => "pending",
      dispose: () => {},
      foxMeasurement: () => undefined,
      ladderCounts: () => undefined,
      pipelineCompiles: () => 0,
      placementBytes: new Uint8Array(8),
      positionHash: "00000000",
      // The stub draws no pixels; the driver only probes a rung that asked to be a ladder rung, and
      // this harness never claims to be one.
      probeFrame: async () => {
        throw new Error("TN_BENCH_NO_LADDER_RUNG");
      },
      render: async () => {
        advance(RENDER_MS);
      },
      // The stub renderer holds nothing but the backend seam the completion probe reads.
      renderer: (queue === undefined
        ? {}
        : { backend: { device: { queue } } }) as unknown as ILoadTestHarness["renderer"],
      setRung: () => {},
      stats: () => ({ drawCalls: 8, triangles: 96, visibleObjects: 4 }),
      step: () => {
        advance(STEP_MS);
      },
      stepMs: STEP_MS,
    };
  }

  /** A harness whose queue drains, so the completed-work metric is observable. */
  function drainingHarness(advance: (ms: number) => void): {
    harness: ILoadTestHarness;
    drains: () => number;
  } {
    let drains = 0;
    const harness = stubHarness(
      {
        onSubmittedWorkDone: async () => {
          drains += 1;
          advance(drains === 1 ? PRE_DRAIN_MS : POST_DRAIN_MS);
        },
      },
      advance,
    );
    return { drains: () => drains, harness };
  }

  it("measures the wall window over N completed frames, the browser's waits included", async () => {
    const { measureRung } = await loadDriver();
    const { advance, clock } = virtualClock();
    const { drains, harness } = drainingHarness(advance);
    const report = await measureRung(
      harness,
      ARM,
      { mode: "L1", objectCount: 64 },
      0,
      KNOBS,
      clock,
    );
    expect(report.measuredFrames).toBe(2);
    // Wall time from immediately after the 3 ms pre-drain (t=55) to immediately after the 5 ms tail
    // drain (t=112) over 2 frames: 57/2 = 28.5. Two waits of 16 ms sit inside it, so the sum of the
    // 10 ms submit spans plus the 5 ms drain (12.5) is not the answer, the pre-drain is outside it
    // (30.0), and the tail is inside (26.0). One number pins every edge of the window.
    expect(report.completedWorkMeanMs).toBe(28.5);
    expect(report.drainPolicy).toBe(
      "pre-drain:untimed,post-drain:timed,per-frame-fence:none,timing-scope:cadence-inclusive-browser-delivery",
    );
    // One pre-drain and one post-drain, and never a fence per frame: four frames would be six.
    expect(drains()).toBe(2);
    // The CPU submit half is a proxy and stays labelled as one, beside the metric that is not.
    expect(report.cpuSubmitMeanMs).toBe(10);
    // The legacy series is untouched: successive rAF intervals over the measured frames only, still
    // read from the drained clock, so the boundary change moves the primary metric and nothing else.
    expect(report.frameMs).toEqual([26, 26]);
    expect(report.stepMs).toEqual([STEP_MS, STEP_MS]);
  });

  it("captures a no-post rung strictly after its measured window closes", async () => {
    const { measureRung } = await loadDriver();
    const { advance, clock } = virtualClock();
    const { harness } = drainingHarness(advance);
    const capture = vi.fn(async () => {
      advance(1000);
      return "small-frame";
    });
    vi.stubGlobal("__TN_BENCH_CAPTURE__", capture);
    try {
      const result = await measureRung(
        harness,
        ARM,
        { mode: "L1", objectCount: 64 },
        0,
        KNOBS,
        clock,
      );
      expect(capture).toHaveBeenCalledOnce();
      expect(result.framePng).toBe("small-frame");
      expect(result.completedWorkMeanMs).toBe(28.5);
      expect(result.frameMs).toEqual([26, 26]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the same window on a clock with no cadence, where it equals the submit sum", async () => {
    const { measureRung } = await loadDriver();
    const { advance, clock } = virtualClock(0);
    const { harness } = drainingHarness(advance);
    const report = await measureRung(
      harness,
      ARM,
      { mode: "L1", objectCount: 64 },
      0,
      KNOBS,
      clock,
    );
    // With no presentation wait there is nothing between the submit spans, so 20 ms of work plus the
    // 5 ms tail drain over 2 frames is 12.5 — the two clocks differ by exactly the cadence, which is
    // what makes the browser's number a delivery figure and not a capacity one.
    expect(report.completedWorkMeanMs).toBe(12.5);
    expect(report.cpuSubmitMeanMs).toBe(10);
  });

  it("reports a hole in the measurement as null plus a reason, never the submit proxy", async () => {
    const { measureRung } = await loadDriver();
    const { advance, clock } = virtualClock();
    // A backend with no queue to ask: a WebGL context, a stub, a seam that moved.
    const report = await measureRung(
      stubHarness(undefined, advance),
      ARM,
      { mode: "L1", objectCount: 64 },
      0,
      KNOBS,
      clock,
    );
    expect(report.completedWorkMeanMs).toBeNull();
    expect(report.completedWorkReason).toBe("queue-completion-unavailable");
    // The submit time is still worth having, as long as nothing can mistake it for finished work.
    expect(report.cpuSubmitMeanMs).toBe(10);
  });

  it("fails closed on a window with no measured frame", async () => {
    const { measureRung } = await loadDriver();
    const { advance, clock } = virtualClock();
    const harness = stubHarness(undefined, advance);
    const rung = { mode: "L1" as const, objectCount: 64 };
    for (const knobs of [
      { frames: FRAMES, repeats: 1, warmup: FRAMES },
      { frames: FRAMES, repeats: 1, warmup: FRAMES + 1 },
    ]) {
      await expect(measureRung(harness, ARM, rung, 0, knobs, clock)).rejects.toThrow(
        /TN_BENCH_WARMUP_GE_FRAMES/u,
      );
    }
  });

  it("records the pipelines the measured window compiled, not the warmup's", async () => {
    const { measureRung } = await loadDriver();
    const { advance, clock } = virtualClock();
    let frame = 0;
    // Four pipelines compile while warming up (frames 0-1) and two more inside the window.
    const harness: ILoadTestHarness = {
      ...stubHarness(undefined, advance),
      pipelineCompiles: () => (frame < 2 ? 4 : frame < 3 ? 5 : 6),
      step: (index) => {
        frame = index;
      },
    };
    const result = await measureRung(
      harness,
      ARM,
      { mode: "L1", objectCount: 64 },
      0,
      KNOBS,
      clock,
    );
    expect(result.pipelineCompiles).toBe(2);
  });
});

describe("the scoreboard counters", () => {
  // Eight frames at 10 ms and two spikes: a hitch is a frame over twice the rung's own p50.
  const spiky = [...series(10, 8), 25, 40];

  it("carries p95, p99, the hitch count, draw calls and pipeline compiles on every row", () => {
    const [row] = scoreboardRows(
      report({ rungs: [rung({ frameMs: spiky, pipelineCompiles: 3 })] }),
    );
    expect(row).toMatchObject({
      drawCalls: 4097,
      hitches: 2,
      mode: "L1",
      objectCount: 4096,
      p50: 10,
      p95: 40,
      p99: 40,
      pipelineCompiles: 3,
    });
  });

  it("reports Godot/native p50 on R2, R3 and R5 without inventing unsupported Godot rows", () => {
    const modes = ["R2", "R3", "R5"] as const;
    const native = report({
      arm: "tn-desktop",
      rungs: modes.map((mode) => rung({ mode, frameMs: series(10), pipelineCompiles: 0 })),
    });
    const godot = report({
      arm: "godot-desktop",
      engine: { name: "godot", version: "4.7.1" },
      rungs: modes.map((mode) => rung({ mode, frameMs: series(25) })),
    });
    const rows = scoreboardRows(native, godot);
    expect(rows.map((row) => row.godotRatio)).toEqual([2.5, 2.5, 2.5]);
    const unsupported = { ...godot, rungs: godot.rungs.slice(0, 2) };
    expect(scoreboardRows(native, unsupported).map((row) => row.godotRatio)).toEqual([
      2.5,
      2.5,
      undefined,
    ]);
    expect(scoreboardRows(unsupported)).toHaveLength(2);
    expect(scoreboardRows(native).every((row) => row.godotRatio === undefined)).toBe(true);
  });
  it("counts no hitch on a flat series", () => {
    const [row] = scoreboardRows(report({ rungs: [rung({ pipelineCompiles: 0 })] }));
    expect(row?.hitches).toBe(0);
  });

  it("fails closed on a rung whose pipeline-compile counter is missing", () => {
    expect(() => scoreboardRows(report())).toThrow(/TN_BENCH_COUNTER_MISSING.*pipelineCompiles/u);
  });

  it("lets a Godot row omit pipelineCompiles, because the Godot load test cannot count them", () => {
    const godot = report({
      arm: "godot-desktop",
      engine: { name: "godot", version: "4.7.1" },
      rungs: [rung()],
    });
    const [row] = scoreboardRows(godot);
    expect(row?.pipelineCompiles).toBeUndefined();
    // The exemption is the one counter only: a Godot rung with no draw call still fails.
    expect(() => scoreboardRows({ ...godot, rungs: [rung({ drawCalls: 0 })] })).toThrow(
      /TN_BENCH_COUNTER_MISSING.*drawCalls/u,
    );
  });

  it("fails closed on a counter that is not a count", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => scoreboardRows(report({ rungs: [rung({ pipelineCompiles: bad })] }))).toThrow(
        /TN_BENCH_COUNTER_MISSING/u,
      );
    }
  });

  it("fails closed on a rung that submitted no draw call", () => {
    expect(() =>
      scoreboardRows(report({ rungs: [rung({ drawCalls: 0, pipelineCompiles: 0 })] })),
    ).toThrow(/TN_BENCH_COUNTER_MISSING.*drawCalls/u);
  });

  it("still parses a report from before the counter existed, and rejects a malformed one", () => {
    expect(() => parseRunReport(JSON.parse(JSON.stringify(report())))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(report({ rungs: [rung({ pipelineCompiles: 2 })] })));
    bad.rungs[0].pipelineCompiles = "two";
    expect(() => parseRunReport(bad)).toThrow(/TN_BENCH_BAD_SHAPE.*pipelineCompiles/u);
  });

  it("prints the new columns in the arm table", () => {
    const text = renderArmMarkdown(
      report({ rungs: [rung({ frameMs: spiky, pipelineCompiles: 3 })] }),
    );
    expect(text).toContain("| p99 ms | hitches |");
    expect(text).toContain("| compiles |");
  });
});

describe("the pipeline-compile counter", () => {
  it("counts each pipeline the backend is asked to create, and still creates it", () => {
    const created: string[] = [];
    const backend = {
      createComputePipeline: (name: string) => created.push(name),
      createRenderPipeline: (name: string) => created.push(name),
    };
    const count = countPipelineCreates({ backend } as never);
    backend.createRenderPipeline("a");
    backend.createRenderPipeline("b");
    backend.createComputePipeline("c");
    expect(count()).toBe(3);
    expect(created).toEqual(["a", "b", "c"]);
  });

  it("fails closed on a backend that moved the seam", () => {
    expect(() => countPipelineCreates({ backend: {} } as never)).toThrow(
      /TN_BENCH_NO_PIPELINE_COUNTER/u,
    );
    expect(() => countPipelineCreates({} as never)).toThrow(/TN_BENCH_NO_PIPELINE_COUNTER/u);
  });
});

describe("the host-load verdict", () => {
  const source = (load1: number, cores: number) => ({
    cores: () => cores,
    loadavg: () => [load1, 0, 0],
  });
  const baseline = {
    evidence: "docs/verification/prd-130-phase-6-2026-08-16.md",
    rungs: { "L1@4096": 10 },
  };

  it("reads the one-minute load and the core count from its source", () => {
    expect(readHostLoad(source(3.5, 12))).toEqual({ cores: 12, load1: 3.5 });
  });

  it("keeps absolutes valid at or below half the core count", () => {
    const stamped = withHostLoad(report(), readHostLoad(source(6, 12)));
    expect(stamped.hostLoad).toEqual({ absolutes: "valid", cores: 12, load1: 6 });
  });

  it("marks absolutes invalid-absolute above half the core count", () => {
    const stamped = withHostLoad(report(), readHostLoad(source(6.01, 12)));
    expect(stamped.hostLoad?.absolutes).toBe("invalid-absolute");
    expect(renderArmMarkdown(stamped)).toContain("invalid-absolute");
  });

  it("fails closed on a load source that reports nothing usable", () => {
    expect(() => readHostLoad(source(Number.NaN, 12))).toThrow(/TN_BENCH_HOST_LOAD_UNREADABLE/u);
    expect(() => readHostLoad(source(1, 0))).toThrow(/TN_BENCH_HOST_LOAD_UNREADABLE/u);
  });

  it("round-trips through the parser and rejects a verdict that disagrees with its numbers", () => {
    const stamped = withHostLoad(report(), readHostLoad(source(20, 12)));
    expect(parseRunReport(JSON.parse(JSON.stringify(stamped))).hostLoad).toEqual(stamped.hostLoad);
    const lying = JSON.parse(JSON.stringify(stamped));
    lying.hostLoad.absolutes = "valid";
    expect(() => parseRunReport(lying)).toThrow(/TN_BENCH_BAD_SHAPE.*hostLoad/u);
  });

  it("keeps a loaded run out of an absolute baseline gate, and lets a quiet one through", () => {
    const loaded = withHostLoad(report(), readHostLoad(source(20, 12)));
    expect(() => checkPerformance(loaded, { "tn-web": baseline })).toThrow(
      /TN_BENCH_INVALID_ABSOLUTE/u,
    );
    const quiet = withHostLoad(report(), readHostLoad(source(1, 12)));
    expect(checkPerformance(quiet, { "tn-web": baseline })?.regressions).toEqual([]);
  });
});

// PRD-573 v1.10: the owned engine as a bench arm, and the guard that lets two arms be compared at all.
describe("the tn-engine-desktop arm", () => {
  const engineReport = (overrides: Partial<IRunReport> = {}): IRunReport =>
    report({ arm: "tn-engine-desktop", ...overrides });

  it("is a registered arm that reports as ThreeNative and cannot be filed as another engine", () => {
    expect(ARMS).toContain("tn-engine-desktop");
    const parsed = parseRunReport(JSON.parse(JSON.stringify(engineReport())));
    expect(parsed.arm).toBe("tn-engine-desktop");
    expect(() =>
      parseRunReport({ ...engineReport(), engine: { name: "godot", version: "4.7.1" } }),
    ).toThrow(/TN_BENCH/u);
  });

  it("is reachable from --arm and --pair, and its entry is the shared run with the engine's Fox", async () => {
    const [cli, entry, run] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts/engine-load-test/cli.ts"), "utf8"),
      readFile(path.join(process.cwd(), "examples/engine-load-test/src/native-engine.ts"), "utf8"),
      readFile(path.join(process.cwd(), "examples/engine-load-test/src/native-run.ts"), "utf8"),
    ]);
    expect(cli).toMatch(/arm === "tn-engine-desktop"[\s\S]*runTnEngineDesktop/u);
    expect(cli).toMatch(/PAIRABLE_ARMS = \[\s*"tn-desktop",\s*"tn-engine-desktop"/u);
    expect(cli).toMatch(/renderPairMarkdown\(/u);
    expect(entry).toMatch(/runNative\(/u);
    expect(run).toMatch(/onEngine/u);
  });

  it("builds the engine bundle from the same options as the legacy bundle", () => {
    const options = {
      axes: DEFAULT_AXES,
      frames: 160,
      height: 1080,
      ladder: "4096",
      modes: "R2,R5",
      repeats: 1,
      sourceSha: "abc123",
      warmup: 40,
      width: 1920,
    };
    const defines = engineDefines(options, "/fox.glb");
    expect(JSON.parse(defines.__TN_PLATFORM__ as string)).toBe("engine-desktop");
    const config = JSON.parse(defines.__TN_BENCH_CONFIG__ as string);
    expect(config).toMatchObject({
      frames: 160,
      height: 1080,
      ladder: [4096],
      modes: ["R2", "R5"],
      repeats: 1,
      sourceSha: "abc123",
      warmup: 40,
      width: 1920,
    });
  });

  it("puts both desktop arms on one display, so a pair never splits between :0 and Xvfb", () => {
    expect(benchDisplay({ DISPLAY: ":0" })).toBe(":0");
    expect(benchDisplay({ DISPLAY: ":0", TN_BENCH_DISPLAY: ":7" })).toBe(":7");
    expect(benchDisplay({})).toBe("");
  });

  it("opens the player at the requested surface, uncapped, and reads per-frame CPU only on request", () => {
    const options = {
      axes: DEFAULT_AXES,
      frames: 1,
      height: 1080,
      ladder: "1",
      modes: "R5",
      repeats: 1,
      warmup: 1,
      width: 1920,
    };
    expect(engineEnvironment(options, {})).toMatchObject({
      TN_PLAYER_HEIGHT: "1080",
      TN_PLAYER_VSYNC: "0",
      TN_PLAYER_WIDTH: "1920",
    });
    expect(engineEnvironment(options, {}).TN_PLAYER_METRICS).toBeUndefined();
    expect(engineEnvironment(options, { TN_BENCH_ENGINE_METRICS: "1" }).TN_PLAYER_METRICS).toBe(
      "1",
    );
    expect(engineEnvironment(options, { TN_BENCH_VSYNC: "on" }).TN_PLAYER_VSYNC).toBe("1");
    expect(
      playerSurface(
        "[Playtest] threenative-native-engine ready: game x, runtime v8, 1920x1080, mailbox off",
      ),
    ).toEqual({ height: 1080, width: 1920 });
    expect(playerSurface("[Playtest] No presentable surface; running headless.")).toBeUndefined();
  });
});

describe("the runner's host CPU reading", () => {
  const stat = (name: string, group: number, user: number, system: number): string =>
    `4242 (${name}) S 1 ${group} ${group} 0 -1 4194560 100 0 0 0 ${user} ${system} 0 0 20 0 9 0 12345 1000 100`;

  it("reads utime, stime and the group past a command name with spaces and parentheses", () => {
    expect(parseProcStat(stat("tn native (v8) x", 777, 120, 30))).toEqual({
      cpuTicks: 150,
      group: 777,
    });
    expect(() => parseProcStat("garbage")).toThrow(/TN_BENCH_PROC_STAT/u);
  });

  const recorderFor = (readings: Array<number | undefined>): HostCpuRecorder => {
    const queue = [...readings];
    return new HostCpuRecorder({ read: () => queue.shift() });
  };

  it("brackets a window between its two markers and keeps the player's frame samples inside it", () => {
    const recorder = recorderFor([1000, 1480]);
    recorder.line('TN_PLAYER_FRAME:{"cpuFrameCpuMs":9}');
    recorder.line("window R2@4096");
    recorder.line('TN_PLAYER_FRAME:{"cpuFrameCpuMs":2.5,"presentCpuMs":30,"bridgeCalls":900}');
    recorder.line('TN_PLAYER_FRAME:{"cpuFrameCpuMs":3.5,"presentCpuMs":31}');
    recorder.line("rung R2@4096 frame p50 3.00 | step p50 1.00");
    expect(recorder.windows).toEqual([
      {
        begin: 1000,
        cpuMs: 480,
        crossingsPerFrame: [900],
        key: "R2@4096",
        presentFrameMs: [30, 31],
        renderFrameMs: [],
        threadFrameMs: [2.5, 3.5],
      },
    ]);
  });

  it("carries the present call's CPU and the crossings onto the rung, for either arm's lines", () => {
    const recorder = recorderFor([0, 40]);
    recorder.line("window R2@4096");
    for (const present of [30.0004, 32])
      recorder.line(`TN_PLAYER_FRAME:{"cpuFrameCpuMs":4,"presentCpuMs":${present}}`);
    recorder.line("rung R2@4096 frame p50 1 | step");
    const page = { rungs: [{ frameMs: series(1, 2), mode: "R2", objectCount: 4096 }] };
    const stamped = withHostCpu(page, recorder, true) as {
      rungs: Array<{ bridgeCalls?: number[]; presentCpuMs: number[]; threadCpuMs: number[] }>;
    };
    expect(stamped.rungs[0]).toMatchObject({ presentCpuMs: [30, 32], threadCpuMs: [4, 4] });
    expect(stamped.rungs[0]?.bridgeCalls).toBeUndefined();
  });

  it("adds cpuMsPerFrame to the matching rung and refuses windows that do not pair with rungs", () => {
    const recorder = recorderFor([0, 160]);
    recorder.line("window R2@4096");
    recorder.line("rung R2@4096 frame p50 1 | step");
    const page = { rungs: [{ frameMs: series(1, 8), mode: "R2", objectCount: 4096 }] };
    const stamped = withHostCpu(page, recorder) as { rungs: Array<{ cpuMsPerFrame: number }> };
    expect(stamped.rungs[0]?.cpuMsPerFrame).toBe(20);
    expect(() => withHostCpu({ rungs: [page.rungs[0], page.rungs[0]] }, recorder)).toThrow(
      /TN_BENCH_CPU_WINDOWS/u,
    );
    expect(() => withHostCpu({ rungs: [{ ...page.rungs[0], mode: "R3" }] }, recorder)).toThrow(
      /TN_BENCH_CPU_WINDOWS/u,
    );
    expect(() => withHostCpu(page, recorder, true)).toThrow(/player frame samples/u);
  });

  it("round-trips the present series, summarizes it and rejects an empty one", () => {
    const withPresent = report({
      rungs: [
        rung({ bridgeCalls: [10, 20, 30], presentCpuMs: [30, 32, 31], threadCpuMs: [1, 2, 3] }),
      ],
    });
    const parsed = parseRunReport(JSON.parse(JSON.stringify(withPresent)));
    expect(summarize(parsed)[0]).toMatchObject({
      crossingsP50: 20,
      presentCpuP50: 31,
      threadCpuP50: 2,
    });
    expect(() =>
      parseRunReport({ ...withPresent, rungs: [{ ...withPresent.rungs[0], presentCpuMs: [] }] }),
    ).toThrow(/presentCpuMs/u);
  });

  it("fails when the host process cannot be found at a marker", () => {
    expect(() => recorderFor([undefined]).line("window R2@4096")).toThrow(
      /TN_BENCH_CPU_UNREADABLE/u,
    );
  });

  it("round-trips through the report parser and rejects a negative reading", () => {
    const withCpu = report({ rungs: [rung({ cpuMsPerFrame: 4.2, threadCpuMs: [1, 2, 3] })] });
    const parsed = parseRunReport(JSON.parse(JSON.stringify(withCpu)));
    expect(parsed.rungs[0]).toMatchObject({ cpuMsPerFrame: 4.2, threadCpuMs: [1, 2, 3] });
    expect(summarize(parsed)[0]).toMatchObject({ cpuMsPerFrame: 4.2, threadCpuP50: 2 });
    expect(() =>
      parseRunReport({ ...withCpu, rungs: [{ ...withCpu.rungs[0], cpuMsPerFrame: -1 }] }),
    ).toThrow(/cpuMsPerFrame/u);
    expect(() =>
      parseRunReport({ ...withCpu, rungs: [{ ...withCpu.rungs[0], threadCpuMs: [] }] }),
    ).toThrow(/threadCpuMs/u);
  });
});

const frames = 8;
const column = (value: number): number[] => series(value, frames);
/** The page's five phases for `frames` frames, then the host's lines for the same frames. */
const phased = (
  page: Record<string, number>,
  host: { present: number; thread: number; render?: number },
) => ({
  phases: Object.fromEntries(PHASES.map((name) => [name, column(page[name] ?? 0)])) as NonNullable<
    IRunReport["rungs"][number]["phases"]
  >,
  presentCpuMs: column(host.present),
  ...(host.render === undefined ? {} : { renderCpuMs: column(host.render) }),
  threadCpuMs: column(host.thread),
});
const phasedRung = (extra: Partial<IRunReport["rungs"][number]>): IRunReport["rungs"][number] =>
  rung({ frameMs: series(10, frames), ...extra });

describe("the per-frame phase telemetry", () => {
  it("splits a frame exclusively: a nested phase pauses its parent", () => {
    let now = 0;
    const phases = createPhaseRecorder(() => now);
    phases.begin(1);
    now = 2;
    phases.begin(2);
    now = 5;
    phases.end();
    now = 6;
    phases.end();
    now = 100;
    expect(phases.take()).toEqual([0, 3, 3, 0, 0]);
    expect(phases.take()).toEqual([0, 0, 0, 0, 0]);
    phases.begin(0);
    expect(() => phases.take()).toThrow(/TN_BENCH_PHASE_OPEN: game/u);
    phases.end();
    expect(() => phases.end()).toThrow(/TN_BENCH_PHASE_UNOPENED/u);
  });

  it("fails closed when the host has no thread CPU clock, and reads it when it has", () => {
    expect(() => threadCpuClock()).toThrow(/TN_BENCH_PHASES_NO_CLOCK/u);
    const host = globalThis as { __tnThreadCpuMs?: () => number };
    host.__tnThreadCpuMs = () => -1;
    try {
      expect(() => threadCpuClock()).toThrow(/no thread CPU clock/u);
      host.__tnThreadCpuMs = () => 12.5;
      expect(threadCpuClock()()).toBe(12.5);
    } finally {
      host.__tnThreadCpuMs = undefined;
    }
  });

  it("names the most crossed names between two snapshots, per frame", () => {
    const before = { copy: 10, geometry: 5 };
    const after = { copy: 110, geometry: 5, material: 50, position: 20, scale: 1, y: 300, z: 6 };
    expect(topCrossings(before, after, 10)).toEqual([
      ["y", 30],
      ["copy", 10],
      ["material", 5],
      ["position", 2],
      ["z", 0.6],
    ]);
  });

  it("keeps the host's render call, when it reports one, and stamps it onto the rung", () => {
    const recorder = new HostCpuRecorder({ read: () => 0 });
    recorder.line("window R2@4096");
    recorder.line('TN_PLAYER_FRAME:{"cpuFrameCpuMs":4,"presentCpuMs":30,"renderCpuMs":1.5}');
    recorder.line("rung R2@4096 frame p50 1 | step");
    const page = { rungs: [{ frameMs: series(1, 1), mode: "R2", objectCount: 4096 }] };
    const stamped = withHostCpu(page, recorder, true) as {
      rungs: Array<{ renderCpuMs?: number[] }>;
    };
    expect(stamped.rungs[0]?.renderCpuMs).toEqual([1.5]);
  });

  it("round-trips the phases and sums them with the host's lines into present and other", () => {
    const parsed = parseRunReport(
      JSON.parse(
        JSON.stringify(
          report({
            rungs: [
              phasedRung(
                phased(
                  { animation: 0.5, game: 1, matrixWorld: 0.25, projection: 2, render: 0.5 },
                  { present: 30, render: 1.5, thread: 8 },
                ),
              ),
            ],
          }),
        ),
      ),
    );
    const stats = summarize(parsed)[0]?.phases;
    // The engine player's draw is reported by the host, so `render` is the page's 0.5 plus 1.5.
    expect(stats?.render).toEqual({ mean: 2, p50: 2 });
    expect(stats?.present).toEqual({ mean: 30, p50: 30 });
    // 8 ms of thread CPU less the five phases (1 + 0.5 + 0.25 + 2 + 2).
    expect(stats?.other).toEqual({ mean: 2.25, p50: 2.25 });
    expect(stats?.game).toEqual({ mean: 1, p50: 1 });
  });

  it("reports only the page's phases when the run carries no host lines, and skips runs without phases", () => {
    const stats = summarize(
      parseRunReport(
        report({
          rungs: [phasedRung({ phases: phased({ game: 3 }, { present: 0, thread: 0 }).phases })],
        }),
      ),
    )[0]?.phases;
    expect(stats?.game?.p50).toBe(3);
    expect(stats?.present).toBeUndefined();
    expect(stats?.other).toBeUndefined();
    expect(
      summarize(parseRunReport(report({ rungs: [phasedRung({})] })))[0]?.phases,
    ).toBeUndefined();
  });

  it("fails closed on malformed phases and crossings", () => {
    const good = phased({ game: 1 }, { present: 1, thread: 5 });
    const parse = (extra: Record<string, unknown>) =>
      parseRunReport({
        ...report({ rungs: [phasedRung({})] }),
        rungs: [{ ...phasedRung({}), ...extra }],
      });
    expect(parse({ phases: good.phases }).rungs[0]?.phases).toEqual(good.phases);
    expect(() => parse({ phases: { ...good.phases, game: undefined } })).toThrow(/phases\.game/u);
    expect(() => parse({ phases: { ...good.phases, game: [1, 2] } })).toThrow(/phases\.game/u);
    expect(() => parse({ phases: { ...good.phases, render: column(-1) } })).toThrow(
      /phases\.render/u,
    );
    expect(() => parse({ phases: { ...good.phases, render: column(Number.NaN) } })).toThrow(
      /phases\.render/u,
    );
    expect(() => parse({ phases: { ...good.phases, physics: column(1) } })).toThrow(
      /unknown phases: physics/u,
    );
    expect(() => parse({ phases: [] })).toThrow(/phases must be an object/u);
    expect(() => parse({ renderCpuMs: [] })).toThrow(/renderCpuMs/u);
    expect(parse({ crossingTop: [["y", 2.5]] }).rungs[0]?.crossingTop).toEqual([["y", 2.5]]);
    for (const bad of [
      [["y"]],
      [["", 1]],
      [["y", -1]],
      [["y", "1"]],
      "y",
      Array.from({ length: 6 }, () => ["y", 1]),
    ])
      expect(() => parse({ crossingTop: bad })).toThrow(/crossingTop/u);
  });

  it("turns the page's telemetry and the crossing histogram on only when asked", () => {
    const options = {
      axes: DEFAULT_AXES,
      frames: 1,
      height: 1080,
      ladder: "1",
      modes: "R5",
      repeats: 1,
      warmup: 1,
      width: 1920,
    };
    const phases = (): unknown =>
      JSON.parse(engineDefines(options, undefined).__TN_BENCH_CONFIG__ as string).phases;
    vi.stubEnv("TN_BENCH_PHASES", undefined);
    expect(phases()).toBe(false);
    vi.stubEnv("TN_BENCH_PHASES", "1");
    expect(phases()).toBe(true);
    vi.unstubAllEnvs();
    expect(engineEnvironment(options, {}).TN_PLAYER_CROSSINGS).toBeUndefined();
    expect(engineEnvironment(options, { TN_BENCH_CROSSINGS: "1" }).TN_PLAYER_CROSSINGS).toBe("1");
  });
});

describe("the same-run pair guard", () => {
  const framePath = path.resolve("scripts/__tests__/fixtures/engine-load-test/scene.png");
  const wobble = (base: number): number[] => [
    base,
    base + 1,
    base + 2,
    base,
    base + 1,
    base + 2,
    base,
    base + 1,
  ];
  const scene = {
    pointLights: 8,
    postPasses: 0,
    resolution: "1280x720",
    shadowCasters: 4096,
    skinnedMeshes: 0,
    tonemapping: 0,
  };
  const arm = (
    name: IRunReport["arm"],
    options: {
      cpu?: number;
      frame?: number;
      ladder?: Partial<typeof scene>;
      load?: number;
      overrides?: Partial<IRunReport>;
      rung?: Partial<IRunReport["rungs"][number]>;
    } = {},
  ): IRunReport =>
    withHostLoad(
      report({
        arm: name,
        rungs: [
          rung({
            framePath,
            cpuMsPerFrame: options.cpu ?? 10,
            drawCalls: 40,
            frameMs: wobble(options.frame ?? 10),
            ladder: { ...scene, ...options.ladder },
            mode: "R2",
            pipelineCompiles: 0,
            triangles: 49_154,
            ...options.rung,
          }),
        ],
        ...options.overrides,
      }),
      readHostLoad({ cores: () => 12, loadavg: () => [options.load ?? 1, 0, 0] }),
    );
  const labels = ["tn-desktop", "tn-engine-desktop"] as const;

  it("records identical and noisy PNG parity in JSON rows and markdown", () => {
    const left = arm("tn-desktop");
    const right = arm("tn-engine-desktop");
    expect(pairRows([left], [right], labels)[0]?.visual).toMatchObject({ score: 0, waived: false });
    (right.rungs[0] as IRunReport["rungs"][number]).framePath = path.resolve(
      "scripts/__tests__/fixtures/engine-load-test/noise.png",
    );
    expect(pairRows([left], [right], labels)[0]?.visual?.score).toBeLessThan(0.02);
    expect(renderPairMarkdown([left], [right], labels)).toContain("| visual |");
  });

  it("rejects color loss with similar luminance and checks every round and repeat", async () => {
    const { visualParity } = await import("../engine-load-test/visual.js");
    const left = arm("tn-desktop");
    const right = arm("tn-engine-desktop");
    (right.rungs[0] as IRunReport["rungs"][number]).framePath = path.resolve(
      "scripts/__tests__/fixtures/engine-load-test/tinted.png",
    );
    expect(() => pairRows([left], [right], labels)).toThrow(/TN_BENCH_VISUAL_PARITY/u);
    expect(visualParity([left], [left, right])).toHaveLength(2);
    expect(visualParity([left], [left, right])[1]?.error).toBe("TN_BENCH_VISUAL_MISSING");
    vi.stubEnv("TN_BENCH_WAIVE", "drawCalls");
    try {
      expect(() => pairRows([left], [right], labels)).toThrow(/TN_BENCH_VISUAL_PARITY/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a blocked windscreen even when scene counters match", () => {
    const right = arm("tn-engine-desktop");
    (right.rungs[0] as IRunReport["rungs"][number]).framePath = path.resolve(
      "scripts/__tests__/fixtures/engine-load-test/blocked.png",
    );
    expect(pairVerdict([arm("tn-desktop")], [right], labels).problem).toContain(
      "TN_BENCH_VISUAL_PARITY",
    );
    expect(() => pairRows([arm("tn-desktop")], [right], labels)).toThrow(/TN_BENCH_VISUAL_PARITY/u);
  });

  it("fails closed for absent, unreadable and malformed frames unless visual is explicitly waived", () => {
    for (const frame of [undefined, "/missing/frame.png", path.resolve("package.json")]) {
      const right = arm("tn-engine-desktop");
      (right.rungs[0] as IRunReport["rungs"][number]).framePath = frame;
      expect(() => pairRows([arm("tn-desktop")], [right], labels)).toThrow(
        /TN_BENCH_VISUAL_MISSING/u,
      );
      vi.stubEnv("TN_BENCH_WAIVE", "drawCalls,visual");
      try {
        expect(pairRows([arm("tn-desktop")], [right], labels)[0]?.visual).toMatchObject({
          waived: true,
        });
        expect(renderPairMarkdown([arm("tn-desktop")], [right], labels)).toContain(
          "TN_BENCH_WAIVE=visual",
        );
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it("persists PNG and native RGBA transports beside JSON without retaining transport pixels", async () => {
    const { saveFrames } = await import("../engine-load-test/visual.js");
    const { PNG } = await import("pngjs");
    const directory = makeTempDirSync("bench-frames-");
    try {
      const raw = fs.readFileSync(framePath);
      const decoded = PNG.sync.read(raw);
      const run = arm("tn-desktop");
      (run.rungs[0] as IRunReport["rungs"][number]).frameRgba = {
        width: decoded.width,
        height: decoded.height,
        data: decoded.data.toString("hex"),
      };
      (run.rungs[0] as IRunReport["rungs"][number]).framePath = undefined;
      const parsed = parseRunReport({
        ...run,
        rungs: run.rungs.map((rung) => ({ ...rung, mode: "L1", ladder: undefined })),
      });
      await saveFrames(parsed, path.join(directory, "native.json"));
      expect(
        PNG.sync.read(
          fs.readFileSync((parsed.rungs[0] as IRunReport["rungs"][number]).framePath as string),
        ).data,
      ).toEqual(decoded.data);
      expect((parsed.rungs[0] as IRunReport["rungs"][number]).frameRgba).toBeUndefined();
      (run.rungs[0] as IRunReport["rungs"][number]).framePng = raw.toString("base64");
      (run.rungs[0] as IRunReport["rungs"][number]).frameRgba = undefined;
      await saveFrames(run, path.join(directory, "web.json"));
      expect(
        fs.readFileSync((run.rungs[0] as IRunReport["rungs"][number]).framePath as string),
      ).toEqual(raw);
      expect((run.rungs[0] as IRunReport["rungs"][number]).framePng).toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects report frames larger than 160x90 and preserves fixture verdicts after downscaling", async () => {
    const { saveFrames, visualParity } = await import("../engine-load-test/visual.js");
    const { PNG } = await import("pngjs");
    const directory = makeTempDirSync("bench-small-frames-");
    try {
      const oversized = new PNG({ width: 161, height: 90 });
      const run = arm("tn-desktop", {
        rung: { framePng: PNG.sync.write(oversized).toString("base64") },
      });
      await expect(saveFrames(run, path.join(directory, "oversized.json"))).rejects.toThrow(
        "TN_BENCH_VISUAL_MISSING",
      );
      for (const fixture of ["scene", "noise", "tinted", "blocked"]) {
        const right = arm("tn-engine-desktop", {
          rung: {
            framePath: path.resolve(`scripts/__tests__/fixtures/engine-load-test/${fixture}.png`),
          },
        });
        const before = visualParity([arm("tn-desktop")], [right])[0];
        const smallReports = [arm("tn-desktop"), right];
        for (const [index, smallReport] of smallReports.entries()) {
          const image = PNG.sync.read(fs.readFileSync(smallReport.rungs[0]?.framePath as string));
          const small = new PNG({ width: 160, height: 90 });
          small.data = Buffer.from(downscaleFrame(image.data, image.width, image.height));
          (smallReport.rungs[0] as IRunReport["rungs"][number]).framePng = PNG.sync
            .write(small)
            .toString("base64");
          await saveFrames(smallReport, path.join(directory, `${fixture}-${index}.json`));
          const saved = PNG.sync.read(fs.readFileSync(smallReport.rungs[0]?.framePath as string));
          expect(saved.width).toBeLessThanOrEqual(160);
          expect(saved.height).toBeLessThanOrEqual(90);
        }
        const after = visualParity(
          [smallReports[0] as IRunReport],
          [smallReports[1] as IRunReport],
        )[0];
        expect(after?.error).toBe(before?.error);
        expect(Math.abs((after?.score as number) - (before?.score as number))).toBeLessThan(0.003);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives FPS from mean frame time and 1% low from p99", () => {
    const left = arm("tn-desktop", { rung: { frameMs: [10, 10, 10, 20] } });
    const right = arm("tn-engine-desktop", { rung: { frameMs: [5, 5, 5, 10] } });
    const [row] = pairRows([left], [right], labels);
    expect(row?.left).toMatchObject({ fps: 80, fpsLow1: 50 });
    expect(row?.right).toMatchObject({ fps: 160, fpsLow1: 100 });
    expect(row?.ratio.fps).toBe(2);
    const markdown = renderPairMarkdown([left], [right], labels);
    expect(markdown).toContain("| fps | 1% low fps |");
    expect(markdown).toContain("| 80.00 | 50.00 |");
    expect(() =>
      pairRows([arm("tn-desktop", { rung: { frameMs: [] } })], [right], labels),
    ).toThrow();
  });

  it("prints a ratio when both arms drew the same scene, and carries the load beside it", () => {
    const rows = pairRows(
      [arm("tn-desktop", { cpu: 10 })],
      [arm("tn-engine-desktop", { cpu: 4, frame: 5 })],
      labels,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ratio.cpu).toBeCloseTo(2.5);
    expect(rows[0]?.ratio.p50).toBeGreaterThan(1.5);
    const markdown = renderPairMarkdown(
      [arm("tn-desktop", { load: 9 })],
      [arm("tn-engine-desktop")],
      labels,
    );
    expect(markdown).toContain("9.0!");
    expect(markdown).toContain("present cpu p50");
    expect(markdown).toContain("ratio thread cpu");
  });

  it("prints a per-phase table with the right arm over the left, and the top crossings", () => {
    const withPhases = (
      name: "tn-desktop" | "tn-engine-desktop",
      page: Record<string, number>,
      top?: Array<[string, number]>,
    ) =>
      arm(name, {
        rung: {
          ...phased(page, { present: 30, thread: 10 }),
          ...(top === undefined ? {} : { crossingTop: top }),
        },
      });
    const markdown = renderPairMarkdown(
      [withPhases("tn-desktop", { game: 1, projection: 1, render: 4 })],
      [withPhases("tn-engine-desktop", { game: 1, projection: 3, render: 1 }, [["y", 513]])],
      labels,
    );
    expect(markdown).toContain("#### Where the frame goes");
    expect(markdown).toContain("| R2@4096 | projection | 1.000 | 1.000 | 3.000 | 3.000 | 3.00 |");
    expect(markdown).toContain("| R2@4096 | render | 4.000 | 4.000 | 1.000 | 1.000 | 0.25 |");
    expect(markdown).toContain("| R2@4096 | present | 30.000 | 30.000 | 30.000 | 30.000 | 1.00 |");
    expect(markdown).toContain("Top crossings per frame, R2@4096 tn-engine-desktop: y 513");
    expect(
      pairRows(
        [withPhases("tn-desktop", { game: 2 })],
        [withPhases("tn-engine-desktop", { game: 1 })],
        labels,
      )[0]?.phaseRatio.game,
    ).toBe(0.5);
  });

  it("names the web arms' phase clock as page wall time, not thread CPU", () => {
    const markdown = renderPairMarkdown(
      [arm("tn-web", { rung: phased({ game: 1 }, { present: 1, thread: 5 }) })],
      [arm("tn-engine-web", { rung: phased({ game: 2 }, { present: 1, thread: 5 }) })],
      ["tn-web", "tn-engine-web"],
    );
    expect(markdown).toContain("performance.now()");
    expect(markdown).not.toContain("CLOCK_THREAD_CPUTIME_ID");
  });

  it("leaves the phase block out when either arm carries no phases", () => {
    const phasedArm = arm("tn-desktop", { rung: phased({ game: 1 }, { present: 1, thread: 5 }) });
    expect(renderPairMarkdown([phasedArm], [arm("tn-engine-desktop")], labels)).not.toContain(
      "Where the frame goes",
    );
  });

  it("refuses a ratio when the engine drew fewer lights or no bloom, and names what differs", () => {
    const fewer = pairVerdict(
      [arm("tn-desktop")],
      [arm("tn-engine-desktop", { ladder: { pointLights: 0 } })],
      labels,
    );
    expect(fewer.problem).toContain("R2@4096 scene");
    expect(() =>
      pairRows(
        [arm("tn-desktop")],
        [arm("tn-engine-desktop", { ladder: { postPasses: 1 } })],
        labels,
      ),
    ).toThrow(/TN_BENCH_PARITY/u);
    expect(() =>
      pairRows(
        [arm("tn-desktop")],
        [arm("tn-engine-desktop", { ladder: { shadowCasters: 0 } })],
        labels,
      ),
    ).toThrow(/TN_BENCH_PARITY/u);
  });

  it("refuses an R rung whose engine arm crosses the bridge like core's JS mirror did", () => {
    const hosted = pairVerdict(
      [arm("tn-desktop")],
      [arm("tn-engine-desktop", { rung: { bridgeCalls: series(62) } })],
      labels,
    );
    expect(hosted.problem).toBeUndefined();
    const mirrored = pairVerdict(
      [arm("tn-desktop")],
      [arm("tn-engine-desktop", { rung: { bridgeCalls: series(17_669) } })],
      labels,
    );
    expect(mirrored.problem).toContain(
      `R2@4096 crossings per frame (budget ${HOST_PROJECTION_CROSSING_BUDGET})`,
    );
  });

  it("records the engine page's crossings every measured frame, census or not", async () => {
    const driver = await readFile(
      path.join(process.cwd(), "examples/engine-load-test/src/driver.ts"),
      "utf8",
    );
    const entry = await readFile(
      path.join(process.cwd(), "packages/three-native/src/browser-entry.ts"),
      "utf8",
    );
    expect(entry).toMatch(/__tnCrossingCount = crossings/u);
    expect(driver).toMatch(/__tnCrossingCount\?\.\(\)/u);
    expect(driver).toMatch(
      /if \(crossed !== undefined\) bridgeCalls\.push\(crossed - callsBefore\)/u,
    );
    expect(driver).toMatch(/bridgeCalls\.length === 0 \? \{\} : \{ bridgeCalls \}/u);
  });

  it("holds the web engine arm to the same crossing budget, on its page's bridgeCalls", () => {
    const web = ["tn-web", "tn-engine-web"] as const;
    const engine = (bridgeCalls: number) =>
      arm("tn-engine-web", { rung: { bridgeCalls: series(bridgeCalls) } });
    // 52: the web R5 frame on the host projection report (web-final-2-crossings).
    expect(pairVerdict([arm("tn-web")], [engine(52)], web).problem).toBeUndefined();
    // 38,308: the same page on core's JS mirror (web-baseline-crossings).
    expect(pairVerdict([arm("tn-web")], [engine(38_308)], web).problem).toContain(
      `R2@4096 crossings per frame (budget ${HOST_PROJECTION_CROSSING_BUDGET})`,
    );
  });

  it("refuses arms whose surface, present mode, frame clock or rasteriser differ", () => {
    const surface = pairVerdict(
      [arm("tn-desktop")],
      [
        arm("tn-engine-desktop", {
          overrides: { display: { height: 1080, refreshHz: 60, vsync: false, width: 1920 } },
        }),
      ],
      labels,
    );
    expect(surface.problem).toContain("surface");
    const capped = pairVerdict(
      [arm("tn-desktop")],
      [
        arm("tn-engine-desktop", {
          overrides: { display: { height: 720, refreshHz: 60, vsync: true, width: 1280 } },
        }),
      ],
      labels,
    );
    expect(capped.problem).toContain("vsync");
    const frozenRung = { ...arm("tn-engine-desktop").rungs[0], frameMs: series(16.667) };
    const frozen = pairVerdict(
      [arm("tn-desktop")],
      [arm("tn-engine-desktop", { overrides: { rungs: [frozenRung as never] } })],
      labels,
    );
    expect(frozen.problem).toContain("frame clock");
    const software = pairVerdict(
      [arm("tn-desktop")],
      [
        arm("tn-engine-desktop", {
          overrides: { driver: { adapter: "SwiftShader", renderer: "x" } },
        }),
      ],
      labels,
    );
    expect(software.problem).toContain("adapter class");
  });

  it("refuses when one arm carries a timing series the other lacks, and when a triangle count drifts", () => {
    const stepped = arm("tn-engine-desktop");
    const withStep = {
      ...stepped,
      rungs: [{ ...(stepped.rungs[0] as object), stepMs: wobble(1) }],
    } as IRunReport;
    expect(seriesFamilies(withStep)).toEqual(["frameMs", "stepMs"]);
    expect(pairVerdict([arm("tn-desktop")], [withStep], labels).problem).toContain(
      "series families",
    );
    const drift = arm("tn-engine-desktop");
    const fewerTriangles = {
      ...drift,
      rungs: [{ ...(drift.rungs[0] as object), triangles: 20_000 }],
    } as IRunReport;
    expect(pairVerdict([arm("tn-desktop")], [fewerTriangles], labels).problem).toMatch(
      /triangle/iu,
    );
  });

  it("refuses to compare when an arm has no runs", () => {
    expect(() => pairVerdict([], [arm("tn-engine-desktop")], labels)).toThrow(/TN_BENCH_PARITY/u);
    expect(reportFacets(arm("tn-desktop"))["R2@4096 frames"]).toBe("8");
  });
});

describe("the probe's read-back on a host that draws after the frame callback", () => {
  it("stores at most 160x90 RGBA in a report, with box averages rather than sampled pixels", () => {
    const pixels = new Uint8Array(1920 * 1080 * 4);
    for (let y = 0; y < 1080; y++)
      for (let x = 0; x < 1920; x++)
        pixels.set(x % 2 === 0 ? [0, 20, 40, 60] : [200, 220, 240, 160], (y * 1920 + x) * 4);
    const small = downscaleFrame(pixels, 1920, 1080);
    const parsed = parseRunReport(
      report({
        rungs: [
          rung({
            frameRgba: { width: 160, height: 90, data: Buffer.from(small).toString("hex") },
          }),
        ],
      }),
    );
    expect(parsed.rungs[0]?.frameRgba?.data).toHaveLength(160 * 90 * 8);
    expect(Array.from(small.slice(0, 4))).toEqual([100, 120, 140, 110]);
    expect(small.slice(-4)).toEqual(small.slice(0, 4));
    expect(
      downscaleFrame(new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]), 2, 1).slice(79 * 4, 81 * 4),
    ).toEqual(new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]));
    expect(() => downscaleFrame(pixels, 1, 1)).toThrow("TN_BENCH_PROBE_SIZE");
  });

  it("reads the frame the callback stepped, not the one before it", async () => {
    const stepped = 4;
    let drawn = 3; // the player draws what a callback left only once that callback returns
    let wake: (() => void) | undefined;
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => {
        wake = resolve;
      });
    const read = async (): Promise<number> => drawn;
    // Inside the callback that stepped frame 4, a plain read sees frame 3: the lag the probe picture had.
    expect(await read()).toBe(3);
    const result = drawnFrameReader(nextFrame, read)();
    drawn = stepped; // the callback returns and the player draws frame 4
    wake?.();
    expect(await result).toBe(4);
  });
});

describe("the tn-engine-web arm (PRD-573 slice 7)", () => {
  const web = {
    startup: { entryMs: 812.5, firstFrameMs: 1340.2, wasmInstantiateMs: [96.4] },
    memory: { jsHeapUsedBytes: 48_000_000, wasmMemoryBytes: 67_108_864 },
    artifact: {
      jsBytes: 900_000,
      jsGzipBytes: 220_000,
      wasmBytes: 3_311_074,
      wasmGzipBytes: 1_067_000,
    },
    engineWasm: { mtime: "2026-10-12T21:36:54.969Z", sha256: "ab".repeat(32) },
  };

  it("parses an engine-web report with its startup, memory and byte counts", () => {
    const parsed = parseRunReport(report({ arm: "tn-engine-web", web }));
    expect(parsed.arm).toBe("tn-engine-web");
    expect(parsed.web).toEqual(web);
    expect(parseRunReport(report()).web).toBeUndefined();
  });

  it("fails closed on a malformed web block", () => {
    for (const bad of [
      { ...web, startup: { ...web.startup, entryMs: -1 } },
      { ...web, startup: { ...web.startup, wasmInstantiateMs: ["fast"] } },
      { ...web, memory: { ...web.memory, wasmMemoryBytes: "64 MB" } },
      { ...web, artifact: { ...web.artifact, wasmGzipBytes: undefined } },
      { ...web, engineWasm: { mtime: "x" } },
    ])
      expect(() => parseRunReport({ ...report({ arm: "tn-engine-web" }), web: bad })).toThrow(
        /TN_BENCH_BAD_SHAPE|report\.web/u,
      );
  });

  it("refuses a Wasm older than the engine sources it is built from", async () => {
    const root = makeTempDirSync("tn-web-engine-");
    const wasm = path.join(root, WEB_ENGINE_WASM);
    const source = path.join(root, "packages/runtime-native/src/engine/scene/object3d.cpp");
    fs.mkdirSync(path.dirname(wasm), { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/runtime-native/include"), { recursive: true });
    fs.writeFileSync(source, "// engine");
    fs.writeFileSync(wasm, "wasm");
    fs.utimesSync(source, new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(wasm, new Date(2_000_000), new Date(2_000_000));
    expect((await freshWasm(root)).sha256).toBe(createHash("sha256").update("wasm").digest("hex"));
    fs.utimesSync(source, new Date(3_000_000), new Date(3_000_000));
    await expect(freshWasm(root)).rejects.toThrow("TN_BENCH_STALE_WASM");
    fs.rmSync(wasm);
    await expect(freshWasm(root)).rejects.toThrow("TN_BENCH_WASM_MISSING");
    fs.rmSync(root, { force: true, recursive: true });
  });

  it("counts the shipped .js and .wasm bytes, raw and gzip", async () => {
    const dist = makeTempDirSync("tn-web-dist-");
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets/a.js"), "x".repeat(1000));
    fs.writeFileSync(path.join(dist, "assets/b.wasm"), "y".repeat(500));
    fs.writeFileSync(path.join(dist, "assets/c.css"), "z");
    const bytes = await webArtifactBytes(dist);
    expect(bytes.jsBytes).toBe(1000);
    expect(bytes.wasmBytes).toBe(500);
    expect(bytes.jsGzipBytes).toBeGreaterThan(0);
    expect(bytes.jsGzipBytes).toBeLessThan(1000);
    fs.rmSync(path.join(dist, "assets/a.js"));
    await expect(webArtifactBytes(dist)).rejects.toThrow("TN_BENCH_TN_BUILD_MISSING");
    fs.rmSync(dist, { force: true, recursive: true });
  });

  it("launches every web arm with the playtest WebGPU recipe when asked, and refuses an unknown one", () => {
    const recipe = browserLaunchArgs(undefined, "webgpu");
    expect(recipe).toContain("--enable-features=Vulkan");
    expect(recipe).toContain("--disable-gpu-vsync");
    expect(browserLaunchArgs(undefined, undefined)).not.toContain("--enable-features=Vulkan");
    expect(() => browserLaunchArgs(undefined, "metal")).toThrow("TN_BENCH_BAD_FLAG");
  });

  it("pairs the web arms only with each other, as production builds, and builds the engine page", async () => {
    const [cli, config, main] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts/engine-load-test/cli.ts"), "utf8"),
      readFile(path.join(process.cwd(), "examples/engine-load-test/vite.config.ts"), "utf8"),
      readFile(path.join(process.cwd(), "examples/engine-load-test/src/main.ts"), "utf8"),
    ]);
    expect(cli).toMatch(/arm === "tn-engine-web"\) return runTnEngineWeb/u);
    expect(cli).toMatch(/never mixes a web arm and a desktop arm/u);
    expect(cli).toMatch(/a web pair runs production builds only/u);
    expect(config).toMatch(
      /createWebEnginePlugin\(\{ engine: "threenative", wasm: WASM_ENGINE \}\)/u,
    );
    expect(config).toMatch(
      /__TN_WEB_ARM__: JSON\.stringify\(webEngine \? "tn-engine-web" : "tn-web"\)/u,
    );
    expect(main).toMatch(/arm: __TN_WEB_ARM__/u);
  });
});
