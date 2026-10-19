// Generated for you. Measure actual source radiance; unreadable environments stay unknown.
import {
  type Color,
  EquirectangularReflectionMapping,
  FloatType,
  LinearSRGBColorSpace,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  type Scene,
  type Texture,
  UnsignedByteType,
} from "three";

export interface IEnvironmentMeasurement {
  readonly status: "measured" | "unknown";
  readonly meanRadiance: number | null;
  readonly meanRGB: readonly [number, number, number] | null;
  readonly reason: string;
}
const unknown = (reason: string): IEnvironmentMeasurement => ({
  status: "unknown",
  meanRadiance: null,
  meanRGB: null,
  reason,
});
const linear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
interface IReadableSource {
  readonly status: "source";
  readonly data: Uint8Array | Float32Array;
  readonly width: number;
  readonly height: number;
  readonly bytes: boolean;
}
function readSource(
  texture: Texture,
  maxSourceTexels: number,
): IReadableSource | IEnvironmentMeasurement {
  if (texture.mapping !== EquirectangularReflectionMapping)
    return unknown("Only CPU-readable equirectangular source radiance is qualified.");
  const image: unknown = texture.image;
  if (
    image === null ||
    typeof image !== "object" ||
    !("data" in image) ||
    !("width" in image) ||
    !("height" in image)
  )
    return unknown("Environment source pixels are not CPU-readable; no radiance was inferred.");
  const { data, width, height } = image;
  if (!validSize(width) || !validSize(height))
    return unknown("Environment source dimensions are invalid.");
  if (width * height > maxSourceTexels)
    return unknown("Environment CPU sample budget exceeded; no radiance was inferred.");
  if (texture.format !== RGBAFormat)
    return unknown("Only explicit RGBA source samples are qualified.");
  const bytes = texture.type === UnsignedByteType && data instanceof Uint8Array;
  const floats = texture.type === FloatType && data instanceof Float32Array;
  if (!bytes && !floats) return unknown("Environment source sample type is not qualified.");
  if (data.length !== width * height * 4)
    return unknown("Environment source samples do not match their dimensions.");
  if (
    !new Set<string>([NoColorSpace, LinearSRGBColorSpace, SRGBColorSpace]).has(texture.colorSpace)
  )
    return unknown("Environment source color-space conversion is not qualified.");
  return { status: "source", data, width, height, bytes };
}

function accumulate(source: IReadableSource, srgb: boolean) {
  const { data, width, height, bytes } = source;
  const sums = [0, 0, 0];
  const weights = Array.from(
    { length: height },
    (_, y) => Math.cos((Math.PI * y) / height) - Math.cos((Math.PI * (y + 1)) / height),
  );
  for (let offset = 0; offset < data.length; offset += 4) {
    const weight = weights[Math.floor(offset / (width * 4))] ?? 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const sample = data[offset + channel];
      if (sample === undefined || !Number.isFinite(sample) || sample < 0)
        return unknown("Environment radiance samples must be finite and nonnegative.");
      const value = bytes ? sample / 255 : sample;
      sums[channel] = (sums[channel] ?? 0) + (srgb ? linear(value) : value) * weight;
    }
  }
  return { sums, weightSum: weights.reduce((a, b) => a + b, 0) * width };
}

/**
 * CPU-readable equirectangular source radiance only; no DOM/canvas or invented JPEG mean.
 * Rows are weighted by their exact spherical solid angle, rather than overweighting the poles.
 * Arbitrary GPU/compressed/HTML/cube sources remain explicitly unknown until separately proven.
 */
export function measureEnvironment(scene: Scene, maxSourceTexels: number): IEnvironmentMeasurement {
  if (!Number.isSafeInteger(maxSourceTexels) || maxSourceTexels < 1)
    throw new Error("Environment CPU sample budget must be a positive safe integer.");
  const texture = scene.environment;
  if (texture === null)
    return {
      status: "measured",
      meanRadiance: 0,
      meanRGB: [0, 0, 0],
      reason: "No environment is bound.",
    };
  if (!Number.isFinite(scene.environmentIntensity) || scene.environmentIntensity < 0)
    return unknown("Environment intensity must be finite and nonnegative.");
  const source = readSource(texture, maxSourceTexels);
  if (source.status !== "source") return source;
  const accumulated = accumulate(source, texture.colorSpace === SRGBColorSpace);
  if ("status" in accumulated) return accumulated;
  const { sums, weightSum } = accumulated;
  const meanRGB = sums.map((sum) => (sum / weightSum) * scene.environmentIntensity) as [
    number,
    number,
    number,
  ];
  const meanRadiance = meanRGB[0] * 0.2126 + meanRGB[1] * 0.7152 + meanRGB[2] * 0.0722;
  if (!meanRGB.every(Number.isFinite) || !Number.isFinite(meanRadiance))
    return unknown("Environment radiance accumulation overflowed.");
  return {
    status: "measured",
    meanRadiance,
    meanRGB,
    reason: "Solid-angle-weighted linear source radiance, with active environment intensity.",
  };
}

interface IContributionControls {
  readonly darkThreshold: number;
  readonly rimGain: number;
  readonly fillGain: number;
  readonly fillAdmitted: boolean;
  readonly fillColor: Color;
  readonly maxSourceTexels: number;
}
function fillReport(options: IContributionControls) {
  const blackColorOverride = options.fillColor.toArray().every((value) => value === 0);
  let reason = "analytic fill enabled by caller; contribution still needs pixel qualification";
  if (!options.fillAdmitted) reason = "not admitted by this qualification";
  else if (options.fillGain === 0) reason = "disabled by fillGain override";
  else if (blackColorOverride) reason = "disabled by black fillColor override";
  return {
    requestedGain: options.fillGain,
    admitted: options.fillAdmitted,
    effectiveGain: options.fillAdmitted ? options.fillGain : 0,
    color: options.fillColor.toArray(),
    blackColorOverride,
    reason,
  };
}
/** Overrides change the look, never whether its source contribution is measured/reported. */
export function reportEnvironmentContribution(
  scene: Scene,
  options: IContributionControls,
  measurement?: IEnvironmentMeasurement,
) {
  if (
    ![
      options.darkThreshold,
      options.rimGain,
      options.fillGain,
      ...options.fillColor.toArray(),
    ].every((value) => Number.isFinite(value) && value >= 0)
  )
    throw new Error("Backlight measurement controls must be finite and nonnegative.");
  const measured = measurement ?? measureEnvironment(scene, options.maxSourceTexels);
  const dark =
    measured.meanRadiance === null ? null : measured.meanRadiance <= options.darkThreshold;
  const environmentState =
    scene.environment === null ? "missing" : dark === null ? "unknown" : dark ? "dark" : "bright";
  const report = {
    ...measured,
    scope: "scene environment source availability; not material-specific reflected contribution",
    environmentState,
    ibl: dark === null ? "unknown" : dark ? "non-contributing" : "contributing",
    analyticFill: fillReport(options),
    rimGain: options.rimGain,
    fillGain: options.fillGain,
    darkThreshold: options.darkThreshold,
  };
  console.info(`TN_ENVIRONMENT_CONTRIBUTION:${JSON.stringify(report)}`);
  return report;
}
