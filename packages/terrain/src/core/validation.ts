import { MATERIAL_IDS } from "./masks.js";
import { OPERATION_TYPES, followsTerrain } from "./operations.js";
import type {
  IMask,
  IMaterialRule,
  ITerrainConfig,
  ITerrainDocument,
  Layer,
  MaskType,
  OperationType,
} from "./types.js";

/** Valid grid resolutions: vertices per side, not cells. */
export const RESOLUTIONS: readonly number[] = Object.freeze([17, 33, 65, 129, 257, 513, 1025]);

const brush = [
  "at",
  "points",
  "radius",
  "strength",
  "falloff",
  "shape",
  "rotation",
  "spacing",
  "jitter",
];

/** Terrain-following grading, shared by the spline operations. */
const grade = ["followTerrain", "maxGrade", "maxCut", "maxFill"];

/** The parameters each operation accepts. Anything else is rejected before the state changes. */
export const PARAMS: Readonly<Record<OperationType, readonly string[]>> = Object.freeze({
  noise: [
    "amplitude",
    "scale",
    "octaves",
    "persistence",
    "lacunarity",
    "mode",
    "warp",
    "base",
    "blend",
    "island",
    "coastDepth",
  ],
  sculpt: brush,
  smooth: [...brush, "iterations"],
  flatten: [...brush, "height"],
  paint: [...brush, "material"],
  stamp: [
    "at",
    "radius",
    "size",
    "amplitude",
    "shape",
    "rotation",
    "mirrorX",
    "mirrorZ",
    "blend",
    "roughness",
    "scale",
    "offset",
    "data",
    "falloff",
  ],
  paste: [
    "at",
    "size",
    "radius",
    "rotation",
    "mirrorX",
    "mirrorZ",
    "blend",
    "offset",
    "scale",
    "data",
    "falloff",
  ],
  erode: [
    ...brush,
    "method",
    "iterations",
    "talus",
    "rate",
    "droplets",
    "maxSteps",
    "inertia",
    "capacity",
    "erosion",
    "deposition",
    "evaporation",
  ],
  terrace: ["step", "softness", "strength", "offset"],
  materials: ["base", "rules", "reset"],
  biome: [...brush, "name", "value"],
  scatter: [
    "asset",
    "count",
    "minDistance",
    "scale",
    "minHeight",
    "maxHeight",
    "minSlope",
    "maxSlope",
    "avoidWater",
    "offsetY",
    "alignToNormal",
  ],
  clear: ["target", "asset", "name"],
  road: ["points", "width", "shoulder", "material", "smooth", ...grade],
  river: [
    "points",
    "width",
    "shoulder",
    "depth",
    "material",
    "smooth",
    "water",
    "waterWidth",
    "color",
    "enforceDownhill",
    ...grade,
  ],
  ramp: ["from", "to", "width", "shoulder", "material", ...grade],
  water: ["kind", "at", "radius", "level", "color"],
  heightmap: ["data", "scale", "offset", "blend", "at", "size", "rotation", "falloff"],
});

function fail(message: string): never {
  throw new TypeError(message);
}

/** Rejects anything a recipe cannot round-trip: non-finite numbers, views, cycles, unsafe keys. */
export function finiteTree(value: unknown, path = "value", depth = 0): void {
  if (depth > 32) fail(`${path}: nesting is too deep`);
  if (typeof value === "number" && !Number.isFinite(value)) fail(`${path} must be finite`);
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  )
    fail(`${path} is not JSON-serializable`);
  if (value && typeof value === "object") {
    if (ArrayBuffer.isView(value)) fail(`${path}: use a plain array in recipes`);
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        fail(`${path}: unsafe object key`);
      finiteTree(entry, `${path}.${key}`, depth + 1);
    }
  }
}

const num = (v: unknown, name: string, min = -1e9, max = 1e9, integer = false): void => {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < min ||
    v > max ||
    (integer && !Number.isInteger(v))
  )
    fail(`${name} must be ${integer ? "an integer" : "finite"} between ${min} and ${max}`);
};

