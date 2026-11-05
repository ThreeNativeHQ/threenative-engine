// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One sun. The sky in `sky.ts` is the fill light — its environment reaches every face the
// sun misses — so there is no hemisphere or ambient light stacked on top to flatten the frame.
// The rig is returned because `WorldEnvironment`'s godrays stage raymarches against a shadow map,
// so `setupPost` needs the key light itself; a shadowless one is refused by name.
//
// The sun's shadow box travels with the runner. The track is endless, so a box left at the start
// line covers the first stretch and nothing after it: past it the runner, the obstacles and the
// rails cast no shadow at all. `follow` aims the box at the ground the chase camera sees.
import { Color, DirectionalLight, Matrix4, PCFSoftShadowMap, type Scene, Vector3 } from "three";
import {
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  sunLight,
  sunLightTransmittance,
  temperatureColour,
} from "./atmosphere.js";
import { SKY_OPTIONS, SUN_DIRECTION } from "./sky.js";

/** The sun as Unreal's default level has it: 6 lux at 6500 K, tinted by the air it crosses. */
function atmosphereSun(): DirectionalLight {
  const tint = temperatureColour(SUN_KELVIN);
  const through = sunLightTransmittance(Math.asin(Math.min(1, Math.max(-1, SUN_DIRECTION.y))));
  const colour = new Color().setRGB(
    tint[0] * through[0],
    tint[1] * through[1],
    tint[2] * through[2],
  );
  const key = new DirectionalLight(colour, SUN_ILLUMINANCE);
  // `gpuSky.ts` re-tints it when the sun moves.
  sunLight.current = key;
  return key;
}

/** How far up its own ray the sun sits. The shadow camera's depth range starts at that distance. */
const SUN_DISTANCE = 30;
/** How far ahead of the runner the shadow box is centred: the ground the chase camera sees. */
const LEAD = 12;
const UP = new Vector3(0, 1, 0);
const ORIGIN = new Vector3();

type ShadowRenderer = { shadowMap: { enabled: boolean; type: number } };

export interface ILighting {
  readonly key: DirectionalLight;
  readonly fill: DirectionalLight;
  /**
   * Put the sun's shadow box on the runner, so the ground in frame keeps its shadows all run long.
   * The track runs down -Z, so the box leads the runner there. Call it once per rendered frame.
   */
  follow(target: Vector3): void;
}

export function setupLighting(scene: Scene, renderer: ShadowRenderer, mobile = false): ILighting {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  // Warm white, matched by eye to the photographed midday sun against its own sky. Aimed low and
  // down-track so it rakes across the obstacles and throws each one's shadow back toward the
  // The photo sky keeps the warm white matched by eye to its photographed midday sun.
  const key = SKY_OPTIONS.sky === "photo" ? new DirectionalLight(0xfff1e0, 4.5) : atmosphereSun();
  const offset = SUN_DIRECTION.clone().multiplyScalar(SUN_DISTANCE);
  key.position.copy(offset);
  key.castShadow = true;
  // One map fitted to what the chase camera can see from the runner: 4096² is about a centimetre a
  // texel, so every shadow has the same softness. Phones take 2048².
  const size = mobile ? 2048 : 4096;
  key.shadow.mapSize.set(size, size);
  key.shadow.radius = 2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 140;
  const extent = mobile ? 16 : 24;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  // Small biases: a large normal bias is what lifted the runner's shadow off its own skirt.
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.005;
  scene.add(key);
  // three reads the target's world matrix, which only a scene traversal refreshes: a target left
  // out of the graph stays at the origin however its position reads.
  scene.add(key.target);

  // The sky alone leaves every down-track face in its own shade, so the runner reads as a dark
  // silhouette against the obstacle it is about to hit — the one comparison the game asks the
  // player to make. A soft fill from ahead of the camera lifts those faces without flattening the
  // sun's own shadows.
  const fill = new DirectionalLight(0xdfe8ff, 0.9);
  fill.position.set(0, 8, 20);
  scene.add(fill);

  // A shadow map is a grid in the light's own frame. Slide the box by a fraction of a texel and every
  // sample lands between texels, so the whole map crawls with the runner. Both ends snap to whole
  // texels of that grid instead, which leaves every texel on one fixed cell of the world however the
  // runner moves. The sun never turns, so the frame is built once.
  const texel = (2 * extent) / size;
  const intoLight = new Matrix4().lookAt(offset, ORIGIN, UP).invert();
  const outOfLight = intoLight.clone().invert();
  const centre = new Vector3();

  return {
    key,
    fill,
    follow(target: Vector3): void {
      centre.set(target.x, 0, target.z - LEAD).applyMatrix4(intoLight);
      centre.x = Math.round(centre.x / texel) * texel;
      centre.y = Math.round(centre.y / texel) * texel;
      centre.applyMatrix4(outOfLight);
      key.target.position.copy(centre);
      key.target.updateMatrixWorld();
      key.position.copy(centre).add(offset);
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
