import { fileURLToPath } from "node:url";
import { PerspectiveCamera, Scene as ThreeScene } from "three";
import { describe, expect, it, vi } from "vitest";
import { composeScenarioSetupRequest } from "../../playtest/src/runner/setup-request.js";
import { loadPlaytestScenario } from "../../playtest/src/scenario.js";
import { installThreePlaytestBridge } from "../../playtest/src/three/bridge.js";
import { studyTier } from "../templates/rain/src/render/quality.js";
import { Coast, type WeatherCtx } from "../templates/rain/src/scenes/Boot.js";
import { intentPatch, preset } from "../templates/rain/src/state.js";

vi.mock("@threenative/core", () => ({
  Scene: class {
    load() {}
  },
  alwaysRender: vi.fn(),
  isMobile: () => false,
}));
vi.mock("../templates/rain/src/audio/storm.js", () => ({
  STORM_AUDIO_ENTITY: "audio",
  createStormAudio: vi.fn(),
}));
vi.mock("../templates/rain/src/render/camera.js", () => ({
  createCameraRig: vi.fn(),
  setupCamera: vi.fn(),
}));
vi.mock("../templates/rain/src/render/lightning.js", () => ({ createStormLightning: vi.fn() }));
vi.mock("../templates/rain/src/render/loading.js", () => ({ createLoadingScreen: vi.fn() }));
vi.mock("../templates/rain/src/render/postprocessing.js", () => ({ setupPost: vi.fn() }));
vi.mock("../templates/rain/src/render/rain.js", () => ({ createStormRain: vi.fn() }));
vi.mock("../templates/rain/src/render/world.js", () => ({ createWeatherWorld: vi.fn() }));

function load(software: string | undefined, width: number, choice?: string) {
  let state = { ...Coast.initialState };
  if (choice !== undefined)
    state = { ...state, ...intentPatch("setQuality", choice, preset("storm")) };
  const ctx = {
    renderer: { softwareAdapter: software },
    viewport: { size: { width, height: 720 } },
    state: {
      getState: () => state,
      set: (patch: object) => {
        state = { ...state, ...patch };
      },
      flush: vi.fn(),
    },
  } as unknown as WeatherCtx;
  new Coast().load(ctx);
  return { state, ctx };
}

describe("Rain study quality before scene entry", () => {
  it("can apply the tiers scenario setup through the engine's read-only state contract", async () => {
    const scenario = await loadPlaytestScenario(
      fileURLToPath(new URL("../templates/rain/", import.meta.url)),
      "playtests/tiers.playtest.json",
    );
    const installation = installThreePlaytestBridge({
      camera: new PerspectiveCamera(),
      scene: new ThreeScene(),
      renderer: { getDrawingBufferSize: (target) => target.set(1280, 720) },
      resources: { read: () => ({ state: { quality: "performance" } }) },
    });
    try {
      await expect(
        installation.bridge.applySetup?.(
          await composeScenarioSetupRequest(
            { sample: async (request) => installation.bridge.sample(request) },
            scenario,
          ),
        ),
      ).resolves.toEqual({
        entities: [],
        resources: [],
      });
    } finally {
      installation.dispose();
    }
  });
  it.each(["swiftshader", "llvmpipe"])(
    "selects performance on %s before the first storm frame",
    (adapter) => {
      expect(load(adapter, 1440).state.quality).toBe("performance");
    },
  );
  it("leaves the authored hardware window-width policy to the UI", () => {
    expect(load(undefined, 1440).state.quality).toBe("balanced");
    expect(load(undefined, 699).state.quality).toBe("balanced");
    expect(load(undefined, 700).state.softwareRendering).toBe(false);
  });
  it("feeds the existing cheap cloud and reflection policy without changing its budgets", () => {
    expect(studyTier(load("swiftshader", 1440).state.quality)).toEqual({
      cloudScale: 0.4,
      cloudSteps: 32,
      rainBudget: 6_500,
      reflections: false,
    });
    expect(studyTier(load("swiftshader", 1440, "high").state.quality)).toEqual({
      cloudScale: 0.6,
      cloudSteps: 64,
      rainBudget: 12_000,
      reflections: true,
    });
  });
  it.each(["performance", "balanced", "high", "ultra"])(
    "preserves an early explicit %s choice",
    (quality) => {
      expect(load("swiftshader", 1440, quality).state.quality).toBe(quality);
    },
  );
  it("does not revise a choice on a viewport resize", () => {
    const { state, ctx } = load(undefined, 1440);
    Object.assign(ctx.viewport.size, { width: 400 });
    expect(state.quality).toBe("balanced");
  });
});
