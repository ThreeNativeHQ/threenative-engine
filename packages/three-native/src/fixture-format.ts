/**
 * The compatibility fixture format, its goldens, and the reader that fails closed.
 *
 * One fixture is a script plus a non-empty observation set: `ops` build state, `observe` reads
 * it, and the tolerance decides when the native engine's answer matches. The same fixture is
 * executed twice — once in Node against the pinned `three` to produce a golden
 * (`tests/compatibility/run-reference.ts`), once against a native driver that speaks the line
 * protocol (`tests/compatibility/run-native.ts`).
 *
 * A golden records every number as its 16-hex-digit IEEE-754 binary64 bit string, because JSON
 * cannot hold `-0`, `NaN` or a NaN payload and those are exactly the values a compatibility
 * fixture exists to compare. The decimal next to it is for humans and is never compared.
 *
 *   pnpm --filter @threenative/three-native test:reference
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The package root. Derived from this file so a spec and a package script agree. */
export const PACKAGE_ROOT = path.join(import.meta.dirname, "..");
export const REPO_ROOT = path.join(PACKAGE_ROOT, "..", "..");
export const FIXTURES_DIR = path.join(PACKAGE_ROOT, "tests", "compatibility", "fixtures");
export const GOLDENS_DIR = path.join(PACKAGE_ROOT, "tests", "compatibility", "goldens");

