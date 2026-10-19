// PANM layout follows the MIT-licensed pinned Procedural Animals bake format.
export const ANIMAL_DONOR_REVISION = "c95ae49346aa8e140a924376cec6cf0073d99512";
export const ANIMAL_ADAPTER_VERSION = 1;
export const ANIMAL_LIMITS = Object.freeze({
  bytes: 64 * 1024 * 1024,
  vertices: 250_000,
  indices: 1_500_000,
  bones: 256,
  headerBytes: 1024 * 1024,
});

export const ANIMAL_ARRAYS = {
  pos: [Float32Array, 3],
  nrm: [Float32Array, 3],
  index: [Uint32Array, 0],
  skinIndex: [Uint16Array, 4],
  skinWeight: [Float32Array, 4],
  comb: [Float32Array, 3],
  tint: [Float32Array, 4],
  coat: [Float32Array, 4],
  pat: [Float32Array, 4],
  surf: [Float32Array, 4],
} as const;

export type AnimalArrayKey = keyof typeof ANIMAL_ARRAYS;
export type AnimalTier = "high" | "crowd";
export type AnimalPoint = readonly [number, number, number];
export interface IAnimalBone {
  readonly name: string;
  readonly parent: string | null;
  readonly headJ: string;
  readonly tailJ: string;
  readonly region?: string;
  readonly group?: string;
}
export interface IAnimalBake {
  readonly version: 1;
  readonly species: "wolf";
  readonly seed: number;
  readonly quality: AnimalTier;
  readonly nV: number;
  readonly bones: readonly IAnimalBone[];
  readonly joints: Readonly<Record<string, AnimalPoint>>;
  readonly refJoints: Readonly<Record<string, AnimalPoint>>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly threenative: {
    readonly donorRevision: typeof ANIMAL_DONOR_REVISION;
    readonly adapterVersion: typeof ANIMAL_ADAPTER_VERSION;
    readonly buildRuntime: string;
    readonly cacheKey: string;
    readonly integrity: string;
  };
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
  readonly index: Uint32Array;
  readonly skinIndex: Uint16Array;
  readonly skinWeight: Float32Array;
  readonly comb: Float32Array;
  readonly tint: Float32Array;
  readonly coat: Float32Array;
  readonly pat: Float32Array;
  readonly surf: Float32Array;
}

/** FNV-1a detects payload corruption; it is not a signature or an authenticity claim. */
export function bakeIntegrity(buffer: ArrayBuffer): string {
  const view = new DataView(buffer);
  const headerBytes = view.getUint32(8, true);
  const start = Math.ceil((12 + headerBytes) / 8) * 8;
  const bytes = new Uint8Array(buffer);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerBytes)));
  const { integrity: _integrity, ...metadata } = header.threenative;
  let hash = 0x811c9dc5;
  for (const section of [
    new TextEncoder().encode(JSON.stringify({ ...header, threenative: metadata })),
    bytes.subarray(start),
  ])
    for (const byte of section) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

const validatedBakes = new WeakSet<object>();
export function requireValidatedBake(bake: IAnimalBake): void {
  if (!validatedBakes.has(bake))
    throw animalError("VALIDATION", "parse the complete bake before allocating resources");
  validateArrayData(bake, bake.nV, bake.bones.length);
}

export function animalError(code: string, detail: string): Error {
  return new Error(`TN_ANIMAL_${code}: ${detail}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw animalError("HEADER", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw animalError("LIMIT", `${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u.test(value)) {
    throw animalError("RIG", `${label} must be a joint or bone name`);
  }
  return value;
}

function joints(value: unknown, label: string): Readonly<Record<string, AnimalPoint>> {
  const entries = Object.entries(record(value, label));
  integer(entries.length, 2, 4096, `${label} count`);
  for (const [key, point] of entries) {
    name(key, label);
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
      throw animalError("RIG", `${label}.${key} must be a finite point`);
    }
  }
  return value as Readonly<Record<string, AnimalPoint>>;
}

