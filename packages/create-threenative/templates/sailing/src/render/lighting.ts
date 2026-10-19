// Generated for you. This is ordinary Three.js; tune the key for your sea.
import { Color, DirectionalLight, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import { palette } from "./palette.js";
import { SUN_DIRECTION } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

/** How far from the ship the sun is placed. Its direction is the light; its place is not. */
const SUN_DISTANCE = 30;

export function setupLighting(scene: Scene, renderer: ShadowRenderer): DirectionalLight {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // One sun, and no ambient light stacked on top of it. The photograph is the fill: it is the
  // scene's `environment`, so every face the sun misses is filled by the sky it is standing under.
  // A hemisphere light as well would light the shadow side twice and flatten the rig.
  //
  // The colour is the palette's sun, not white: a neutral key over this blue-grey sky leaves the
  // canvas and the timber the same value, and the sails stop reading as cloth.
  const key = new DirectionalLight(palette.player, 3.4);
  key.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 80;
  // Tight, because this frustum travels with the ship rather than covering the world. The passage
  // runs out past x = -34, and a box centred on the origin leaves the ship sailing out of its own
  // shadow map with every shadow in the frame switching off at once.
  const extent = 12;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  // Small: a large normal bias is what lifts a shadow off the deck it falls across.
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  // The target is added too — a directional light aims at `target`, and a target that is not in
  // the scene keeps its own transform but is never updated from the one that is.
  scene.add(key.target);
  return key;
}

/**
 * Carry the shadow frustum along with the ship.
 *
 * A directional light has no position in the physics of it — only a direction — but its shadow
 * camera does, and that camera is a box of finite size. Moving the light and its target together
 * keeps the sun's direction exactly constant while putting the box where the ship is.
 */
export function followSun(
  key: DirectionalLight,
  target: { x: number; y: number; z: number },
): void {
  key.target.position.set(target.x, 0, target.z);
  key.position.set(
    target.x + SUN_DIRECTION.x * SUN_DISTANCE,
    SUN_DIRECTION.y * SUN_DISTANCE,
    target.z + SUN_DIRECTION.z * SUN_DISTANCE,
  );
  key.target.updateMatrixWorld();
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
