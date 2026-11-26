// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun. The sky in `sky.ts` is the fill light — its environment reaches every face the
// sun misses — so there is no hemisphere or ambient light stacked on top to flatten the frame.
// The lamp point lights in `mansion.ts` are the only other sources, and they carry no shadows.
import { Color, DirectionalLight, Object3D, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import {
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  sunLight,
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
  const key = new DirectionalLight(colour, SUN_ILLUMINANCE);
  // `gpuSky.ts` re-tints it when the sun moves.
  sunLight.current = key;
  return key;
}

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

/** Half the shadow camera's box, in metres. The wing spans 27 x 20 around its centre. */
const EXTENT = 18;
/** The middle of the wing's plan, where the sun aims. */
const CENTRE = { x: 5.5, z: -1 } as const;

export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  mobile = false,
): { key: DirectionalLight } {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const key = atmosphereSun();
  key.name = "key-light";
  key.position.copy(SUN_DIRECTION).multiplyScalar(40);
  // A directional light aims at its target; the default target is the world origin, which would
  // push the study out of the shadow map.
  const target = new Object3D();
  target.name = "key-light-target";
  target.position.set(CENTRE.x, 0, CENTRE.z);
  scene.add(target, key);
  key.target = target;
  key.castShadow = true;
  // One map fitted to the wing: 4096² over 36 m is under a centimetre a texel, so every shadow
  // has the same softness. Camera-centred cascades (`VirtualShadowNode`) are for open worlds; here
  // their level boundaries showed as shadows that turned sharp halfway along. Phones take 2048².
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 90;
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
