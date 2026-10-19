import { describe, expect, it } from "vitest";

import {
  isSafeProjectRelativePng,
  optionalBoolean,
  optionalPositiveInteger,
  optionalTrivialityReason,
  optionalTargetArray,
  requireArray,
  validateNumberTuple,
  validateOptionalNumberTuple,
  validateRenderChainAssertion,
  validateResourcePathAssertion,
  validateVisualAssertion,
  validateViewport,
} from "../src/scenario/schema-accessors.js";
import {
  playtestStepHoldTicks,
  playtestStepWaitTicks,
  validateAimTarget,
  validateAssertions,
  validateParityAnimation,
  validateParityCompare,
  validateParityConfig,
  validatePlaytestScenario,
  validatePointer,
  validateReachabilityAssertion,
  validateSetup,
  validateSetupEntity,
  validateSetupResource,
  validateStep,
  validateStepLabels,
  validateWorldAssertion,
} from "../src/scenario/schema-validate.js";

function scenario(assert: unknown, steps: unknown[] = [{ label: "sample", waitTicks: 1 }]) {
  return {
    assert,
    name: "schema-boundary",
    schemaVersion: 1,
    steps,
    subject: "player",
  };
}

describe("scenario schema boundaries", () => {
  it("accepts the deterministic browser renderer-failure seam and visible HUD assertion", () => {
    const parsed = validatePlaytestScenario({
      ...scenario({
        hud: [{ id: "threenative-canvas-error", textIncludes: "Error creating WebGL context", visible: true }],
        visual: [{ region: { element: { id: "threenative-canvas-error" }, maxDarkPixelRatio: 0.5, minNonblankPixelRatio: 0.002 } }],
      }),
      bootFailure: "renderer-no-adapter",
      target: "web",
      viewport: { height: 720, width: 1280 },
    }, "boot-failure.playtest.json");

    expect(parsed.bootFailure).toBe("renderer-no-adapter");
    expect(parsed.assert?.hud?.[0]?.visible).toBe(true);
    expect(parsed.assert?.visual?.[0]?.region).toEqual({
      element: { id: "threenative-canvas-error" },
      maxDarkPixelRatio: 0.5,
      minNonblankPixelRatio: 0.002,
    });
  });

  it.each(["desktop", "bevy"] as const)("rejects bootFailure on the non-web target %s", (target) => {
    expect(() => validatePlaytestScenario({
      ...scenario(undefined),
      bootFailure: "renderer-no-adapter",
      target,
      viewport: { height: 720, width: 1280 },
    }, `invalid-${target}-boot-failure.playtest.json`)).toThrow(/browser-only.*target|target.*web/u);
  });

  it("defaults an omitted boot-failure target to web deterministically", () => {
    const parsed = validatePlaytestScenario({
      ...scenario(undefined),
      bootFailure: "renderer-no-adapter",
      viewport: { height: 720, width: 1280 },
    }, "omitted-target-boot-failure.playtest.json");

    expect(parsed.target).toBe("web");
  });

  it("accepts reduced-motion emulation on the web target and refuses it elsewhere", () => {
    const parsed = validatePlaytestScenario({
      ...scenario(undefined),
      reducedMotion: "reduce",
      target: "web",
      viewport: { height: 720, width: 1280 },
    }, "reduced-motion.playtest.json");
    expect(parsed.reducedMotion).toBe("reduce");
    expect(() => validatePlaytestScenario({
      ...scenario(undefined),
      reducedMotion: "reduce",
      target: "desktop",
      viewport: { height: 720, width: 1280 },
    }, "desktop-reduced-motion.playtest.json")).toThrow(/reducedMotion is browser-only/u);
    expect(() => validatePlaytestScenario({
      ...scenario(undefined),
      reducedMotion: "no-preference",
    }, "invalid-reduced-motion.playtest.json")).toThrow(/reducedMotion must be 'reduce'/u);
  });

  it("accepts a click on a DOM element by id or selector, never both or neither", () => {
    const click = (at: unknown) => ({
      ...scenario(undefined),
      steps: [{ at, kind: "click", release: true, waitTicks: 1 }],
      target: "web",
      viewport: { height: 720, width: 1280 },
    });
    expect(validatePlaytestScenario(click({ element: { id: "cloud" } }), "id.playtest.json").steps[0]?.at).toEqual({
      element: { id: "cloud" },
    });
    expect(
      validatePlaytestScenario(click({ element: { selector: "[role=switch]" } }), "sel.playtest.json").steps[0]?.at,
    ).toEqual({ element: { selector: "[role=switch]" } });
    expect(() => validatePlaytestScenario(click({ element: { id: "a", selector: "b" } }), "both.playtest.json")).toThrow(
      /exactly one of id or selector/u,
    );
    expect(() => validatePlaytestScenario(click({ element: {} }), "none.playtest.json")).toThrow(
      /exactly one of id or selector/u,
    );
  });

  it("rejects an unknown boot-failure seam", () => {
    expect(() => validatePlaytestScenario({
      ...scenario(undefined),
      bootFailure: "scene-load-throw",
    }, "invalid-boot-failure.playtest.json")).toThrow(/bootFailure/u);
  });

  it("accepts the portable runtime world field that its validator defines", () => {
    expect(() =>
      validatePlaytestScenario(
        scenario({
          world: {
            runtime: {
              agent: "agent-v1",
              core: "core-v1",
              portable: true,
              randomState: 7,
              rapier: null,
              step: 0.016,
            },
            seed: 42,
          },
        }),
        "schema-boundary.playtest.json",
      ),
    ).not.toThrow();
  });

  it("round-trips the complete authored scenario vocabulary", () => {
    const reason = "This held value is intentional until the later transition is sampled.";
    const parsed = validatePlaytestScenario(
      scenario({
        aerodynamics: [
          {
            controls: [{ minAbs: 0.1, sign: "positive", surface: "elevator" }],
            entity: "aircraft",
            minForceSamples: 2,
            torques: [
              { axis: "y", label: "turn", minAbs: 0.1, relativeToLabel: "start", sign: "positive" },
            ],
          },
        ],
        animation: [
          { advancedFrames: 2, allowTrivial: reason, clip: "run", entered: true, entity: "player", finished: false },
        ],
        camera: { entity: "camera.main", follows: "player", targetInViewport: true, within: 5 },
        components: [
          {
            allowTrivial: reason,
            atSteps: [{ equals: { x: 1 }, label: "start" }],
            changed: true,
            component: "Transform",
            entity: "player",
            equals: { x: 1 },
            gte: 0,
            lte: 2,
            path: "position.x",
          },
        ],
        contacts: [
          { atStep: "hit", entity: "player", kind: "ground", maxCount: 3, minCount: 1, requiredOn: ["web", "desktop"], with: "floor" },
        ],
        deviceMetrics: { maxTemperatureRiseC: 2, maxThermalStatus: 1, notThermallyConfounded: true },
        diagnostics: {
          consoleErrorsOptOutReason: reason,
          networkErrorsOptOutReason: reason,
          noConsoleErrors: true,
          noNetworkErrors: false,
          noRuntimeDiagnostics: false,
          runtimeDiagnosticsOptOutReason: reason,
          runtimeReady: true,
        },
        framebufferCoverage: {
          backdrop: [0, 1, 2],
          grid: { columns: 4, rows: 3 },
          tolerance: 2,
          window: { endStep: "end", startStep: "start" },
        },
        hud: [
          {
            allowTrivial: reason,
            changed: true,
            equals: "ready",
            gte: 0,
            id: "hud",
            lte: 2,
            path: "text",
            textIncludes: "ready",
          },
        ],
        movement: {
          axis: "x",
          closesDistanceToPosition: { min: 0.2, position: [0, 0, 0] },
          entity: "player",
          facesMovementWithinDegrees: 10,
          maxDistance: 20,
          maxTiltDegrees: 45,
          minAxisDelta: { axis: "+x", min: 0.2 },
          minDistance: 0.5,
          minResolvedAxisDelta: { axis: "+x", min: 0.2 },
          minVelocity: 0.01,
          notFacing: { entity: "camera.main", minDegrees: 20 },
          notFacingPosition: { minDegrees: 20, position: [1, 0, 1] },
          pathLength: 1,
          reachesPositionWithin: { atStep: "goal", maxDistance: 1, position: [1, 0, 0] },
          rotationChanged: true,
        },
        occluded: [{ allowTrivial: reason, entity: "player", target: "wall" }],
        overlayNodes: [
          { attribute: "aria-label", equals: 10, overlayId: "hud", selector: "#score", textIncludes: "10", visible: true },
        ],
        performance: {
          maxDrawCalls: 10,
          maxFrameMsP95: 5,
          maxPhaseMsP95: { hostGap: 1, overlay: 2, render: 3, residual: 4, update: 5 },
          maxTriangles: 100,
          minFps: 60,
        },
        reachability: { artifact: "artifacts/reach.json", entities: ["platform.a", "platform.b"] },
        renderChain: { tier: "high", velocity: { maxRejectionFraction: 0.2 } },
        resources: [
          {
            allowTrivial: reason,
            atSteps: [{ equals: 1, label: "start", textIncludes: "1" }],
            changed: true,
            equals: 1,
            gte: 0,
            id: "state",
            lte: 2,
            path: "score",
            textIncludes: "1",
            throughoutSteps: true,
          },
          {
            anyOf: [{ changed: true, equals: 2, gte: 0, lte: 3, path: "backup", textIncludes: "2" }],
            id: "state",
          },
        ],
        settled: [
          { allowTrivial: reason, atStep: "settled", compareToStep: "start", entity: "crate", minBodies: 1, minMeanPoseDistance: 0.1, requiredOn: ["web"] },
        ],
        signals: [{ atStep: "hit", entity: "player", maxCount: 2, minCount: 1, name: "hit" }],
        states: [{ allowTrivial: reason, entity: "player", equals: "ready" }],
        tags: [{ allowTrivial: reason, count: 2, gte: 1, lte: 3, tag: "coin" }],
        visibility: [{ allowTrivial: reason, entity: "player", maxOffscreenRatio: 0.1, minProjectedPixels: 20, present: true }],
        visual: [
          {
            entityVisible: { entity: "player", minProjectedPixels: 20, throughoutFrames: true },
            frameDiff: { baselineImage: "artifacts/base.png", maxChangedPixelRatio: 0.9, minChangedPixelRatio: 0.1 },
            region: { height: 10, maxDarkPixelRatio: 0.8, maxLuminance: 0.9, minDarkPixelRatio: 0.1, minNonblankPixelRatio: 0.2, width: 10, x: 0, y: 0 },
          },
        ],
        world: {
          runtime: { agent: "agent-v1", core: "core-v1", portable: true, randomState: 7, rapier: null, step: 0.016 },
          seed: 42,
        },
      }, [
        { label: "start", release: true, waitTicks: 1 },
        { label: "hit", release: true, waitTicks: 1 },
        { label: "goal", release: true, waitTicks: 1 },
        { label: "end", release: true, waitTicks: 1 },
        { label: "settled", release: true, waitTicks: 1 },
      ]),
      "complete.playtest.json",
      "/tmp/complete.playtest.json",
    );

    expect(parsed).toMatchObject({
      assert: { world: { runtime: { portable: true } } },
      inputDelivery: "deterministic",
      sourcePath: "/tmp/complete.playtest.json",
      target: "web",
      viewport: { height: 720, width: 1280 },
      warmupFrames: 0,
    });
  });

  it("validates parity, setup, and every step delivery form", () => {
    expect(
      validateParityConfig(
        {
          animation: [{ clip: "run", entity: "player", requiredOn: ["web", "desktop"] }],
          axisDelta: { x: 1, y: 2, z: 3, ignored: "nope" },
          compare: {
            animation: [{ entity: "player" }],
            axisDelta: { x: 0.1 },
            contacts: { minSharedCount: 1 },
            movementDistance: { maxDelta: 0.2 },
            resources: ["state"],
          },
          contacts: { minSharedCount: 2 },
          movementDistance: { maxDelta: 1 },
          resources: ["state"],
          targets: ["web", "bevy"],
        },
        "parity.playtest.json",
      ),
    ).toMatchObject({ targets: ["web", "bevy"], resources: ["state"] });
    expect(validateParityCompare({ axisDelta: { x: 1 }, movementDistance: { maxDelta: 2 } })).toEqual({
      axisDelta: { x: 1 },
      movementDistance: { maxDelta: 2 },
    });
    expect(validateParityAnimation({ entity: "player" })).toEqual({ entity: "player" });

    expect(
      validateSetup(
        {
          aim: { pitch: 0.1, yaw: 0.2 },
          entities: [
            { entity: "player", position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            { entity: "camera.main", rotation: [0, 0, 0, 1] },
          ],
          place: [
            { at: { x: 0, y: 0, z: 0 }, entity: "crate", facing: { yaw: 0 }, frozen: true },
            { at: { x: 1, y: 0, z: 1 }, entity: "wall", lookAt: { x: 0, y: 0, z: 0 } },
          ],
          resources: [{ id: "state", path: "game.mode", value: "ready" }],
          spawn: { x: 1, y: 2, z: 3 },
        },
        "setup.playtest.json",
        "player",
      ),
    ).toMatchObject({ spawn: { x: 1, y: 2, z: 3 }, resources: [{ id: "state" }] });

    expect(validateStep({ kind: "wait", label: "message", overlayMessage: { overlayId: "hud", payload: { ok: true }, type: "toast" }, waitTicks: 1 }, "steps.json", 0)).toMatchObject({ kind: "wait", overlayMessage: { type: "toast" } });
    expect(validateStep({ kind: "click", at: { entity: "button" }, label: "click", release: false, screenshot: "clicked" }, "steps.json", 1)).toMatchObject({ kind: "click", at: { entity: "button" } });
    expect(validateStep({ kind: "input", holdTicks: 2, label: "input", pointerPosition: { buttons: 1, x: 0.5, y: 0.5 }, pointers: [{ buttons: 1, id: 1, x: 0.5, y: 0.5 }], press: ["KeyW", "ShiftLeft"], release: true, wheel: { deltaX: 1, deltaY: -1 } }, "steps.json", 2)).toMatchObject({ pointers: [{ id: 1 }], wheel: { deltaY: -1 } });
    expect(validateStep({ media: { colorScheme: "dark", reducedMotion: "reduce" }, wheel: { deltaY: 50, x: 0.25, y: 1 }, waitTicks: 1 }, "steps.json", 5)).toMatchObject({ media: { colorScheme: "dark", reducedMotion: "reduce" }, wheel: { deltaY: 50, x: 0.25, y: 1 } });
    expect(validateStep({ kind: "aimAt", label: "aim", pitch: 0.2, target: { x: 1, z: 2 }, waitTicks: 1, release: true }, "steps.json", 3)).toMatchObject({ target: { x: 1, z: 2 } });
    expect(validateStep({ kind: "wait", label: "resize", release: true, window: { height: 480, operation: "resize", width: 640 } }, "steps.json", 4)).toMatchObject({ window: { operation: "resize" } });
    expect(validateAimTarget({ entity: "player" }, "steps.json", 0)).toEqual({ entity: "player" });
    expect(validatePointer({ buttons: 1, id: 2, x: 0, y: 1 }, "steps.json", 0, 0)).toEqual({ buttons: 1, id: 2, x: 0, y: 1 });
    expect(playtestStepHoldTicks({ press: "KeyW", release: true } as never, 3)).toBe(3);
    // A touch hold authored in ticks is held for those ticks, not dropped to one display frame.
    expect(playtestStepHoldTicks({ holdTicks: 90, pointers: [{ id: 7, x: 0.2, y: 0.5 }], release: true } as never, 0)).toBe(90);
    expect(playtestStepHoldTicks({ holdTicks: 5, pointerPosition: { x: 0.5, y: 0.5 }, release: true } as never, 0)).toBe(5);
    // A pointer step with no authored hold keeps its one-frame timing.
    expect(playtestStepHoldTicks({ pointers: [{ id: 7, x: 0.2, y: 0.5 }], release: true } as never, 0)).toBe(0);
    expect(playtestStepWaitTicks({ release: true, waitTicks: 4 } as never)).toBe(4);
  });

  it("accepts the scalar and composite assertion validators at their boundaries", () => {
    const reason = "This held value is intentional until the later transition is sampled.";
    expect(validateWorldAssertion({ seed: null }, "world.json")).toEqual({ seed: null });
    expect(validateWorldAssertion({ runtime: { agent: "a", core: "c", portable: false, randomState: 0, rapier: "r", step: 1 }, seed: 0 }, "world.json")).toMatchObject({ runtime: { portable: false, step: 1 } });
    expect(validateReachabilityAssertion({ artifact: "reach.json", entities: ["a", "b", "c"] }, "reach.json")).toEqual({ artifact: "reach.json", entities: ["a", "b", "c"] });
    expect(validateSetupResource({ id: "state", path: "game.score", value: 1 }, "setup.json", 0)).toEqual({ id: "state", path: "game.score", value: 1 });
    expect(validateSetupEntity({ entity: "player", scale: [1, 1, 1] }, "setup.json", 0)).toEqual({ entity: "player", scale: [1, 1, 1] });
    expect(validateAssertions({
      deviceMetrics: { maxTemperatureRiseC: 1 },
      renderChain: { tier: "off" },
      states: [{ allowTrivial: reason, equals: "ready" }],
      visibility: [{ minProjectedPixels: 1 }],
    }, "assert.json")).toMatchObject({ deviceMetrics: { maxTemperatureRiseC: 1 }, renderChain: { tier: "off" } });
  });

  it("rejects malformed roots, setup entries, targets, timing, and labels", () => {
    expect(() => validatePlaytestScenario([], "invalid.json")).toThrow(/root must be a JSON object/u);
    expect(() => validatePlaytestScenario({ name: "bad", schemaVersion: 1, steps: [] }, "invalid.json")).toThrow(/steps\[\] must contain/u);
    expect(() => validateSetupResource({ id: "state" }, "invalid.json", 0)).toThrow(/must define value/u);
    expect(() => validateSetupResource({ id: "state", path: "game..score", value: 1 }, "invalid.json", 0)).toThrow(/dot path/u);
    expect(() => validateSetupEntity({ entity: "player" }, "invalid.json", 0)).toThrow(/position, rotation, or scale/u);
    expect(() => validateSetup({ spawn: { x: 1, z: 2 } }, "invalid.json")).toThrow(/declares no subject/u);
    expect(() => validateSetup({ place: [] }, "invalid.json", "player")).toThrow(/at least one placement/u);
    expect(() => validateSetup({ place: [{ at: { x: 0, y: 0, z: 0 }, entity: "a", facing: { yaw: 0 }, lookAt: { x: 0, y: 0, z: 0 } }] }, "invalid.json", "player")).toThrow(/facing or lookAt/u);
    expect(() => validateAimTarget({ x: 1 }, "invalid.json", 0)).toThrow(/x and z/u);
    expect(() => validatePointer({ id: 0, x: 0, y: 0 }, "invalid.json", 0, 0)).toThrow(/positive integer/u);
    expect(() => validateStep({ kind: "unknown", waitTicks: 1, release: true }, "invalid.json", 0)).toThrow(/kind must be/u);
    expect(() => validateStep({ kind: "wait", press: "KeyW", waitTicks: 1, release: true }, "invalid.json", 0)).toThrow(/kind wait/u);
    expect(() => validateStep({ kind: "click", at: { x: 0, y: 0 }, holdTicks: 1, release: true }, "invalid.json", 0)).toThrow(/kind 'click'/u);
    expect(() => validateStep({ kind: "aimAt", target: { x: 1, z: 2 }, press: "KeyW", release: true }, "invalid.json", 0)).toThrow(/kind 'aimAt'/u);
    expect(() => validateStep({ kind: "wait", waitFrames: 1, waitTicks: 1, release: true }, "invalid.json", 0)).toThrow(/choose waitTicks or waitFrames/u);
    expect(() => validateStepLabels([{ label: "same", release: true, waitTicks: 1 }, { label: "same", release: true, waitTicks: 1 }] as never, undefined, "invalid.json")).toThrow(/duplicate label/u);
    expect(() => validateStepLabels([{ label: "start", release: true, waitTicks: 1 }] as never, { signals: [{ atStep: "missing", name: "hit" }] } as never, "invalid.json")).toThrow(/no scenario step defines/u);
  });

  // PRD-536 A1: the root parser decided each of these by `isRecord(...)` or a
  // `typeof x === "number" ? { x } : {}` spread, so a wrong-typed root field was
  // dropped and the scenario ran without it.
  it("rejects a root field it would otherwise drop", () => {
    const dropped: [unknown, RegExp][] = [
      [-1, /warmupFrames/u],
      ["2", /warmupFrames/u],
      [[], /setup/u],
      [5, /subject/u],
      [{ screenshots: "no" }, /screenshots/u],
      ["before-after", /parity/u],
    ];
    const keys = ["warmupFrames", "warmupFrames", "setup", "subject", "artifacts", "parity"];
    keys.forEach((key, index) => {
      const [bad, message] = dropped[index]!;
      expect(() => validatePlaytestScenario({ ...scenario(undefined), [key]: bad }, "invalid.json")).toThrow(message);
    });
    expect(validatePlaytestScenario({ ...scenario(undefined), warmupFrames: 0 }, "valid.json").warmupFrames).toBe(0);
  });

  // PRD-536 A2: each of these loaded and then bounded nothing, so the run reported
  // green with the author's check missing. Same rejection shape as notThermallyConfounded:false.
  it("rejects an assertion that sets no bound", () => {
    const vacuous: [Record<string, unknown>, RegExp][] = [
      [{ performance: {} }, /performance/u],
      [{ visual: [{ frameDiff: {} }] }, /frameDiff/u],
      [{ resources: [{ atSteps: [{ label: "sample" }], id: "state" }] }, /atSteps\[0\]/u],
      [{ resources: [{ atSteps: [], id: "state" }] }, /atSteps/u],
      [{ causedBy: [{ cause: { contact: { entity: "player", with: "crate" } }, effect: { becomes: "won", path: "game.mode" }, neverBefore: false }] }, /neverBefore/u],
      [{ scene: { cameraClearsScene: false } }, /cameraClearsScene/u],
      [{ scene: { minVisibleLights: 0 } }, /minVisibleLights/u],
      [{ sceneNodes: [{ select: { name: "crate" }, texturesLoaded: false }] }, /texturesLoaded/u],
      [{ movement: { rotationChanged: false } }, /rotationChanged/u],
    ];
    for (const [assert, message] of vacuous) {
      expect(() => validateAssertions(assert, "invalid.json")).toThrow(message);
    }
  });

  // PRD-536 A3: the ranges are the runtime units the evaluators compare against —
  // capture.ts divides luminance by 255, projectedOffscreenRatio returns 0..1.
  it("rejects an out-of-range or malformed bound", () => {
    const outOfRange: [Record<string, unknown>, RegExp][] = [
      [{ visual: [{ region: { element: { id: "hud" }, minNonblankPixelRatio: 1.2 } }] }, /minNonblankPixelRatio/u],
      [{ visual: [{ region: { element: { id: "hud" }, minDarkPixelRatio: -0.1 } }] }, /minDarkPixelRatio/u],
      [{ visual: [{ region: { element: { id: "hud" }, maxLuminance: 100 } }] }, /maxLuminance/u],
      [{ animation: [{ entity: "player", maxFootSlide: -0.5 }] }, /maxFootSlide/u],
      [{ visibility: [{ entity: "player", maxOffscreenRatio: 1.5 }] }, /maxOffscreenRatio/u],
      [{ visibility: [{ entity: "player", minProjectedPixels: -1 }] }, /minProjectedPixels/u],
      [{ visual: [{ entityVisible: { entity: "player", minProjectedPixels: -1 } }] }, /minProjectedPixels/u],
      [{ movement: { maxDistance: -1 } }, /maxDistance/u],
      [{ movement: { pathLength: -1 } }, /pathLength/u],
      [{ movement: { maxDistance: "20" } }, /maxDistance/u],
      [{ movement: { closesDistanceToPosition: "near" } }, /closesDistanceToPosition/u],
      [{ movement: { minAxisDelta: [{ axis: "+x", min: 0.2 }] } }, /minAxisDelta/u],
    ];
    for (const [assert, message] of outOfRange) {
      expect(() => validateAssertions(assert, "invalid.json")).toThrow(message);
    }
    expect(() => validateStep({ press: "KeyW", release: "no" }, "invalid.json", 0)).toThrow(/release/u);
  });

  it("rejects assertion shapes and impossible boundary values", () => {
    expect(() => validateAssertions({ signals: [] }, "invalid.json")).toThrow(/signals.*at least one/u);
    expect(() => validateAssertions({ camera: {} }, "invalid.json")).toThrow(/camera.*within|targetInViewport/u);
    expect(() => validateAssertions({ world: { seed: "random" } }, "invalid.json")).toThrow(/world\.seed/u);
    expect(() => validateAssertions({ reachability: { artifact: "", entities: ["a"] } }, "invalid.json")).toThrow(/reachability/u);
    expect(() => validateAssertions({ renderChain: "high" }, "invalid.json")).toThrow(/renderChain.*object/u);
    expect(() => validateAssertions({ pipelineCensus: "zero" }, "invalid.json")).toThrow(/pipelineCensus.*object/u);
    expect(() => validateAssertions({ pipelineCensus: { maxNodeBuildsAfterWarmUpSettled: "zero" } }, "invalid.json")).toThrow(/maxNodeBuildsAfterWarmUpSettled.*non-negative integer/u);
    expect(() => validateAssertions({ pipelineCensus: {} }, "invalid.json")).toThrow(/pipeline census assertion observes nothing/u);
    expect(() => validateAssertions({ pipelineCensus: { warmUpScope: "chunk:0" } }, "invalid.json")).toThrow(/pipeline census assertion observes nothing/u);
    expect(() => validateAssertions({ pipelineCensus: { maxRenderPipelineCreationsAfterWarmUpScope: 0 } }, "invalid.json")).toThrow(/warmUpScope.*required/u);
    expect(() => validateAssertions({ performance: "fast" }, "invalid.json")).toThrow(/performance/u);
    expect(() => validateAssertions({ visual: [{}] }, "invalid.json")).toThrow(/visual.*declare/u);
    expect(() => validateAssertions({ aerodynamics: [{ entity: "plane", controls: [{ sign: "sideways", surface: "elevator" }] }] }, "invalid.json")).toThrow(/negative.*positive/u);
    expect(() => validateAssertions({ framebufferCoverage: { backdrop: [0, 0, 0], tolerance: 0, window: { endStep: "start", startStep: "end" } } }, "invalid.json")).not.toThrow();
  });

  it("fails closed at scenario, parity, and setup boundaries", () => {
    expect(
      validatePlaytestScenario(
        { ...scenario(undefined), acceptanceId: "accepted", inputDelivery: "focused-dom", name: "valid", parity: {}, target: "desktop", warmupFrames: 2 },
        "valid.json",
      ),
    ).toMatchObject({ acceptanceId: "accepted", inputDelivery: "focused-dom", target: "desktop", warmupFrames: 2 });
    expect(() => validatePlaytestScenario({ ...scenario(undefined), acceptanceId: "" }, "invalid.json")).toThrow(/acceptanceId/u);
    expect(() => validatePlaytestScenario({ ...scenario(undefined), name: 42 }, "invalid.json")).toThrow(/name/u);
    expect(() => validatePlaytestScenario({ ...scenario("not-an-object"), }, "invalid.json")).toThrow(/assert must be/u);
    expect(() => validatePlaytestScenario({ ...scenario(undefined, [{ kind: "aimAt", target: { x: 1, z: 2 }, waitTicks: 1 }]), subject: undefined }, "invalid.json")).toThrow(/declare scenario.subject/u);

    expect(() => validateParityConfig({ resources: "state" }, "invalid.json")).toThrow(/array of resource ids/u);
    expect(() => validateParityConfig({ targets: "desktop" }, "invalid.json")).toThrow(/array of targets/u);
    expect(validateParityConfig({}, "valid.json")).toEqual({});
    expect(validateParityCompare({ axisDelta: { bad: 1, x: "bad", y: Number.POSITIVE_INFINITY, z: null }, contacts: { minSharedCount: "bad" } }, "valid.json")).toEqual({});

    expect(() => validateSetup({ entities: [null] }, "invalid.json", "player")).toThrow(/must name an entity/u);
    expect(() => validateSetup({ place: "not-an-array" }, "invalid.json", "player")).toThrow(/setup\.place.*array/u);
    expect(() => validateSetup({ place: [{ at: { x: 0, y: 0, z: 0 }, entity: "crate", facing: {} }] }, "invalid.json", "player")).toThrow(/facing\.yaw/u);
    expect(() => validateSetup({ place: [{ at: { x: 0, y: 0 }, entity: "crate" }] }, "invalid.json", "player")).toThrow(/finite x, y, and z/u);
    expect(() => validateSetup({ resources: [{}] }, "invalid.json", "player")).toThrow(/name a resource id/u);
    expect(validateSetup({ resources: [{ id: "state", value: 1 }] }, "valid.json", "player")).toEqual({ resources: [{ id: "state", value: 1 }] });
    expect(() => validateSetupEntity(null, "invalid.json", 0)).toThrow(/must name an entity/u);
  });

  it("fails closed for every step delivery and timing boundary", () => {
    expect(validateStep({ press: "KeyW" }, "valid.json", 0)).toMatchObject({ press: "KeyW", release: true });
    expect(validateStep({ overlayMessage: { overlayId: "hud", type: "toast" }, waitTicks: 1 }, "valid.json", 1)).toMatchObject({ overlayMessage: { payload: {} } });
    expect(validateStep({ kind: "wait", release: true, window: { operation: "minimize" }, waitTicks: 1 }, "valid.json", 2)).toMatchObject({ window: { operation: "minimize" } });
    expect(validateStep({ at: { x: 1, y: 2 }, kind: "click", release: true }, "valid.json", 3)).toMatchObject({ at: { x: 1, y: 2 } });
    expect(validateStep({ holdTicks: 1, press: [], release: true }, "valid.json", 4)).toMatchObject({ holdTicks: 1, press: [] });

    const invalidSteps: unknown[] = [
      null,
      { press: "" },
      { press: ["KeyW", "KeyW"] },
      { press: [1] },
      { overlayMessage: { overlayId: "", type: "toast" }, waitTicks: 1 },
      { pointerPosition: { x: "0", y: 0.5 }, waitTicks: 1 },
      { pointerPosition: { x: Number.NaN, y: 0.5 }, waitTicks: 1 },
      { pointerPosition: { x: -0.1, y: 0.5 }, waitTicks: 1 },
      { pointerPosition: { x: 1.1, y: 0.5 }, waitTicks: 1 },
      { pointerPosition: { x: 0.5, y: "0" }, waitTicks: 1 },
      { pointerPosition: { x: 0.5, y: Number.NaN }, waitTicks: 1 },
      { pointerPosition: { x: 0.5, y: -0.1 }, waitTicks: 1 },
      { pointerPosition: { x: 0.5, y: 1.1 }, waitTicks: 1 },
      { pointerPosition: { buttons: 0.5, x: 0.5, y: 0.5 }, waitTicks: 1 },
      { pointerPosition: { buttons: -1, x: 0.5, y: 0.5 }, waitTicks: 1 },
      { pointers: [{ id: 1, x: 0, y: 0 }, { id: 1, x: 1, y: 1 }], waitTicks: 1 },
      { pointers: {}, waitTicks: 1 },
      { wheel: { deltaY: Number.NaN }, waitTicks: 1 },
      { wheel: { deltaY: 1, x: 0.5 }, waitTicks: 1 },
      { wheel: { deltaY: 1, x: 1.5, y: 0.5 }, waitTicks: 1 },
      { wheel: { deltaY: 1, x: 0.5, y: 0.5, z: 0 }, waitTicks: 1 },
      { media: {}, waitTicks: 1 },
      { media: { colorScheme: "sepia" }, waitTicks: 1 },
      { media: { reducedMotion: true }, waitTicks: 1 },
      { media: { colorScheme: "dark", contrast: "more" }, waitTicks: 1 },
      { kind: "click", at: { x: 0, y: 0 }, media: { colorScheme: "dark" } },
      { screenshot: "not safe!", waitTicks: 1 },
      { label: " ", waitTicks: 1 },
      { window: { height: 0, operation: "resize", width: 640 }, waitTicks: 1 },
      { window: { operation: "unknown" }, waitTicks: 1 },
      { kind: "wait", at: { x: -1, y: 0 }, waitTicks: 1 },
      { kind: "click", at: { entity: "" } },
      { kind: "click", at: { x: 0, y: 0 }, press: "KeyW" },
      { kind: "wait", pitch: 0.2, waitTicks: 1 },
      { kind: "wait", target: { x: 1, z: 2 }, waitTicks: 1 },
      {},
      { kind: "aimAt", waitTicks: 1 },
      { kind: "aimAt", pitch: Number.NaN, target: { x: 1, z: 2 }, waitTicks: 1 },
      { holdFrames: 0, press: "KeyW" },
      { press: "KeyW", waitFrames: 0 },
      { holdTicks: 0, press: "KeyW" },
      { press: "KeyW", waitTicks: 0 },
      { holdFrames: 1, holdTicks: 1, press: "KeyW" },
      { holdTicks: 1, press: "KeyW", waitFrames: 1 },
    ];
    for (const [index, step] of invalidSteps.entries()) {
      expect(() => validateStep(step, "invalid.json", index)).toThrow();
    }
    expect(() => validateStepLabels([{ label: " ", release: true, waitTicks: 1 }] as never, undefined, "invalid.json")).toThrow(/non-empty/u);
  });

  it("rejects malformed runtime, reachability, and assertion cardinality values", () => {
    expect(() => validateWorldAssertion({ runtime: { agent: "a", core: "c", portable: "yes", randomState: 1, rapier: null, step: 1 }, seed: 1 }, "invalid.json")).toThrow(/portable/u);
    expect(() => validateWorldAssertion({ runtime: { agent: "a", core: "c", randomState: 1.5, rapier: null, step: 1 }, seed: 1 }, "invalid.json")).toThrow(/randomState/u);
    expect(() => validateWorldAssertion({ runtime: { agent: "a", core: "c", randomState: 1, rapier: 4, step: 1 }, seed: 1 }, "invalid.json")).toThrow(/rapier/u);
    expect(() => validateWorldAssertion({ runtime: { agent: "a", core: "c", randomState: 1, rapier: null, step: 0 }, seed: 1 }, "invalid.json")).toThrow(/positive/u);
    expect(() => validateWorldAssertion({ runtime: { agent: "a", core: "c", randomState: 1, rapier: null }, seed: 1 }, "invalid.json")).toThrow(/positive/u);
    expect(() => validateReachabilityAssertion({ artifact: "", entities: ["a", "b"] }, "invalid.json")).toThrow(/artifact/u);
    expect(() => validateReachabilityAssertion({ artifact: "reach.json", entities: ["a", ""] }, "invalid.json")).toThrow(/entities/u);
    expect(() => validateReachabilityAssertion({ artifact: "reach.json", entities: ["a", "a"] }, "invalid.json")).toThrow(/repeat/u);
    expect(() => validateAimTarget(null, "invalid.json", 0)).toThrow(/object/u);
    expect(() => validateAimTarget({ entity: "player", x: 1, z: 2 }, "invalid.json", 0)).toThrow(/both forms/u);
    expect(() => validatePointer(null, "invalid.json", 0, 0)).toThrow(/object/u);
    expect(() => validateAssertions({ signals: {} }, "invalid.json")).toThrow(/signals.*array/u);
    expect(() => validateAssertions({ aerodynamics: [{ entity: "plane", torques: [{ axis: "q", label: "turn", sign: "positive" }] }] }, "invalid.json")).toThrow(/axis/u);
    expect(() => validateAssertions({ aerodynamics: [{ entity: "plane", torques: [{ axis: "y", label: "turn", sign: "sideways" }] }] }, "invalid.json")).toThrow(/negative.*positive/u);
    expect(validateAssertions({ components: [{ atSteps: [{ label: "start" }], component: "Transform", entity: "player" }], overlayNodes: [{ overlayId: "hud", selector: "#score" }] }, "valid.json")).toMatchObject({ components: [{ atSteps: [{ label: "start" }] }], overlayNodes: [{ overlayId: "hud" }] });
  });

  it("keeps typed accessor boundaries fail-closed", () => {
    expect(isSafeProjectRelativePng("art/base.PNG")).toBe(true);
    expect(isSafeProjectRelativePng("../base.png")).toBe(false);
    expect(() => requireArray({ values: "not-an-array" }, "values", "invalid.json", "object")).toThrow(/array/u);
    expect(() => optionalBoolean({ enabled: "yes" }, "enabled", "invalid.json", "object")).toThrow(/boolean/u);
    expect(() => optionalPositiveInteger({ count: 0 }, "count", "invalid.json", "object")).toThrow(/positive integer/u);
    expect(optionalPositiveInteger({}, "count", "valid.json", "object")).toBeUndefined();
    expect(() => optionalTrivialityReason({ reason: false }, "reason", "invalid.json", "object")).toThrow(/non-whitespace/u);
    expect(() => optionalTargetArray({ targets: "desktop" }, "targets", "invalid.json", "object")).toThrow(/array of targets/u);

    expect(() => validateVisualAssertion({ region: { height: "large", width: 1, x: 0, y: 0 } }, "invalid.json", "assert.visual[0]")).toThrow(/height/u);
    expect(() => validateVisualAssertion({ region: { height: 1, maxDarkPixelRatio: "dark", width: 1, x: 0, y: 0 } }, "invalid.json", "assert.visual[0]")).toThrow(/maxDarkPixelRatio/u);
    expect(() => validateVisualAssertion({ region: { height: 1, maxDarkPixelRatio: 2, width: 1, x: 0, y: 0 } }, "invalid.json", "assert.visual[0]")).toThrow(/between 0 and 1/u);
    expect(() => validateVisualAssertion({ entityVisible: { entity: "player", minProjectedPixels: "many" } }, "invalid.json", "assert.visual[0]")).toThrow(/minProjectedPixels/u);
    expect(() => validateVisualAssertion({ frameDiff: { baselineImage: "/base.png" } }, "invalid.json", "assert.visual[0]")).toThrow(/baselineImage/u);
    expect(() => validateRenderChainAssertion({ tier: "ultra" }, "invalid.json", "assert.renderChain")).toThrow(/tier/u);
    expect(() => validateRenderChainAssertion({ velocity: { maxRejectionFraction: 2 } }, "invalid.json", "assert.renderChain")).toThrow(/between 0 and 1/u);
    expect(() => validateRenderChainAssertion({}, "invalid.json", "assert.renderChain")).toThrow(/tier, stages, contributions, or velocity/u);
    expect(() => validateResourcePathAssertion({ anyOf: "not-an-array", id: "state" }, "invalid.json", "assert.resources[0]")).toThrow(/array/u);
    expect(validateResourcePathAssertion({ atSteps: [{ equals: 1, label: "start" }], id: "state" }, "valid.json", "assert.resources[0]")).toMatchObject({ atSteps: [{ equals: 1, label: "start" }] });
    expect(() => validateViewport({ width: 1 }, "invalid.json")).toThrow(/height/u);
    expect(() => validateOptionalNumberTuple({ position: [1, 2] }, "position", 3, "invalid.json", 0)).toThrow(/tuple/u);
    expect(validateNumberTuple([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(validateNumberTuple("not-a-tuple", 3)).toBeUndefined();
    expect(() => validateAssertions({ aerodynamics: [{ controls: [null], entity: "plane" }] }, "invalid.json")).toThrow(/object/u);
  });
});
