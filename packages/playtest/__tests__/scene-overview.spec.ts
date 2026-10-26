import { describe, expect, it } from "vitest";

import { formatSceneOverview, summariseScene, type ISceneObservation } from "../src/runner/sceneOverview.js";

const OBSERVATION: ISceneObservation = {
  description: { engine: "three", name: "my-game", version: "0.4.0" },
  snapshot: {
    clock: { mode: "fixed-step", tick: 120 },
    diagnostics: [],
    entities: [
      { id: "player", transform: { position: [0, 1, 0], scale: [1, 1, 1] }, visible: true },
      { id: "enemy.1", transform: { position: [10, 1, -4], scale: [1, 1, 1] }, visible: true },
      { id: "ground", transform: { position: [0, 0, 0], scale: [50, 1, 30] }, visible: true },
      { id: "pickup.hidden", transform: { position: [-6, 1, 8], scale: [1, 1, 1] }, visible: false },
    ],
    gameplay: {
      animation: { player: { advancedFrames: 12, clip: "run" } },
      states: { "enemy.1": "chase", player: "running" },
      tags: { enemy: { count: 3 }, pickup: { count: 7 } },
      world: { runtime: { agent: "browser", core: "0.4.0", randomState: 7, rapier: "0.14.0", step: 120 }, seed: 42 },
    },
    performance: { drawCalls: 118, triangles: 84_000 },
    runtimeDiagnosticsSeries: [
      { drawCalls: 118, frameMs: 16.6, triangles: 84_000 },
      { drawCalls: 118, frameMs: 16.2, triangles: 84_000 },
      { drawCalls: 118, frameMs: 16.4, triangles: 84_000 },
    ],
  },
  url: "http://127.0.0.1:5173",
};

function observation(overrides: Partial<ISceneObservation["snapshot"]>): ISceneObservation {
  return { ...OBSERVATION, snapshot: { ...OBSERVATION.snapshot, ...overrides } };
}

describe("scene overview", () => {
  it("counts what is in the scene and how much of it is visible", () => {
    const overview = summariseScene(OBSERVATION);
    expect(overview.entities).toEqual({ hidden: 1, observed: 4, visible: 3 });
  });

  it("reports world extents from entity positions", () => {
    const { extents } = summariseScene(OBSERVATION);
    expect(extents).toEqual({
      x: { max: 10, min: -6, size: 16 },
      y: { max: 1, min: 0, size: 1 },
      z: { max: 8, min: -4, size: 12 },
    });
  });

  it("reads a metre-scaled scene as metres and a centimetre-scaled one as suspect", () => {
    expect(summariseScene(OBSERVATION).scale.verdict).toBe("consistent with metres");
    const centimetres = summariseScene(
      observation({
        entities: [
          { id: "a", transform: { position: [0, 0, 0], scale: [100, 100, 100] }, visible: true },
          { id: "b", transform: { position: [0, 0, 0], scale: [180, 180, 180] }, visible: true },
        ],
      }),
    );
    expect(centimetres.scale.verdict).toMatch(/centimetre/);
    expect(centimetres.scale.medianEntityScale).toBe(140);
  });

  it("turns the frame series into a frame time and a frame rate", () => {
    const { render } = summariseScene(OBSERVATION);
    expect(render.drawCalls).toBe(118);
    expect(render.triangles).toBe(84_000);
    expect(render.frameMs).toBeCloseTo(16.4, 1);
    expect(render.fps).toBe(61);
  });

  it("summarises gameplay: states, clips advancing, tag counts", () => {
    const { gameplay } = summariseScene(OBSERVATION);
    expect(gameplay.states).toBe(2);
    expect(gameplay.clipsAdvancing).toEqual(["player: run"]);
    expect(gameplay.tags).toEqual({ enemy: 3, pickup: 7 });
  });

  it("says what the bridge cannot see rather than leaving it out", () => {
    expect(summariseScene(OBSERVATION).notObserved.length).toBeGreaterThan(0);
    expect(summariseScene(OBSERVATION).notObserved.join(" ")).toMatch(/light/i);
  });

  it("survives a bridge that reports almost nothing, and says so", () => {
    const bare = summariseScene({ ...OBSERVATION, snapshot: { clock: { mode: "fixed-step" } } });
    expect(bare.entities.observed).toBe(0);
    expect(bare.extents).toBeUndefined();
    expect(bare.render.drawCalls).toBeUndefined();
    expect(formatSceneOverview(bare)).toMatch(/no entities/i);
  });

  it("rounds extents for the eye while the JSON keeps full precision", () => {
    const messy = summariseScene(
      observation({
        entities: [
          { id: "a", transform: { position: [0, 0, 0], scale: [1, 1, 1] }, visible: true },
          { id: "b", transform: { position: [532.7578139524942, 0, 0], scale: [1, 1, 1] }, visible: true },
        ],
      }),
    );
    expect(messy.extents?.x.max).toBe(532.7578139524942);
    expect(formatSceneOverview(messy)).toMatch(/x 0\.\.532\.76 \(532\.76\)/);
  });

  it("formats a report a person can read at a glance", () => {
    const text = formatSceneOverview(summariseScene(OBSERVATION));
    expect(text).toMatch(/entities\s+4 registered with the bridge, 3 visible, 1 hidden/);
    expect(text).toMatch(/118 draw calls/);
    expect(text).toMatch(/61 fps/);
    expect(text.split("\n").length).toBeLessThan(16);
  });

  it("reports incomplete warm-up coverage instead of claiming pipeline completion", () => {
    const overview = summariseScene({
      ...OBSERVATION,
      startup: {
        phase: "ready",
        progress: 1,
        warmup: {
          candidates: 12,
          attempted: 12,
          observed: {
            created: 4,
            failed: 0,
            pending: 1,
            status: "incomplete",
            uniquePipelines: 4,
            uniquePrograms: 3,
          },
          status: "incomplete",
        },
      },
    });
    expect(overview.startup?.warmup?.observed?.created).toBe(4);
    expect(overview.warnings.join(" ")).toMatch(/pipeline completion is not proven/u);
    expect(formatSceneOverview(overview)).toMatch(/warm-up incomplete: 4 created \/ 12 candidates/u);
  });
});

