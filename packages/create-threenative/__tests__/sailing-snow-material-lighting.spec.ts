import { Color, Scene } from "three";
import { expect, test, vi } from "vitest";
import {
  createLightingConvention as sailingConvention,
  setupLighting as sailingLights,
} from "../templates/sailing/src/render/lighting.js";
import { palette } from "../templates/sailing/src/render/palette.js";
import {
  createLightingConvention as snowConvention,
  setupLighting as snowLights,
} from "../templates/snow/src/render/lighting.js";
import { materialLightingEnabled } from "../templates/snow/src/render/quality.js";
test("sailing preserves authored sun palette while exposing independent material controls", () => {
  const scene = new Scene();
  const key = sailingLights(scene, { shadowMap: { enabled: false, type: 0 } });
  expect(key.intensity).toBe(3.4);
  expect(key.color.equals(new Color(palette.player))).toBe(true);
  expect(sailingConvention().rimGain).toBe(0.12);
});
test("snow preserves storm lights and defaults analytic fill to zero", () => {
  const scene = new Scene();
  const lights = snowLights(scene, { shadowMap: { enabled: false, type: 0 } });
  expect(scene.children).toHaveLength(4);
  lights.update({ x: 0, z: 0 }, 1);
  expect(lights.sun.intensity).toBeCloseTo(0.4);
  expect(snowConvention().fillGain).toBe(0);
  expect(snowConvention().rimGain).toBe(0.12);
  expect(materialLightingEnabled("high", { web: false, rendererKind: "webgpu" })).toBe(false);
});

test("sailing setup samples the loaded source without disposing borrowed sky textures", async () => {
  const { Texture } = await import("three");
  const { loadSky } = await import("../templates/sailing/src/render/sky.js");
  const { prepareEnvironmentSample, loadedEnvironmentSample } = await import(
    "../templates/sailing/src/render/environmentSetup.js"
  );
  const texture = new Texture();
  const dispose = vi.spyOn(texture, "dispose");
  await loadSky({ texture: async () => texture });
  await prepareEnvironmentSample({}, { web: false, rendererKind: "webgpu" });
  const sample = loadedEnvironmentSample();
  expect(sample?.source).toBe(texture);
  expect(sample?.measurement.status).toBe("unknown");
  expect(dispose).not.toHaveBeenCalled();
});