const vec = (v: unknown, name: string, n: number): void => {
  if (!Array.isArray(v) || v.length !== n) fail(`${name} must contain ${n} numbers`);
  for (const x of v) num(x, name);
};

const identifier = (v: unknown, name: string): void => {
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    v.length > 100 ||
    ["__proto__", "prototype", "constructor"].includes(v)
  )
    fail(`${name} must be a nonempty safe string, at most 100 characters`);
};

const enumeration = (v: unknown, name: string, choices: readonly string[]): void => {
  if (!choices.includes(v as string)) fail(`${name}: expected ${choices.join(", ")}`);
};

export function validateConfig(config: ITerrainConfig): void {
  num(config.size, "size", 1, 100000);
  if (!RESOLUTIONS.includes(config.resolution))
    fail(`resolution must be one of ${RESOLUTIONS.join(", ")}`);
  num(config.seed, "seed", 0, 4294967295, true);
}

/** Validates one mask expression; `validateMask` is the only mask entry point. */
export function validateMask(m: IMask, depth = 0): void {
  if (!m || typeof m !== "object" || depth > 20) fail("Invalid mask");
  enumeration(m.type, "mask.type", [
    "all",
    "none",
    "circle",
    "rectangle",
    "height",
    "slope",
    "noise",
    "biome",
    "material",
    "and",
    "or",
    "not",
  ]);
  const allowed: Readonly<Record<MaskType, readonly string[]>> = {
    all: [],
    none: [],
    circle: ["at", "radius", "falloff"],
    rectangle: ["at", "size", "rotation", "falloff"],
    height: ["min", "max", "fade"],
    slope: ["min", "max", "fade"],
    noise: ["scale", "threshold", "seed", "fade"],
    biome: ["name"],
    material: ["name"],
    and: ["masks"],
    or: ["masks"],
    not: ["mask"],
  };
  for (const key of Object.keys(m))
    if (key !== "type" && !allowed[m.type].includes(key)) fail(`Unknown mask field '${key}'`);
  if (m.rotation !== undefined) num(m.rotation, "mask.rotation");
  if (m.seed !== undefined) num(m.seed, "mask.seed", 0, 4294967295, true);
  if (m.type === "circle") {
    vec(m.at, "mask.at", 2);
    num(m.radius, "mask.radius", 0.001, 1e6);
  }
  if (m.type === "rectangle") {
    vec(m.at, "mask.at", 2);
    const size = m.size;
    if (Array.isArray(size)) {
      vec(size, "mask.size", 2);
      for (const value of size) num(value, "mask.size", 0.001, 1e6);
    } else num(size, "mask.size", 0.001, 1e6);
  }
  if (["height", "slope"].includes(m.type)) {
    if (m.min !== undefined) num(m.min, "mask.min");
    if (m.max !== undefined) num(m.max, "mask.max");
    if ((m.min ?? -1e9) > (m.max ?? 1e9)) fail("mask.min must not exceed mask.max");
    if (m.fade !== undefined) num(m.fade, "mask.fade", 0, 1e6);
  }
  if (m.type === "noise") {
    num(m.scale, "mask.scale", 0.001, 1e6);
    if (m.threshold !== undefined) num(m.threshold, "mask.threshold", 0, 1);
    if (m.fade !== undefined) num(m.fade, "mask.fade", 0.000001, 1);
  }
  if (m.type === "biome") identifier(m.name, "mask.name");
  if (m.type === "material") enumeration(m.name, "mask.material", MATERIAL_IDS);
  if (m.type === "not") validateMask(m.mask as IMask, depth + 1);
  if (["and", "or"].includes(m.type)) {
    if (!Array.isArray(m.masks) || m.masks.length > 32)
      fail("mask.masks must be an array of at most 32 masks");
    for (const entry of m.masks) validateMask(entry, depth + 1);
  }
  if (m.falloff !== undefined) num(m.falloff, "mask.falloff", 0, 1);
}

