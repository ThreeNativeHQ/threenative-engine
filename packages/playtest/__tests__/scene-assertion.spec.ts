import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { requiredPlaytestCapabilities } from "../src/assertion-schema.js";
import { emitGeometry } from "../src/evaluators/geometry.js";
import { emitScene } from "../src/evaluators/scene.js";
import { connectPlaytestBridgeTransport } from "../src/runner/bridgeClient.js";
import { PLAYTEST_PROTOCOL_LIMITS, PLAYTEST_PROTOCOL_VERSION } from "../src/protocol.js";
import type { IBridgeTransport } from "../src/runner/bridgeClient.js";
import { loadPlaytestScenario } from "../src/scenario.js";
import type { IPlaytestSceneObservation } from "../src/protocol.js";

/**
 * `doctor --url` reports the room, but a report is read by whoever runs it and a scenario is read
 * by every later change. These pin the scenario-level bound, and every way it must fail closed —
 * above all on a run whose bridge reported no scene, which is the shape a vacuous pass would take.
 */

function scene(overrides: Partial<IPlaytestSceneObservation> = {}): IPlaytestSceneObservation {
  return {
    background: "color:#000000",
    camera: { far: 1000, forward: [0, 0, -1], fov: 60, near: 0.1, position: [0, 0, 0], type: "PerspectiveCamera" },
    lights: [{ color: "#ffffff", intensity: 1, type: "DirectionalLight", visible: true }],
    materials: { MeshStandardMaterial: 3 },
    objects: 12,
    truncated: false,
    worldExtent: { max: [10, 10, 10], min: [-10, -10, -10] },
    ...overrides,
  };
}

function evaluate(assertion: unknown, observed: IPlaytestSceneObservation | undefined) {
  const assertions: Array<{ details?: Record<string, unknown>; id: string; pass: boolean }> = [];
  const diagnostics: Array<{ code: string; message: string; severity: "error" | "warning" }> = [];
  emitScene({
    assertions,
    diagnostics,
    input: {
      report: { observations: observed === undefined ? {} : { scene: observed } },
      scenario: { assert: { scene: assertion } },
    },
    scenarioAssertions: { scene: assertion },
  } as never);
  return { assertions, diagnostics };
}

