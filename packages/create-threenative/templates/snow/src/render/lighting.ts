// Generated for you. This is ordinary Three.js; tune the sun and fill for your snow.
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PCFSoftShadowMap,
  type Scene,
  Vector3,
} from "three";
import { palette } from "./palette.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export interface ISnowLights {
  /** Follow `target` with the shadow frustum and dim everything for a storm. */
  update(target: { readonly x: number; readonly z: number }, storm: number): void;
  readonly sun: DirectionalLight;
}

export function setupLighting(scene: Scene, renderer: ShadowRenderer): ISnowLights {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  // Bright sky above, a cool grey bounce from the snow below.
  const sky = new HemisphereLight(0xdbeeff, 0x7d8e9c, 2.2);
  scene.add(sky);

  // A low warm sun, so footprints throw shadows into their own floors.
  const sun = new DirectionalLight(0xffead1, 3.3);
  sun.position.set(-22, 30, -20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -19;
  sun.shadow.camera.right = 19;
  sun.shadow.camera.top = 19;
  sun.shadow.camera.bottom = -19;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 100;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.028;
  scene.add(sun, sun.target);

  // A cool fill from the camera side keeps the shadowed faces of the forest from going black.
  const fill = new DirectionalLight(palette.skyLow, 0.45);
  fill.position.set(8, 6, 15);
  scene.add(fill);

  return {
    sun,
    update(target, storm) {
      sun.position.set(target.x - 22, 30, target.z - 20);
      sun.target.position.set(target.x, 0, target.z);
      sun.target.updateMatrixWorld();
      sun.intensity = 3.3 - storm * 2.9;
      sky.intensity = 2.2 - storm * 0.55;
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
    fillGain: 0, // Existing hemisphere and camera fill own the storm response.
    fillColor: new Color(0x667b9d),
    fillDirection: new Vector3(0, 1, 1).normalize(),
    fillAngularSize: 0.7,
    darkThreshold: 0.001,
    maxSourceTexels: 65536,
    ...overrides,
  };
}