/** Kinds a golden can carry. Anything else is a typo, and a typo must not read as a match. */
export const OBSERVATION_KINDS = [
  "number",
  "numbers",
  "boolean",
  "string",
  "json",
  "pixels",
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * The tone mappings a render fixture may name, and the three constant each one is.
 *
 * The constant names are shipped to the browser instead of being written twice, so a new mapping
 * cannot be spelled in one half of the runner and missing from the other.
 */
export const TONE_MAPPING_CONSTANTS = {
  none: "NoToneMapping",
  linear: "LinearToneMapping",
  reinhard: "ReinhardToneMapping",
  cineon: "CineonToneMapping",
  aces: "ACESFilmicToneMapping",
  agx: "AgXToneMapping",
  neutral: "NeutralToneMapping",
} as const;
export type ToneMappingName = keyof typeof TONE_MAPPING_CONSTANTS;
export const TONE_MAPPINGS = Object.keys(TONE_MAPPING_CONSTANTS) as readonly ToneMappingName[];

/** What the renderer writes into the canvas. `linear` leaves the working space untouched. */
export const OUTPUT_COLOR_SPACES = ["srgb", "linear"] as const;
export type OutputColorSpace = (typeof OUTPUT_COLOR_SPACES)[number];

/** How close two renders must be for the differential runner to call them the same frame. */
export interface IPixelsMetric {
  readonly maxPixelMismatchRatio: number;
  readonly maxPerceptualDeltaE: number;
  /**
   * Channel levels a pixel may differ by and still count as matching (default 0). Only for a
   * frame that accumulates float state over many frames, where exact 8-bit agreement is not a
   * reachable target; `levelsReason` says why.
   */
  readonly levels?: number;
  readonly levelsReason?: string;
}

/** The one frame a render fixture renders, and the settings that frame is captured under. */
export interface IFixtureRender {
  readonly scene: string;
  readonly camera: string;
  readonly width: number;
  readonly height: number;
  readonly toneMapping: ToneMappingName;
  readonly toneMappingExposure: number;
  readonly outputColorSpace: OutputColorSpace;
  /** three's `renderer.shadowMap.enabled` (PCFShadowMap); absent is off. */
  readonly shadowMap?: boolean;
  /** three's `renderer.shadowMap.type` while shadows are on; absent is PCFShadowMap. */
  readonly shadowMapType?: "PCFShadowMap" | "PCFSoftShadowMap";
}

/** What `navigator.gpu` reported about the adapter that drew the golden frame. */
export interface IAdapterInfo {
  readonly architecture: string;
  readonly description: string;
  readonly device: string;
  readonly vendor: string;
}

/** The capture itself: the PNG next to the JSON golden, its hash, and the adapter that drew it. */
export interface IRenderGolden {
  readonly png: string;
  readonly pngSha256: string;
  readonly width: number;
  readonly height: number;
  readonly adapter: IAdapterInfo;
}

/** JSON has no NaN, Infinity or -0, so those numbers travel under a name. */
export type FixtureNumberName = "NaN" | "Infinity" | "-Infinity" | "-0";
export const FIXTURE_NUMBER_NAMES: readonly FixtureNumberName[] = [
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
];

export interface IFixtureRef {
  readonly ref: string;
}

export interface IFixtureNumber {
  readonly num: FixtureNumberName;
}

/** The typed arrays a fixture may build: a geometry attribute's own storage. */
export const FIXTURE_ARRAY_TYPES = [
  "Float32Array",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
] as const;
export type FixtureArrayType = (typeof FIXTURE_ARRAY_TYPES)[number];

/** `new <type>(array)`: a typed array of finite numbers, for a BufferAttribute. */
export interface IFixtureArray {
  readonly array: readonly number[];
  readonly type: FixtureArrayType;
}

/** A plain array of bound objects, as `new Skeleton([bone0, bone1])` takes. */
export interface IFixtureRefs {
  readonly refs: readonly string[];
}

/** A plain options object of scalars, as `new ExtrudeGeometry(shape, { depth: 2 })` takes. */
export interface IFixtureRecord {
  readonly record: Readonly<Record<string, number | string | boolean | null>>;
}

/** Every argument an op or observation carries. */
export type FixtureArg =
  | number
  | string
  | boolean
  | null
  | IFixtureRef
  | IFixtureNumber
  | IFixtureArray
  | IFixtureRefs
  | IFixtureRecord;

/** `abs` is an absolute difference; `ulps` is a distance in representable doubles. At least one. */
export interface IFixtureTolerance {
  readonly abs?: number;
  readonly ulps?: number;
}

export interface INewOp {
  readonly op: "new";
  readonly id: string;
  readonly class: string;
  readonly args: readonly FixtureArg[];
}

export interface ICallOp {
  readonly op: "call";
  readonly id: string;
  readonly method: string;
  readonly args: readonly FixtureArg[];
  /** The id the return value is bound to. Absent means the value is discarded. */
  readonly result?: string;
}

export interface ISetOp {
  readonly op: "set";
  readonly id: string;
  readonly path: string;
  readonly value: FixtureArg;
}

/**
 * Loads a repository glTF/GLB (a path from the repository root) and binds `id` to its default
 * scene: three's GLTFLoader in the references, the native loader in the native driver.
 */
export interface IGltfOp {
  readonly op: "gltf";
  readonly id: string;
  readonly file: string;
  /** Ids bound to the file's animations, in order (`gltf.animations[i]`). */
  readonly clips?: readonly string[];
}

/**
 * Applies a named TSL program to a bound material (and the GPU work it needs before the frame):
 * `render/tsl-programs.js` in the reference, the C++ registry `tsl_programs.h` in the native driver,
 * authored once each with upstream TSL and the native TSL builder. Render fixtures only.
 */
export interface ITslOp {
  readonly op: "tsl";
  readonly id: string;
  readonly program: string;
}

export type FixtureOp = INewOp | ICallOp | ISetOp | IGltfOp | ITslOp;

/** A TSL program name: lower-case words joined by hyphens. */
export const TSL_PROGRAM = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** A repository-relative glTF path: no parent steps, no absolute root. */
export const GLTF_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+\.(?:glb|gltf)$/u;

/** Reads `path` or calls `method`, never both: one observation, one source. */
export interface IObservation {
  readonly id: string;
  readonly kind: ObservationKind;
  readonly path?: string;
  readonly method?: string;
  /** Required by `pixels`, forbidden on every other kind: the bounds the differential applies. */
  readonly metric?: IPixelsMetric;
}

export interface IFixture {
  readonly name: string;
  readonly adaptedFrom: string;
  readonly tolerance: IFixtureTolerance;
  readonly ops: readonly FixtureOp[];
  readonly observe: readonly IObservation[];
  /** Present when this fixture renders a frame. Its scene and camera must name bound ids. */
  readonly render?: IFixtureRender;
}

/** One recorded observation. `value` is exactly what a driver prints on the wire. */
export interface IGoldenObservation {
  readonly index: number;
  readonly id: string;
  readonly kind: ObservationKind;
  readonly path?: string;
  readonly method?: string;
  readonly value: string;
  /** Human-readable form of `value`. Never compared. */
  readonly decimal?: string;
}

export interface IFixtureGolden {
  readonly name: string;
  readonly threeVersion: string;
  readonly adaptedFrom: string;
  /** Non-null when the reference could not execute this fixture; `observations` is then empty. */
  readonly blocked: string | null;
  readonly observations: readonly IGoldenObservation[];
  /** Present exactly when an observation is `pixels`: where the frame is and who drew it. */
  readonly render?: IRenderGolden;
}

/** Protocol tokens share one alphabet: no spaces, no separators, no escaping. */
const TOKEN = /^[A-Za-z_$][\w$]*$/u;
/** A fixture name may also carry hyphens, because the corpus is named like a test file. */
const NAME = /^[A-Za-z_$][\w$-]*$/u;
const PATH_SEGMENT = /^(?:[A-Za-z_$][\w$]*|\d+)$/u;
const HEX_BITS = /^[0-9a-f]{16}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isPath(value: string): boolean {
  return value.split(".").every((segment) => PATH_SEGMENT.test(segment));
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const BUFFER = new DataView(new ArrayBuffer(8));

/**
 * The binary64 bits of `value` as 16 hex digits: the only lossless form a golden can hold.
 *
 * A NaN is recorded as the canonical quiet NaN. Hardware raises several NaN bit patterns for the
 * same invalid operation — `0 * Infinity` alone yields both signs on x86 — so the payload is not
 * part of the claim, and a golden carrying one would fail `--repeat` for reasons that have nothing
 * to do with compatibility. `-0` keeps its sign, which is the sign that carries meaning.
 */
export function numberBits(value: number): string {
  if (Number.isNaN(value)) return "7ff8000000000000";
  BUFFER.setFloat64(0, value, false);
  return BUFFER.getBigUint64(0, false).toString(16).padStart(16, "0");
}

/** The inverse of {@link numberBits}. Throws on anything that is not 16 hex digits. */
export function bitsNumber(bits: string): number {
  if (!HEX_BITS.test(bits))
    throw new Error(`TN_FIXTURE_BITS_INVALID: ${bits} is not 16 lowercase hex digits`);
  BUFFER.setBigUint64(0, BigInt(`0x${bits}`), false);
  return BUFFER.getFloat64(0, false);
}

/** A decimal form a human can read. `-0` needs `Object.is`, and `String` already says NaN. */
export function decimalOf(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** Key-sorted JSON, so two drivers that build the same object compare equal regardless of order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const entries = Object.entries(item as Record<string, unknown>);
    return Object.fromEntries(
      entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}

/**
 * Every rule the format states, as messages. Fails closed: an empty array is the only pass, so a
 * caller cannot forget to read the result.
 */
export function fixtureErrors(value: unknown, expectedName?: string): readonly string[] {
  const errors: string[] = [];
  const root = record(value);
  const name = root.name;
  if (typeof name !== "string" || !NAME.test(name))
    errors.push("$.name: required, and must match /^[A-Za-z_$][\\w$-]*$/");
  if (expectedName !== undefined && name !== expectedName)
    errors.push(`$.name: ${JSON.stringify(name)} does not match its file name ${expectedName}`);
  if (typeof root.adaptedFrom !== "string" || root.adaptedFrom.trim() === "")
    errors.push("$.adaptedFrom: required, and must name the upstream test or `original`");

  // A render block names a frame and the settings it is captured under. Anything less than the
  // whole block is a capture nobody can reproduce, so each field is required rather than assumed.
  let render: Record<string, unknown> | null = null;
  if (root.render !== undefined) {
    render = record(root.render);
    if (root.render === null || typeof root.render !== "object" || Array.isArray(root.render))
      errors.push("$.render: must be an object naming the scene, camera, size and tone mapping");
    else {
      if (typeof render.scene !== "string" || !TOKEN.test(render.scene))
        errors.push("$.render.scene: required, and must match /^[A-Za-z_$][\\w$]*$/");
      if (typeof render.camera !== "string" || !TOKEN.test(render.camera))
        errors.push("$.render.camera: required, and must match /^[A-Za-z_$][\\w$]*$/");
      for (const key of ["width", "height"] as const) {
        if (!Number.isInteger(render[key]) || (render[key] as number) < 1)
          errors.push(`$.render.${key}: required, and must be a positive integer`);
      }
      if (!TONE_MAPPINGS.includes(render.toneMapping as ToneMappingName))
        errors.push(`$.render.toneMapping: must be one of ${TONE_MAPPINGS.join(", ")}`);
      if (
        render.toneMappingExposure !== undefined &&
        !(
          typeof render.toneMappingExposure === "number" &&
          Number.isFinite(render.toneMappingExposure) &&
          render.toneMappingExposure > 0
        )
      )
        errors.push("$.render.toneMappingExposure: must be a positive finite number when present");
      if (
        render.outputColorSpace !== undefined &&
        !OUTPUT_COLOR_SPACES.includes(render.outputColorSpace as OutputColorSpace)
      )
        errors.push(`$.render.outputColorSpace: must be one of ${OUTPUT_COLOR_SPACES.join(", ")}`);
      if (render.shadowMap !== undefined && typeof render.shadowMap !== "boolean")
        errors.push("$.render.shadowMap: must be a boolean when present");
      if (
        render.shadowMapType !== undefined &&
        (render.shadowMap !== true ||
          !["PCFShadowMap", "PCFSoftShadowMap"].includes(render.shadowMapType as string))
      )
        errors.push(
          "$.render.shadowMapType: PCFShadowMap or PCFSoftShadowMap, and only with shadowMap true",
        );
    }
  }

  const tolerance = record(root.tolerance);
  if (root.tolerance === undefined) errors.push("$.tolerance: required");
  else if (tolerance.abs === undefined && tolerance.ulps === undefined)
    errors.push("$.tolerance: needs at least one of abs or ulps");
  for (const key of ["abs", "ulps"] as const) {
    if (tolerance[key] !== undefined && !nonNegative(tolerance[key]))
      errors.push(`$.tolerance.${key}: must be a non-negative finite number`);
  }

  if (!Array.isArray(root.ops) || root.ops.length === 0)
    errors.push("$.ops: required, and a fixture with no operations has nothing to observe");
  if (!Array.isArray(root.observe) || root.observe.length === 0)
    errors.push("$.observe: required, and a fixture with no observations asserts nothing");

  // Ids are resolved as operations are read, so a reference can only name something that exists.
  const defined = new Set<string>();
  const bind = (id: unknown, path: string): void => {
    if (typeof id !== "string" || !TOKEN.test(id)) {
      errors.push(`${path}: required, and must match /^[A-Za-z_$][\\w$]*$/`);
      return;
    }
    if (defined.has(id)) {
      errors.push(`${path}: id ${id} is already bound`);
      return;
    }
    defined.add(id);
  };
  const argument = (arg: unknown, path: string): void => {
    if (arg === null || typeof arg === "boolean" || typeof arg === "string") return;
    if (typeof arg === "number") {
      if (!Number.isFinite(arg))
        errors.push(`${path}: write ${String(arg)} as { "num": "${String(arg)}" }`);
      return;
    }
    const node = record(arg);
    const keys = Object.keys(node);
    if (keys.length === 1 && "ref" in node) {
      if (typeof node.ref !== "string" || !TOKEN.test(node.ref))
        errors.push(`${path}.ref: required, and must match /^[A-Za-z_$][\\w$]*$/`);
      else if (!defined.has(node.ref)) errors.push(`${path}.ref: ${node.ref} is not a bound id`);
      return;
    }
    if (keys.length === 1 && "num" in node) {
      if (!FIXTURE_NUMBER_NAMES.includes(node.num as FixtureNumberName))
        errors.push(`${path}.num: must be one of ${FIXTURE_NUMBER_NAMES.join(", ")}`);
      return;
    }
    if (keys.length === 2 && "array" in node && "type" in node) {
      if (!FIXTURE_ARRAY_TYPES.includes(node.type as FixtureArrayType))
        errors.push(`${path}.type: must be one of ${FIXTURE_ARRAY_TYPES.join(", ")}`);
      if (
        !Array.isArray(node.array) ||
        !node.array.every((value) => typeof value === "number" && Number.isFinite(value))
      )
        errors.push(`${path}.array: must be an array of finite numbers`);
      return;
    }
    if (keys.length === 1 && "refs" in node) {
      if (!Array.isArray(node.refs)) {
        errors.push(`${path}.refs: must be an array of bound ids`);
        return;
      }
      for (const [index, id] of node.refs.entries()) {
        if (typeof id !== "string" || !TOKEN.test(id) || !defined.has(id))
          errors.push(`${path}.refs[${index}]: ${String(id)} is not a bound id`);
      }
      return;
    }
    if (keys.length === 1 && "record" in node) {
      const fields = record(node.record);
      if (node.record === null || typeof node.record !== "object" || Array.isArray(node.record))
        errors.push(`${path}.record: must be an object of scalars`);
      for (const [key, value] of Object.entries(fields)) {
        if (!TOKEN.test(key))
          errors.push(`${path}.record.${key}: keys must match /^[A-Za-z_$][\\w$]*$/`);
        const scalar =
          value === null ||
          ["boolean", "string"].includes(typeof value) ||
          (typeof value === "number" && Number.isFinite(value));
        if (!scalar)
          errors.push(`${path}.record.${key}: must be a finite number, string, boolean or null`);
      }
      return;
    }
    errors.push(
      `${path}: must be a number, string, boolean, null, { "ref": id }, { "num": name }, { "array": [...], "type": name }, { "refs": [...] } or { "record": {...} }`,
    );
  };

  for (const [index, op] of (Array.isArray(root.ops) ? root.ops : []).entries()) {
    const at = `$.ops[${index}]`;
    const node = record(op);
    const args = node.args === undefined ? [] : node.args;
    if (node.op === "gltf") {
      if (typeof node.file !== "string" || !GLTF_FILE.test(node.file))
        errors.push(`${at}.file: required, a repository-relative .glb or .gltf path`);
      bind(node.id, `${at}.id`);
      if (node.clips !== undefined) {
        if (!Array.isArray(node.clips)) errors.push(`${at}.clips: must be an array of ids`);
        else node.clips.forEach((clip, i) => bind(clip, `${at}.clips[${i}]`));
      }
      continue;
    }
    if (node.op === "tsl") {
      if (typeof node.program !== "string" || !TSL_PROGRAM.test(node.program))
        errors.push(`${at}.program: required, a TSL program name`);
      if (typeof node.id !== "string" || !defined.has(node.id))
        errors.push(`${at}.id: must name an id bound earlier`);
      continue;
    }
    if (node.op !== "new" && node.op !== "call" && node.op !== "set") {
      errors.push(`${at}.op: must be new, call, set, gltf or tsl`);
      continue;
    }
    if (!Array.isArray(args)) errors.push(`${at}.args: must be an array`);
    else args.forEach((arg, position) => argument(arg, `${at}.args[${position}]`));

    if (node.op === "new") {
      if (typeof node.class !== "string" || !TOKEN.test(node.class))
        errors.push(`${at}.class: required, and must match /^[A-Za-z_$][\\w$]*$/`);
      bind(node.id, `${at}.id`);
      continue;
    }
    if (typeof node.id !== "string" || !defined.has(node.id)) {
      errors.push(`${at}.id: ${JSON.stringify(node.id)} is not a bound id`);
    }
    if (node.op === "call" && (typeof node.method !== "string" || !TOKEN.test(node.method)))
      errors.push(`${at}.method: required, and must match /^[A-Za-z_$][\\w$]*$/`);
    if (node.op === "call" && node.result !== undefined) bind(node.result, `${at}.result`);
    if (node.op === "set") {
      if (typeof node.path !== "string" || !isPath(node.path))
        errors.push(`${at}.path: required, and must be dotted identifiers or indices`);
      argument(node.value, `${at}.value`);
    }
  }

  let pixels = 0;
  for (const [index, observation] of (Array.isArray(root.observe) ? root.observe : []).entries()) {
    const at = `$.observe[${index}]`;
    const node = record(observation);
    if (typeof node.id !== "string" || !defined.has(node.id))
      errors.push(`${at}.id: ${JSON.stringify(node.id)} is not a bound id`);
    if (!OBSERVATION_KINDS.includes(node.kind as ObservationKind))
      errors.push(`${at}.kind: must be one of ${OBSERVATION_KINDS.join(", ")}`);
    const hasPath = node.path !== undefined;
    const hasMethod = node.method !== undefined;
    // Neither is legal: an id bound to a returned value (a `toArray()` array) is read directly.
    if (hasPath && hasMethod) errors.push(`${at}: path and method are mutually exclusive`);
    if (hasPath && node.path !== undefined && (typeof node.path !== "string" || !isPath(node.path)))
      errors.push(`${at}.path: required, and must be dotted identifiers or indices`);
    if (
      hasMethod &&
      node.method !== undefined &&
      (typeof node.method !== "string" || !TOKEN.test(node.method))
    )
      errors.push(`${at}.method: required, and must match /^[A-Za-z_$][\\w$]*$/`);

    // `pixels` reads the whole captured frame, not a property of one object: it names the render's
    // own scene, carries no path, and states the bounds the differential applies to the frame.
    if (node.kind === "pixels") {
      pixels += 1;
      if (render === null) errors.push(`${at}: a pixels observation needs a $.render block`);
      else if (node.id !== render.scene)
        errors.push(
          `${at}.id: a pixels observation names the rendered scene ${JSON.stringify(render.scene)}`,
        );
      if (hasPath || hasMethod)
        errors.push(`${at}: pixels is the whole frame, so path and method do not apply`);
      const metric = record(node.metric);
      if (node.metric === undefined) errors.push(`${at}.metric: required for pixels`);
      for (const key of ["maxPixelMismatchRatio", "maxPerceptualDeltaE"] as const) {
        if (!nonNegative(metric[key]) || (metric[key] as number) > 1)
          errors.push(`${at}.metric.${key}: must be a ratio between 0 and 1`);
      }
      if (metric.levels !== undefined) {
        if (
          !Number.isInteger(metric.levels) ||
          (metric.levels as number) < 0 ||
          (metric.levels as number) > 4
        )
          errors.push(`${at}.metric.levels: must be an integer between 0 and 4`);
        else if (
          (metric.levels as number) > 0 &&
          (typeof metric.levelsReason !== "string" || metric.levelsReason.trim() === "")
        )
          errors.push(`${at}.metric.levelsReason: required when levels is above 0`);
      }
      continue;
    }
    if (node.metric !== undefined)
      errors.push(`${at}.metric: only a pixels observation carries a metric`);
  }
  // A captured frame nothing observes is a frame nobody compared.
  if (render !== null && pixels === 0)
    errors.push("$.render: a render block needs a pixels observation naming its scene");
  return errors;
}

/** Parses a fixture or throws. One error message names every disagreement. */
export function parseFixture(value: unknown, expectedName?: string): IFixture {
  const errors = fixtureErrors(value, expectedName);
  if (errors.length > 0)
    throw new Error(`TN_FIXTURE_INVALID:\n${errors.map((line) => `  ${line}`).join("\n")}`);
  return value as IFixture;
}

/** The reasons a golden cannot be trusted. A blocked golden is the only one with no observations. */
export function goldenErrors(value: unknown, expectedName?: string): readonly string[] {
  const errors: string[] = [];
  const root = record(value);
  if (typeof root.name !== "string" || !NAME.test(root.name)) errors.push("$.name: required");
  else if (expectedName !== undefined && root.name !== expectedName)
    errors.push(`$.name: ${root.name} does not match its file name ${expectedName}`);
  if (typeof root.threeVersion !== "string" || root.threeVersion === "")
    errors.push("$.threeVersion: required, and must record the reference version");
  if (root.blocked !== null && typeof root.blocked !== "string")
    errors.push("$.blocked: must be null or a reason");
  const observations = root.observations;
  let pixels = false;
  if (!Array.isArray(observations)) errors.push("$.observations: must be an array");
  else {
    if (root.blocked === null && observations.length === 0)
      errors.push("$.observations: a golden that ran asserts nothing");
    observations.forEach((entry, index) => {
      const node = record(entry);
      if (!Number.isInteger(node.index) || node.index !== index)
        errors.push(`$.observations[${index}].index: must equal ${index}`);
      if (!OBSERVATION_KINDS.includes(node.kind as ObservationKind))
        errors.push(
          `$.observations[${index}].kind: must be one of ${OBSERVATION_KINDS.join(", ")}`,
        );
      if (typeof node.id !== "string" || !TOKEN.test(node.id))
        errors.push(`$.observations[${index}].id: required`);
      if (typeof node.value !== "string" || node.value === "")
        errors.push(`$.observations[${index}].value: required`);
      if (node.kind === "pixels") pixels = true;
    });
  }
  // A pixels observation is a claim about a file on disk: without the file's hash and the adapter
  // that drew it, the claim is a number nobody can check.
  const render = record(root.render);
  if (pixels) {
    if (root.render === undefined) errors.push("$.render: required when an observation is pixels");
    else {
      if (typeof render.png !== "string" || render.png === "")
        errors.push("$.render.png: required, and must name the capture file");
      if (typeof render.pngSha256 !== "string" || !SHA256.test(render.pngSha256))
        errors.push("$.render.pngSha256: required, and must be 64 lowercase hex digits");
      for (const key of ["width", "height"] as const)
        if (!Number.isInteger(render[key]) || (render[key] as number) < 1)
          errors.push(`$.render.${key}: required, and must be a positive integer`);
      if (record(render.adapter).vendor === undefined)
        errors.push("$.render.adapter: required, and must record what navigator.gpu reported");
    }
  } else if (root.render !== undefined)
    errors.push("$.render: only a golden with a pixels observation carries a render block");
  return errors;
}

export function parseGolden(value: unknown, expectedName?: string): IFixtureGolden {
  const errors = goldenErrors(value, expectedName);
  if (errors.length > 0)
    throw new Error(`TN_GOLDEN_INVALID:\n${errors.map((line) => `  ${line}`).join("\n")}`);
  return value as IFixtureGolden;
}

/**
 * The reference version goldens are keyed by: the workspace catalog pin.
 *
 * `three` is not hoisted, so each package that declares `three: catalog:` owns its own link to the
 * same store copy. This reads the pin the way `run-conformance.mjs` does, so a golden can never be
 * recorded against a version the workspace does not name.
 */
export function pinnedThreeVersion(root: string = REPO_ROOT): string {
  const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const version = workspace.match(/^\s*three:\s*['"]?([^\s'"]+)['"]?\s*$/mu)?.[1];
  if (version === undefined)
    throw new Error(
      `TN_FIXTURE_THREE_UNPINNED: ${path.join(root, "pnpm-workspace.yaml")} has no three pin`,
    );
  return version;
}

export function goldenPath(name: string, version: string): string {
  return path.join(GOLDENS_DIR, version, `${name}.json`);
}

export function readGolden(name: string, version: string): IFixtureGolden | null {
  const file = goldenPath(name, version);
  if (!existsSync(file)) return null;
  return parseGolden(JSON.parse(readFileSync(file, "utf8")), name);
}

export function writeGolden(golden: IFixtureGolden, version: string): string {
  const file = goldenPath(golden.name, version);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
  return file;
}

/** The captured frame, beside the JSON golden that names its hash. Never inside `artifacts/`. */
export function renderPngPath(name: string, version: string): string {
  return path.join(GOLDENS_DIR, version, `${name}.png`);
}

export function writeRenderPng(name: string, version: string, png: Uint8Array): string {
  const file = renderPngPath(name, version);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, png);
  return file;
}

/**
 * Every fixture in the corpus, sorted by name, each parsed against its own file name.
 *
 * The sort is on the bare name, not on the file name: `"a-b.json"` sorts before `"a.json"` because
 * `-` is below `.`, and the conformance parent orders its rows by bare name too.
 */
export function loadFixtures(directory: string = FIXTURES_DIR): readonly IFixture[] {
  const names = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"))
    .sort();
  if (names.length === 0) throw new Error(`TN_FIXTURE_EMPTY: ${directory} holds no fixtures`);
  return names.map((name) =>
    parseFixture(JSON.parse(readFileSync(path.join(directory, `${name}.json`), "utf8")), name),
  );
}

/** The distance between two doubles in representable steps. Used by a `ulps` tolerance. */
export function ulpDistance(left: number, right: number): number {
  const ordered = (value: number): bigint => {
    BUFFER.setFloat64(0, value, false);
    const bits = BUFFER.getBigUint64(0, false);
    return bits >= 0x8000000000000000n ? bits - 0x8000000000000000n : -(bits & 0x7fffffffffffffffn);
  };
  const distance = ordered(left) - ordered(right);
  return Number(distance < 0n ? -distance : distance);
}
