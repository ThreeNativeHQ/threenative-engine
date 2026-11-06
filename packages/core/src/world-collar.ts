/**
 * `HeightfieldCollar`: the far ring a heightfield grows past its playable square, and the band of it
 * a collider follows.
 *
 * A landscape renders its square at full detail and its surroundings at a fraction of it, because
 * the surroundings' triangles are (Unreal `ALandscapeMeshProxyActor`, HLOD). The mechanism is the
 * same everywhere: one vertex per boundary sample, one ring per distance step, and a quad grid
 * between them whose innermost ring is the square's own edge. What a ring is worth in metres, what
 * it looks like and where the ground stops being walkable are the game's decisions, so they arrive
 * as options: `ringDistance` is its framing curve and `height` is its own surface.
 */
import { BufferAttribute, BufferGeometry } from "three";

/** One ring vertex: where it stands and which ring and boundary sample it belongs to. */
export interface IHeightfieldCollarSite {
  /** Metres past the square's edge along the framing curve. */
  readonly distance: number;
  /** Ring number, 0 at the square's own edge. */
  readonly ring: number;
  /** Index along the perimeter walk, 0 at the ring's own (-x, -z) corner. */
  readonly vertex: number;
  readonly x: number;
  readonly z: number;
}

/** The collar quad a world point falls in, in ring and perimeter indices. */
export interface IHeightfieldCollarQuad {
  /** Share from `from` to `to` along the perimeter, 0..1. */
  readonly edgeShare: number;
  /** Perimeter index at or before the point. */
  readonly from: number;
  /** The ring inside the point. */
  readonly lower: number;
  /** Share from `lower` to `upper` across the rings, 0..1. */
  readonly ringShare: number;
  /** Perimeter index after `from`. */
  readonly to: number;
  /** The ring outside the point. */
  readonly upper: number;
}

export interface IHeightfieldCollarOptions {
  /** The height at one ring vertex. The game's look: surveyed relief, its smoothing and its seams. */
  readonly height: (site: IHeightfieldCollarSite) => number;
  /** Samples along one side of the square; a ring keeps one vertex per boundary sample. */
  readonly resolution: number;
  /** Metres past the square's edge of one ring. `ringDistance(0)` reads 0 and it never decreases. */
  readonly ringDistance: (ring: number) => number;
  /** Rings past the edge, outermost included. */
  readonly rings: number;
  /** The square's side in metres: the heightfield's own width. */
  readonly size: number;
  /** Metres past the edge that stay walkable: `walk` ends at the outermost ring inside it. */
  readonly walkBand: number;
}

/** The walkable band of the collar, as the drawn triangles themselves. */
export interface IHeightfieldCollarWalk {
  /** Metres past the edge where the band ends. */
  readonly extent: number;
  /** A view of the collar's own position buffer and index slice, not a resample. */
  readonly geometry: BufferGeometry;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`HeightfieldCollar ${name} must be finite.`);
}

function requireShape(options: IHeightfieldCollarOptions): void {
  if (!Number.isInteger(options.resolution) || options.resolution < 2)
    throw new Error("HeightfieldCollar needs at least 2 samples per side.");
  if (!Number.isInteger(options.rings) || options.rings < 1)
    throw new Error("HeightfieldCollar needs at least 1 ring.");
  requireFinite(options.size, "size");
  if (options.size <= 0) throw new Error("HeightfieldCollar size must be positive.");
  requireFinite(options.walkBand, "walkBand");
  if (options.walkBand < 0) throw new Error("HeightfieldCollar walkBand must not be negative.");
}

/** The distance of every ring, checked once: a framing curve that folds cannot locate a point. */
function ringDistances(options: IHeightfieldCollarOptions): Float64Array {
  const distances = new Float64Array(options.rings + 1);
  for (let ring = 0; ring <= options.rings; ring += 1) {
    const distance = options.ringDistance(ring);
    requireFinite(distance, `ring ${ring} distance`);
    if (ring > 0 && distance < (distances[ring - 1] as number))
      throw new Error(`HeightfieldCollar ring ${ring} distance is closer than the ring inside it.`);
    distances[ring] = distance;
  }
  if (distances[0] !== 0)
    throw new Error("HeightfieldCollar ring 0 stands on the square's own edge and reads 0.");
  return distances;
}