describe("scene overview, the parts that catch a broken run", () => {
  it("separates an unobserved draw count from a zero one", () => {
    const unobserved = summariseScene(observation({ performance: undefined }));
    expect(unobserved.render.drawCalls).toBeUndefined();
    expect(formatSceneOverview(unobserved)).toMatch(/draw calls not observed/);

    const drewNothing = summariseScene(observation({ performance: { drawCalls: 0, triangles: 0 } }));
    expect(drewNothing.render.drawCalls).toBe(0);
    expect(drewNothing.warnings.join(" ")).toMatch(/nothing drew/i);
  });

  it("reports the last frame's draw calls and triangles per render pass", () => {
    const split = summariseScene(
      observation({
        runtimeDiagnosticsSeries: [
          {
            frameMs: 16.4,
            passes: [
              { draws: 1418, kind: "main", triangles: 4_727_398 },
              { draws: 316, kind: "shadow", triangles: 1_814_234 },
            ],
          },
        ],
      }),
    );
    expect(split.render.passes).toEqual([
      { draws: 1418, kind: "main", triangles: 4_727_398 },
      { draws: 316, kind: "shadow", triangles: 1_814_234 },
    ]);
    expect(formatSceneOverview(split)).toContain("passes       main 1,418 draws / 4,727,398 tris · shadow 316 draws / 1,814,234 tris");

    // No pass split is reported as absent, never as a zero.
    const unsplit = summariseScene(OBSERVATION);
    expect(unsplit.render.passes).toBeUndefined();
    expect(formatSceneOverview(unsplit)).not.toContain("  passes ");
  });

  it("calls a scene that did not change between samples frozen", () => {
    const frozen = summariseScene({
      ...OBSERVATION,
      previous: { ...OBSERVATION.snapshot },
    });
    expect(frozen.liveness.moved).toBe(0);
    expect(frozen.liveness.live).toBe(false);
    expect(frozen.warnings.join(" ")).toMatch(/did not change/i);
  });

  it("counts the entities that moved between two samples", () => {
    const moving = summariseScene({
      ...OBSERVATION,
      previous: {
        ...OBSERVATION.snapshot,
        clock: { mode: "fixed-step", tick: 60 },
        entities: [
          { id: "player", transform: { position: [0, 1, 0], scale: [1, 1, 1] }, visible: true },
          { id: "enemy.1", transform: { position: [4, 1, -4], scale: [1, 1, 1] }, visible: true },
        ],
      },
    });
    expect(moving.liveness).toMatchObject({ live: true, moved: 1, ticks: 60 });
  });

  it("reads a uniform frame as a blank screen and says so loudly", () => {
    const blank = summariseScene({
      ...OBSERVATION,
      frame: { brightPixelRatio: 0, distinctColors: 1, height: 720, luminanceStdDev: 0, width: 1280 },
    });
    expect(blank.screen?.blank).toBe(true);
    expect(blank.warnings.join(" ")).toMatch(/blank/i);
    const drawn = summariseScene({
      ...OBSERVATION,
      frame: { brightPixelRatio: 0.38, distinctColors: 41_000, height: 720, luminanceStdDev: 0.21, width: 1280 },
    });
    expect(drawn.screen?.blank).toBe(false);
  });

  it("says when a frame time is a vsync interval rather than a measured cost", () => {
    const vsynced = summariseScene(
      observation({
        runtimeDiagnosticsSeries: [
          { frameMs: 33.3, drawCalls: 424 },
          { frameMs: 33.4, drawCalls: 424 },
          { frameMs: 33.3, drawCalls: 424 },
        ],
      }),
    );
    expect(vsynced.render.vsyncLocked).toBe(true);
    expect(vsynced.warnings.join(" ")).toMatch(/vsync/i);
    expect(vsynced.warnings.join(" ")).toMatch(/disable-gpu-vsync/);

    const measured = summariseScene(
      observation({
        runtimeDiagnosticsSeries: [
          { frameMs: 7.2, drawCalls: 424 },
          { frameMs: 7.4, drawCalls: 424 },
          { frameMs: 7.1, drawCalls: 424 },
        ],
      }),
    );
    expect(measured.render.vsyncLocked).toBe(false);
    expect(measured.warnings.join(" ")).not.toMatch(/vsync/i);
  });

  it("reports the engine's own renderable count, which the entity count is not", () => {
    const withProjection = summariseScene({
      ...OBSERVATION,
      projection: {
        batches: 0,
        projecting: false,
        reason: "projecting would draw 1477 of 1477 candidates, which is not worth its own cost",
        reasonCode: "notWorthwhile",
        sourceRenderables: 1477,
      },
    });
    expect(withProjection.projection?.renderables).toBe(1477);
    const text = formatSceneOverview(withProjection);
    expect(text).toMatch(/renderables\s+1,477/);
    expect(text).toMatch(/notWorthwhile/);
  });

  it("parses the projection diagnostic the engine prints to the console", async () => {
    const { parseProjectionDiagnostic } = await import("../src/runner/sceneOverview.js");
    expect(
      parseProjectionDiagnostic([
        "irrelevant",
        'TN_RENDER_PROJECTION:{"projecting":false,"reasonCode":"notWorthwhile","reason":"nope","sourceRenderables":1477,"batches":0}',
      ]),
    ).toMatchObject({ batches: 0, projecting: false, reasonCode: "notWorthwhile", sourceRenderables: 1477 });
    expect(parseProjectionDiagnostic(["nothing here"])).toBeUndefined();
    expect(parseProjectionDiagnostic(["TN_RENDER_PROJECTION:{not json"])).toBeUndefined();
  });

  it("treats a software adapter as a warning, because its numbers are not the machine's", () => {
    const software = summariseScene({
      ...OBSERVATION,
      page: { adapter: "Google SwiftShader (vulkan)", canvas: { dpr: 1, height: 720, width: 1280 }, consoleErrors: [] },
    });
    expect(software.warnings.join(" ")).toMatch(/swiftshader/i);
  });

  it("reports a missing canvas and console errors, the two loudest startup failures", () => {
    const broken = summariseScene({
      ...OBSERVATION,
      page: { consoleErrors: ["TypeError: x is not a function"] },
      startupMs: 4200,
    });
    expect(broken.warnings.join(" ")).toMatch(/no canvas/i);
    expect(formatSceneOverview(broken)).toMatch(/TypeError/);
    expect(formatSceneOverview(broken)).toMatch(/4\.2 s/);
  });

  it("prints what the reveal awaited and the estimated download at the stated link speed", () => {
    const overview = summariseScene({
      ...OBSERVATION,
      startup: {
        offscreenBytes: {
          awaitedBytes: 50_000_000,
          fix: "Stream these files with WorldCells.",
          offscreenBytes: 45_000_000,
          top: [{ bytes: 45_000_000, path: "forest.glb", reason: "outside-view" }],
          unattributedBytes: 0,
          unsizedFiles: 0,
          visibleBytes: 5_000_000,
          warn: true,
        },
        phase: "ready",
        progress: 1,
      },
    });
    const text = formatSceneOverview(overview);
    // 50 MB = 400 Mbit, which is 20.0 s at 20 Mbit/s.
    expect(text).toMatch(/awaited 50\.0 MB · off-screen 45\.0 MB · est\. reveal download 20\.0 s at 20 Mbit\/s/u);
    expect(text).toMatch(/forest\.glb 45\.0 MB \(outside-view\)/u);
    expect(text).toMatch(/warning: Stream these files with WorldCells/u);
    expect(overview.startup?.offscreenBytes?.awaitedBytes).toBe(50_000_000);
  });
});
