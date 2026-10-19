import type { IThreeNativeConfig } from "./config.js";
import type { MatrixWorldMode } from "./matrix-world.js";
import type { PlatformOS } from "./platform.js";
import { RESOLUTION_SCALER } from "./resolution-scaler.js";

type RendererConfig = NonNullable<IThreeNativeConfig["renderer"]>;

/** How the active drawing-buffer scale was arrived at, reported beside every fps number. */
export type ScaleSource = "pinned" | "auto";

export interface IResolvedScale {
  readonly resolutionScale: number;
  readonly scaleSource: ScaleSource;
}

/** Where an `"auto"` scale starts before the controller has seen a frame-budget window. */
export const AUTO_SCALE_START = 1;

function requireScale(
  value: number | "auto" | undefined,
  key: string,
): number | "auto" | undefined {
  if (value === undefined || value === "auto") return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1)
    throw new Error(
      `${key} must be "auto" or a number within (0, 1], received ${JSON.stringify(value)}.`,
    );
  return value;
}

/**
 * The one place a configured scale becomes a number the renderer can apply, and the one place
 * that says whether the game chose it or the engine did.
 *
 * Validation lives here rather than in the renderer because the renderer only ever sees the
 * resolved number: a game that writes `renderer.android.resolutionScale: 2` has to be told which
 * key it got wrong, not that some scale somewhere was out of range.
 */
export function resolveRendererScaleSetting(
  config: RendererConfig | undefined,
  fallback: number | undefined,
  os: PlatformOS,
): IResolvedScale {
  const android = requireScale(
    config?.android?.resolutionScale,
    "renderer.android.resolutionScale",
  );
  const portable = requireScale(config?.resolutionScale, "renderer.resolutionScale");
  const selected = os === "android" && android !== undefined ? android : (portable ?? fallback);
  // Silence is "auto", not a pin. The engine measures the frame budget where the scale is used, so
  // a game that named nothing gets the loop that holds it; a pinned full-resolution buffer on a
  // HiDPI desktop is 4x MSAA over 4527x2207 until the GPU device is lost, and asking a game to
  // write the key to avoid it is a constant it has to revisit later. A number still pins, and an
  // explicit "auto" is still the same answer it always was.
  if (selected === "auto" || selected === undefined)
    return { resolutionScale: AUTO_SCALE_START, scaleSource: "auto" };
  return {
    resolutionScale: requireScale(selected, "renderer.resolutionScale") as number,
    scaleSource: "pinned",
  };
}

/**
 * The lowest rung a platform's scaler may take, or `undefined` for the whole ladder.
 *
 * Android and iOS keep every rung: those rungs are what the device arm measured, and a phone buys
 * the pixels back in ways a desktop does not. Everything else stops at
 * `RESOLUTION_SCALER.desktopFloorScale`, because a desktop with nothing reconstructing the frame
 * from fewer pixels turns the bottom of that ladder into blocky mush rather than a faster frame.
 * A desktop whose render chain does reconstruct it lifts the floor itself, per step.
 */
export function resolvePlatformResolutionFloor(os: PlatformOS): number | undefined {
  return os === "android" || os === "ios" ? undefined : RESOLUTION_SCALER.desktopFloorScale;
}

/**
 * The one place `renderer.matrixWorld` becomes the walk the frame runs.
 *
 * Validated here rather than inside the pass for the same reason the scale is: the pass only ever
 * sees a resolved mode, so a game that wrote a typo has to be told which key it got wrong.
 */
export function resolveMatrixWorldMode(
  config: RendererConfig | undefined,
  fallback: MatrixWorldMode = "visible",
): MatrixWorldMode {
  const value = config?.matrixWorld;
  if (value === undefined) return fallback;
  if (value === "visible" || value === "all") return value;
  throw new Error(
    `renderer.matrixWorld must be "visible" or "all", received ${JSON.stringify(value)}.`,
  );
}

/**
 * Internal config-to-renderer seam for multisampling, resolved exactly as the scale is.
 *
 * Separate from the scale resolver rather than folded into one call because the two values have
 * different types and different fallbacks, and a combined resolver would have to invent a shape
 * for "this platform overrides one of them".
 */
export function resolveRendererAntialias(
  config: RendererConfig | undefined,
  fallback: boolean | undefined,
  os: PlatformOS,
): boolean | undefined {
  if (os === "android" && config?.android?.antialias !== undefined) {
    return config.android.antialias;
  }
  return config?.antialias ?? fallback;
}

/**
 * The same seam for alpha antialiasing, which spends the samples `antialias` buys rather than
 * buying any of its own. Resolved separately because a platform can want one without the other:
 * a phone that dropped to a single-sampled surface has no coverage mask to hand a cutout, and a
 * game after a hard-edged look wants the samples on its geometry and not on its foliage.
 */
export function resolveRendererAlphaAntialiasing(
  config: RendererConfig | undefined,
  fallback: boolean | undefined,
  os: PlatformOS,
): boolean | undefined {
  if (os === "android" && config?.android?.alphaAntialiasing !== undefined) {
    return config.android.alphaAntialiasing;
  }
  return config?.alphaAntialiasing ?? fallback;
}
