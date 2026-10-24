// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun, and the sky in `sky.ts` is the fill — a fresh Unreal level's directional light and sky
// light, and nothing stacked on top. A hemisphere or ambient light next to an image-based
// environment fills the same faces twice and flattens the shadow side the sun is there to make.
// The shadow itself is the engine's `VirtualShadowNode`, attached in `scenes/Race.ts`: clip
// levels round the camera, so the kart's shadow is crisp and the far hills still have one.
import { DirectionalLight, PCFShadowMap, type Scene, type Vector3 } from "three";
import { SUN_DIRECTION } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export interface ILighting {
  readonly key: DirectionalLight;
  /** Keeps the sun's target on the player, so its direction is the same wherever the kart is. */
  follow(target: Vector3): void;
}

export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  castShadows: boolean,
): ILighting {
  // No caster draws until the renderer's own shadow map is on, the virtual shadow included.
  renderer.shadowMap.enabled = castShadows;
  // PCF with a radius: three's soft variant ignores `shadow.radius` and leaves a hard edge.
  renderer.shadowMap.type = PCFShadowMap;
  // A 5,500 K late-morning sun. The level is the meter's: auto exposure scales the frame, so this
  // number sets the sun against the sky, not how bright the picture is.
  const key = new DirectionalLight(0xffe4c4, 3.2);
  key.castShadow = castShadows;
  // Small biases: a large normal bias lifts the shadow off the tyres of whatever casts it.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  // The virtual shadow's pages carry a 2-texel border, so the PCF radius stays at 1.5 or under:
  // the owned engine refuses a wider filter (TN_VIRTUAL_SHADOW_UNSUPPORTED) and stops drawing.
  key.shadow.radius = 1;
  scene.add(key);
  scene.add(key.target);
  const offset = SUN_DIRECTION.clone().multiplyScalar(120);
  return {
    follow(target: Vector3): void {
      key.position.set(target.x + offset.x, target.y + offset.y, target.z + offset.z);
      key.target.position.copy(target);
      key.target.updateMatrixWorld();
    },
    key,
  };
}
