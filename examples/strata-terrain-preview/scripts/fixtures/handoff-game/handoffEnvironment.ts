// This game's own binding of the exported environment settings. It is ordinary Three.js: the
// settings file says WHAT the author chose (sun angles and strength, fill, sky colour, haze,
// exposure) and this file decides HOW the game draws it. Replace it and nothing else changes.
import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  LinearToneMapping,
  NoToneMapping,
  type Object3D,
  type Scene,
} from "three";

export interface IEnvironmentSettings {
  readonly sun?: {
    readonly azimuth?: number;
    readonly elevation?: number;
    readonly intensity?: number;
    readonly colour?: string;
  };
  readonly fill?: { readonly intensity?: number };
  readonly sky?: { readonly colour?: string };
  readonly fog?: { readonly mode?: "exp2"; readonly colour?: string; readonly density?: number };
  readonly exposure?: number;
}

interface IBindingTarget {
  add(object: Object3D): unknown;
  readonly scene: Scene;
  readonly renderer: { readonly raw: unknown };
}

const SUN_DISTANCE = 300;
const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export function bindEnvironment(target: IBindingTarget, settings: IEnvironmentSettings) {
  const sun = new DirectionalLight(settings.sun?.colour ?? "#ffffff", settings.sun?.intensity ?? 2);
  const azimuth = radians(settings.sun?.azimuth ?? 0);
  const elevation = radians(settings.sun?.elevation ?? 45);
  sun.position
    .set(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.sin(azimuth),
    )
    .multiplyScalar(SUN_DISTANCE);
  const fill = new HemisphereLight(0xd6e9ef, 0x403c2e, settings.fill?.intensity ?? 1);
  target.add(sun);
  target.add(fill);
  target.scene.background = new Color(settings.sky?.colour ?? "#a6c5d3");
  if (settings.fog?.colour !== undefined && settings.fog.density !== undefined)
    target.scene.fog = new FogExp2(settings.fog.colour, settings.fog.density);
  const raw = target.renderer.raw as { toneMapping?: number; toneMappingExposure?: number };
  raw.toneMapping = settings.exposure === undefined ? NoToneMapping : LinearToneMapping;
  raw.toneMappingExposure = settings.exposure ?? 1;
  return { sun, fill, raw };
}