/** A control point: X and Z are always metres; Y may only be left out when the spline follows. */
function splinePoint(v: unknown, name: string, follows: boolean): void {
  if (!Array.isArray(v) || v.length !== 3) fail(`${name} must contain 3 numbers`);
  num(v[0], name);
  num(v[2], name);
  const y = v[1];
  if (y === null || y === undefined) {
    if (follows) return;
    fail(`${name} must contain 3 numbers`);
  }
  if (typeof y !== "number") fail(`${name} must contain 3 numbers`);
  if (!Number.isFinite(y) && !follows) fail(`${name} elevation must be finite`);
}

/** Whether a spline layer grades itself to the ground it crosses. */
function layerFollowsTerrain(layer: Layer): boolean {
  if (!layer || typeof layer !== "object" || !["road", "river", "ramp"].includes(layer.type))
    return false;
  const params = (layer.params ?? {}) as Record<string, unknown>;
  const source = (layer.type === "ramp" ? [params.from, params.to] : params.points) as
    | readonly (readonly [number, number, number | null])[]
    | undefined;
  if (!Array.isArray(source)) return false;
  return followsTerrain(source, params.followTerrain as boolean | undefined);
}

/**
 * `finiteTree` cannot tell an elevation the recipe left out from a mistake, so a document is
 * checked against a copy whose omitted slots read zero. The evaluator takes the ground there.
 */
function omittedElevations(layer: Layer, follows: boolean): unknown {
  if (!follows) return layer;
  const params = (layer.params ?? {}) as Record<string, unknown>;
  const zero = (p: unknown): unknown => (Array.isArray(p) && p.length === 3 ? [p[0], 0, p[2]] : p);
  const points = params.points;
  const fixes = {
    ...(Array.isArray(points) ? { points: points.map(zero) } : {}),
    ...(Array.isArray(params.from) ? { from: zero(params.from) } : {}),
    ...(Array.isArray(params.to) ? { to: zero(params.to) } : {}),
  };
  return Object.keys(fixes).length ? { ...layer, params: { ...params, ...fixes } } : layer;
}

