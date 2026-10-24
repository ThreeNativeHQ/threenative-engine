// Harness overlay only; shipped template render source remains unchanged.
// Behaviour/units reference: Unreal 5.8.3 Engine/Source/Runtime/Engine/Private/Components/
// SkyAtmosphereComponent.cpp and SkyLightComponent.cpp; values: tools/unreal-reference/template-actors.json.
import { Atmosphere, SkyCapture } from "@threenative/core";
import { type DirectionalLight, FogExp2, type Scene, type Texture, Vector3 } from "three";
import { positionWorldDirection } from "three/tsl";
import type { Node, WebGPURenderer } from "three/webgpu";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

export const SUN_DIRECTION = new Vector3(0.555, 0.742, 0.38).normalize();
const cleanups = new WeakMap<Scene, () => void>();

/** The look this fog replaced: FogExp2 at 0.003, which read as 18% haze at 150 m from 2 m up. */
const EYE_LEVEL = { density: 0.003, distance: 150, cameraHeight: 2 };

/**
 * The distance term's density that, with the height term, keeps the old eye-level haze: at
 * `EYE_LEVEL.distance` along the horizon from `EYE_LEVEL.cameraHeight` the two together transmit what
 * FogExp2 at `EYE_LEVEL.density` did. The distance term is lowered, never removed, so the ground
 * still ends in fog at a kilometre.
 */
function distanceDensity(p: HeightFogParams = HEIGHT_FOG): number {
  const { distance, density, cameraHeight } = EYE_LEVEL;
  const old = (density * distance) ** 2;
  const height = heightFogDepth(p, cameraHeight, cameraHeight, distance) * Math.LN2;
  return Math.sqrt(Math.max(0, old - height)) / distance;
}

export function setupSky(scene: Scene, sky: Texture, software = false): void {
  cleanups.get(scene)?.();
  const atmosphere = new Atmosphere({
    rayleigh: [
      0.17528699338436127 * 0.03310000151395798,
      0.4096072316169739 * 0.03310000151395798,
      0.03310000151395798,
    ],
    // shortcut: Atmosphere exposes only Mie extinction, separate scattering/absorption when its API supports them.
    mie: [0.003996 + 0.000444, 0.003996 + 0.000444, 0.003996 + 0.000444],
    ozone: [
      0.001881 * 0.34556084871292114,
      0.001881 * 0.9999999403953552,
      0.001881 * 0.045188724994659424,
    ],
    planetRadius: 6360,
    atmosphereRadius: 6360 + 60,
  });
  atmosphere.setSunDirection(SUN_DIRECTION);
  const radiance = atmosphere.radiance(positionWorldDirection) as Node<"vec3">;
  scene.background = null;
  scene.backgroundNode = radiance;
  scene.backgroundIntensity = 1;
  scene.environment = null;
  scene.environmentIntensity = 1;
  let capture: SkyCapture | undefined;
  let attached = false;
  const previous = scene.onBeforeRender;
  const before: typeof scene.onBeforeRender = (...args) => {
    previous.apply(scene, args);
    const renderer = args[0] as unknown as WebGPURenderer;
    atmosphere.setSunDirection(SUN_DIRECTION);
    // The harness owns this object rather than adding it to the framework compute registry.
    if (!attached) {
      atmosphere.attachRenderer(renderer as unknown as Parameters<Atmosphere["attachRenderer"]>[0]);
      attached = true;
    }
    atmosphere.process();
    const light = scene.getObjectByProperty("isDirectionalLight", true) as
      | DirectionalLight
      | undefined;
    if (light !== undefined) {
      const transmission = atmosphere.sunTransmittance(SUN_DIRECTION) as Vector3;
      light.color.setRGB(transmission.x, transmission.y, transmission.z);
    }
    if (!software) {
      // The reference level disables the constructor's black lower hemisphere override.
      capture ??= new SkyCapture(renderer, radiance, { lowerHemisphereBlack: false });
      if (capture.update(SUN_DIRECTION)) scene.environment = capture.texture ?? null;
    }
  };
  scene.onBeforeRender = before;
  const cleanup = (): void => {
    if (scene.onBeforeRender === before) scene.onBeforeRender = previous;
    if (scene.backgroundNode === radiance) scene.backgroundNode = null;
    if (capture !== undefined && scene.environment === capture.texture) scene.environment = null;
    capture?.dispose();
    atmosphere.detach();
    sky.removeEventListener("dispose", cleanup);
    cleanups.delete(scene);
  };
  cleanups.set(scene, cleanup);
  sky.addEventListener("dispose", cleanup);
  const params: HeightFogParams = { ...HEIGHT_FOG };
  const distanceFog = new FogExp2(palette.skyLow, distanceDensity(params));
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, params, SUN_DIRECTION);
}
