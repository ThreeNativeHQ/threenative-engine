// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun, and the sky in `sky.ts` is the fill — a fresh Unreal level's directional light and sky
// light, and nothing stacked on top. A hemisphere or ambient light next to an image-based
// environment fills the same faces twice and flattens the shadow side the sun is there to make.
import { DirectionalLight, PCFSoftShadowMap, type Scene, type Vector3 } from "three";
import { SUN_DIRECTION } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export interface ILighting {
  /** Aimed at the hero every frame, so one shadow map covers the play space around it. */
  readonly key: DirectionalLight;
  follow(target: Vector3): void;
}

export function setupLighting(scene: Scene, renderer: ShadowRenderer, mobile = false): ILighting {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  // Warm white. The level is the meter's: auto exposure scales the frame, so this number sets the
  // sun against the sky, not how bright the picture is.
  const key = new DirectionalLight(0xfff0dc, 3.2);
  key.castShadow = true;
  // The camera sees about 30 m of island around the hero; the map is fitted to that and travels.
  const size = mobile ? 2048 : 4096;
  const extent = mobile ? 16 : 26;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 140;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  // Small biases: a large normal bias lifts the shadow off the feet of whatever casts it.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);
  const offset = SUN_DIRECTION.clone().multiplyScalar(60);
  return {
    follow(target: Vector3): void {
      key.position.set(target.x + offset.x, target.y + offset.y, target.z + offset.z);
      key.target.position.copy(target);
      key.target.updateMatrixWorld();
    },
    key,
  };
}
