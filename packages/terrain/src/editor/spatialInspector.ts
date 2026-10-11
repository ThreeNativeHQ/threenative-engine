import { gradientAt, sampleHeight } from "../core/math.js";
import type { ITerrainState } from "../core/types.js";

/** A labelled point shared between a reference image and local world metres. */
export interface ISpatialControlPoint {
  readonly id: string;
  /** `[u, v]` image pixels. */
  readonly image: readonly [number, number];
  /** `[x, z]` local metres, Y up, centred on the terrain origin. */
  readonly world: readonly [number, number];
}

/**
 * A bounded local reference image saved with the document.
 * `screenshot` is a perspective view reference; only a `top-down-map` is metric.
 */
export interface ISpatialReference {
  readonly id: string;
  readonly kind: "top-down-map" | "screenshot";
  /** Content hash of the imported image; different pixels are a different reference. */
  readonly hash: string;
  /** Where the image came from, in the author's words. */
  readonly source: string;
  /** Vertical datum. `null` means unknown, never zero. */
  readonly datum?: string | null;
  /** Horizontal residual budget for a checkpoint to count as aligned. Defaults to 1 m. */
  readonly toleranceMetres?: number;
  /** Two distinct controls fit scale, rotation and translation; more are reported, not fitted. */
  readonly controls: readonly ISpatialControlPoint[];
  /** An independent check point, never used to fit. Without one the fit is uncalibrated. */
  readonly checkpoint?: ISpatialControlPoint | null;
}

/** A validated reference: every optional field resolved, unknown datum kept as `null`. */
export type ISavedSpatialReference = ISpatialReference & {
  readonly datum: string | null;
  readonly toleranceMetres: number;
  readonly checkpoint: ISpatialControlPoint | null;
};

export type ISpatialQuery =
  | { readonly kind: "point"; readonly at: readonly number[] }
  | {
      readonly kind: "profile";
      readonly from: readonly number[];
      readonly to: readonly number[];
      readonly samples?: number;
    }
  | { readonly kind: "reference"; readonly reference: ISpatialReference };

/** One measured surface value, labelled with the sampler that produced it. */
export interface ISurfaceReading {
  readonly source: "bilinear-heightfield" | "evaluated-triangle";
  readonly height: number;
  readonly slopeDeg: number;
  /** Compass degrees clockwise from -Z. `null` on flat ground, where it is undefined. */
  readonly aspectDeg: number | null;
  readonly normal: readonly [number, number, number];
}

export interface IPointObservation {
  readonly kind: "point";
  readonly revision: string;
  readonly units: "metres";
  readonly resolution: number;
  readonly at: readonly [number, number];
  readonly bilinear: ISurfaceReading;
  readonly triangle: ISurfaceReading;
  /** `triangle.height - bilinear.height`; non-zero inside a non-planar cell. */
  readonly difference: number;
  readonly datum: string | null;
  readonly labels: readonly string[];
}

export interface IProfileSample {
  /** Horizontal distance from `from`, in metres. */
  readonly distance: number;
  /** Distance walked along the measured surface so far. */
  readonly surfaceDistance: number;
  readonly height: number;
  readonly slopeDeg: number;
}

export interface IProfileObservation {
  readonly kind: "profile";
  readonly revision: string;
  readonly units: "metres";
  readonly resolution: number;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly sampleCount: number;
  readonly horizontalDistance: number;
  readonly surfaceDistance: number;
  readonly minElevation: number;
  readonly maxElevation: number;
  readonly maxGradeDeg: number;
  readonly samples: readonly IProfileSample[];
  readonly datum: string | null;
  readonly labels: readonly string[];
}

