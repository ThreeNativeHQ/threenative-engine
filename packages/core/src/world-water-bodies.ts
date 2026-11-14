import type { Heightfield } from "./world-heightfield.js";

/**
 * Metres a river's water reaches sideways per metre of its channel width.
 *
 * The water stands on its bed, not on the spline: the bake measures a channel's wet reach at 2.5
 * widths either side of its centreline. The drawn ribbon and the query below read this one number,
 * so a swimmer cannot leave the surface they see.
 */
export const WATER_RIBBON_REACH = 2.5;

/** One river as the bake records it: stations along its centreline, its width and its flow. */
export interface IWaterRibbon {
  /** Stations `[x, y, z]` in world metres; `y` is the surface height at the station. */
  readonly points: readonly (readonly number[])[];
  /** Metres of water across the channel. The surface reaches `2.5 * width` m either side. */
  readonly width: number;
  /** Downstream speed in m/s, the flow that carries a swimmer along the tangent. */
  readonly flow: number;
}

/** One lake as the bake records it: where its flood fill was seeded, its level and its cap. */
export interface IWaterLake {
  /** Where the flood fill was seeded, `[x, z]` in world metres. */
  readonly at: readonly number[];
  /** The surface's height, in metres. */
  readonly level: number;
  /** The furthest the game lets this water reach, in metres, whatever its basin measures. */
  readonly radius: number;
  /** How far past the measured waterline the water reaches, so the shore stands inside it. */
  readonly margin: number;
}

/** A sea: one level and the square of ground it floods. */
export interface IWaterOcean {
  /** The surface's height, in metres. */
  readonly level: number;
  /** Metres from the origin the surface covers, either side of it. */
  readonly extent: number;
}

/** Which water stands at a point. */
export type WaterBodyKind = "river" | "lake" | "ocean";

/** The water standing at one (x, z): which body it is and how high its surface is. */
export interface IWaterFootprint {
  readonly kind: WaterBodyKind;
  /** Surface height there, in metres. */
  readonly level: number;
}

/** A flow in m/s along x and z; the caller may pass one to reuse instead of allocating. */
export interface IWaterCurrent {
  x: number;
  z: number;
}

/** The baked water of one world: the arrays a game's biome file names, and the ground they flood. */
export interface IWaterBodiesOptions {
  readonly ribbons?: readonly IWaterRibbon[];
  readonly lakes?: readonly IWaterLake[];
  readonly ocean?: IWaterOcean;
  /** The canonical terrain. A lake's footprint is measured on it, so any lake needs it. */
  readonly field?: Heightfield;
}

/** One straight piece of a river's centreline: its ends, surface heights, reach and flow. */
interface IReach {
  readonly ax: number;
  readonly az: number;
  readonly dx: number;
  readonly dz: number;
  readonly length2: number;
  readonly ha: number;
  readonly hb: number;
  readonly reach: number;
  readonly flow: number;
}

/** One lake as the surface sees it: where it stands, how far it reaches and how high it is. */
interface IPool {
  readonly x: number;
  readonly z: number;
  readonly radius2: number;
  readonly level: number;
  readonly disc: ILakeDisc | undefined;
  readonly field: Heightfield;
}

/** What stands at one (x, z): the water body covering it, its surface, and the river piece carrying it. */
interface ISample {
  readonly kind: WaterBodyKind;
  readonly level: number;
  readonly river: IReach | undefined;
}

const NO_REACHES: readonly IReach[] = [];
const NO_LAKES: readonly IWaterLake[] = [];

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`TN_WATER_BODIES_INVALID: ${name} must be a finite number.`);
  return value;
}

function positive(value: unknown, name: string): number {
  const number = finite(value, name);
  if (!(number > 0)) throw new Error(`TN_WATER_BODIES_INVALID: ${name} must be above zero.`);
  return number;
}

