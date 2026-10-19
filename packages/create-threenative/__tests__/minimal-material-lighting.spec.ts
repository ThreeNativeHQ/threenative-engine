import {
  BoxGeometry,
  Camera,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  Scene,
} from "three";
import { afterEach, expect, test, vi } from "vitest";
import {
  createLightingConvention,
  setupLighting,
} from "../templates/minimal/src/render/lighting.js";
import { createMaterialLighting } from "../templates/minimal/src/render/materialLighting.js";
import { materialLightingEnabled, qualityPreset } from "../templates/minimal/src/render/quality.js";
const apply = vi.hoisted(() => vi.fn());
vi.mock("../templates/minimal/src/render/worldEnvironment.js", () => ({
  WorldEnvironment: class {
    apply = apply;
  },
}));
import { setupPost } from "../templates/minimal/src/render/postprocessing.js";
afterEach(() => vi.restoreAllMocks());
test("minimal preserves its authored sun and independent convention overrides", () => {
  const scene = new Scene();
  const { key } = setupLighting(scene, { shadowMap: { enabled: false, type: 0 } });
  expect(key.intensity).toBe(4.5);
  expect(key.color.equals(new Color(0xfff1e0))).toBe(true);
  const convention = createLightingConvention({ rimGain: 0 });
  expect(convention.rimGain).toBe(0);
  expect(createLightingConvention().rimGain).toBe(0.12);
  expect(qualityPreset("high").ssgiEnabled).not.toBe(true);
});
test("minimal converts attached materials only on admitted desktop and restores borrowed sources", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const scene = new Scene();
  const source = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(), source);
  scene.add(mesh);
  const environment = { web: true, rendererKind: "webgpu" };
  const controller = createMaterialLighting(scene, new Camera(), new DirectionalLight(), {
    ...environment,
    enabled: materialLightingEnabled("high", environment),
  });
  expect(mesh.material).not.toBe(source);
  controller.setEnabled(false);
  expect(mesh.material).toBe(source);
  controller.dispose();
  expect(materialLightingEnabled("high", { ...environment, web: false })).toBe(false);
});
test("minimal post owns its graph and invokes the tier callback after apply", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const events: string[] = [];
  const dispose = vi.fn();
  apply.mockImplementation(() => {
    events.push("apply");
    return { dispose };
  });
  const post = setupPost({} as never, new Scene(), new Camera(), {
    tier: "low",
    onTierChanged: () => events.push("tier"),
  });
  expect(events).toEqual(["apply", "tier"]);
  expect(post.tier).toBe("low");
  post.dispose();
  post.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});
