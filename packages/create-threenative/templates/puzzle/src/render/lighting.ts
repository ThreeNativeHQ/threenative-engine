// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// A dark room with two warm lamps in it (authored with the props themselves, in `vault.ts`). The
// whole read of this picture is that the *ambient* is almost nothing and every bright surface is
// bright because a named source is pointing at it, so the temptation to raise the fill until the
// crates are comfortably visible has to be resisted: the moment the floor stops being near-black
// the picture stops being a vault.
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PCFSoftShadowMap,
  type Scene,
  Vector3,
} from "three";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

/** Returns the key light: the godrays stage raymarches a shadow map and refuses a shadowless one. */
export function setupLighting(
  scene: Scene,
  renderer: ShadowRenderer,
  mobile = false,
): DirectionalLight {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // Sky above, floor bounce below, both cold and both very quiet.
  scene.add(new HemisphereLight(0x33456a, 0x171d29, 0.6));

  // The key. Warm, high, and from the lantern side, so crate tops catch a little of the same
  // colour the plaster does and the shadows all fall the same way.
  const key = new DirectionalLight(0xf4e8da, 0.8);
  key.position.set(-7, 15, 5);
  key.castShadow = true;
  const size = mobile ? 1024 : 2048;
  key.shadow.mapSize.set(size, size);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 46;
  // The extent covers the whole room and nothing else: the vault is 16 x 11 metres and a shadow
  // camera any wider spends its texels outside the walls.
  const extent = 10;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.bias = -0.0006;
  // Rounded geometry self-shadows at grazing angles without this, and the bias alone would have
  // to grow big enough to detach the contact shadow under every crate.
  key.shadow.normalBias = 0.035;
  scene.add(key);

  // The rim: cold, low and shadowless, from the far corner the lanterns never reach. A crate's
  // shadowed side is otherwise the same black as the floor it stands on, and the pile stops
  // reading as forty separate boxes.
  const rim = new DirectionalLight(0x5f7fb0, 0.24);
  rim.position.set(9, 5, -7);
  scene.add(rim);

  return key;
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
