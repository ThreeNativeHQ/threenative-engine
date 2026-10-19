// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun. The sky image in `sky.ts` is the fill light — its environment reaches every face the
// sun misses — so there is no hemisphere or ambient light stacked on top to flatten the frame.
import { Color, DirectionalLight, Object3D, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import { SUN_DIRECTION } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

/** The shadow map is a window that follows the camera, not the whole 224 m map. 64 m across on a
 * 4096 map is 3 cm a texel, so a `tank`'s tracks and a worker's shadow are the same softness. */
const EXTENT = 32;
const SUN_DISTANCE = 120;

export interface ISun {
  readonly key: DirectionalLight;
  /** Keep the shadow window over the point the camera is looking at. */
  readonly follow: (x: number, z: number) => void;
}

export function setupLighting(scene: Scene, renderer: ShadowRenderer, mobile = false): ISun {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // Warm white, matched by eye to the photographed midday sun against its own sky.
  const key = new DirectionalLight(0xfff1e0, 4.5);
  key.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE);
  key.castShadow = true;
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = SUN_DISTANCE * 2.5;
  key.shadow.camera.left = -EXTENT;
  key.shadow.camera.right = EXTENT;
  key.shadow.camera.top = EXTENT;
  key.shadow.camera.bottom = -EXTENT;
  // Small biases: a large normal bias is what lifts a model's shadow off its own feet.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  // The light's target is the origin by default, so a directional light that never moves casts one
  // fixed set of shadows across the whole map. It is added to the scene because three only updates
  // a light target that is in the graph.
  const target = new Object3D();
  scene.add(target);
  key.target = target;
  return {
    key,
    follow: (x, z) => {
      target.position.set(x, 0, z);
      target.updateMatrixWorld();
      key.position.set(
        x + SUN_DIRECTION.x * SUN_DISTANCE,
        SUN_DIRECTION.y * SUN_DISTANCE,
        z + SUN_DIRECTION.z * SUN_DISTANCE,
      );
    },
  };
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
