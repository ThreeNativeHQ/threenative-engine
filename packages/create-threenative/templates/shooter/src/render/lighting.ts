// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun. The sky image in `sky.ts` is the fill light — its environment reaches every face the
// sun misses — so there is no hemisphere or ambient light stacked on top to flatten the frame.
import { Color, DirectionalLight, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import { SUN_DIRECTION } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

/**
 * The sun for this town, and the shadow map fitted to it.
 *
 * ## Why `halfExtent` is a parameter and not a constant
 *
 * A shadow map is an orthographic camera, and geometry outside it does not get a softer shadow —
 * it gets the *edge texel* of the map, clamped, and a whole block of the town reads as solid
 * shade. That is the largest single thing between this game reading as daylight and reading as
 * dark: the map was fitted to an 18 m half-extent inherited from the 36 m arena `minimal` opens
 * with, over a town that is 84 m across, so two thirds of it sat outside the frustum and was lit
 * by nothing but the sky. `Play.enter` passes the town's own `TOWN_HALF`, so the number that
 * sizes the shadow lives beside the number that sizes the world.
 *
 * At 4096² over 84 m a texel is about two centimetres, which still resolves a boot on the ground.
 */
export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  halfExtent: number,
  mobile = false,
): { key: DirectionalLight } {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // Warm white, matched by eye to the photographed midday sun against its own sky.
  const key = new DirectionalLight(0xfff1e0, 4.5);
  // The light sits outside the map's own box, so its near plane is not inside the town.
  key.position.copy(SUN_DIRECTION).multiplyScalar(halfExtent * 2);
  key.castShadow = true;
  // One map fitted to the world. Camera-centred cascades (`VirtualShadowNode`) are for open
  // worlds; here their level boundaries showed as shadows that turned sharp halfway along.
  // Phones take 2048², which is 8 cm a texel over this town and still reads as a soft edge.
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  // Deep enough to reach the far corner *along the light's own axis*, not just across the ground
  // plane, or the tallest thing in town casts from a depth the map has never recorded.
  key.shadow.camera.far = halfExtent * 4;
  key.shadow.camera.left = -halfExtent;
  key.shadow.camera.right = halfExtent;
  key.shadow.camera.top = halfExtent;
  key.shadow.camera.bottom = -halfExtent;
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