export interface IReferenceObservation {
  readonly kind: "reference";
  readonly revision: string;
  readonly units: "metres";
  readonly id: string;
  readonly source: string;
  readonly hash: string;
  readonly metric: boolean;
  /** Smallest 2D similarity from the two fit controls. `null` until two distinct ones exist. */
  readonly fit: {
    readonly scaleMetresPerPixel: number | null;
    readonly rotationDegrees: number | null;
    /** The fit never mirrors an image; a mirrored sheet is reported, not silently applied. */
    readonly mirrored: false;
  } | null;
  readonly controlResidualMetres: number | null;
  readonly landmarks: readonly {
    readonly id: string;
    readonly role: "control" | "checkpoint";
    readonly image: readonly [number, number];
    readonly world: readonly [number, number];
    /** `null` until two distinct controls exist; never a fabricated zero. */
    readonly fitted: readonly [number, number] | null;
    readonly horizontalResidualMetres: number | null;
  }[];
  readonly checkpoint: {
    readonly id: string;
    readonly residualMetres: number;
    readonly withinTolerance: boolean;
  } | null;
  readonly toleranceMetres: number;
  /** Fitted controls alone are not calibration; an independent checkpoint within tolerance is. */
  readonly calibrated: boolean;
  readonly datum: string | null;
  readonly labels: readonly string[];
}

export type ISpatialObservation = IPointObservation | IProfileObservation | IReferenceObservation;

const MAX_PROFILE_SAMPLES = 1024;
const MAX_CONTROLS = 8;
/** Below this slope the downslope direction is noise, so aspect is undefined rather than north. */
const FLAT_SLOPE_DEG = 1e-6;

function point(value: unknown, name: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  )
    throw new Error(`${name} must be finite [x, z] coordinates`);
  return [value[0] as number, value[1] as number];
}

function bounded(state: ITerrainState, value: unknown, name: string): [number, number] {
  const [x, z] = point(value, name);
  const half = state.size / 2;
  if (x < -half || x > half || z < -half || z > half)
    throw new Error(`${name} [${x}, ${z}] is outside the ${state.size} m terrain extent`);
  return [x, z];
}

function normalOf(gradient: readonly [number, number]): [number, number, number] {
  const length = Math.hypot(gradient[0], 1, gradient[1]);
  return [-gradient[0] / length, 1 / length, -gradient[1] / length];
}

function reading(
  source: ISurfaceReading["source"],
  height: number,
  gradient: readonly [number, number],
): ISurfaceReading {
  const slopeDeg = (Math.atan(Math.hypot(gradient[0], gradient[1])) * 180) / Math.PI;
  return {
    source,
    height,
    slopeDeg,
    aspectDeg:
      slopeDeg < FLAT_SLOPE_DEG
        ? null
        : ((Math.atan2(-gradient[0], gradient[1]) * 180) / Math.PI + 360) % 360,
    normal: normalOf(gradient),
  };
}

/** Canonical bilinear heightfield sample; not the rendered or collidable surface. */
function bilinear(state: ITerrainState, x: number, z: number): ISurfaceReading {
  return reading("bilinear-heightfield", sampleHeight(state, x, z), gradientAt(state, x, z));
}

type Vertex = readonly [number, number, number];

/**
 * The rendered triangle under a world point: its own plane, gradient and normal.
 * Follows the baked index order (`a, c, b, b, c, d`), so the diagonal runs a -> d.
 */
function triangle(state: ITerrainState, x: number, z: number): ISurfaceReading {
  const n = state.resolution;
  const cell = state.size / (n - 1);
  const gx = Math.min(n - 2, Math.max(0, Math.floor((x + state.size / 2) / cell)));
  const gz = Math.min(n - 2, Math.max(0, Math.floor((z + state.size / 2) / cell)));
  const tx = Math.min(1, Math.max(0, (x + state.size / 2) / cell - gx));
  const tz = Math.min(1, Math.max(0, (z + state.size / 2) / cell - gz));
  const x0 = -state.size / 2 + gx * cell;
  const z0 = -state.size / 2 + gz * cell;
  const h = (ix: number, iz: number): number => state.height[(gz + iz) * n + gx + ix] as number;
  const a: Vertex = [x0, h(0, 0), z0];
  const b: Vertex = [x0 + cell, h(1, 0), z0];
  const c: Vertex = [x0, h(0, 1), z0 + cell];
  const d: Vertex = [x0 + cell, h(1, 1), z0 + cell];
  const [first, second, third] = tx + tz <= 1 ? [a, c, b] : [b, c, d];
  const u: Vertex = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
  const v: Vertex = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
  const normal: Vertex = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const length = Math.hypot(...normal) || 1;
  const nx = (normal[0] / length) as number;
  const ny = Math.abs(normal[1] / length) || 1;
  const nz = (normal[2] / length) as number;
  return reading(
    "evaluated-triangle",
    first[1] - (nx * (x - first[0]) + nz * (z - first[2])) / ny,
    [-nx / ny, -nz / ny],
  );
}

