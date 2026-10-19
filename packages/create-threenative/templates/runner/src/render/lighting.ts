// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun. The sky image in `sky.ts` is the fill light — its environment reaches every face the
// sun misses — so there is no hemisphere or ambient light stacked on top to flatten the frame.
// The rig is returned because `WorldEnvironment`'s godrays stage raymarches against a shadow map,
// so `setupPost` needs the key light itself; a shadowless one is refused by name.
import { Color, DirectionalLight, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import { SUN_DIRECTION } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  mobile = false,
): { key: DirectionalLight; fill: DirectionalLight } {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // Warm white, matched by eye to the photographed midday sun against its own sky. Aimed low and
  // down-track so it rakes across the obstacles and throws each one's shadow back toward the
  // player: at speed the shadow arrives before the block does, which is the only warning in time.
  const key = new DirectionalLight(0xfff1e0, 4.5);
  key.position.copy(SUN_DIRECTION).multiplyScalar(30);
  key.castShadow = true;
  // One map fitted to what the chase camera can see from the runner: 4096² is well under a
  // centimetre a texel, so every shadow has the same softness. Phones take 2048².
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 140;
  const extent = 28;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  // Small biases: a large normal bias is what lifted the runner's shadow off its own skirt.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.005;
  scene.add(key);

  // The sky alone leaves every down-track face in its own shade, so the runner reads as a dark
  // silhouette against the obstacle it is about to hit — the one comparison the game asks the
  // player to make. A soft fill from ahead of the camera lifts those faces without flattening the
  // sun's own shadows.
  const fill = new DirectionalLight(0xdfe8ff, 0.9);
  fill.position.set(0, 8, 20);
  scene.add(fill);

  return { key, fill };
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