function validateHeader(header: Record<string, unknown>): void {
  if (
    header.version !== 1 ||
    header.species !== "wolf" ||
    (header.quality !== "high" && header.quality !== "crowd")
  ) {
    throw animalError("REVISION", "expected version 1, wolf, and high or crowd geometry");
  }
  integer(header.seed, 0, 0xffff_ffff, "seed");
  integer(header.nV, 3, ANIMAL_LIMITS.vertices, "vertex count");
  const metadata = record(header.threenative, "threenative");
  if (
    metadata.donorRevision !== ANIMAL_DONOR_REVISION ||
    metadata.adapterVersion !== ANIMAL_ADAPTER_VERSION
  ) {
    throw animalError("REVISION", "unknown donor revision or adapter version");
  }
  if (
    typeof metadata.buildRuntime !== "string" ||
    metadata.buildRuntime !== "node-v20.19.6" ||
    typeof metadata.cacheKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(metadata.cacheKey) ||
    typeof metadata.integrity !== "string" ||
    !/^[a-f0-9]{8}$/u.test(metadata.integrity)
  ) {
    throw animalError("HEADER", "missing pinned build runtime or SHA-256 cache key");
  }
  const params = record(header.params, "params");
  if (typeof params.size !== "number" || !Number.isFinite(params.size) || params.size <= 0) {
    throw animalError("RIG", "params.size must be finite and positive");
  }
  if (params.seed !== undefined && params.seed !== header.seed)
    throw animalError("OPTIONS", "individual seed contradicts bake seed");
  const points = joints(header.joints, "joints");
  joints(header.refJoints, "refJoints");
  if (!Array.isArray(header.bones)) throw animalError("RIG", "bones must be an array");
  integer(header.bones.length, 1, ANIMAL_LIMITS.bones, "bone count");
  const parents = new Map<string, string | null>();
  for (const value of header.bones) {
    const bone = record(value, "bone");
    const key = name(bone.name, "bone.name");
    if (parents.has(key)) throw animalError("RIG", `duplicate bone ${key}`);
    const parent = bone.parent === null ? null : name(bone.parent, `${key}.parent`);
    parents.set(key, parent);
    const headName = name(bone.headJ, `${key}.headJ`);
    const tailName = name(bone.tailJ, `${key}.tailJ`);
    const head = Object.hasOwn(points, headName) ? points[headName] : undefined;
    const tail = Object.hasOwn(points, tailName) ? points[tailName] : undefined;
    const length =
      head && tail
        ? Math.hypot(head[0] - tail[0], head[1] - tail[1], head[2] - tail[2])
        : Number.NaN;
    if (!Number.isFinite(length) || length < 1e-8) {
      throw animalError("RIG", `${key} has missing joints or zero length`);
    }
  }
  for (const key of parents.keys()) {
    const seen = new Set<string>();
    let current: string | null = key;
    while (current !== null) {
      if (seen.has(current) || !parents.has(current))
        throw animalError("RIG", `${key} has a cyclic or missing parent`);
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }
}

function validateArrayData(
  arrays: Partial<Record<AnimalArrayKey, Float32Array | Uint16Array | Uint32Array>>,
  vertices: number,
  boneCount: number,
): void {
  for (const key of Object.keys(ANIMAL_ARRAYS) as AnimalArrayKey[]) {
    const array = arrays[key];
    const [Constructor, width] = ANIMAL_ARRAYS[key];
    if (
      !(array instanceof Constructor) ||
      !array ||
      (key === "index"
        ? array.length < 3 || array.length > ANIMAL_LIMITS.indices || array.length % 3 !== 0
        : array.length !== vertices * width)
    )
      throw animalError("SECTIONS", `${key} changed after validation`);
    for (const value of array) {
      if (!Number.isFinite(value))
        throw animalError("FINITE", `${key} contains a non-finite value`);
      if (key === "index" && value >= vertices)
        throw animalError("INDEX", `vertex index ${value} exceeds vertex count`);
      if (key === "skinIndex" && value >= boneCount)
        throw animalError("BONE_INDEX", `bone index ${value} exceeds bone count`);
    }
  }
  const weights = arrays.skinWeight as Float32Array;
  for (let i = 0; i < weights.length; i += 4) {
    const group = weights.subarray(i, i + 4);
    if (
      group.some((weight) => weight < 0 || weight > 1) ||
      Math.abs(group.reduce((a, b) => a + b, 0) - 1) > 1e-4
    ) {
      throw animalError("WEIGHTS", `vertex ${i / 4} has non-normalized skin weights`);
    }
  }
}

/** Validate all PANM bytes before a caller creates any Three.js/GPU object. */
export function parseAnimalBake(buffer: ArrayBuffer): IAnimalBake {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength < 16 ||
    buffer.byteLength > ANIMAL_LIMITS.bytes
  ) {
    throw animalError("LIMIT", `payload must contain 16..${ANIMAL_LIMITS.bytes} bytes`);
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x50414e4d) throw animalError("MAGIC", "expected PANM");
  if (view.getUint32(4, true) !== 1) throw animalError("REVISION", "unknown PANM version");
  const headerBytes = integer(
    view.getUint32(8, true),
    8,
    ANIMAL_LIMITS.headerBytes,
    "header bytes",
  );
  const start = Math.ceil((12 + headerBytes) / 8) * 8;
  if (headerBytes % 8 !== 0 || start > buffer.byteLength)
    throw animalError("SECTIONS", "truncated or unaligned header");
  let header: Record<string, unknown>;
  try {
    header = record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, 12 + headerBytes)),
      ),
      "header",
    );
  } catch (error) {
    throw animalError("HEADER", `invalid UTF-8/JSON header: ${String(error)}`);
  }
  const pending: { value: unknown; depth: number }[] = [{ value: header, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > 100_000)
      throw animalError("LIMIT", "header exceeds the structural traversal limit");
    const entry = pending.pop();
    if (!entry) break;
    const { value, depth } = entry;
    if (depth > 64) throw animalError("LIMIT", "header nesting exceeds 64 levels");
    if (typeof value === "number" && !Number.isFinite(value))
      throw animalError("FINITE", "header contains a non-finite number");
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  validateHeader(header);
  if (!Array.isArray(header.arrays) || header.arrays.length !== Object.keys(ANIMAL_ARRAYS).length) {
    throw animalError("SECTIONS", "expected every supported array exactly once");
  }
  const arrays: Partial<Record<AnimalArrayKey, Float32Array | Uint16Array | Uint32Array>> = {};
  const ranges: [number, number][] = [];
  for (const value of header.arrays) {
    const section = record(value, "section");
    if (typeof section.key !== "string")
      throw animalError("SECTIONS", "section key must be a string");
    const key = section.key as AnimalArrayKey;
    if (!Object.hasOwn(ANIMAL_ARRAYS, key) || arrays[key] !== undefined)
      throw animalError("SECTIONS", `unknown or duplicate section ${String(key)}`);
    const [Constructor, width] = ANIMAL_ARRAYS[key];
    if (section.type !== Constructor.name)
      throw animalError("SECTIONS", `${key} must contain ${Constructor.name}`);
    const length = integer(
      section.length,
      1,
      key === "index" ? ANIMAL_LIMITS.indices : ANIMAL_LIMITS.vertices * width,
      `${key} length`,
    );
    if (
      (key === "index" && length % 3 !== 0) ||
      (key !== "index" && length !== Number(header.nV) * width)
    ) {
      throw animalError("SECTIONS", `${key} length contradicts the vertex or triangle count`);
    }
    const offset = integer(section.offset, 0, ANIMAL_LIMITS.bytes, `${key} offset`);
    const end = start + offset + Math.ceil((length * Constructor.BYTES_PER_ELEMENT) / 8) * 8;
    if (offset % 8 !== 0 || end > buffer.byteLength)
      throw animalError("SECTIONS", `${key} is unaligned or truncated`);
    ranges.push([start + offset, end]);
    arrays[key] = new Constructor(buffer, start + offset, length);
  }
  let end = start;
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    if (range[0] !== end) throw animalError("SECTIONS", "sections overlap or contain gaps");
    end = range[1];
  }
  if (end !== buffer.byteLength)
    throw animalError("SECTIONS", "byte length contradicts section extents");
  validateArrayData(arrays, Number(header.nV), (header.bones as unknown[]).length);
  if (bakeIntegrity(buffer) !== (header.threenative as Record<string, unknown>).integrity)
    throw animalError("INTEGRITY", "baked header or array bytes changed");
  // Snapshot the caller's input only after validation; later caller writes cannot invalidate it.
  for (const key of Object.keys(arrays) as AnimalArrayKey[]) arrays[key] = arrays[key]?.slice();
  const { arrays: _sections, ...data } = header;
  const objects: object[] = [data];
  while (objects.length > 0) {
    const object = objects.pop();
    if (!object) break;
    for (const value of Object.values(object))
      if (value !== null && typeof value === "object") objects.push(value);
    Object.freeze(object);
  }
  // quality-allow: the header and every typed array were validated field by field above; the spread is the validated IAnimalBake.
  const bake = Object.freeze({ ...data, ...arrays }) as unknown as IAnimalBake;
  validatedBakes.add(bake);
  return bake;
}
