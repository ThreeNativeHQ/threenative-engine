// Generated for you. This is ordinary Three.js; tune the storm's light here.
//
// The coast is ray-marched, so nothing here is added to the scene: these are Three's own light
// objects used as the place the storm's lighting is decided, and `setupLighting` hands their
// direction and colour × intensity to the two shaders. No shadow map is involved — the march
// computes its own occlusion — so there is nothing to tune for one.
import { Color, DirectionalLight, HemisphereLight, LinearSRGBColorSpace } from "three";
import * as clouds from "./clouds-shader.js";
import * as world from "./world-shader.js";

/** The study's colours are linear RGB; these keep them exact instead of converting from sRGB. */
const linear = (r: number, g: number, b: number): Color =>
  new Color().setRGB(r, g, b, LinearSRGBColorSpace);

export interface IStormLighting {
  /** The low storm sun behind the deck: its direction lights the clouds and the coast. */
  readonly key: DirectionalLight;
  /** The lightning's own light. Its intensity is scaled by the flash every frame in the shader. */
  readonly rim: DirectionalLight;
  /** The overcast sky light; the shader weights it `0.45 + 0.55 · n.y`, like a hemisphere. */
  readonly fill: HemisphereLight;
}

export function setupLighting(): IStormLighting {
  const key = new DirectionalLight(linear(0.56, 0.61, 0.67), 0.35);
  key.position.set(-0.62, 0.34, -0.71).normalize();
  const rim = new DirectionalLight(linear(0.8 / 1.4, 1.04 / 1.4, 1), 1.4);
  const fill = new HemisphereLight(linear(0.64, 0.86, 1.03), linear(0.29, 0.39, 0.46), 0.65);

  world.uSunDir.value.copy(key.position);
  clouds.uSunDir.value.copy(key.position);
  const sun = key.color.clone().multiplyScalar(key.intensity);
  world.uSunColor.value.set(sun.r, sun.g, sun.b);
  const flash = rim.color.clone().multiplyScalar(rim.intensity);
  world.uFlashLight.value.set(flash.r, flash.g, flash.b);
  const sky = fill.color.clone().multiplyScalar(fill.intensity);
  world.uFill.value.set(sky.r, sky.g, sky.b);
  return { fill, key, rim };
}