/**
 * The perimeter walk: one boundary sample per step, starting at the square's (-x, -z) corner and
 * following its four sides, so a ring's vertex stands over the edge it grows from.
 */
function boundaryWalk(segments: number): { columns: Int32Array; rows: Int32Array } {
  const perimeter = segments * 4;
  const starts = [
    [0, 0],
    [segments, 0],
    [segments, segments],
    [0, segments],
  ] as const;
  const steps = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const;
  const columns = new Int32Array(perimeter);
  const rows = new Int32Array(perimeter);
  for (let vertex = 0; vertex < perimeter; vertex += 1) {
    const side = Math.floor(vertex / segments);
    const along = vertex % segments;
    const start = starts[side] as readonly [number, number];
    const step = steps[side] as readonly [number, number];
    columns[vertex] = start[0] + along * step[0];
    rows[vertex] = start[1] + along * step[1];
  }
  return { columns, rows };
}

/**
 * A heightfield's far ring: `rings` square rings past its playable square, one vertex per boundary
 * sample, and the index grid that draws them.
 * @situation draw the terrain past the playable square without hand-building a ring grid
 * @situation ground a character past the square, out to the walk band, on drawn triangles
 * @constraint every ring vertex asks the game's `height` callback; core owns no terrain look
 * @constraint the collar is a ring of triangles, not a field: `heightAt` answers on it and null off it
 * @example const collar = new HeightfieldCollar({ resolution: 129, size: 512, rings: 384, ringDistance: (ring) => (ring / 384) ** 1.65 * 2100, walkBand: 200, height: ({ x, z }) => surveyed.heightAt(x, z) });
 */
export class HeightfieldCollar {
  readonly #columns: Int32Array;
  readonly #half: number;
  readonly #positions: Float32Array;
  readonly #rows: Int32Array;
  /** The radius scale of each ring: 1 at the square's own edge. */
  readonly #scales: Float64Array;
  readonly #segments: number;

  /** The drawn ring grid: positions, then the index triangles between the rings. */
  readonly geometry: BufferGeometry;
  /** Vertices around one ring. */
  readonly perimeter: number;
  /** Ring count, outermost included. */
  readonly rings: number;
  /** The band a collider follows, and the outermost ring it reaches. */
  readonly walk: IHeightfieldCollarWalk;
  /** Metres past the edge that stay walkable. */
  readonly walkBand: number;

