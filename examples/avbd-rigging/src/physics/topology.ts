/** GPU-independent topology; no solver allocation occurs until the complete input is valid. */
export interface IRiggingPatch {
  name: string;
  columns: number;
  rows: number;
  width: number;
  height: number;
  origin: [number, number, number];
  totalMass: number;
  pinned: number[];
}

export interface IRiggingRope {
  name: string;
  segments: number;
  start: [number, number, number];
  end: [number, number, number];
  totalMass: number;
  pinned: number[];
}

export interface IRiggingInput {
  patches: IRiggingPatch[];
  ropes: IRiggingRope[];
}

export interface IRiggingLimits {
  particles: number;
  constraints: number;
  colliders: number;
  iterations: number;
  catchUpSteps: number;
}

export interface IRiggingTopology {
  positions: Float32Array;
  masses: Float32Array;
  edges: Uint32Array;
  restLengths: Float32Array;
  anchors: Uint32Array;
  ranges: { name: string; offset: number; count: number; totalMass: number }[];
  limits: Readonly<IRiggingLimits>;
}

const ceilings: Readonly<IRiggingLimits> = {
  particles: 2048,
  constraints: 8192,
  colliders: 16,
  iterations: 24,
  catchUpSteps: 5,
};

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be finite and positive.`);
  return value;
}

function count(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}; received ${value}.`);
  }
  return value;
}

function point(name: string, value: readonly number[]): void {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new Error(`${name} must contain three finite coordinates.`);
  }
  if (!value.every((coordinate) => Number.isFinite(Math.fround(coordinate)))) {
    throw new Error(`${name} coordinates exceed Float32 representation.`);
  }
}