/**
 * Probe the evaluated surface at one world point, separating bilinear from triangle values.
 * @requires npm i -D @threenative/terrain
 * @situation measure an authored terrain point with provenance and a revision identity
 * @constraint authoring data only; non-finite, malformed and out-of-extent queries throw
 * @example const probe = probeTerrain(state, revision, [12, -4]);
 * @override the caller owns the revision identity and the evaluated state being inspected
 */
export function probeTerrain(
  state: ITerrainState,
  revision: string,
  at: readonly number[],
): IPointObservation {
  const [x, z] = bounded(state, at, "Point");
  const bilinearValue = bilinear(state, x, z);
  const triangleValue = triangle(state, x, z);
  return {
    kind: "point",
    revision,
    units: "metres",
    resolution: state.resolution,
    at: [x, z],
    bilinear: bilinearValue,
    triangle: triangleValue,
    difference: triangleValue.height - bilinearValue.height,
    datum: null,
    labels: ["unknown-datum"],
  };
}

function profile(
  state: ITerrainState,
  revision: string,
  query: Extract<ISpatialQuery, { kind: "profile" }>,
): IProfileObservation {
  const from = bounded(state, query.from, "Profile from");
  const to = bounded(state, query.to, "Profile to");
  const horizontalDistance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (horizontalDistance === 0) throw new Error("Profile endpoints are degenerate");
  const cell = state.size / (state.resolution - 1);
  const count =
    query.samples ?? Math.min(MAX_PROFILE_SAMPLES, Math.ceil(horizontalDistance / cell) + 1);
  if (!Number.isInteger(count) || count < 2 || count > MAX_PROFILE_SAMPLES)
    throw new Error(`Profile samples must be an integer 2–${MAX_PROFILE_SAMPLES}`);
  const step = horizontalDistance / (count - 1);
  const samples: IProfileSample[] = [];
  let surfaceDistance = 0;
  for (let index = 0; index < count; index++) {
    const distance = index * step;
    const x = from[0] + (to[0] - from[0]) * (distance / horizontalDistance);
    const z = from[1] + (to[1] - from[1]) * (distance / horizontalDistance);
    const value = bilinear(state, x, z);
    const previous = samples[index - 1];
    if (previous) {
      const run = Math.hypot(step, value.height - previous.height);
      surfaceDistance += run;
      samples[index - 1] = { ...previous, surfaceDistance };
    }
    samples.push({ distance, surfaceDistance, height: value.height, slopeDeg: value.slopeDeg });
  }
  let maxGradeDeg = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1] as IProfileSample;
    const sample = samples[index] as IProfileSample;
    maxGradeDeg = Math.max(
      maxGradeDeg,
      (Math.atan(Math.abs(sample.height - previous.height) / step) * 180) / Math.PI,
    );
  }
  const heights = samples.map((sample) => sample.height);
  return {
    kind: "profile",
    revision,
    units: "metres",
    resolution: state.resolution,
    from,
    to,
    sampleCount: count,
    horizontalDistance,
    surfaceDistance,
    minElevation: Math.min(...heights),
    maxElevation: Math.max(...heights),
    maxGradeDeg,
    samples,
    datum: null,
    labels: ["unknown-datum", "bilinear-samples"],
  };
}

