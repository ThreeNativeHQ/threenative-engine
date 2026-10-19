// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Three lights, each with one job: a warm low sun that carves every facet and throws the shadows, a
// cool sky-to-moss hemisphere that keeps the shaded sides from going black, and a faint cold rim from
// behind that separates the towers from the slab. The photographed sky in `sky.ts` is the fourth
// source: it is what metal reflects.
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PCFSoftShadowMap,
  type Scene,
  Vector3,
} from "three";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  mobile = false,
): { key: DirectionalLight } {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  scene.add(new HemisphereLight(0xd5e8db, 0x3a4435, 1.5));
  const key = new DirectionalLight(0xffe3b1, 3.4);
  key.position.set(-18, 30, 17);
  key.castShadow = true;
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 90;
  const extent = 26;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.03;
  scene.add(key);
  const rim = new DirectionalLight(0xa6d6c4, 0.9);
  rim.position.set(15, 12, -18);
  scene.add(rim);
  // The key light is returned because `WorldEnvironment`'s godrays stage raymarches against its
  // shadow map, so `setupPost` needs the light itself.
  return { key };
}

/** Existing authored rim/fill is preserved; opt in to extra terms with the named gains. */
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
    rimGain: 0,
    fillGain: 0,
    fillColor: new Color(0x667b9d),
    fillDirection: new Vector3(0, 1, 1).normalize(),
    fillAngularSize: 0.7,
    darkThreshold: 0.001,
    maxSourceTexels: 65536,
    ...overrides,
  };
}