function bound(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} count ${value} exceeds capacity ${maximum}.`);
  }
}

function validateMass(name: string, totalMass: number, vertices: number): void {
  const mass = Math.fround(totalMass / vertices);
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`${name}.mass exceeds Float32 representation.`);
  }
}

function validateKinds(input: IRiggingInput): void {
  for (const patch of input.patches) {
    if (
      typeof patch !== "object" ||
      patch === null ||
      !("columns" in patch) ||
      "segments" in patch
    ) {
      throw new Error("Rigging.patches require columns and rows descriptors.");
    }
  }
  for (const rope of input.ropes) {
    if (typeof rope !== "object" || rope === null || !("segments" in rope) || "columns" in rope) {
      throw new Error("Rigging.ropes require segments descriptors.");
    }
  }
}

function validateLimits(overrides: Partial<IRiggingLimits>): IRiggingLimits {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new Error("Rigging limits must be an object.");
  }
  for (const key of Reflect.ownKeys(overrides)) {
    if (!Object.hasOwn(ceilings, key)) throw new Error(`Rigging unknown limit ${String(key)}.`);
  }
  const limits = { ...ceilings, ...overrides };
  for (const key of Object.keys(ceilings) as (keyof IRiggingLimits)[]) {
    count(`Rigging.${key}`, limits[key], 1);
    bound(`Rigging.${key}`, limits[key], ceilings[key]);
  }
  return limits;
}

function dimensions(object: IRiggingPatch | IRiggingRope, limit: number): [number, number] {
  positive(`${object.name}.totalMass`, object.totalMass);
  if ("columns" in object) {
    count(`${object.name}.columns`, object.columns, 2);
    count(`${object.name}.rows`, object.rows, 2);
    const vertices = object.columns * object.rows;
    bound(`${object.name}.particles`, vertices, limit);
    positive(`${object.name}.width`, object.width);
    positive(`${object.name}.height`, object.height);
    point(`${object.name}.origin`, object.origin);
    validateMass(object.name, object.totalMass, vertices);
    return [
      vertices,
      object.rows * (object.columns - 1) +
        object.columns * (object.rows - 1) +
        2 * (object.columns - 1) * (object.rows - 1),
    ];
  }
  count(`${object.name}.segments`, object.segments, 1);
  const vertices = object.segments + 1;
  bound(`${object.name}.particles`, vertices, limit);
  point(`${object.name}.start`, object.start);
  point(`${object.name}.end`, object.end);
  positive(
    `${object.name}.length`,
    Math.hypot(
      object.start[0] - object.end[0],
      object.start[1] - object.end[1],
      object.start[2] - object.end[2],
    ),
  );
  validateMass(object.name, object.totalMass, vertices);
  return [vertices, object.segments];
}

function validatePins(name: string, pinned: number[], vertices: number): void {
  if (!Array.isArray(pinned)) throw new Error(`${name}.pinned must be an array.`);
  bound(`${name}.pinned`, pinned.length, vertices);
  const pins = new Set<number>();
  for (const pin of pinned) {
    count(`${name}.pinned`, pin, 0);
    if (pin >= vertices) throw new Error(`${name}.pinned index ${pin} exceeds ${vertices}.`);
    if (pins.has(pin)) throw new Error(`${name} duplicate pin ${pin}.`);
    pins.add(pin);
  }
}

function writePositions(
  positions: Float32Array,
  object: IRiggingPatch | IRiggingRope,
  offset: number,
  vertices: number,
): void {
  for (let v = 0; v < vertices; v += 1) {
    const p = (offset + v) * 3;
    if ("columns" in object) {
      positions[p] =
        object.origin[0] + ((v % object.columns) * object.width) / (object.columns - 1);
      positions[p + 1] =
        object.origin[1] - (Math.floor(v / object.columns) * object.height) / (object.rows - 1);
      positions[p + 2] = object.origin[2];
    } else {
      for (const axis of [0, 1, 2] as const) {
        positions[p + axis] =
          object.start[axis] + ((object.end[axis] - object.start[axis]) * v) / object.segments;
      }
    }
  }
  if (!positions.subarray(offset * 3, (offset + vertices) * 3).every(Number.isFinite)) {
    throw new Error(`${object.name}.positions exceed Float32 representation.`);
  }
}

function writeEdges(
  object: IRiggingPatch | IRiggingRope,
  offset: number,
  vertices: number,
  connect: (a: number, b: number) => void,
): void {
  for (let v = 0; v < vertices; v += 1) {
    const a = offset + v;
    if (!("columns" in object)) {
      if (v < object.segments) connect(a, a + 1);
      continue;
    }
    const col = v % object.columns;
    const row = Math.floor(v / object.columns);
    for (const [dc, dr] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ] as const) {
      if (col + dc < object.columns && row + dr >= 0 && row + dr < object.rows) {
        connect(a, a + dr * object.columns + dc);
      }
    }
  }
}

/** Construct the comparison's primitive sail/flag grids and polyline ropes, in metres, y-up. */
export function buildRiggingTopology(
  input: IRiggingInput,
  overrides: Partial<IRiggingLimits> = {},
): IRiggingTopology {
  const limits = validateLimits(overrides);
  if (!Array.isArray(input?.patches) || !Array.isArray(input?.ropes)) {
    throw new Error("Rigging requires patches and ropes arrays.");
  }
  const objectCount = input.patches.length + input.ropes.length;
  if (objectCount === 0) throw new Error("Rigging topology must not be empty.");
  bound("Rigging.objects", objectCount, limits.particles);
  validateKinds(input);
  const objects = [...input.patches, ...input.ropes];
  const names = new Set<string>();
  const ranges: IRiggingTopology["ranges"] = [];
  let particles = 0;
  let constraints = 0;
  let anchors = 0;
  for (const object of objects) {
    if (typeof object?.name !== "string" || object.name.trim().length === 0) {
      throw new Error("Rigging object name must not be empty.");
    }
    if (names.has(object.name)) throw new Error(`Rigging duplicate object name ${object.name}.`);
    names.add(object.name);
    const [vertices, edges] = dimensions(object, limits.particles);
    validatePins(object.name, object.pinned, vertices);
    ranges.push({
      name: object.name,
      offset: particles,
      count: vertices,
      totalMass: object.totalMass,
    });
    particles += vertices;
    constraints += edges;
    anchors += object.pinned.length;
  }
  bound("Rigging.particles", particles, limits.particles);
  bound("Rigging.constraints", constraints, limits.constraints);
  const positions = new Float32Array(particles * 3);
  const masses = new Float32Array(particles);
  const edgeIndices = new Uint32Array(constraints * 2);
  const restLengths = new Float32Array(constraints);
  const anchorIndices = new Uint32Array(anchors);
  let edge = 0;
  let anchor = 0;
  const connect = (a: number, b: number, name: string): void => {
    edgeIndices.set([a, b], edge * 2);
    restLengths[edge] = Math.hypot(
      (positions[a * 3] ?? Number.NaN) - (positions[b * 3] ?? Number.NaN),
      (positions[a * 3 + 1] ?? Number.NaN) - (positions[b * 3 + 1] ?? Number.NaN),
      (positions[a * 3 + 2] ?? Number.NaN) - (positions[b * 3 + 2] ?? Number.NaN),
    );
    positive(`${name}.edge[${edge}].restLength`, restLengths[edge] ?? Number.NaN);
    edge += 1;
  };
  for (const [index, object] of objects.entries()) {
    const range = ranges[index];
    if (range === undefined) throw new Error(`Rigging missing range for ${object.name}.`);
    writePositions(positions, object, range.offset, range.count);
    masses.fill(object.totalMass / range.count, range.offset, range.offset + range.count);
    writeEdges(object, range.offset, range.count, (a, b) => connect(a, b, object.name));
    for (const pin of object.pinned) anchorIndices[anchor++] = range.offset + pin;
  }
  return {
    positions,
    masses,
    edges: edgeIndices,
    restLengths,
    anchors: anchorIndices,
    ranges,
    limits,
  };
}

/** Original PRD resolution/dimensions; all masses, positions and pinning are game-owned. */
export function referenceRigging(): IRiggingInput {
  return {
    patches: [
      {
        name: "sail",
        columns: 32,
        rows: 32,
        width: 4,
        height: 4,
        origin: [-2, 7, 0],
        totalMass: 9.6,
        pinned: Array.from({ length: 32 }, (_, i) => i),
      },
      {
        name: "flag",
        columns: 16,
        rows: 16,
        width: 1,
        height: 1,
        origin: [3, 7, 0],
        totalMass: 0.6,
        pinned: Array.from({ length: 16 }, (_, i) => i * 16),
      },
    ],
    ropes: Array.from({ length: 4 }, (_, i) => ({
      name: `rope-${i}`,
      segments: 64,
      start: [-2.5 + i * 1.7, 7, 0.2],
      end: [-2.5 + i * 1.7, 3, 0.2],
      totalMass: 0.4,
      pinned: [0, 64],
    })),
  };
}