/**
 * The furthest a lake's basin reaches on a bearing: where the drawn ground crosses its level.
 *
 * Twenty-four bearings step outwards and stop at the first bank, because binary-searching the whole
 * ray can jump a dry ridge into another pond. Eighteen halvings land inside two centimetres at this
 * scale, well under the ground's own sample spacing.
 *
 * @situation measure where a lake's water meets the ground it floods
 * @situation size a lake's drawn surface or the footprint a swimmer may enter
 * @constraint returns metres on the furthest bearing; the caller applies its own cap
 * @example const reach = waterlineRadius(field, lake.at, lake.level) * 1.12;
 */
export function waterlineRadius(
  field: Heightfield,
  centre: readonly number[],
  level: number,
): number {
  const [cx = 0, cz = 0] = centre;
  if (field.heightAt(cx, cz) >= level) return 0;
  const bearings = 24;
  let furthest = 0;
  for (let index = 0; index < bearings; index += 1) {
    const angle = (index / bearings) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    let wet = 0;
    let dry = Math.min(
      (field.width / 2 - Math.sign(dx) * (cx - field.origin.x)) / Math.max(Math.abs(dx), 1e-6),
      (field.depth / 2 - Math.sign(dz) * (cz - field.origin.z)) / Math.max(Math.abs(dz), 1e-6),
    );
    const cell = Math.max(field.width / (field.columns - 1), field.depth / (field.rows - 1));
    for (let distance = cell; distance < dry; distance += cell) {
      if (field.heightAt(cx + dx * distance, cz + dz * distance) >= level) {
        dry = distance;
        break;
      }
      wet = distance;
    }
    for (let halving = 0; halving < 18; halving += 1) {
      const mid = (wet + dry) / 2;
      if (field.heightAt(cx + dx * mid, cz + dz * mid) < level) wet = mid;
      else dry = mid;
    }
    furthest = Math.max(furthest, (wet + dry) / 2);
  }
  return furthest;
}

/**
 * A lake's disc: `rings` rings of `spokes` vertices around its seed, out to `lakeReach`, packed towards
 * the middle. Vertex 0 is the seed; ring `r` (1 to `rings - 1`) spoke `s` is `1 + (r - 1) * spokes + s`.
 *
 * `depths` is the water over the ground at each vertex, and it is zero where dry ground cuts the vertex
 * off from the seed: a hollow beyond the basin's rim sits under the level too, but the lake does not
 * reach it (a river valley past the dam would otherwise stand under a sheet of lake water that stops
 * where the reach does, in a straight edge). Neighbours are the next spoke on a ring and the next ring
 * on a spoke, so water crosses a ridge only where the ridge falls below the level.
 */
export interface ILakeDisc {
  readonly x: number;
  readonly z: number;
  readonly reach: number;
  readonly rings: number;
  readonly spokes: number;
  readonly packing: number;
  /** `[x, z]` per vertex, clamped to the field. */
  readonly positions: Float32Array;
  readonly depths: Float32Array;
}

