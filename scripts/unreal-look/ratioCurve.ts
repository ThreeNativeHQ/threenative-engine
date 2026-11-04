/**
 * The tone-curve inversion behind `ratio.ts` (PRD-646): a display level back to the scene-linear light
 * that entered the harness's own curve.
 *
 * The harness encodes a frame as `sRGB(filmicToneMap(sceneLight, exposure))` — `filmicToneMap` applies the
 * exposure before the curve (`scaffold/render/tonemap.ts`), and Unreal writes its EXR at the same point,
 * after exposure and before the tone curve. So a PNG level inverts to the *exposed* light of that pixel, and
 * an EXR holds the same quantity. One convention, no exposure and no pi between them.
 */
import { FILMIC_CURVE, type IFilmicCurve, filmicToneMap } from "./scaffold/render/tonemap.js";

/** The sRGB transfer, display value (0-1) as stored in a PNG byte. */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** The inverse transfer: the display value a linear display value is stored as. */
export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** What one scene-linear grey reaches the PNG as, in levels: the forward form the capture draws. */
export function levelOfLight(light: number, curve: IFilmicCurve = FILMIC_CURVE): number {
  const display = filmicToneMap([light, light, light], 1, curve)[1] ?? 0;
  return 255 * linearToSrgb(Math.min(1, Math.max(0, display)));
}

/**
 * The light a PNG level was drawn from: the curve input, which is the scene light times the exposure the
 * frame used. `null` when the level saturates the curve, where a whole stop changes no byte.
 */
export function lightOfLevel(level: number, curve: IFilmicCurve = FILMIC_CURVE): number | null {
  // The curve clamps its input at lutClip: a pixel at the top of the range was drawn from any light above it.
  const top = curve.lutClip > 0 ? curve.lutClip : 1e6;
  if (level >= levelOfLight(top, curve) - 0.5) return null;
  // A byte level is the sRGB transfer of a display-linear value, which is what `filmicToneMap` returns.
  const target = srgbToLinear(Math.min(1, Math.max(0, level / 255)));
  let low = 0;
  let high = top;
  // 60 halvings take a double well past its precision; the curve is monotonic in a grey.
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    const display = Math.min(1, Math.max(0, filmicToneMap([mid, mid, mid], 1, curve)[1] ?? 0));
    if (display < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** The tone curve with the harness's parameters, but without a step the source applies before its EXR. */
export function unrealCurve(curve: IFilmicCurve = FILMIC_CURVE): IFilmicCurve {
  // Unreal's no-tone-curve EXR is taken after Expand Gamut (PostProcessCombineLUTs.usf), so a PNG of it
  // must not expand it twice. The expansion is a no-op on a neutral grey, which is what a ratio row reads.
  return { ...curve, expandGamut: 0 };
}
