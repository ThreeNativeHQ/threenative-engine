/**
 * Which family of GPU the adapter is: the start point of the look and of the pixel count.
 *
 * A fact about the machine, read from the four `adapter.info` fields and nothing else. What a
 * class *looks like* is the game's own decision (`src/render/quality.ts`); this file only names the
 * class, so a Mali-G52 phone and a Mali-G715 phone stop sharing one `mobile` flag.
 *
 * Measurement outranks this table. The first eligible frame-budget window moves the tier and the
 * scale whichever class started them, so a wrong row costs windows, never a stuck look.
 */

export type GpuClass =
  | "software"
  | "mobile-low"
  | "mobile-mid"
  | "mobile-high"
  | "integrated"
  | "discrete"
  | "unknown";

/** The four fields WebGPU's `adapter.info` carries. A field the platform omits is the empty string. */
export interface IGpuAdapterFields {
  readonly architecture: string;
  readonly description: string;
  readonly device: string;
  readonly vendor: string;
}

export interface IGpuClassification {
  readonly class: GpuClass;
  /** The first rule that matched, or `none` when no rule did. */
  readonly rule: string;
  readonly fields: IGpuAdapterFields;
}

/** The marker printed once per launch, beside the class, the rule and the raw fields. */
export const GPU_CLASS_MARKER = "TN_GPU_CLASS";

/**
 * Which `adapter.info` field value names a CPU rasteriser.
 *
 * Every field is searched because which one carries the giveaway depends on the platform: Linux
 * Dawn puts `swiftshader` in `architecture`, Mesa reports `llvmpipe` in `description`, and a
 * headless Windows run says `Microsoft Basic Render Driver` in `device`.
 */
export const SOFTWARE_ADAPTER =
  /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/i;

/**
 * One row: the class it names, or `undefined` when the row does not match.
 *
 * Each row reads only the fields it names. A field the platform did not report is empty and no
 * pattern matches it, so a coarse adapter falls through to `unknown`, never to a wrong class.
 */
type Rule = (fields: IGpuAdapterFields) => GpuClass | undefined;

const MALI_MODEL = /\bmali[\s_-]*g?[\s-]*(\d{2,3})/i;
const ADRENO_MODEL = /\badreno\W*(?:tm\W*)?(\d)(\d\d|xx)/i;
// A Ryzen iGPU names itself `Radeon Graphics` or `Radeon <n>M`; a card carries `RX`/`Pro`/`Vega <n>`.
const AMD_INTEGRATED = /radeon(?:\(tm\))?\s+(?:graphics|\d{3}m)\b/i;
const INTEL_DISCRETE = /\barc\b|xe2?-hpg|battlemage|alchemist/i;

const RULES: readonly (readonly [name: string, rule: Rule])[] = [
  [
    "software",
    ({ architecture, description, device, vendor }) =>
      [architecture, description, device, vendor].some((value) => SOFTWARE_ADAPTER.test(value))
        ? "software"
        : undefined,
  ],
  [
    // Reads `description`, `device` or `architecture`: Chrome on Android often leaves the first two
    // empty and names only the microarchitecture, which the next row handles.
    "mali-model",
    ({ architecture, description, device }) => {
      const number = [description, device, architecture]
        .map((value) => MALI_MODEL.exec(value)?.[1])
        .find((value) => value !== undefined);
      if (number === undefined) return undefined;
      const model = Number(number);
      // G31, G51, G52, G71 and G72 are the budget Bifrost parts; G57 to G78 and the G3xx, G5xx and
      // G6xx Valhall parts are the middle; G710 and newer (G715, G720, G925) are the flagship line.
      if (model >= 710) return "mobile-high";
      return model < 57 || model === 71 || model === 72 ? "mobile-low" : "mobile-mid";
    },
  ],
  [
    "arm-architecture",
    ({ architecture, vendor }) => {
      if (!/\barm\b/i.test(vendor)) return undefined;
      if (/midgard|bifrost/i.test(architecture)) return "mobile-low";
      if (/valhall/i.test(architecture)) return "mobile-mid";
      return /5th-?gen|immortalis/i.test(architecture) ? "mobile-high" : undefined;
    },
  ],
  [
    "adreno-model",
    ({ architecture, description, device }) => {
      const match = [description, device, architecture]
        .map((value) => ADRENO_MODEL.exec(value))
        .find((value) => value !== null && value !== undefined);
      if (match === null || match === undefined) return undefined;
      const generation = Number(match[1]);
      if (generation <= 4) return "mobile-low";
      if (generation === 5) return "mobile-mid";
      // 6xx spans the 610 budget part to the 660 flagship; a generation-only name is the safe middle.
      if (generation === 6)
        return match[2] !== "xx" && Number(match[2]) >= 30 ? "mobile-high" : "mobile-mid";
      return "mobile-high";
    },
  ],
  [
    "nvidia",
    ({ architecture, description, device, vendor }) =>
      /nvidia/i.test(vendor) && ![architecture, description, device].some((v) => /tegra/i.test(v))
        ? "discrete"
        : undefined,
  ],
  [
    "intel",
    ({ architecture, description, device, vendor }) => {
      if (!/intel/i.test(vendor)) return undefined;
      return [architecture, description, device].some((value) => INTEL_DISCRETE.test(value))
        ? "discrete"
        : "integrated";
    },
  ],
  [
    // An APU and a card share an architecture name, so an unnamed iGPU is classed `discrete`: the
    // wrong answer there is today's start, where the other wrong answer would cap a strong GPU.
    "amd",
    ({ description, vendor }) =>
      /\b(?:amd|ati)\b/i.test(vendor)
        ? AMD_INTEGRATED.test(description)
          ? "integrated"
          : "discrete"
        : undefined,
  ],
];

/**
 * Classifies one adapter. Ordered rules, first match wins; no match is `unknown`, which every
 * consumer treats as "the behaviour before this table existed".
 *
 * Apple Silicon, Qualcomm desktop parts and anything unrecognised are `unknown` on purpose: an
 * unmatched strong GPU keeps today's start, while a row guessed wrong would cap it.
 */
export function classifyGpu(fields: Partial<IGpuAdapterFields>): IGpuClassification {
  const normalised: IGpuAdapterFields = {
    architecture: fields.architecture ?? "",
    description: fields.description ?? "",
    device: fields.device ?? "",
    vendor: fields.vendor ?? "",
  };
  for (const [name, rule] of RULES) {
    const matched = rule(normalised);
    if (matched !== undefined) return { class: matched, fields: normalised, rule: name };
  }
  return { class: "unknown", fields: normalised, rule: "none" };
}