export function lakeDisc(
  field: Heightfield,
  lake: IWaterLake,
  rings = 44,
  spokes = 88,
  packing = 1.7,
): ILakeDisc | undefined {
  const reach = lakeReach(field, lake);
  if (!(reach > 0)) return undefined;
  const [cx = 0, cz = 0] = lake.at;
  const minX = field.origin.x - field.width / 2;
  const minZ = field.origin.z - field.depth / 2;
  const count = (rings - 1) * spokes + 1;
  const positions = new Float32Array(count * 2);
  const raw = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const ring = index === 0 ? 0 : Math.floor((index - 1) / spokes) + 1;
    const angle = (((index - 1) % spokes) / spokes) * Math.PI * 2;
    const radius = index === 0 ? 0 : reach * (ring / (rings - 1)) ** packing;
    const x = Math.max(minX, Math.min(minX + field.width, cx + Math.cos(angle) * radius));
    const z = Math.max(minZ, Math.min(minZ + field.depth, cz + Math.sin(angle) * radius));
    positions[index * 2] = x;
    positions[index * 2 + 1] = z;
    raw[index] = Math.max(0, lake.level - field.heightAt(x, z));
  }
  // Flood from the seed through wet vertices only.
  const depths = new Float32Array(count);
  const stack = [0];
  depths[0] = raw[0] as number;
  const visit = (index: number): void => {
    if ((raw[index] as number) > 0 && depths[index] === 0) {
      depths[index] = raw[index] as number;
      stack.push(index);
    }
  };
  while (stack.length > 0) {
    const index = stack.pop() as number;
    if (index === 0) {
      for (let spoke = 0; spoke < spokes; spoke += 1) visit(1 + spoke);
      continue;
    }
    const ring = Math.floor((index - 1) / spokes) + 1;
    const spoke = (index - 1) % spokes;
    const at = (r: number, s: number): number => (r === 0 ? 0 : 1 + (r - 1) * spokes + s);
    visit(at(ring, (spoke + 1) % spokes));
    visit(at(ring, (spoke + spokes - 1) % spokes));
    visit(at(ring - 1, spoke));
    if (ring + 1 < rings) visit(at(ring + 1, spoke));
  }
  return { x: cx, z: cz, reach, rings, spokes, packing, positions, depths };
}

/** Whether the disc cell holding (x, z) has a corner the seed's water reaches. */
function discReaches(disc: ILakeDisc, x: number, z: number): boolean {
  const dx = x - disc.x;
  const dz = z - disc.z;
  const t = (Math.hypot(dx, dz) / disc.reach) ** (1 / disc.packing) * (disc.rings - 1);
  const ring = Math.min(disc.rings - 2, Math.floor(t));
  const turn = (Math.atan2(dz, dx) / (Math.PI * 2) + 1) % 1;
  const spoke = Math.floor(turn * disc.spokes) % disc.spokes;
  const at = (r: number, s: number): number => (r === 0 ? 0 : 1 + (r - 1) * disc.spokes + s);
  const next = (spoke + 1) % disc.spokes;
  return [at(ring, spoke), at(ring, next), at(ring + 1, spoke), at(ring + 1, next)].some(
    (index) => (disc.depths[index] as number) > 0,
  );
}

/**
 * How far a lake's water reaches: the waterline its basin measures, `margin` times out, capped.
 *
 * The drawn surface and the swim footprint both size themselves here, so the shore a player sees is
 * the shore they stop at.
 *
 * @situation size a lake's footprint from its basin and the cap its biome row names
 * @constraint reads the heightfield at every bearing, once per lake, never per frame
 * @example const reach = lakeReach(field, { ...lake, margin: 1.12 });
 */
export function lakeReach(field: Heightfield, lake: IWaterLake): number {
  return Math.min(waterlineRadius(field, lake.at, lake.level) * lake.margin, lake.radius);
}

/**
 * One world's water, queried: surface height, current and footprint from the baked arrays.
 *
 * Rendering and physics read the same store, as they do for `Heightfield`, so the surface a player
 * sees and the surface a swimmer rests on cannot disagree. Every station, level, extent and speed
 * comes from the game, and the shading stays in the game's own `src/render/`.
 *
 * A river's segments sit in a uniform grid, so a query tests the few that can reach its cell
 * instead of every station of every river.
 *
 * @situation ask how high the water is where a player swims
 * @situation ask which way a current carries a body
 * @situation ask which water body covers a point, and how high its surface is
 * @situation share one water store between rendering and physics
 * @constraint every station, level, extent and speed comes from the game's own bake; a lake is measured on the field passed in
 * @example const water = new WaterBodies({ ribbons, lakes, field }); const height = water.surfaceAt(x, z);
 */
export class WaterBodies {
  readonly #cells: ReadonlyMap<string, readonly IReach[]>;
  readonly #cellSize: number;
  readonly #pools: readonly IPool[];
  readonly #ocean: IWaterOcean | undefined;

