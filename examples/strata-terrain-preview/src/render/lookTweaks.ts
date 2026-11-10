import { type ITweakBox, createTweakBox } from "@threenative/terrain/editor";
import { BIOMES } from "./biomes.js";
import { LOOK } from "./lookKnobs.js";
import type { IOutdoorSky } from "./sky.js";

const row = BIOMES.forest;
const [sunX, sunY, sunZ] = row.sun.direction;
const SUN_REACH = Math.hypot(sunX, sunY, sunZ);
const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);
/** A tint multiplier as a picker colour, and back: each channel is the multiplier times 255. */
const asHex = (rgb: readonly number[]) =>
  rgb.reduce((hex, channel) => hex * 256 + Math.round(Math.min(1, channel) * 255), 0);
const channels = (hex: number) =>
  [(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255] as const;

let open: ITweakBox<string> | undefined;

/**
 * The wood's tweak box (`?tweak`): range bars and pickers over the forest row's look, applied to
 * the running scene. "Copy snapshot" puts the values on the clipboard as JSON; they are locked in
 * by writing them into the forest row in `biomes.ts`. The far tree cards and the sky's own sun tint
 * are built once at load, so they follow only after that.
 */
export function openLookTweaks(sky: IOutdoorSky, renderer: { raw: unknown }): void {
  open?.dispose();
  const mist = row.atmosphere.groundMist;
  const aim = (values: Readonly<Record<string, number>>) => {
    const elevation = ((values.sunElevation ?? 0) * Math.PI) / 180;
    const azimuth = ((values.sunAzimuth ?? 0) * Math.PI) / 180;
    sky.setSunDirection(
      Math.cos(elevation) * Math.cos(azimuth) * SUN_REACH,
      Math.sin(elevation) * SUN_REACH,
      Math.cos(elevation) * Math.sin(azimuth) * SUN_REACH,
    );
  };
  const apply: Record<string, (value: number, values: Readonly<Record<string, number>>) => void> = {
    sunElevation: (_, values) => aim(values),
    sunAzimuth: (_, values) => aim(values),
    sunIntensity: (value) => {
      sky.sun.intensity = value;
    },
    sunColor: (value) => void sky.sun.color.setHex(value),
    skyFill: (value) => {
      sky.daylight.fill.intensity = value;
    },
    exposureEV: (value) => {
      (renderer.raw as { toneMappingExposure: number }).toneMappingExposure = 2 ** value;
    },
    mistDensity: (value) => {
      LOOK.mistDensity.value = value;
    },
    mistOpacity: (value) => {
      LOOK.mistOpacity.value = value;
    },
    mistThickness: (value) => {
      LOOK.mistScale.value = value;
    },
    mistColor: (value) => void LOOK.mistColor.value.setHex(value),
    crownTint: (value) => void LOOK.crown.value.set(...channels(value)),
    barkValue: (value) => {
      LOOK.bark.value = value;
    },
    limbValue: (value) => {
      LOOK.limb.value = value;
    },
    plantTint: (value) => void LOOK.sward.value.set(...channels(value)),
    plantShade: (value) => {
      LOOK.plantShade.value = value;
    },
    turfTint: (value) => void LOOK.turf.value.set(...channels(value)),
    rockTint: (value) => void LOOK.rock.value.set(...channels(value)),
  };
  open = createTweakBox({
    title: "Strata forest look",
    storageKey: "strata-forest-look",
    knobs: {
      sunElevation: {
        group: "Sun and sky",
        value: degrees(Math.asin(sunY / SUN_REACH)),
        min: 3,
        max: 70,
        step: 1,
      },
      sunAzimuth: {
        value: (degrees(Math.atan2(sunZ, sunX)) + 360) % 360,
        min: 0,
        max: 360,
        step: 1,
      },
      sunIntensity: { value: row.sun.intensity, min: 1, max: 16, step: 0.1 },
      sunColor: { color: row.sun.color },
      skyFill: { value: row.fill.intensity, min: 0, max: 1.5, step: 0.01 },
      exposureEV: { value: Math.log2(row.exposure), min: -1, max: 2.5, step: 0.01 },
      mistDensity: {
        group: "Mist between the stands",
        value: mist?.term.density ?? 0,
        min: 0,
        max: 0.015,
        step: 0.0001,
      },
      mistOpacity: { value: mist?.maxOpacity ?? 0, min: 0, max: 0.9, step: 0.01 },
      mistThickness: { value: mist?.term.scale ?? 15, min: 3, max: 80, step: 1 },
      mistColor: { color: mist?.color ?? 0x808080 },
      crownTint: { group: "Trees", color: 0xffffff },
      barkValue: { value: 1, min: 0.2, max: 3, step: 0.01 },
      limbValue: { value: 1, min: 0.2, max: 3, step: 0.01 },
      plantTint: { group: "Ground", color: asHex(row.swardTint ?? [1, 1, 1]) },
      plantShade: { value: LOOK.plantShade.value, min: 0, max: 1, step: 0.01 },
      turfTint: { color: asHex(row.turfTint ?? [1, 1, 1]) },
      rockTint: { group: "Mountains", color: 0xffffff },
    },
    onChange: (name, value, values) => apply[name]?.(value, values),
  });
}
