/** Game-owned interpolation policy; the engine only receives the resulting clip weights. */
interface ISpeedSample {
  readonly clip: string;
  readonly speed: number;
}
interface IDirectionSample {
  readonly clip: string;
  readonly point: readonly [number, number];
}
type Point = readonly [number, number];
type Triangle = readonly [number, number, number];
const DOMAIN_EPSILON = 1e-12;

function validateClips(samples: readonly { readonly clip: string }[]): void {
  if (samples.length === 0) throw new Error("Locomotion needs authored samples.");
  const names = new Set<string>();
  for (const { clip } of samples) {
    if (typeof clip !== "string" || clip.trim().length === 0 || names.has(clip))
      throw new Error("Locomotion sample clips must be nonempty and unique.");
    names.add(clip);
  }
}

/** Sorted intervals, endpoint clamping and one-sample fallback are explicit game policy. */
export function createSpeedWeights(authored: readonly ISpeedSample[]) {
  validateClips(authored);
  const samples = authored.map((sample) => ({ ...sample }));
  for (const [index, sample] of samples.entries()) {
    const previous = samples[index - 1];
    if (
      !Number.isFinite(sample.speed) ||
      (previous !== undefined &&
        (!(sample.speed > previous.speed) || !Number.isFinite(sample.speed - previous.speed)))
    )
      throw new Error(
        "Speed samples must be finite, strictly sorted and numerically representable.",
      );
  }
  return (speed: number) => evaluateSpeed(samples, speed);
}

function evaluateSpeed(samples: readonly ISpeedSample[], speed: number) {
  if (!Number.isFinite(speed)) throw new Error("Locomotion speed must be finite.");
  const result = samples.map(({ clip }) => ({ clip, weight: 0 }));
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) throw new Error("Missing speed domain.");
  let lower = 0;
  let upper = 0;
  let fraction = 0;
  if (speed >= last.speed) lower = upper = samples.length - 1;
  else if (speed > first.speed) {
    upper = samples.findIndex((sample) => sample.speed >= speed);
    lower = upper - 1;
    const start = samples[lower];
    const end = samples[upper];
    if (start === undefined || end === undefined) throw new Error("Missing speed interval.");
    fraction = (speed - start.speed) / (end.speed - start.speed);
  }
  const a = result[lower];
  const b = result[upper];
  if (a === undefined || b === undefined) throw new Error("Missing speed weights.");
  a.weight = 1 - fraction;
  b.weight += fraction;
  return result;
}

function validatePoint(point: Point): void {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1])
  )
    throw new Error("Directional coordinates must be exact finite pairs.");
}

const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];

function barycentric(point: Point, a: Point, b: Point, c: Point): Triangle {
  const denominator = cross(subtract(b, a), subtract(c, a));
  const v = cross(subtract(point, a), subtract(c, a)) / denominator;
  const w = cross(subtract(b, a), subtract(point, a)) / denominator;
  return [1 - v - w, v, w];
}

function pointAt(points: readonly Point[], index: number): Point {
  const point = points[index];
  if (!Number.isInteger(index) || point === undefined)
    throw new Error("Directional triangle references an invalid vertex.");
  return point;
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const ab = subtract(b, a);
  const cd = subtract(d, c);
  const opposite = (x: number, y: number) =>
    (x > DOMAIN_EPSILON && y < -DOMAIN_EPSILON) || (y > DOMAIN_EPSILON && x < -DOMAIN_EPSILON);
  return (
    opposite(cross(ab, subtract(c, a)), cross(ab, subtract(d, a))) &&
    opposite(cross(cd, subtract(a, c)), cross(cd, subtract(b, c)))
  );
}

function trianglePoints(
  points: readonly Point[],
  triangle: Triangle,
): readonly [Point, Point, Point] {
  return [pointAt(points, triangle[0]), pointAt(points, triangle[1]), pointAt(points, triangle[2])];
}

function edges(triangle: Triangle): readonly (readonly [number, number])[] {
  return [
    [triangle[0], triangle[1]],
    [triangle[1], triangle[2]],
    [triangle[2], triangle[0]],
  ];
}

function overlapping(points: readonly Point[], left: Triangle, right: Triangle): boolean {
  if (left.every((vertex) => right.includes(vertex))) return true;
  for (const [outer, inner] of [
    [left, right],
    [right, left],
  ] as const) {
    const [a, b, c] = trianglePoints(points, outer);
    if (
      inner.some(
        (vertex) =>
          !outer.includes(vertex) &&
          barycentric(pointAt(points, vertex), a, b, c).every(
            (weight) => weight >= -DOMAIN_EPSILON,
          ),
      )
    )
      return true;
  }
  return edges(left).some(([a, b]) =>
    edges(right).some(([c, d]) =>
      intersects(pointAt(points, a), pointAt(points, b), pointAt(points, c), pointAt(points, d)),
    ),
  );
}