  constructor(options: IWaterBodiesOptions) {
    const field = options.field;
    const reaches: IReach[] = [];
    for (const ribbon of options.ribbons ?? []) buildReaches(ribbon, reaches);
    this.#cellSize = Math.max(1, ...reaches.map((piece) => piece.reach));
    this.#cells = indexReaches(reaches, this.#cellSize);
    this.#pools = (options.lakes ?? NO_LAKES).map((lake) => poolOf(field, lake));
    const ocean = options.ocean;
    this.#ocean =
      ocean === undefined
        ? undefined
        : {
            extent: positive(ocean.extent, "ocean extent"),
            level: finite(ocean.level, "ocean level"),
          };
  }

  /** The height of the water at (x, z), or `undefined` where none is drawn. */
  surfaceAt(x: number, z: number): number | undefined {
    return this.#sample(x, z)?.level;
  }

  /**
   * The flow that carries a body at (x, z), in m/s, or `undefined` where there is no water.
   *
   * A river carries a swimmer along its tangent at the ribbon's flow; a lake and the sea stand still
   * and report a zero vector. The result is written into `out` when one is passed, so a caller in a
   * hot loop owns no allocation.
   */
  currentAt(x: number, z: number, out: IWaterCurrent = { x: 0, z: 0 }): IWaterCurrent | undefined {
    const water = this.#sample(x, z);
    if (water === undefined) return undefined;
    const piece = water.river;
    if (piece === undefined) {
      out.x = 0;
      out.z = 0;
      return out;
    }
    const length = Math.sqrt(piece.length2);
    out.x = (piece.dx / length) * piece.flow;
    out.z = (piece.dz / length) * piece.flow;
    return out;
  }

  /** Which water body covers (x, z) and how high its surface is, or `undefined` where none is. */
  footprintAt(x: number, z: number): IWaterFootprint | undefined {
    const water = this.#sample(x, z);
    return water === undefined ? undefined : { kind: water.kind, level: water.level };
  }

  /**
   * The water at (x, z): the nearest river segment within its reach, unless a lake's or the sea's
   * higher level stands over it. Where two bodies overlap, the higher surface wins and the river
   * stops carrying anything, so a mouth or a flooded station reads as standing water.
   */
  #sample(x: number, z: number): ISample | undefined {
    finite(x, "query x");
    finite(z, "query z");
    let nearest = Number.POSITIVE_INFINITY;
    let river: IReach | undefined;
    let along = 0;
    const candidates =
      this.#cells.get(`${Math.floor(x / this.#cellSize)}:${Math.floor(z / this.#cellSize)}`) ??
      NO_REACHES;
    for (const piece of candidates) {
      const t = Math.max(
        0,
        Math.min(1, ((x - piece.ax) * piece.dx + (z - piece.az) * piece.dz) / piece.length2),
      );
      const distance = Math.hypot(x - piece.ax - piece.dx * t, z - piece.az - piece.dz * t);
      if (distance <= piece.reach && distance < nearest) {
        nearest = distance;
        river = piece;
        along = t;
      }
    }
    let level =
      river === undefined ? Number.NEGATIVE_INFINITY : river.ha + (river.hb - river.ha) * along;
    let kind: WaterBodyKind | undefined = river === undefined ? undefined : "river";
    for (const pool of this.#pools)
      if (
        (x - pool.x) ** 2 + (z - pool.z) ** 2 <= pool.radius2 &&
        pool.level > level &&
        !isolated(pool, x, z)
      ) {
        level = pool.level;
        river = undefined;
        kind = "lake";
      }
    const ocean = this.#ocean;
    if (
      ocean !== undefined &&
      Math.abs(x) <= ocean.extent &&
      Math.abs(z) <= ocean.extent &&
      ocean.level > level
    ) {
      level = ocean.level;
      river = undefined;
      kind = "ocean";
    }
    return kind === undefined ? undefined : { kind, level, river };
  }
}

