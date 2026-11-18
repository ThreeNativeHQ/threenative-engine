import type { HeightfieldCollar } from "@threenative/core/world";
import { DataTexture, FloatType, MathUtils, NearestFilter, RedFormat, type Vector2 } from "three";
import {
  abs,
  float,
  floor,
  max,
  min,
  modelWorldMatrix,
  positionGeometry,
  positionLocal,
  select,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";

/**
 * The collar ring grid's own spacing curve: ring `k` stands `(k / rings) ** power * reach` metres
 * past the playable square's edge. The kit builds the collar, so it passes the curve its rings
 * follow; the morph and the arithmetic locate a point's ring by inverting it.
 */
export interface ICollarRingCurve {
  /** How the rings spread; 1 is even spacing. */
  readonly power: number;
  /** Metres past the square's edge the outermost ring reaches. */
  readonly reach: number;
}

/** What the tile shader reads about the block the streamed tiles draw. */
export interface ICollarStream {
  /** The drawn block's centre, on the tile lattice. */
  readonly centre: UniformNode<"vec2", Vector2>;
  /** Half the drawn block's side, metres; 0 before the first tile settles. */
  readonly half: UniformNode<"float", number>;
}

/** Streamed tile width in metres; the outermost tile of the drawn square is the morph band. */
export const STREAM_TILE = 64;
/**
 * Metres the collar also draws under the streamed block's edge. The tile and the collar cut their
 * triangles differently, so at the split their surfaces part by up to the fold `collarSeamGap`
 * measures; cut at one line, a view across that step saw the sky through it as a dotted white seam.
 */
export const COLLAR_UNDER_TILE = STREAM_TILE / 4;
/**
 * Metres inside the square's edge where the streamed tiles still draw. Each tile hangs a skirt on
 * that edge; a mask cut on the edge itself dropped it, and the rounding cracks where the square
 * and the tiles meet showed the sky as a dotted white line along low-view crests.
 */
export const TILE_INSIDE_SQUARE = 0.5;

/**
 * The collar triangle under `(x, z)` as it is drawn (not a bilinear blend of its quad): its three
 * vertex indices and the point's weights. Undefined where there is no collar.
 */
function collarTriangle(
  collar: HeightfieldCollar,
  x: number,
  z: number,
): { indices: [number, number, number]; weights: [number, number, number] } | undefined {
  const quad = collar.locate(x, z);
  if (quad === undefined) return undefined;
  const position = collar.geometry.getAttribute("position");
  const a = collar.index(quad.lower, quad.from);
  const b = collar.index(quad.lower, quad.to);
  const c = collar.index(quad.upper, quad.from);
  const d = collar.index(quad.upper, quad.to);
  // The collar's two triangles per quad are (a, b, c) and (b, d, c); the point's barycentrics in
  // the plane pick the one it lies in.
  for (const [p, q, r] of [
    [a, b, c],
    [b, d, c],
  ] as const) {
    const [px, pz] = [position.getX(p), position.getZ(p)];
    const [qx, qz] = [position.getX(q), position.getZ(q)];
    const [rx, rz] = [position.getX(r), position.getZ(r)];
    const det = (qz - rz) * (px - rx) + (rx - qx) * (pz - rz);
    const u = ((qz - rz) * (x - rx) + (rx - qx) * (z - rz)) / det;
    const v = ((rz - pz) * (x - rx) + (px - rx) * (z - rz)) / det;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      return { indices: [p, q, r], weights: [u, v, 1 - u - v] };
  }
  return undefined;
}

/**
 * The collar's drawn height under `(x, z)`; null where there is no collar.
 *
 * @requires npm i -D @threenative/terrain
 * @situation measure or collide against the triangles a collar actually draws
 * @constraint reads the collar it is given; never resamples the square or builds a surface
 * @example const y = collarDrawnHeight(collar, x, z);
 */
export function collarDrawnHeight(collar: HeightfieldCollar, x: number, z: number): number | null {
  const triangle = collarTriangle(collar, x, z);
  if (triangle === undefined) return null;
  const position = collar.geometry.getAttribute("position");
  const [p, q, r] = triangle.indices;
  const [u, v, w] = triangle.weights;
  return u * position.getY(p) + v * position.getY(q) + w * position.getY(r);
}

/**
 * PRD-790: where streamed tiles meet the collar. The tiles draw inside the square
 * `(centreX, centreZ, half)` and the collar outside it, so the seam is that square's edge, past the
 * playable square. `gap` is the largest step at the tiles' edge vertices (`spacing` apart), as core
 * measures a tile-to-tile seam; `fold` is the largest step between them, where a fold of the
 * collar's coarser triangles crosses a tile's straight edge.
 *
 * @requires npm i -D @threenative/terrain
 * @situation prove a streamed ground and its collar meet without a step
 * @constraint the caller supplies the height the tiles draw; a coarser `step` samples faster
 * @example const { gap, fold } = collarSeamGap(collar, tilesHeight, x, z, 288, 2);
 */
export function collarSeamGap(
  collar: HeightfieldCollar,
  height: (x: number, z: number) => number,
  centreX: number,
  centreZ: number,
  half: number,
  spacing: number,
  step = 0.1,
): { fold: number; gap: number } {
  let gap = 0;
  let fold = 0;
  const cells = Math.round((2 * half) / spacing);
  // Each edge of the square: its first corner and the unit step along it.
  const edges = [
    [centreX - half, centreZ - half, 1, 0],
    [centreX - half, centreZ + half, 1, 0],
    [centreX - half, centreZ - half, 0, 1],
    [centreX + half, centreZ - half, 0, 1],
  ] as const;
  for (const [startX, startZ, dx, dz] of edges)
    for (let cell = 0; cell < cells; cell += 1) {
      const h0 = height(startX + dx * cell * spacing, startZ + dz * cell * spacing);
      const h1 = height(startX + dx * (cell + 1) * spacing, startZ + dz * (cell + 1) * spacing);
      for (let offset = 0; offset < spacing; offset += step) {
        const along = cell * spacing + offset;
        const drawn = collarDrawnHeight(collar, startX + dx * along, startZ + dz * along);
        if (drawn === null) continue;
        const rise = Math.abs(drawn - (h0 + ((h1 - h0) * offset) / spacing));
        if (offset === 0) gap = Math.max(gap, rise);
        else fold = Math.max(fold, rise);
      }
    }
  return { fold, gap };
}

/**
 * The collar triangle under `(x, z)` found by arithmetic alone, as the tile shader finds it: the
 * ring from the ring spacing, the perimeter step from the face the point projects onto, and the
 * triangle from the point's place in the quad. On one face the world point is an affine map of
 * `(scale, share * scale)`, so weights read there are the drawn triangle's own.
 *
 * @requires npm i -D @threenative/terrain
 * @situation answer a collar height on the CPU exactly as its tile shader computes it
 * @constraint the curve must be the one the collar was built with
 * @example const y = collarArithmeticHeight(collar, { power: 1.65, reach: 2100 }, x, z);
 */
export function collarArithmeticHeight(
  collar: HeightfieldCollar,
  curve: ICollarRingCurve,
  x: number,
  z: number,
): number {
  const position = collar.geometry.getAttribute("position");
  const at = (ring: number, vertex: number): number =>
    position.getY(ring * collar.perimeter + vertex);
  const q = collarQuad(collar.perimeter, collar.rings, collarHalf(collar), curve, x, z);
  return q.first
    ? q.wa * at(q.lower, q.from) + q.wb * at(q.lower, q.to) + q.wc * at(q.lower + 1, q.from)
    : q.wb * at(q.lower, q.to) + q.wd * at(q.lower + 1, q.to) + q.wc * at(q.lower + 1, q.from);
}

/** Half the playable square, read off the collar's first ring. */
function collarHalf(collar: HeightfieldCollar): number {
  const position = collar.geometry.getAttribute("position");
  return Math.abs(position.getZ(0));
}

function collarQuad(
  perimeter: number,
  rings: number,
  half: number,
  curve: ICollarRingCurve,
  x: number,
  z: number,
) {
  const segments = perimeter / 4;
  const cell = (2 * half) / segments;
  const scaleOf = (ring: number): number =>
    1 + ((ring / rings) ** curve.power * curve.reach) / half;
  const chebyshev = Math.max(Math.abs(x), Math.abs(z));
  const scale = chebyshev / half;
  const past = Math.max(0, chebyshev - half);
  const lower = Math.min(
    rings - 1,
    Math.max(0, Math.floor(rings * (past / curve.reach) ** (1 / curve.power))),
  );
  const low = scaleOf(lower);
  const high = scaleOf(lower + 1);
  const edgeX = x / scale;
  const edgeZ = z / scale;
  const along =
    Math.abs(z) >= Math.abs(x)
      ? z < 0
        ? (edgeX + half) / cell
        : 2 * segments + (half - edgeX) / cell
      : x > 0
        ? segments + (edgeZ + half) / cell
        : 3 * segments + (half - edgeZ) / cell;
  const from = Math.min(perimeter - 1, Math.max(0, Math.floor(along)));
  const share = along - from;
  const ring = (scale - low) / (high - low);
  const b = (share * scale) / low;
  const first = b + ring <= 1;
  const back = 1 - ring;
  const d = (share * scale - back * low) / high;
  return {
    first,
    from,
    lower,
    to: (from + 1) % perimeter,
    wa: 1 - b - ring,
    wb: first ? b : back,
    wc: first ? ring : 1 - back - d,
    wd: d,
  };
}

/**
 * PRD-790 box 2: the streamed tiles' vertex shift. Only the outermost tile of the square the tiles
 * draw slides onto the collar's drawn height, smoothly over that tile, so at the square's edge every
 * tile vertex stands on the collar; the ground inside keeps the survey's smooth surface. The
 * collar's heights go to the GPU once, as a float texture of rings by perimeter steps.
 *
 * @requires npm i -D @threenative/terrain
 * @situation slide the streamed ground's outer tile onto a drawn collar without a seam
 * @constraint the curve must be the one the collar was built with; the band is one tile wide
 * @example tile.positionNode = collarMorph(collar, { power: 1.65, reach: 2100 }, stream, 64);
 */
export function collarMorph(
  collar: HeightfieldCollar,
  curve: ICollarRingCurve,
  stream: ICollarStream,
  band: number,
): Node<"vec3"> {
  const { perimeter, rings } = collar;
  const half = collarHalf(collar);
  const segments = perimeter / 4;
  const cell = (2 * half) / segments;
  const position = collar.geometry.getAttribute("position");
  const heights = new Float32Array(perimeter * (rings + 1));
  for (let index = 0; index < heights.length; index += 1) heights[index] = position.getY(index);
  const map = new DataTexture(heights, perimeter, rings + 1, RedFormat, FloatType);
  map.minFilter = NearestFilter;
  map.magFilter = NearestFilter;
  map.needsUpdate = true;
  const at = (ring: Node<"float">, vertex: Node<"float">): Node<"float"> =>
    texture(map, vec2(vertex.add(0.5).div(perimeter), ring.add(0.5).div(rings + 1))).r;

  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1));
  const x = world.x;
  const z = world.z;
  const chebyshev = max(abs(x), abs(z));
  const scale = chebyshev.div(half);
  const past = chebyshev.sub(half).max(0);
  const lower = min(
    float(rings - 1),
    floor(
      past
        .div(curve.reach)
        .pow(1 / curve.power)
        .mul(rings),
    ),
  );
  const scaleOf = (ring: Node<"float">): Node<"float"> =>
    ring
      .div(rings)
      .pow(curve.power)
      .mul(curve.reach / half)
      .add(1);
  const low = scaleOf(lower);
  const high = scaleOf(lower.add(1));
  const edgeX = x.div(scale);
  const edgeZ = z.div(scale);
  const along = select(
    abs(z).greaterThanEqual(abs(x)),
    select(
      z.lessThan(0),
      edgeX.add(half).div(cell),
      float(half)
        .sub(edgeX)
        .div(cell)
        .add(2 * segments),
    ),
    select(
      x.greaterThan(0),
      edgeZ.add(half).div(cell).add(segments),
      float(half)
        .sub(edgeZ)
        .div(cell)
        .add(3 * segments),
    ),
  );
  const from = min(float(perimeter - 1), floor(along).max(0));
  const share = along.sub(from);
  const to = select(from.equal(perimeter - 1), float(0), from.add(1));
  const ring = scale.sub(low).div(high.sub(low));
  const b = share.mul(scale).div(low);
  const back = float(1).sub(ring);
  const d = share.mul(scale).sub(back.mul(low)).div(high);
  const upper = lower.add(1);
  const first = at(lower, from)
    .mul(float(1).sub(b).sub(ring))
    .add(at(lower, to).mul(b))
    .add(at(upper, from).mul(ring));
  const second = at(lower, to)
    .mul(back)
    .add(at(upper, to).mul(d))
    .add(at(upper, from).mul(float(1).sub(back).sub(d)));
  const drawn = select(b.add(ring).lessThanEqual(1), first, second);
  // The outermost tile of the drawn square, and never inside the playable square.
  const fromCentre = max(abs(x.sub(stream.centre.x)), abs(z.sub(stream.centre.y)));
  const weight = smoothstep(stream.half.sub(band), stream.half, fromCentre).mul(
    past.greaterThan(0).select(float(1), float(0)),
  );
  return positionLocal.add(vec3(0, drawn.sub(world.y).mul(weight), 0));
}