  constructor(options: IHeightfieldCollarOptions) {
    requireShape(options);
    const { height, rings, size } = options;
    const distances = ringDistances(options);
    this.rings = rings;
    this.walkBand = options.walkBand;
    this.#segments = options.resolution - 1;
    this.perimeter = this.#segments * 4;
    this.#half = size / 2;
    this.#scales = new Float64Array(rings + 1);
    for (let ring = 0; ring <= rings; ring += 1)
      this.#scales[ring] = 1 + (distances[ring] as number) / this.#half;
    const { columns, rows } = boundaryWalk(this.#segments);
    this.#columns = columns;
    this.#rows = rows;
    let walked = 0;
    while (walked < rings && (distances[walked + 1] as number) <= this.walkBand) walked += 1;
    const { positions, indices } = this.#build(distances, height);
    this.#positions = positions;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    this.geometry = geometry;
    const band = new BufferGeometry();
    band.setAttribute(
      "position",
      new BufferAttribute(positions.subarray(0, (walked + 1) * this.perimeter * 3), 3),
    );
    band.setIndex(new BufferAttribute(indices.subarray(0, walked * this.perimeter * 6), 1));
    this.walk = { extent: distances[walked] as number, geometry: band };
  }

  /** The ring grid's positions and triangles, ring by ring. */
  #build(
    distances: Float64Array,
    height: (site: IHeightfieldCollarSite) => number,
  ): { indices: Uint32Array; positions: Float32Array } {
    const { perimeter, rings } = this;
    const size = this.#half * 2;
    const positions = new Float32Array((rings + 1) * perimeter * 3);
    const indices = new Uint32Array(rings * perimeter * 6);
    let offset = 0;
    let index = 0;
    for (let ring = 0; ring <= rings; ring += 1) {
      const scale = this.#scales[ring] as number;
      const distance = distances[ring] as number;
      for (let vertex = 0; vertex < perimeter; vertex += 1) {
        const x = ((this.#columns[vertex] as number) / this.#segments - 0.5) * size * scale;
        const z = ((this.#rows[vertex] as number) / this.#segments - 0.5) * size * scale;
        positions[offset] = x;
        positions[offset + 1] = height({ distance, ring, vertex, x, z });
        positions[offset + 2] = z;
        offset += 3;
        if (ring === rings) continue;
        const a = ring * perimeter + vertex;
        const b = ring * perimeter + ((vertex + 1) % perimeter);
        const c = a + perimeter;
        const d = b + perimeter;
        indices[index] = a;
        indices[index + 1] = b;
        indices[index + 2] = c;
        indices[index + 3] = b;
        indices[index + 4] = d;
        indices[index + 5] = c;
        index += 6;
      }
    }
    return { indices, positions };
  }

  /**
   * The boundary sample one perimeter vertex stands over: a column and row of the heightfield's own
   * grid, in the walk's order, so the square's edge heights, seams and colours are a lookup.
   */
  boundary(vertex: number): { readonly column: number; readonly row: number } {
    this.#requireVertex(vertex);
    return { column: this.#columns[vertex] as number, row: this.#rows[vertex] as number };
  }

  /** Metres past the square's edge of one ring. */
  distance(ring: number): number {
    if (!Number.isInteger(ring) || ring < 0 || ring > this.rings)
      throw new Error(`HeightfieldCollar ring ${ring} is outside the collar.`);
    return ((this.#scales[ring] as number) - 1) * this.#half;
  }

  /**
   * The drawn collar's height under a world point: bilinear across the quad a scatter placement
   * stands on, so a tree follows the ring grid it is planted on. Null where there is no collar.
   */
  heightAt(x: number, z: number): number | null {
    const quad = this.locate(x, z);
    if (quad === undefined) return null;
    const height = (ring: number, vertex: number): number =>
      this.#positions[(ring * this.perimeter + vertex) * 3 + 1] as number;
    const inside =
      height(quad.lower, quad.from) * (1 - quad.edgeShare) +
      height(quad.lower, quad.to) * quad.edgeShare;
    const outside =
      height(quad.upper, quad.from) * (1 - quad.edgeShare) +
      height(quad.upper, quad.to) * quad.edgeShare;
    return inside * (1 - quad.ringShare) + outside * quad.ringShare;
  }

  /** Vertex index of one ring site, for writing an attribute over the drawn ring grid. */
  index(ring: number, vertex: number): number {
    if (!Number.isInteger(ring) || ring < 0 || ring > this.rings)
      throw new Error(`HeightfieldCollar ring ${ring} is outside the collar.`);
    this.#requireVertex(vertex);
    return ring * this.perimeter + vertex;
  }

  /**
   * The quad a world point falls in, or undefined inside the square and past the outermost ring.
   * Its four corners are `index(lower|upper, from|to)`.
   */
  locate(x: number, z: number): IHeightfieldCollarQuad | undefined {
    requireFinite(x, "query x");
    requireFinite(z, "query z");
    const scale = Math.max(Math.abs(x), Math.abs(z)) / this.#half;
    if (scale < 1 || scale >= (this.#scales[this.rings] as number)) return undefined;
    let lower = 0;
    let upper = this.rings;
    while (upper - lower > 1) {
      const middle = (lower + upper) >> 1;
      if ((this.#scales[middle] as number) <= scale) lower = middle;
      else upper = middle;
    }
    const ringShare =
      (scale - (this.#scales[lower] as number)) /
      ((this.#scales[upper] as number) - (this.#scales[lower] as number));
    // The point pulled back onto the square's edge, then its index along the perimeter walk.
    const half = this.#half;
    const segments = this.#segments;
    const cell = (half * 2) / segments;
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
    const from = Math.min(this.perimeter - 1, Math.max(0, Math.floor(along)));
    return {
      edgeShare: along - from,
      from,
      lower,
      ringShare,
      to: (from + 1) % this.perimeter,
      upper,
    };
  }

  #requireVertex(vertex: number): void {
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= this.perimeter)
      throw new Error(`HeightfieldCollar vertex ${vertex} is outside the ring.`);
  }
}