/** Ground under a lake's level that its water does not reach: a hollow past the basin's rim. */
function isolated(pool: IPool, x: number, z: number): boolean {
  const disc = pool.disc;
  if (disc === undefined || discReaches(disc, x, z)) return false;
  const field = pool.field;
  const minX = field.origin.x - field.width / 2;
  const minZ = field.origin.z - field.depth / 2;
  const ground = field.heightAt(
    Math.max(minX, Math.min(minX + field.width, x)),
    Math.max(minZ, Math.min(minZ + field.depth, z)),
  );
  return ground < pool.level;
}

/** One row of river stations as straight pieces, each as wide as the channel stands over. */
function buildReaches(ribbon: IWaterRibbon, into: IReach[]): void {
  const width = positive(ribbon.width, "ribbon width");
  const flow = finite(ribbon.flow, "ribbon flow");
  const points = ribbon.points;
  if (!Array.isArray(points) || points.length < 2)
    throw new Error(
      `TN_WATER_BODIES_INVALID: a ribbon needs at least two stations, received ${String(points?.length)}.`,
    );
  const reach = width * WATER_RIBBON_REACH;
  for (let k = 1; k < points.length; k += 1) {
    const before = points[k - 1] as readonly number[];
    const after = points[k] as readonly number[];
    const ax = finite(before[0], `ribbon station ${k - 1} x`);
    const az = finite(before[2], `ribbon station ${k - 1} z`);
    const bx = finite(after[0], `ribbon station ${k} x`);
    const bz = finite(after[2], `ribbon station ${k} z`);
    const ha = finite(before[1], `ribbon station ${k - 1} y`);
    const hb = finite(after[1], `ribbon station ${k} y`);
    const dx = bx - ax;
    const dz = bz - az;
    into.push({ ax, az, dx, dz, flow, ha, hb, length2: dx * dx + dz * dz || 1, reach });
  }
}

/** One lake row as the query scans it: measured against the ground, capped at the row's radius. */
function poolOf(field: Heightfield | undefined, lake: IWaterLake): IPool {
  if (field === undefined)
    throw new Error(
      "TN_WATER_BODIES_INVALID: a lake's footprint is measured on the ground; pass `field`.",
    );
  finite(lake.level, "lake level");
  positive(lake.radius, "lake radius");
  positive(lake.margin, "lake margin");
  const [x = 0, z = 0] = lake.at;
  finite(x, "lake x");
  finite(z, "lake z");
  const disc = lakeDisc(field, lake);
  const radius = disc?.reach ?? 0;
  return { level: lake.level, radius2: radius * radius, x, z, disc, field };
}

/**
 * Every reach registered in every cell its own reach can touch, so a query's cell holds a superset
 * of the pieces that can answer it. Each cell's list keeps the row order, so the nearest piece of
 * equal distance is the one the first row names.
 */
function indexReaches(reaches: readonly IReach[], cellSize: number): ReadonlyMap<string, IReach[]> {
  const cells = new Map<string, IReach[]>();
  for (const piece of reaches) {
    const bx = piece.ax + piece.dx;
    const bz = piece.az + piece.dz;
    const fromX = Math.floor((Math.min(piece.ax, bx) - piece.reach) / cellSize);
    const toX = Math.floor((Math.max(piece.ax, bx) + piece.reach) / cellSize);
    const fromZ = Math.floor((Math.min(piece.az, bz) - piece.reach) / cellSize);
    const toZ = Math.floor((Math.max(piece.az, bz) + piece.reach) / cellSize);
    for (let cx = fromX; cx <= toX; cx += 1)
      for (let cz = fromZ; cz <= toZ; cz += 1) {
        const key = `${cx}:${cz}`;
        const list = cells.get(key);
        if (list) list.push(piece);
        else cells.set(key, [piece]);
      }
  }
  return cells;
}
