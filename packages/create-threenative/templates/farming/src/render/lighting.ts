// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun. The sky in `sky.ts` is the fill light — its environment reaches every face the
// sun misses — so there is no hemisphere or ambient light stacked on top to flatten the frame.
import { Color, DirectionalLight, Object3D, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import {
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  sunLightTransmittance,
  temperatureColour,
} from "./atmosphere.js";
import { SUN_DIRECTION } from "./sky.js";

/** The sun as Unreal's default level has it: 6 lux at 6500 K, tinted by the air it crosses. */
function atmosphereSun(): DirectionalLight {
  const tint = temperatureColour(SUN_KELVIN);
  const through = sunLightTransmittance(Math.asin(Math.min(1, Math.max(-1, SUN_DIRECTION.y))));
  const colour = new Color().setRGB(
    tint[0] * through[0],
    tint[1] * through[1],
    tint[2] * through[2],
  );
  // `daylight.ts` colours and aims it every frame, so `sunLight.current` stays unset: the sky must
  // not re-tint it on its own schedule.
  return new DirectionalLight(colour, SUN_ILLUMINANCE);
}

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

/** Half the shadow camera's box, in metres. The farm is 44 x 35, so 26 around its middle covers it. */
const EXTENT = 26;
/**
 * How far the key light sits from the farm's middle, metres. A morning sun is 7 degrees up: the box
 * must start well before the farthest tile on the sun's side, or its shadows clip.
 */
export const LIGHT_DISTANCE = 100;

export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  mobile = false,
): { key: DirectionalLight } {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const key = atmosphereSun();
  key.name = "key-light";
  key.position.copy(SUN_DIRECTION).multiplyScalar(LIGHT_DISTANCE);
  // A directional light aims at its target: `daylight.ts` keeps it on the middle of the farm.
  const target = new Object3D();
  target.name = "key-light-target";
  target.position.set(0, 0, 0);
  scene.add(target, key);
  key.target = target;
  key.castShadow = true;
  // One map fitted to the farm: 4096² over 52 m is under a centimetre a texel, so every shadow
  // has the same softness. Camera-centred cascades (`VirtualShadowNode`) are for open worlds; here
  // their level boundaries showed as shadows that turned sharp halfway along. Phones take 2048².
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = LIGHT_DISTANCE * 2.2;
  key.shadow.camera.left = -EXTENT;
  key.shadow.camera.right = EXTENT;
  key.shadow.camera.top = EXTENT;
  key.shadow.camera.bottom = -EXTENT;
  // Small biases: a large normal bias is what lifted the mannequin's shadow off its own feet.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.005;
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