/** Validates one recipe layer against its operation's allow-list, bounds and enum values. */
export function validateLayer(layer: Layer): void {
  const follows = layerFollowsTerrain(layer);
  finiteTree(omittedElevations(layer, follows), "layer");
  if (!layer || typeof layer !== "object") fail("layer must be an object");
  for (const k of Object.keys(layer))
    if (!["id", "name", "type", "params", "enabled", "opacity", "mask"].includes(k))
      fail(`Unknown layer field '${k}'`);
  identifier(layer.id, "layer.id");
  enumeration(layer.type, "operation", OPERATION_TYPES);
  if (layer.name !== undefined) identifier(layer.name, "layer.name");
  if (layer.enabled !== undefined && typeof layer.enabled !== "boolean")
    fail("enabled must be boolean");
  if (layer.opacity !== undefined) num(layer.opacity, "opacity", 0, 1);
  if (layer.mask) validateMask(layer.mask);
  const params = (layer.params ?? {}) as Record<string, unknown>;
  if (!params || Array.isArray(params) || typeof params !== "object")
    fail("params must be an object");
  for (const k of Object.keys(params))
    if (!PARAMS[layer.type].includes(k) && k !== "seed")
      fail(`Unknown ${layer.type} parameter '${k}'`);
  for (const key of [
    "island",
    "mirrorX",
    "mirrorZ",
    "reset",
    "avoidWater",
    "alignToNormal",
    "smooth",
    "water",
    "enforceDownhill",
    "followTerrain",
  ])
    if (params[key] !== undefined && typeof params[key] !== "boolean")
      fail(`${key} must be boolean`);
  if (params.seed !== undefined) num(params.seed, "seed", 0, 4294967295, true);
  if (params.at !== undefined) vec(params.at, "at", 2);
  if (params.from !== undefined) splinePoint(params.from, "from", follows);
  if (params.to !== undefined) splinePoint(params.to, "to", follows);
  const points = params.points;
  const isSpline = ["road", "river"].includes(layer.type);
  if (points) {
    if (!Array.isArray(points) || !points.length || points.length > 8192)
      fail("points must have 1..8192 entries");
    const dimensions = isSpline ? 3 : 2;
    for (const point of points)
      if (isSpline) splinePoint(point, "point", follows);
      else vec(point, "point", dimensions);
  }
  if (Array.isArray(points) && !isSpline) {
    const stroke = points as readonly (readonly number[])[];
    const spacing = Math.max(
      0.1,
      ((params.radius ?? 30) as number) * 2 * ((params.spacing ?? 0.15) as number),
    );
    let samples = 1;
    for (let k = 1; k < stroke.length; k += 1) {
      const next = stroke[k] as readonly number[];
      const previous = stroke[k - 1] as readonly number[];
      samples += Math.max(
        1,
        Math.ceil(
          Math.hypot(
            (next[0] as number) - (previous[0] as number),
            (next[1] as number) - (previous[1] as number),
          ) / spacing,
        ),
      );
    }
    if (samples > 65536)
      fail(
        "Brush interpolation exceeds 65536 samples; increase radius/spacing or shorten the stroke",
      );
  }
  if (isSpline && (!Array.isArray(points) || points.length < 2))
    fail(`${layer.type} requires at least two [x,y,z] points`);
  if (layer.type === "ramp" && (!params.from || !params.to)) fail("ramp requires from and to");
  for (const key of ["radius", "size"]) {
    const value = params[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      vec(value, key, 2);
      for (const entry of value) num(entry, key, 0.001, 1e6);
    } else num(value, key, 0.001, 1e6);
  }
  if (Array.isArray(params.radius) && !["stamp", "paste"].includes(layer.type))
    fail("Brush radius must be one number");
  for (const key of [
    "amplitude",
    "height",
    "base",
    "offset",
    "offsetY",
    "minHeight",
    "maxHeight",
    "level",
    "rotation",
  ])
    if (params[key] !== undefined && !(key === "base" && layer.type === "materials"))
      if (params[key] !== null || key !== "height") num(params[key], key);
  for (const key of ["width", "step"])
    if (params[key] !== undefined) num(params[key], key, 0.001, 1e6);
  for (const key of [
    "warp",
    "shoulder",
    "roughness",
    "coastDepth",
    "minDistance",
    "depth",
    "capacity",
    "maxCut",
    "maxFill",
  ])
    if (params[key] !== undefined) num(params[key], key, 0, 1e6);
  for (const key of [
    "falloff",
    "jitter",
    "softness",
    "inertia",
    "erosion",
    "deposition",
    "evaporation",
    "rate",
    "value",
    "waterWidth",
    "maxGrade",
  ])
    if (params[key] !== undefined) num(params[key], key, 0, 1);
  if (params.spacing !== undefined) num(params.spacing, "spacing", 0.01, 2);
  if (params.strength !== undefined)
    num(
      params.strength,
      "strength",
      layer.type === "sculpt" ? -10000 : 0,
      layer.type === "sculpt" ? 10000 : 1,
    );
  if (params.scale !== undefined) {
    const scale = params.scale;
    if (layer.type === "scatter") {
      if (Array.isArray(scale)) {
        vec(scale, "scale", 2);
        if ((scale[0] as number) > (scale[1] as number)) fail("scale range is inverted");
        for (const entry of scale) num(entry, "scale", 0.001, 1e4);
      } else num(scale, "scale", 0.001, 1e4);
    } else num(scale, "scale", 0.001, 1e6);
  }
  for (const [key, max] of [
    ["octaves", 10],
    ["iterations", 200],
    ["droplets", 200000],
    ["maxSteps", 128],
    ["count", 20000],
  ] as const)
    if (params[key] !== undefined) num(params[key], key, key === "count" ? 0 : 1, max, true);
  if (params.persistence !== undefined) num(params.persistence, "persistence", 0.01, 1);
  if (params.lacunarity !== undefined) num(params.lacunarity, "lacunarity", 1, 4);
  for (const key of ["minSlope", "maxSlope", "talus"])
    if (params[key] !== undefined) num(params[key], key, 0, key === "talus" ? 89.9 : 90);
  if (
    params.minHeight !== undefined &&
    params.maxHeight !== undefined &&
    (params.minHeight as number) > (params.maxHeight as number)
  )
    fail("height range is inverted");
  if (
    params.minSlope !== undefined &&
    params.maxSlope !== undefined &&
    (params.minSlope as number) > (params.maxSlope as number)
  )
    fail("slope range is inverted");
  if (params.material !== undefined) enumeration(params.material, "material", MATERIAL_IDS);
  if (layer.type === "materials") {
    if (params.base !== undefined) enumeration(params.base, "base", MATERIAL_IDS);
    const rules = params.rules;
    if (!Array.isArray(rules) || rules.length > 64) fail("materials requires a rules array");
    for (const rule of rules as IMaterialRule[]) {
      enumeration(rule.material, "rule.material", MATERIAL_IDS);
      if (rule.mask) validateMask(rule.mask);
      if (rule.strength !== undefined) num(rule.strength, "rule.strength", 0, 1);
    }
  }
  if (params.method !== undefined) enumeration(params.method, "method", ["thermal", "hydraulic"]);
  if (params.mode !== undefined) enumeration(params.mode, "mode", ["fbm", "ridged", "billow"]);
  if (params.shape !== undefined)
    enumeration(
      params.shape,
      "shape",
      ["stamp"].includes(layer.type)
        ? ["mountain", "crater", "ridge", "valley", "mesa", "dune"]
        : ["circle", "square"],
    );
  if (params.blend !== undefined)
    enumeration(
      params.blend,
      "blend",
      ["noise", "heightmap"].includes(layer.type)
        ? ["add", "replace"]
        : ["add", "replace", "min", "max"],
    );
  if (layer.type === "clear")
    enumeration(params.target, "clear.target", ["scatter", "paint", "biome", "all"]);
  if (layer.type === "water") enumeration(params.kind ?? "lake", "water.kind", ["lake", "ocean"]);
  if (layer.type === "river" && params.enforceDownhill && Array.isArray(points)) {
    const river = points as readonly (readonly number[])[];
    for (let i = 1; i < river.length; i += 1) {
      const next = river[i] as readonly number[];
      const previous = river[i - 1] as readonly number[];
      if ((next[1] as number) > (previous[1] as number))
        fail("River control-point elevations must be non-increasing");
    }
  }
  if (params.name !== undefined) identifier(params.name, "name");
  if (params.asset !== undefined) identifier(params.asset, "asset");
  if (["heightmap", "paste"].includes(layer.type) && !params.data)
    fail(`${layer.type} requires heightmap data`);
  const data = params.data as
    | { width: number; height: number; values: readonly number[] }
    | undefined;
  if (data) {
    num(data.width, "data.width", 2, 4097, true);
    num(data.height, "data.height", 2, 4097, true);
    if (!Array.isArray(data.values) || data.values.length !== data.width * data.height)
      fail("heightmap dimensions do not match values");
    for (const value of data.values)
      if (typeof value !== "number" || !Number.isFinite(value))
        fail("data.values must contain only finite numbers");
  }
}

/** Validates a whole recipe: version, config, layer count and unique layer IDs. */
/**
 * Validates the recovered recipe schema, operation allow-lists and numeric bounds.
 * @requires npm i @threenative/terrain
 * @situation validate a terrain document before accepting an authoring write
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example validateDocument(new Terrain({ resolution: 17 }).toJSON());
 */
export function validateDocument(doc: ITerrainDocument): void {
  finiteTree(
    Array.isArray(doc.layers)
      ? {
          ...doc,
          layers: doc.layers.map((layer) => omittedElevations(layer, layerFollowsTerrain(layer))),
        }
      : doc,
    "recipe",
  );
  if (doc.version !== 1) fail("Unsupported recipe version; expected 1");
  validateConfig(doc.config);
  if (!Array.isArray(doc.layers) || doc.layers.length > 512)
    fail("layers must be an array of at most 512 layers");
  const ids = new Set<string>();
  for (const layer of doc.layers) {
    validateLayer(layer);
    if (ids.has(layer.id)) fail(`Duplicate layer ID: ${layer.id}`);
    ids.add(layer.id);
  }
}