function control(value: unknown, name: string): ISpatialControlPoint {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be a control point object`);
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !["id", "image", "world"].includes(key));
  if (extra.length) throw new Error(`${name} has unknown fields: ${extra.join(", ")}`);
  if (typeof input.id !== "string" || !input.id) throw new Error(`${name}.id must be a name`);
  return {
    id: input.id,
    image: point(input.image, `${name}.image`),
    world: point(input.world, `${name}.world`),
  };
}

/** Smallest 2D similarity (uniform scale, rotation, translation) from image pixels to world metres. */
function similarity(
  first: ISpatialControlPoint,
  second: ISpatialControlPoint,
): { place(image: readonly [number, number]): [number, number]; scale: number; degrees: number } {
  const image = [second.image[0] - first.image[0], second.image[1] - first.image[1]] as const;
  const world = [second.world[0] - first.world[0], second.world[1] - first.world[1]] as const;
  const imageLength = Math.hypot(...image);
  const worldLength = Math.hypot(...world);
  if (imageLength === 0 || worldLength === 0)
    throw new Error("Reference controls must be two distinct image and world positions");
  const scale = worldLength / imageLength;
  const angle = Math.atan2(world[1], world[0]) - Math.atan2(image[1], image[0]);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const offset = first.world;
  const place = (u: readonly [number, number]): [number, number] => {
    const x = scale * (cos * u[0] - sin * u[1]);
    const z = scale * (sin * u[0] + cos * u[1]);
    return [
      x + offset[0] - scale * (cos * first.image[0] - sin * first.image[1]),
      z + offset[1] - scale * (sin * first.image[0] + cos * first.image[1]),
    ];
  };
  return { place, scale, degrees: (angle * 180) / Math.PI };
}

/**
 * Normalise and validate one saved reference, exactly as a document commit would store it.
 * @requires npm i -D @threenative/terrain
 * @situation accept a bounded local reference image registration into the shared document
 * @constraint authoring metadata only; rejects unknown fields, malformed points and unknown scale
 * @example const reference = validateSpatialReference(JSON.parse(saved));
 * @override a project owns the image file; only its hash and provenance travel in the document
 */
export function validateSpatialReference(input: unknown): ISavedSpatialReference {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Reference must be an object");
  const value = input as Record<string, unknown>;
  const extra = Object.keys(value).filter(
    (key) =>
      ![
        "id",
        "kind",
        "hash",
        "source",
        "datum",
        "toleranceMetres",
        "controls",
        "checkpoint",
      ].includes(key),
  );
  if (extra.length) throw new Error(`Reference has unknown fields: ${extra.join(", ")}`);
  if (typeof value.id !== "string" || !value.id) throw new Error("Reference.id must be a name");
  if (value.kind !== "top-down-map" && value.kind !== "screenshot")
    throw new Error("Reference.kind must be 'top-down-map' or 'screenshot'");
  if (typeof value.hash !== "string" || !value.hash) throw new Error("Reference.hash must be set");
  if (typeof value.source !== "string" || !value.source)
    throw new Error("Reference.source must describe the image");
  if (
    !Array.isArray(value.controls) ||
    !value.controls.length ||
    value.controls.length > MAX_CONTROLS
  )
    throw new Error(`Reference.controls must hold 1–${MAX_CONTROLS} control points`);
  const controls = value.controls.map((entry, index) => control(entry, `controls[${index}]`));
  const checkpoint =
    value.checkpoint === undefined || value.checkpoint === null
      ? null
      : control(value.checkpoint, "checkpoint");
  if (checkpoint && controls.some((entry) => entry.id === checkpoint.id))
    throw new Error("Reference.checkpoint must be independent of the fit controls");
  const toleranceMetres =
    value.toleranceMetres === undefined ? 1 : (value.toleranceMetres as number);
  if (
    typeof toleranceMetres !== "number" ||
    !Number.isFinite(toleranceMetres) ||
    toleranceMetres <= 0
  )
    throw new Error("Reference.toleranceMetres must be a positive finite number");
  const datum = typeof value.datum === "string" && value.datum ? value.datum : null;
  return {
    id: value.id,
    kind: value.kind,
    hash: value.hash,
    source: value.source,
    datum,
    toleranceMetres,
    controls,
    checkpoint,
  };
}

function reference(revision: string, input: unknown): IReferenceObservation {
  const saved = validateSpatialReference(input);
  const labels: string[] = [];
  const { controls, checkpoint, toleranceMetres, datum } = saved;
  if (!datum) labels.push("unknown-datum");
  const metric = saved.kind === "top-down-map";
  if (!metric) labels.push("perspective");
  let transform: ReturnType<typeof similarity> | null = null;
  // A screenshot is not a plan view: it has no valid metric mapping, so none is invented.
  if (metric && controls.length >= 2)
    transform = similarity(
      controls[0] as ISpatialControlPoint,
      controls[1] as ISpatialControlPoint,
    );
  else if (metric) labels.push("insufficient-controls");
  const landmarks = [
    ...controls.map((entry) => ({ entry, role: "control" as const })),
    ...(checkpoint ? [{ entry: checkpoint, role: "checkpoint" as const }] : []),
  ].map(({ entry, role }) => {
    const fitted = transform?.place(entry.image) ?? null;
    return {
      id: entry.id,
      role,
      image: entry.image,
      world: entry.world,
      fitted,
      horizontalResidualMetres: fitted
        ? Math.hypot(fitted[0] - entry.world[0], fitted[1] - entry.world[1])
        : null,
    };
  });
  const residuals = landmarks
    .filter((entry) => entry.role === "control")
    .map((entry) => entry.horizontalResidualMetres as number);
  const checkpointEntry = checkpoint
    ? landmarks.find((entry) => entry.role === "checkpoint")
    : undefined;
  const checkpointObservation = checkpointEntry
    ? {
        id: checkpointEntry.id,
        residualMetres: checkpointEntry.horizontalResidualMetres as number,
        withinTolerance: (checkpointEntry.horizontalResidualMetres as number) <= toleranceMetres,
      }
    : null;
  if (!transform) labels.push("unscaled");
  if (!checkpoint) labels.push("no-checkpoint");
  const calibrated = Boolean(metric && transform && checkpointObservation?.withinTolerance);
  if (!calibrated) labels.push("uncalibrated");
  return {
    kind: "reference",
    revision,
    units: "metres",
    id: saved.id,
    source: saved.source,
    hash: saved.hash,
    metric,
    fit: transform
      ? {
          scaleMetresPerPixel: transform.scale,
          rotationDegrees: transform.degrees,
          mirrored: false as const,
        }
      : null,
    controlResidualMetres: residuals.length ? Math.max(...residuals) : null,
    landmarks,
    checkpoint: checkpointObservation,
    toleranceMetres,
    calibrated,
    datum,
    labels,
  };
}

/**
 * Read-only spatial inspection of one evaluated terrain revision.
 * @requires npm i -D @threenative/terrain
 * @situation measure a point, profile a transect or score a saved reference against the world
 * @constraint authoring data only; queries outside the extent or without observations throw
 * @example const observation = inspectSpatial(state, revision, { kind: "point", at: [0, 0] });
 * @override the caller owns the revision identity and the evaluated state being inspected
 */
export function inspectSpatial(
  state: ITerrainState,
  revision: string,
  query: ISpatialQuery,
): ISpatialObservation {
  if (!query || typeof query !== "object" || Array.isArray(query))
    throw new Error("Inspection query must be an object");
  switch (query.kind) {
    case "point":
      return probeTerrain(state, revision, query.at);
    case "profile":
      return profile(state, revision, query);
    case "reference":
      return reference(revision, query.reference);
    default:
      throw new Error("Unknown inspection query kind");
  }
}