function rejectOverlap(points: readonly Point[], triangles: readonly Triangle[]): void {
  if (
    triangles.some((left, index) =>
      triangles.slice(index + 1).some((right) => overlapping(points, left, right)),
    )
  )
    throw new Error(
      "Directional domains must not overlap, repeat triangles or have hanging vertices.",
    );
}

function projectEdge(point: Point, points: readonly Point[], from: number, to: number) {
  const start = pointAt(points, from);
  const edge = subtract(pointAt(points, to), start);
  const offset = subtract(point, start);
  const along = Math.max(
    0,
    Math.min(
      1,
      (offset[0] * edge[0] + offset[1] * edge[1]) / (edge[0] * edge[0] + edge[1] * edge[1]),
    ),
  );
  return {
    distance: Math.hypot(offset[0] - along * edge[0], offset[1] - along * edge[1]),
    indices: [from, to] as const,
    weights: [1 - along, along] as const,
  };
}

function evaluateDirection(
  input: Point,
  scale: number,
  names: readonly string[],
  points: readonly Point[],
  triangles: readonly Triangle[],
) {
  const point: Point = [input[0] / scale, input[1] / scale];
  if (!point.every(Number.isFinite))
    throw new Error("Directional input must be finite and representable.");
  const result = names.map((clip) => ({ clip, weight: 0 }));
  let nearest = Number.POSITIVE_INFINITY;
  let selected: readonly number[] = [];
  let selectedWeights: readonly number[] = [];
  for (const triangle of triangles) {
    const [a, b, c] = trianglePoints(points, triangle);
    const weights = barycentric(point, a, b, c);
    if (!weights.every(Number.isFinite))
      throw new Error("Directional input exceeds the numerical range.");
    if (weights.every((weight) => weight >= -DOMAIN_EPSILON)) {
      selected = triangle;
      selectedWeights = weights.map((weight) => Math.max(0, weight));
      break;
    }
    for (const [from, to] of edges(triangle)) {
      const candidate = projectEdge(point, points, from, to);
      if (candidate.distance < nearest) {
        nearest = candidate.distance;
        selected = candidate.indices;
        selectedWeights = candidate.weights;
      }
    }
  }
  const total = selectedWeights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) throw new Error("Directional input cannot be projected onto the domain.");
  selected.forEach((index, at) => {
    const entry = result[index];
    const weight = selectedWeights[at];
    if (entry === undefined || weight === undefined)
      throw new Error("Missing directional weights.");
    entry.weight = weight / total;
  });
  return result;
}

/**
 * Authored non-overlapping triangles; outside inputs project to the nearest domain edge.
 * Ties use declaration order. Degenerate/unrepresentable domains fail explicitly, not silently.
 * The epsilon applies after scaling authored coordinates to their largest absolute coordinate.
 */
export function createDirectionWeights(
  authored: readonly IDirectionSample[],
  declared: readonly Triangle[],
) {
  validateClips(authored);
  if (declared.length === 0) throw new Error("Direction weights require declared triangles.");
  const names = authored.map(({ clip }) => clip);
  const unique = new Set<string>();
  let scale = 0;
  for (const { point } of authored) {
    validatePoint(point);
    const key = JSON.stringify(point);
    if (unique.has(key)) throw new Error("Directional sample coordinates must be unique.");
    unique.add(key);
    scale = Math.max(scale, Math.abs(point[0]), Math.abs(point[1]));
  }
  if (!Number.isFinite(scale) || scale === 0) throw new Error("Directional domain is degenerate.");
  const points: Point[] = authored.map(({ point }) => [point[0] / scale, point[1] / scale]);
  const triangles: Triangle[] = declared.map((triangle) => {
    if (!Array.isArray(triangle) || triangle.length !== 3)
      throw new Error("Directional triangles must name exactly three vertices.");
    const [a, b, c] = triangle;
    pointAt(points, a);
    pointAt(points, b);
    pointAt(points, c);
    return [a, b, c];
  });
  const used = new Set<number>();
  for (const triangle of triangles) {
    const [a, b, c] = triangle.map((index) => {
      used.add(index);
      return pointAt(points, index);
    });
    const area =
      a === undefined || b === undefined || c === undefined
        ? Number.NaN
        : cross(subtract(b, a), subtract(c, a));
    if (!Number.isFinite(area) || Math.abs(area) <= DOMAIN_EPSILON)
      throw new Error("Directional triangles must have a representable nonzero area.");
  }
  if (used.size !== points.length)
    throw new Error("Every directional sample must belong to the domain.");
  rejectOverlap(points, triangles);
  return (input: Point) => evaluateDirection(input, scale, names, points, triangles);
}