/**
 * The height a tile vertex stands at once `collarMorph` moved it: the survey inside the band, the
 * collar's arithmetic height at the drawn square's edge. The seam measure reads this.
 *
 * @requires npm i -D @threenative/terrain
 * @situation check on the CPU the surface the tile shader draws after its morph
 * @constraint mirrors `collarMorph`'s weight exactly; both read the same curve and band
 * @example const height = createMorphedHeight(collar, curve, surveyHeight, x, z, 288, 64);
 */
export function createMorphedHeight(
  collar: HeightfieldCollar,
  curve: ICollarRingCurve,
  height: (x: number, z: number) => number,
  centreX: number,
  centreZ: number,
  half: number,
  band: number,
): (x: number, z: number) => number {
  const square = collarHalf(collar);
  return (x, z) => {
    const fine = height(x, z);
    const past = Math.max(Math.abs(x), Math.abs(z)) - square;
    if (past <= 0) return fine;
    const fromCentre = Math.max(Math.abs(x - centreX), Math.abs(z - centreZ));
    const t = Math.min(1, Math.max(0, (fromCentre - (half - band)) / band));
    const weight = MathUtils.smoothstep(t, 0, 1);
    return fine + (collarArithmeticHeight(collar, curve, x, z) - fine) * weight;
  };
}
