// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun. The sky in `sky.ts` is the fill light — its environment reaches every face the sun
// misses — so there is no hemisphere or ambient light stacked on top to flatten the frame.
import { Color, DirectionalLight, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import { ARENA, GROUND_Y } from "./arena.js";
import {
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  sunLight,
  sunLightTransmittance,
  temperatureColour,
} from "./atmosphere.js";
import { SKY_OPTIONS, SUN_DIRECTION } from "./sky.js";

/** The sun as Unreal's default level has it: 6 lux at 6500 K, tinted by the air it crosses. */
function atmosphereSun(): DirectionalLight {
  const tint = temperatureColour(SUN_KELVIN);
  const through = sunLightTransmittance(Math.asin(Math.min(1, Math.max(-1, SUN_DIRECTION.y))));
  const colour = new Color().setRGB(
    tint[0] * through[0],
    tint[1] * through[1],
    tint[2] * through[2],
  );
  const key = new DirectionalLight(colour, SUN_ILLUMINANCE);
  // `gpuSky.ts` re-tints it when the sun moves.
  sunLight.current = key;
  return key;
}

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  mobile = false,
): { key: DirectionalLight } {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // The photo sky keeps the warm white matched by eye to its photographed midday sun.
  const key = SKY_OPTIONS.sky === "photo" ? new DirectionalLight(0xfff1e0, 4.5) : atmosphereSun();
  key.position.copy(SUN_DIRECTION).multiplyScalar(30);
  key.castShadow = true;
  // One map fitted to the 28 m arena: 4096² is under a centimetre a texel, so every shadow has the
  // same softness. Camera-centred cascades (`VirtualShadowNode`) are for open worlds; here their
  // level boundaries showed as shadows that turned sharp halfway along. Phones take 2048².
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 80;
  // Cover the arena's diagonal in light space, so a wall shadow cannot stop at the map edge.
  const extent = Math.hypot(
    ARENA.halfX + ARENA.thickness / 2,
    ARENA.halfZ + ARENA.thickness / 2,
    Math.max(Math.abs(GROUND_Y), Math.abs(ARENA.wallTop)),
  );
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  // Small biases: a large normal bias is what lifted the mannequin's shadow off its own feet.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.005;
  scene.add(key);
  // The key light is returned because `WorldEnvironment`'s godrays stage raymarches against its
  // shadow map, so `setupPost` needs the light itself.
  return { key };
}

/** Material conventions are game-owned; each scene gets independent mutable controls. */
export interface ILightingConvention {
  rimGain: number;
  fillGain: number;
  fillColor: Color;
  fillDirection: Vector3;
  fillAngularSize: number;
  darkThreshold: number;
  maxSourceTexels: number;
}
export function createLightingConvention(
  overrides: Partial<ILightingConvention> = {},
): ILightingConvention {
  return {
    rimGain: 0.12,
    fillGain: 1,
    fillColor: new Color(0x667b9d),
    fillDirection: new Vector3(0, 1, 1).normalize(),
    fillAngularSize: 0.7,
    darkThreshold: 0.001,
    maxSourceTexels: 65536,
    ...overrides,
  };
}
