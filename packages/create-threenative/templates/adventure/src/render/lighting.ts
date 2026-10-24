// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun, and the sky in `sky.ts` is the fill: no hemisphere or ambient light stacked on top to
// flatten the shadow side. The dungeon is lit by its own torches (`torch` below), placed by
// `level/Hollow.ts`; the sun's shadow map follows Wren, so it covers the room she is in.
import {
  type ColorRepresentation,
  DirectionalLight,
  PCFShadowMap,
  PointLight,
  type Scene,
  type Vector3,
} from "three";
import { SUN_DIRECTION, setMist } from "./sky.js";

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export interface ILighting {
  readonly key: DirectionalLight;
  /** Keeps the shadow map centred on Wren. Call after physics has moved her. */
  follow(target: Vector3): void;
  /**
   * Under the Hollow's roof the sky barely reaches: the sky light drops to a tenth and the torches
   * carry the room, and the forest mist thins so the far wall and the Warden stay clear. Auto
   * exposure (core's default) then meters the darker room on its own.
   */
  setIndoors(indoors: boolean): void;
}

export function setupLighting(scene: Scene, renderer: ShadowRenderer, mobile = false): ILighting {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // Warm late-morning sun. It shines through the canopy's gaps: those are the shafts the render
  // chain's god rays draw from this light's shadow map.
  const key = new DirectionalLight(0xffd9a0, 4);
  key.castShadow = true;
  // The camera sees about 30 m around Wren, so the map covers that window and travels with her:
  // 4096² over 36 m is under a centimetre a texel. Phones take 2048² over a smaller window.
  const size = mobile ? 2048 : 4096;
  const extent = mobile ? 12 : 18;
  key.shadow.mapSize.set(size, size);
  // A soft edge: the canopy's dapple is light through leaves ten metres up, never a sharp cut-out.
  // PCF reads `radius` in texels (12 is about 10 cm here); temporal AA smooths its five samples.
  key.shadow.radius = 12;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 90;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  // Small biases: a large normal bias lifts a shadow off the feet that cast it.
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const offset = SUN_DIRECTION.clone().multiplyScalar(40);
  return {
    follow(target: Vector3): void {
      key.position.copy(target).add(offset);
      key.target.position.copy(target);
      key.target.updateMatrixWorld();
    },
    key,
    setIndoors(indoors: boolean): void {
      scene.environmentIntensity = indoors ? 0.1 : 1;
      setMist(scene, indoors);
    },
  };
}

/** A wall torch: warm, short-range, no shadow map (eight of them would be eight more passes). */
export function torch(color: ColorRepresentation = 0xffa65a, intensity = 14): PointLight {
  return new PointLight(color, intensity, 11, 2);
}
