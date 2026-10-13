import { PNG } from "pngjs";
import type { IPlaytestToneAssertion } from "./scenario/schema-base.js";
import type { IToneMetrics, IToneRegion, IPlaytestRegionalToneObservation } from "./tone.js";

export const CAPTURE_GUARD_LIMITS = {
  brightLuminance: 0.05,
  contentLuminanceDelta: 0.1, // Count content at least 10% luminance away from the modal clear-color bin.
  darkFrameMinDistinctColors: 32,
  darkFrameMaxLuminance: 0.5,
  darkFrameMinLuminanceStdDev: 0.02,
  // Native content: before 0.073214, centered 0.068491, pan 0.004435, cull-off 0.007173, startup 0.015981–0.016013.
  desktopMinContentRatio: 0.001, // Lowest native frame clears this floor by 4.43x; uniform content is 0.
  minBrightPixelRatio: 0.05,
  minDistinctColors: 8,
  minLuminanceStdDev: 0.01,
} as const;

export interface ICaptureFrameStats {
  readonly tone?: IToneMetrics;
  readonly distinctColors: number;
  readonly brightPixelRatio: number;
  readonly contentRatio: number;
  readonly height: number;
  readonly luminanceStdDev: number;
  readonly maxLuminance: number;
  readonly width: number;
}

/**
 * Explain why a captured frame failed the non-blank guard.
 * @situation fail a visual test when the rendered frame is blank
 * @situation include capture statistics in a playtest error
 * @example throw new CaptureGuardError("menu", "no bright pixels");
 */
export class CaptureGuardError extends Error {
  readonly code = "TN_CAPTURE_BLANK";

  constructor(
    readonly label: string,
    readonly reason: string,
    readonly stats?: ICaptureFrameStats,
  ) {
    super(`TN_CAPTURE_BLANK: ${label}: ${reason}`);
    this.name = "CaptureGuardError";
  }
}

/**
 * Inspect a PNG frame for visible pixels and luminance variation.
 * @situation measure whether a screenshot contains a rendered game
 * @situation diagnose a uniform or blank capture
 * @example const stats = inspectFrame(png);
 */
export function inspectFrame(png: Buffer): ICaptureFrameStats {
  return inspectDecodedFrame(PNG.sync.read(png));
}

function inspectDecodedFrame(image: PNG): ICaptureFrameStats {
  const colors = new Set<number>();
  const histogram = new Uint32Array(256);
  let toneTotal = 0;
  let luminanceTotal = 0;
  let luminanceSquaredTotal = 0;
  let brightPixels = 0;
  let visiblePixels = 0;
  let maxLuminance = 0;

  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const alpha = image.data[offset + 3] ?? 0;
    colors.add(((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0);
    if (alpha === 0) continue;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    const bin = Math.round(luminance * 255);
    histogram[bin] = (histogram[bin] ?? 0) + 1;
    toneTotal += bin;
    visiblePixels += 1;
    maxLuminance = Math.max(maxLuminance, luminance);
    if (luminance > CAPTURE_GUARD_LIMITS.brightLuminance) brightPixels += 1;
    luminanceTotal += luminance;
    luminanceSquaredTotal += luminance * luminance;
  }

  const mean = visiblePixels === 0 ? 0 : luminanceTotal / visiblePixels;
  const variance = visiblePixels === 0 ? 0 : luminanceSquaredTotal / visiblePixels - mean * mean;
  let modalBin = 0;
  for (let bin = 1; bin < histogram.length; bin += 1) {
    if ((histogram[bin] ?? 0) > (histogram[modalBin] ?? 0)) modalBin = bin;
  }
  let contentPixels = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    if (Math.abs(bin - modalBin) / 255 >= CAPTURE_GUARD_LIMITS.contentLuminanceDelta) {
      contentPixels += histogram[bin] ?? 0;
    }
  }
  const percentile = (fraction: number): number => {
    const rank = Math.ceil(visiblePixels * fraction);
    let count = 0;
    for (let bin = 0; bin < histogram.length; bin += 1) {
      count += histogram[bin] ?? 0;
      if (count >= rank) return bin;
    }
    return 255;
  };
  return {
    ...(visiblePixels === 0 ? {} : { tone: {
      mean: toneTotal / visiblePixels,
      p1: percentile(0.01),
      p50: percentile(0.5),
      p99: percentile(0.99),
      clipFraction: (histogram[255] ?? 0) / visiblePixels,
      blackFraction: (histogram[0] ?? 0) / visiblePixels,
    } }),
    distinctColors: colors.size,
    brightPixelRatio: image.data.length === 0 ? 0 : brightPixels / (image.data.length / 4),
    contentRatio: image.data.length === 0 ? 0 : contentPixels / (image.data.length / 4),
    height: image.height,
    luminanceStdDev: Math.sqrt(Math.max(0, variance)),
    maxLuminance,
    width: image.width,
  };
}

/**
 * Fail closed when a screenshot is blank or uniform.
 * @situation guard a visual playtest against a blank frame
 * @situation prove a screenshot contains more than a loading surface
 * @constraint the assertion throws instead of returning a false pass
 * @example assertCaptureNotBlank(png, "first frame");
 */
