// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun, and the sky photograph in `sky.ts` is the fill. Nothing else is stacked on top: a
// hemisphere or ambient light next to an image-based environment fills the same faces twice and
// flattens exactly the shadow side the sun was there to make. The low-poly geometry keeps its own
// separation through `flatShading` and baked vertex mottle, which is why this level reads as
// facetted without a second light.
import { Color, DirectionalLight, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import { SUN_DIRECTION } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export interface ILighting {
  /** Aimed at the player every frame, so one map covers the route instead of 100 m of it. */
  readonly key: DirectionalLight;
  follow(player: Vector3): void;
}

export function setupLighting(scene: Scene, renderer: ShadowRenderer, mobile = false): ILighting {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // Warm white, matched by eye to the photographed midday sun against its own sky.
  const key = new DirectionalLight(0xfff1e0, 4.2);
  key.castShadow = true;
  // The camera never sees more than about 40 m of the route at once, so the map is fitted to that
  // window and travels with the player. 4096² over 40 m is under a centimetre a texel; phones
  // take 2048². Fitted to the whole 100 m route instead, every shadow would be the same size as
  // the fox's ear.
  const size = mobile ? 2048 : 4096;
  const extent = mobile ? 14 : 22;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 120;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  // Small biases: a large normal bias is what lifts a shadow off the feet of the thing casting it.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);
  const offset = SUN_DIRECTION.clone().multiplyScalar(40);
  return {
    follow(player: Vector3): void {
      key.position.set(player.x + offset.x, player.y + offset.y, player.z + offset.z);
      key.target.position.copy(player);
      key.target.updateMatrixWorld();
    },
    key,
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