describe("a scenario can bound the room", () => {
  test("fails closed when the bridge reported no scene at all", () => {
    const result = evaluate({ minVisibleLights: 1 }, undefined);
    expect(result.assertions).toEqual([
      { details: { expected: { minVisibleLights: 1 }, observed: undefined }, id: "scene.observed", pass: false },
    ]);
    expect(result.diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_UNOBSERVED");
  });

  test("holds a visible-light floor and fails below it", () => {
    expect(
      evaluate({ minVisibleLights: 1 }, scene()).assertions.find(({ id }) => id === "scene.minVisibleLights")?.pass,
    ).toBe(true);
    const dark = evaluate({ minVisibleLights: 1 }, scene({ lights: [] }));
    expect(dark.assertions.find(({ id }) => id === "scene.minVisibleLights")?.pass).toBe(false);
    expect(dark.diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_UNLIT");
  });

  test("counts an invisible light as no light, because the renderer will", () => {
    const result = evaluate(
      { minVisibleLights: 1 },
      scene({ lights: [{ color: "#ffffff", intensity: 1, type: "PointLight", visible: false }] }),
    );
    expect(result.assertions[0]?.pass).toBe(false);
    expect(result.assertions[0]?.details).toMatchObject({ observed: 0, total: 1 });
  });

  test("litMaterialsAreLit fails an unlit scene of lit materials and passes an unlit scene of none", () => {
    const black = evaluate({ litMaterialsAreLit: true }, scene({ lights: [] }));
    expect(black.assertions[0]?.pass).toBe(false);
    expect(black.diagnostics[0]?.message).toContain("renders black");
    // A scene of MeshBasicMaterial needs no light, and must not be failed for having none.
    const unlitByDesign = evaluate(
      { litMaterialsAreLit: true },
      scene({ lights: [], materials: { MeshBasicNodeMaterial: 4 } }),
    );
    expect(unlitByDesign.assertions[0]?.pass).toBe(true);
  });

  test("fogClearsScene catches a fog that ends in front of what it fogs", () => {
    // Round 9's defect: a scene reaching ~17 units behind a fog that goes opaque at 12.
    const clipped = evaluate(
      { fogClearsScene: true },
      scene({ fog: { color: "#ffffff", far: 12, near: 4, type: "linear" } }),
    );
    expect(clipped.assertions[0]?.pass).toBe(false);
    expect(clipped.diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_FOG_CLIPS");
    expect(
      evaluate({ fogClearsScene: true }, scene({ fog: { color: "#ffffff", far: 400, near: 4, type: "linear" } }))
        .assertions[0]?.pass,
    ).toBe(true);
    // Exponential fog has no far plane to clear, and must not be failed for lacking one.
    expect(
      evaluate({ fogClearsScene: true }, scene({ fog: { color: "#ffffff", density: 0.01, type: "exponential" } }))
        .assertions[0]?.pass,
    ).toBe(true);
    expect(evaluate({ fogClearsScene: true }, scene()).assertions[0]?.pass).toBe(true);
  });

  test("an unmeasurable comparison fails rather than counting as cleared", () => {
    const noExtent = evaluate({ fogClearsScene: true }, scene({ worldExtent: undefined }));
    expect(noExtent.assertions[0]?.pass).toBe(false);
    expect(noExtent.diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_UNOBSERVED");
    const noFarPlane = evaluate(
      { cameraClearsScene: true },
      scene({ camera: { forward: [0, 0, -1], position: [0, 0, 0], type: "Camera" } }),
    );
    expect(noFarPlane.assertions[0]?.pass).toBe(false);
    expect(noFarPlane.diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_UNOBSERVED");
  });

  test("cameraClearsScene catches a far plane inside the scene", () => {
    const clipped = evaluate(
      { cameraClearsScene: true },
      scene({ camera: { far: 5, forward: [0, 0, -1], fov: 60, near: 0.1, position: [0, 0, 0], type: "PerspectiveCamera" } }),
    );
    expect(clipped.assertions[0]?.pass).toBe(false);
    expect(clipped.diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_CAMERA_CLIPS");
    expect(evaluate({ cameraClearsScene: true }, scene()).assertions[0]?.pass).toBe(true);
  });

  test("evaluates every asserted bound, not just the first that fails", () => {
    const result = evaluate(
      { cameraClearsScene: true, fogClearsScene: true, litMaterialsAreLit: true, minVisibleLights: 2 },
      scene({ fog: { color: "#ffffff", far: 3, near: 1, type: "linear" }, lights: [] }),
    );
    expect(result.assertions.map(({ id }) => id)).toEqual([
      "scene.minVisibleLights",
      "scene.litMaterialsAreLit",
      "scene.fogClearsScene",
      "scene.cameraClearsScene",
    ]);
    expect(result.assertions.filter(({ pass }) => !pass)).toHaveLength(3);
  });
});

describe("the scene assertion schema fails closed", () => {
  function scenarioFile(assertion: unknown): { file: string; project: string } {
    const project = makeTempDirSync("threenative-scene-assert-");
    const file = join(project, "scene.playtest.json");
    writeFileSync(
      file,
      JSON.stringify({
        assert: { scene: assertion },
        name: "scene",
        schemaVersion: 1,
        steps: [{ waitTicks: 1 }],
        subject: "player",
        target: "web",
      }),
    );
    return { file, project };
  }

  test("accepts a well-typed bound", async () => {
    const { file, project } = scenarioFile({ litMaterialsAreLit: true, minVisibleLights: 1 });
    const scenario = await loadPlaytestScenario(project, file);
    expect(scenario.assert?.scene).toEqual({ litMaterialsAreLit: true, minVisibleLights: 1 });
  });

  test("refuses an empty scene assertion, which would observe nothing", async () => {
    const { file, project } = scenarioFile({});
    await expect(loadPlaytestScenario(project, file)).rejects.toThrow(/observes nothing/u);
  });

  test("throws on an unknown key instead of dropping it", async () => {
    const { file, project } = scenarioFile({ minVisibleLigths: 1 });
    await expect(loadPlaytestScenario(project, file)).rejects.toThrow(/minVisibleLigths/u);
  });

  test("throws on a wrong-typed bound instead of coercing it", async () => {
    const wrongNumber = scenarioFile({ minVisibleLights: "one" });
    await expect(loadPlaytestScenario(wrongNumber.project, wrongNumber.file)).rejects.toThrow(/minVisibleLights/u);
    const wrongFlag = scenarioFile({ litMaterialsAreLit: "yes" });
    await expect(loadPlaytestScenario(wrongFlag.project, wrongFlag.file)).rejects.toThrow(/litMaterialsAreLit/u);
  });
});

describe("geometry is one registry kind, like every other assertion", () => {
  function geometryResult(observed: unknown) {
    const assertions: Array<{ id: string; pass: boolean }> = [];
    const diagnostics: Array<{ code: string }> = [];
    emitGeometry({
      assertions,
      diagnostics,
      input: { report: { observations: observed === undefined ? {} : { geometry: observed } } },
      scenarioAssertions: { geometry: { limit: 5 } },
    } as never);
    return { assertions, diagnostics };
  }

  test("a captured frame passes and a missing or unavailable report fails closed", () => {
    expect(geometryResult({ status: "captured" }).assertions).toEqual([{ details: expect.anything(), id: "geometry.observed", pass: true }]);
    for (const observed of [undefined, { status: "unavailable" }]) {
      const result = geometryResult(observed);
      expect(result.assertions[0]).toMatchObject({ id: "geometry.observed", pass: false });
      expect(result.diagnostics[0]?.code).toBe("TN_PLAYTEST_GEOMETRY_UNOBSERVED");
    }
  });

  test("the capability it needs comes from its registry entry, with no special case", () => {
    const scenario = { assert: { geometry: { limit: 5 } }, artifacts: { screenshots: false }, name: "g", schemaVersion: 1, steps: [] };
    expect(requiredPlaytestCapabilities(scenario as never)).toEqual(["runtime.geometry"]);
  });

  test("a bridge that does not advertise runtime.geometry is refused at the handshake", async () => {
    const description = { capabilities: [] as string[], limits: PLAYTEST_PROTOCOL_LIMITS, name: "g", protocolVersion: PLAYTEST_PROTOCOL_VERSION };
    const transport: IBridgeTransport = {
      capabilities: [],
      call: async <T>(method: string) => (method === "describe" ? description : { ready: true }) as T,
      close: async () => undefined,
      waitForBridge: async () => true,
    };
    const scenario = { assert: { geometry: { limit: 5 } }, artifacts: { screenshots: false }, name: "g", schemaVersion: 1, steps: [{ release: true, waitFrames: 1 }], target: "web", viewport: { height: 180, width: 320 } };
    await expect(connectPlaytestBridgeTransport(transport, scenario as never)).rejects.toThrow("runtime.geometry");
    description.capabilities = ["runtime.geometry"];
    await expect(connectPlaytestBridgeTransport(transport, scenario as never)).resolves.toBeDefined();
  });
});