export function assertCaptureNotBlank(png: Buffer, label: string): ICaptureFrameStats {
  return assertCaptureSurface(png, label, "browser");
}

/**
 * Fail closed when a desktop-host frame shows no rendered content.
 * A native desktop frame has no HTML overlay, so the browser bright-pixel floor does not apply.
 * @situation guard a native desktop capture of a 3D scene
 * @constraint keeps the uniform-frame checks and replaces only the bright-pixel floor
 * @example assertDesktopCaptureNotBlank(png, "panned-culled.png");
 */
export function assertDesktopCaptureNotBlank(png: Buffer, label: string): ICaptureFrameStats {
  return assertCaptureSurface(png, label, "desktop");
}

function assertCaptureSurface(
  png: Buffer,
  label: string,
  target: "browser" | "desktop",
): ICaptureFrameStats {
  const stats = inspectFrame(png);
  if (stats.distinctColors < CAPTURE_GUARD_LIMITS.minDistinctColors) {
    throw new CaptureGuardError(
      label,
      `only ${stats.distinctColors} distinct color(s); capture is likely uniform or blank`,
      stats,
    );
  }
  if (stats.luminanceStdDev < CAPTURE_GUARD_LIMITS.minLuminanceStdDev) {
    throw new CaptureGuardError(
      label,
      `luminance standard deviation ${stats.luminanceStdDev.toFixed(5)} is below ${CAPTURE_GUARD_LIMITS.minLuminanceStdDev}`,
      stats,
    );
  }
  if (target === "desktop") {
    if (!(stats.contentRatio >= CAPTURE_GUARD_LIMITS.desktopMinContentRatio)) {
      throw new CaptureGuardError(
        label,
        `content ratio ${stats.contentRatio.toFixed(5)} is below ${CAPTURE_GUARD_LIMITS.desktopMinContentRatio}`,
        stats,
      );
    }
    return stats;
  }
  const hasDarkFrameVariation =
    stats.distinctColors >= CAPTURE_GUARD_LIMITS.darkFrameMinDistinctColors &&
    stats.luminanceStdDev >= CAPTURE_GUARD_LIMITS.darkFrameMinLuminanceStdDev &&
    stats.maxLuminance <= CAPTURE_GUARD_LIMITS.darkFrameMaxLuminance;
  if (stats.brightPixelRatio < CAPTURE_GUARD_LIMITS.minBrightPixelRatio && !hasDarkFrameVariation) {
    throw new CaptureGuardError(
      label,
      `bright pixel ratio ${stats.brightPixelRatio.toFixed(5)} is below ${CAPTURE_GUARD_LIMITS.minBrightPixelRatio}`,
      stats,
    );
  }
  return stats;
}

/**
 * Fail closed when a screenshot is blank or uniform.
 * @situation guard a visual playtest against a blank frame
 * @situation prove a screenshot contains more than a loading surface
 * @constraint the assertion throws instead of returning a false pass
 * @example assertFrameShowsSomething(png, "first frame");
 */
export const assertFrameShowsSomething = assertCaptureNotBlank;

/**
 * Collect opt-in regional tone observations from the same acquired PNG.
 * @situation measure a specified pixel crop in a captured playtest frame
 * @constraint does not acquire another screenshot or alter frame timing
 * @example collectRegionalTone(png, assertions, "character", "posed");
 */
export function collectRegionalTone(
  png: Buffer,
  assertions: readonly IPlaytestToneAssertion[],
  label: string,
  atStep?: string,
): IPlaytestRegionalToneObservation[] {
  const selected: { assertion: IPlaytestToneAssertion; assertionIndex: number }[] = [];
  for (const [assertionIndex, assertion] of assertions.entries())
    if (assertion.region !== undefined && assertion.atStep === atStep)
      selected.push({ assertion, assertionIndex });
  if (selected.length === 0) return [];
  const image = PNG.sync.read(png);
  const measure = (region: IToneRegion): { metrics?: IToneMetrics; error?: string } => {
    if (
      ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width <= 0 ||
      region.height <= 0 ||
      region.width > image.width - region.x ||
      region.height > image.height - region.y
    )
      return { error: "Tone region is outside decoded PNG bounds or invalid." };
    const cropped = new PNG({ width: region.width, height: region.height });
    for (let y = 0; y < region.height; y++) {
      const offset = ((region.y + y) * image.width + region.x) * 4;
      image.data.copy(cropped.data, y * region.width * 4, offset, offset + region.width * 4);
    }
    const metrics = inspectDecodedFrame(cropped).tone;
    return metrics === undefined
      ? { error: "Tone region contains no visible pixels." }
      : { metrics };
  };
  return selected.map(({ assertion, assertionIndex }) => {
    const region = assertion.region!;
    const measured = measure(region);
    const reference =
      assertion.compare === undefined
        ? undefined
        : { region: assertion.compare.region, ...measure(assertion.compare.region) };
    return {
      code: "TN_TONE",
      label,
      ...(atStep === undefined ? {} : { atStep }),
      assertionIndex,
      region,
      ...measured.metrics,
      ...(measured.error === undefined ? {} : { error: measured.error }),
      ...(reference === undefined ? {} : { reference }),
    };
  });
}
