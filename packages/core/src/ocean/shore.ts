// Shore waves: when a swell reaches a cell from the beach outward, which way its front runs there,
// and how tall it stands by then. Ported from [Ultra-Water](https://github.com/Humpalumps/Ultra-Water)
// (MIT, `ce9248f`, `src/water/shoreMap.js`), rewritten as TypeScript over the heightfield a bake
// already has. The method is Ultra-Water's: a fast-sweeping eikonal solve of |grad tau| = 1/c with
// c = sqrt(g depth), fronts read off grad tau, ray-tube convergence read off the front curvature,
// Green's law plus a 0.42 depth breaking limit on the crest.
//
// It measures the bathymetry it is given, so it carries no tuning constant: the reference depth for
// Green's law is the deepest water in the field, and the ray-tube window is a fraction of the
// domain. A cell the swell cannot reach — behind a bar that breaks the surface, in a lagoon, a
// puddle — gets no front at all, and that is the whole of the old "exposed shore" rule.
//
// The solve is seeded at the coastline of the open sea, not at the domain border: travel time is
// zero where water meets land and grows offshore, so fronts are iso-lines of the coast and refract
// around it. Seeding at the border instead draws iso-lines of the rectangle the bake covers, which
// reads as regular corrugation parallel to an invisible box on a straight shelf.
//
// It decides no look. Foam, colour, wave period, how the crest leans and how wide a surf zone reads
// are the game's, from the fields below.

const GRAVITY = 9.81;

/**
 * The depth, in metres, at which a shallow-water wave stops propagating.
 *
 * c = sqrt(g depth) reaches zero at the waterline and the travel time diverges there, which is the
 * model telling you the wave has already broken. Under this floor c stops falling, so the last few
 * centimetres of water cost a finite time instead of an infinite one. A model limit, not a knob:
 * the breaking limit below is what decides where a crest tops out.
 */
const FLOOR_DEPTH = 0.25;

/** How much of the water depth under a crest a breaking wave can stand in. Physical, not aesthetic. */
const BREAK_RATIO = 0.42;

/** Guards on the shoaling factor, so a nearly dry cell cannot carry an unbounded crest. */
const SHOALING_MIN = 0.3;
const SHOALING_MAX = 2.5;

/** Above this many passes the solve stops: four diagonal orders have long since converged. */
const MAX_SWEEPS = 8;
/** Front curvature is clamped to this, in 1/m, so one noisy texel cannot fold a crest. */
const CURVATURE_MAX = 1 / 25;

/** What one shore-wave bake produces, all arrays `resolution * resolution`, row-major by Z then X. */
export interface IShoreWaveField {
  /** Cells per side, as given. */
  readonly resolution: number;
  /** The world-space edge length the grid spans, in metres, as given. */
  readonly size: number;
  /** Metres between cell centres. */
  readonly cellSize: number;
  /**
   * Seconds a front needs to reach this cell from the beach it is running at: zero on the waterline,
   * growing offshore, so the front itself travels down the gradient.
   *
   * `Infinity` where no front arrives: land, and any water the swell cannot reach — a lagoon behind
   * a spit, a pond, a puddle. Consumers must mask by this rather than by depth.
   */
  readonly travel: Float32Array;
  /** Unit direction the front runs, in world x/z: down the travel-time gradient, at the beach. */
  readonly directionX: Float32Array;
  readonly directionZ: Float32Array;
  /**
   * Crest amplitude factor relative to the deepest water in the field: Green's law times the
   * ray-tube factor. One in uniformly deep water, above one where a front converges on a headland,
   * below one in a bay.
   */
  readonly shoaling: Float32Array;
  /**
   * The crest height a front of `incidentHeight` carries at this cell, in metres: the shoaled
   * height, capped at 0.42 of the water depth under it. Zero on land.
   */
  readonly height: Float32Array;
  /**
   * How clean the front is, 0 to 1: one on a smooth train, falling to zero where fronts from two
   * stretches of coast collide (a shock in `travel`) and the heightfield would fold. Multiply the
   * crest height by it.
   */
  readonly fade: Float32Array;
}

export interface IShoreWaveOptions {
  /**
   * The crest height, in metres, the swell carries in open water.
   *
   * A sea state, so the game states it: the bake scales the shoaling to it and then applies the
   * breaking limit, and it cannot invent a wave height no one asked for.
   */
  readonly incidentHeight: number;
}

function checkInput(
  heights: ArrayLike<number>,
  resolution: number,
  size: number,
  level: number,
  options: IShoreWaveOptions,
): void {
  if (!Number.isFinite(level)) throw new Error("bakeShoreWaves.level must be a finite number.");
  if (!Number.isInteger(resolution) || resolution < 2)
    throw new Error("bakeShoreWaves.resolution must be an integer of at least 2.");
  if (!Number.isFinite(size) || size <= 0)
    throw new Error("bakeShoreWaves.size must be a positive number of metres.");
  if (heights.length !== resolution * resolution)
    throw new Error(
      `bakeShoreWaves.heights has ${heights.length} cells; ${resolution}x${resolution} needs ${resolution * resolution}.`,
    );
  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index] as number;
    if (!Number.isFinite(height))
      throw new Error(`bakeShoreWaves.heights[${index}] is not a finite height.`);
  }
  const incident = options.incidentHeight;
  if (!Number.isFinite(incident) || incident <= 0)
    throw new Error("bakeShoreWaves.incidentHeight must be a positive number of metres.");
}

/** Metres of water over every cell; zero or less is land and blocks a front. */
function depthsUnder(heights: ArrayLike<number>, level: number): Float32Array {
  const depth = new Float32Array(heights.length);
  for (let index = 0; index < heights.length; index += 1)
    depth[index] = level - (heights[index] as number);
  return depth;
}

/** Seconds to cross one cell, and the shallow-water speed that sets it. */
function cellTimes(
  depth: Float32Array,
  cellSize: number,
): { speed: Float32Array; slow: Float64Array } {
  const speed = new Float32Array(depth.length);
  const slow = new Float64Array(depth.length);
  for (let index = 0; index < depth.length; index += 1) {
    const water = depth[index] as number;
    if (water <= 0) continue;
    const c = Math.sqrt(GRAVITY * Math.max(water, FLOOR_DEPTH));
    speed[index] = c;
    slow[index] = cellSize / c;
  }
  return { speed, slow };
}

/**
 * The open sea: the water a swell can arrive in, flooded from the water cells on the domain border.
 *
 * A pond behind a bar, a lagoon inside a spit, a puddle on the sand — none of them is connected to
 * open water, so none of them carries a front. That is the sheltered-water rule, measured instead
 * of assumed, and it is the only reason a domain needs a border: the sea has to touch it somewhere.
 */
function openSea(depth: Float32Array, resolution: number): Uint8Array {
  const open = new Uint8Array(depth.length);
  const stack: number[] = [];
  const push = (cell: number): void => {
    if (open[cell] === 1 || (depth[cell] as number) <= 0) return;
    open[cell] = 1;
    stack.push(cell);
  };
  for (let index = 0; index < resolution; index += 1) {
    push(index);
    push((resolution - 1) * resolution + index);
    push(index * resolution);
    push(index * resolution + resolution - 1);
  }
  // Iterative flood fill: a recursive one blows the stack on a 1025-cell bake.
  while (stack.length > 0) {
    const cell = stack.pop() as number;
    const row = Math.floor(cell / resolution);
    const column = cell % resolution;
    if (column > 0) push(cell - 1);
    if (column < resolution - 1) push(cell + 1);
    if (row > 0) push(cell - resolution);
    if (row < resolution - 1) push(cell + resolution);
  }
  return open;
}

/**
 * Seeds the solve at the coastline of that open sea, not at the domain border.
 *
 * This is the difference between fronts that follow the water and fronts that follow the rectangle
 * the bake happens to cover: a rim-seeded solve draws iso-lines of the border, so a straight shelf
 * becomes regular corrugation parallel to an invisible box. Seeding where water meets land and
 * letting travel time grow offshore gives iso-lines of the *coast*, so a headland bends them, a bay
 * spreads them and the shelf bunches them as it shallows.
 *
 * `travel` is padded by one cell on every side so the sweep needs no edge tests; the padding stays
 * `Infinity` and acts as a wall.
 */
function seedCoast(
  travel: Float64Array,
  depth: Float32Array,
  open: Uint8Array,
  resolution: number,
): number {
  const width = resolution + 2;
  // Outside the bake is the open sea continuing, not a shore: only land, and water closed off from
  // the open sea, stops a front.
  const blocks = (row: number, column: number): boolean => {
    if (row < 0 || column < 0 || row >= resolution || column >= resolution) return false;
    return open[row * resolution + column] !== 1;
  };
  let seeds = 0;
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      if (open[row * resolution + column] !== 1) continue;
      const shoreward =
        blocks(row - 1, column) ||
        blocks(row + 1, column) ||
        blocks(row, column - 1) ||
        blocks(row, column + 1);
      if (!shoreward) continue;
      travel[(row + 1) * width + column + 1] = 0;
      seeds += 1;
    }
  }
  return seeds;
}

/**
 * The first-order Godunov update: the smaller neighbour on each axis decides the arrival time, from
 * the flat front when the two differ by more than one cell or from the circular front otherwise.
 */
function arrival(left: number, right: number, back: number, front: number, cell: number): number {
  const across = Math.min(left, right);
  const along = Math.min(back, front);
  const difference = Math.abs(across - along);
  if (difference >= cell) return Math.min(across, along) + cell;
  return 0.5 * (across + along + Math.sqrt(2 * cell * cell - difference * difference));
}

/**
 * One Gauss-Seidel pass over the whole grid in one of the four diagonal orders. Only a strictly
 * earlier arrival is written, so the rim's zero and the padding's `Infinity` never move.
 */
function sweep(
  travel: Float64Array,
  slow: Float64Array,
  wet: Uint8Array,
  resolution: number,
  stepX: number,
  stepZ: number,
): number {
  const width = resolution + 2;
  let changed = 0;
  for (
    let rowIndex = 0, row = stepZ > 0 ? 0 : resolution - 1;
    rowIndex < resolution;
    rowIndex += 1, row += stepZ
  ) {
    for (
      let columnIndex = 0, column = stepX > 0 ? 0 : resolution - 1;
      columnIndex < resolution;
      columnIndex += 1, column += stepX
    ) {
      const cell = row * resolution + column;
      if (!wet[cell]) continue;
      const padded = (row + 1) * width + column + 1;
      const time = arrival(
        travel[padded - 1] as number,
        travel[padded + 1] as number,
        travel[padded - width] as number,
        travel[padded + width] as number,
        slow[cell] as number,
      );
      if (time < (travel[padded] as number) - 1e-4) {
        travel[padded] = time;
        changed += 1;
      }
    }
  }
  return changed;
}

/** Four diagonal orders, repeated until no cell moves. */
function solve(
  travel: Float64Array,
  slow: Float64Array,
  wet: Uint8Array,
  resolution: number,
): void {
  for (let pass = 0; pass < MAX_SWEEPS; pass += 1) {
    const changed =
      sweep(travel, slow, wet, resolution, 1, 1) +
      sweep(travel, slow, wet, resolution, -1, 1) +
      sweep(travel, slow, wet, resolution, 1, -1) +
      sweep(travel, slow, wet, resolution, -1, -1);
    if (changed === 0) return;
  }
}

/** A least-squares slope through the neighbours that exist; one-sided on the domain edge. */
function slope(before: number, after: number, centre: number, cellSize: number): number {
  if (Number.isFinite(before) && Number.isFinite(after)) return (after - before) / (2 * cellSize);
  if (Number.isFinite(after)) return (after - centre) / cellSize;
  if (Number.isFinite(before)) return (centre - before) / cellSize;
  return 0;
}

/**
 * The front runs up the travel-time gradient, because travel time grows toward the beach as the
 * water shallows. `fade` compares the gradient with the local slowness: a first-order front in
 * water of depth h has |grad tau| = 1/c, so |grad tau| c reads 1 on a clean train and falls below
 * one where two trains meet and flatten each other's gradient.
 */
function frontDirections(
  travel: Float64Array,
  speed: Float32Array,
  resolution: number,
  cellSize: number,
  directionX: Float32Array,
  directionZ: Float32Array,
  fade: Float32Array,
): void {
  const width = resolution + 2;
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const padded = (row + 1) * width + column + 1;
      const time = travel[padded] as number;
      if (!Number.isFinite(time)) continue;
      const gradientX = slope(
        travel[padded - 1] as number,
        travel[padded + 1] as number,
        time,
        cellSize,
      );
      const gradientZ = slope(
        travel[padded - width] as number,
        travel[padded + width] as number,
        time,
        cellSize,
      );
      const gradient = Math.hypot(gradientX, gradientZ);
      if (!(gradient > 1e-9)) continue;
      // Travel time grows offshore, so the front runs *down* the gradient: toward the beach.
      const cell = row * resolution + column;
      directionX[cell] = -gradientX / gradient;
      directionZ[cell] = -gradientZ / gradient;
      const coherent = Math.min(1, Math.max(0, (gradient * (speed[cell] as number) - 0.7) / 0.25));
      fade[cell] = coherent * coherent * (3 - 2 * coherent);
    }
  }
}

/** Separable box blur, clamped at the edge, radius `reach`. Used on curvature and on the fade. */
function softened(source: Float32Array, resolution: number, reach: number): Float32Array {
  const window = 2 * reach + 1;
  const limit = resolution - 1;
  const clamp = (value: number): number => (value < 0 ? 0 : value > limit ? limit : value);
  const rows = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  for (let row = 0; row < resolution; row += 1) {
    const offset = row * resolution;
    let sum = 0;
    for (let index = -reach; index <= reach; index += 1)
      sum += source[offset + clamp(index)] as number;
    for (let column = 0; column < resolution; column += 1) {
      rows[offset + column] = sum / window;
      sum +=
        (source[offset + clamp(column + reach + 1)] as number) -
        (source[offset + clamp(column - reach)] as number);
    }
  }
  for (let column = 0; column < resolution; column += 1) {
    let sum = 0;
    for (let index = -reach; index <= reach; index += 1)
      sum += rows[clamp(index) * resolution + column] as number;
    for (let row = 0; row < resolution; row += 1) {
      out[row * resolution + column] = sum / window;
      sum +=
        (rows[clamp(row + reach + 1) * resolution + column] as number) -
        (rows[clamp(row - reach) * resolution + column] as number);
    }
  }
  return out;
}

/** The front's own bending, 1/m: the divergence of its direction, positive off a headland. */
function frontCurvature(
  directionX: Float32Array,
  directionZ: Float32Array,
  fade: Float32Array,
  resolution: number,
  cellSize: number,
): Float32Array {
  const curvature = new Float32Array(resolution * resolution);
  const at = (row: number, column: number): number => row * resolution + column;
  for (let row = 0; row < resolution; row += 1) {
    const before = row > 0 ? -1 : 0;
    const after = row < resolution - 1 ? 1 : 0;
    for (let column = 0; column < resolution; column += 1) {
      const left = column > 0 ? -1 : 0;
      const right = column < resolution - 1 ? 1 : 0;
      const spanX = (right - left) * cellSize;
      const spanZ = (after - before) * cellSize;
      const bend =
        ((directionX[at(row, column + right)] as number) -
          (directionX[at(row, column + left)] as number)) /
          spanX +
        ((directionZ[at(row + after, column)] as number) -
          (directionZ[at(row + before, column)] as number)) /
          spanZ;
      const cell = at(row, column);
      curvature[cell] =
        Math.min(CURVATURE_MAX, Math.max(-CURVATURE_MAX, bend)) * (fade[cell] as number);
    }
  }
  return softened(softened(curvature, resolution, 2), resolution, 2);
}

/**
 * How much a tube of fronts narrows on its way in, marched offshore along `-direction` and weighted
 * to forget anything further than a tenth of the domain away: `G = integral curvature e^(-s/L) ds`.
 *
 * A tube's width falls as fronts converge, so its energy per unit crest length rises as the square
 * root of the convergence, `exp(G/2)`. A straight coast gives zero, a headland an increase, a bay a
 * decrease. Walks two cells at a time: `G` varies slowly, and the field is a smoothing term.
 */
function rayTubes(
  curvature: Float32Array,
  travel: Float64Array,
  directionX: Float32Array,
  directionZ: Float32Array,
  resolution: number,
  size: number,
  cellSize: number,
): Float32Array {
  const tube = new Float32Array(resolution * resolution);
  const reach = size / 4;
  const stepCells = 2;
  const stride = cellSize * stepCells;
  const steps = Math.max(1, Math.round(reach / stride));
  const decay = size / 10;
  const weight = new Float64Array(steps);
  for (let step = 0; step < steps; step += 1)
    weight[step] = Math.exp(-(step * stride) / decay) * stride;
  const limit = resolution - 2;
  const sample = (field: Float32Array, x: number, z: number): number => {
    const px = Math.min(limit, Math.max(0, x));
    const pz = Math.min(limit, Math.max(0, z));
    const column = Math.floor(px);
    const row = Math.floor(pz);
    const fx = px - column;
    const fz = pz - row;
    const cell = row * resolution + column;
    const top = (field[cell] as number) * (1 - fx) + (field[cell + 1] as number) * fx;
    const bottom =
      (field[cell + resolution] as number) * (1 - fx) +
      (field[cell + resolution + 1] as number) * fx;
    return top * (1 - fz) + bottom * fz;
  };
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const cell = row * resolution + column;
      if (!Number.isFinite(travel[(row + 1) * (resolution + 2) + column + 1] as number)) continue;
      let x = column;
      let z = row;
      let total = 0;
      for (let step = 0; step < steps; step += 1) {
        total += (weight[step] as number) * sample(curvature, x, z);
        const backX = sample(directionX, x, z);
        const backZ = sample(directionZ, x, z);
        x -= backX * stepCells;
        z -= backZ * stepCells;
        if (x < 0 || z < 0 || x > resolution - 1 || z > resolution - 1) break;
      }
      tube[cell] = total;
    }
  }
  return tube;
}

/**
 * The travel time, direction, shoaling and breaking height of a swell arriving on a coast.
 *
 * `heights` are the bake's cell heights in metres, row-major by Z then X, `resolution` cells per
 * side over a square `size` metres. Cells at or above `level` are land: they block a front, and the
 * water line they draw is where every front starts. Water the open sea cannot reach carries none.
 *
 * Pure and synchronous: a 257-cell bake takes a few tens of milliseconds and needs no GPU. Throws
 * on a non-finite level or height, a resolution below 2, a heights length that does not match, or a
 * missing incident height.
 */
export function bakeShoreWaves(
  heights: ArrayLike<number>,
  resolution: number,
  size: number,
  level: number,
  options: IShoreWaveOptions,
): IShoreWaveField {
  checkInput(heights, resolution, size, level, options);
  const cellSize = size / (resolution - 1);
  const depth = depthsUnder(heights, level);
  const open = openSea(depth, resolution);
  let deepest = 0;
  for (let cell = 0; cell < depth.length; cell += 1)
    if (open[cell] === 1) deepest = Math.max(deepest, depth[cell] as number);
  const { speed, slow } = cellTimes(depth, cellSize);
  const width = resolution + 2;
  const padded = new Float64Array(width * width).fill(Number.POSITIVE_INFINITY);
  seedCoast(padded, depth, open, resolution);
  solve(padded, slow, open, resolution);

  const travel = new Float32Array(depth.length);
  const directionX = new Float32Array(depth.length);
  const directionZ = new Float32Array(depth.length);
  const fade = new Float32Array(depth.length);
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const cell = row * resolution + column;
      travel[cell] = padded[(row + 1) * width + column + 1] as number;
    }
  }
  frontDirections(padded, speed, resolution, cellSize, directionX, directionZ, fade);
  const smoothedFade = softened(softened(fade, resolution, 2), resolution, 2);
  const curvature = frontCurvature(directionX, directionZ, fade, resolution, cellSize);
  const tube = rayTubes(curvature, padded, directionX, directionZ, resolution, size, cellSize);

  const shoaling = new Float32Array(depth.length);
  const height = new Float32Array(depth.length);
  const incident = options.incidentHeight;
  for (let cell = 0; cell < depth.length; cell += 1) {
    const water = depth[cell] as number;
    fade[cell] = smoothedFade[cell] as number;
    // No front, no crest: land, and water the swell never reached (a lagoon behind a bar).
    if (water <= 0 || !Number.isFinite(travel[cell] as number)) continue;
    const green = (Math.max(water, FLOOR_DEPTH) / Math.max(deepest, FLOOR_DEPTH)) ** -0.25;
    const factor = Math.min(
      SHOALING_MAX,
      Math.max(SHOALING_MIN, green * Math.exp(0.5 * (tube[cell] as number))),
    );
    shoaling[cell] = factor;
    height[cell] = Math.min(incident * factor, BREAK_RATIO * water);
  }
  return { cellSize, directionX, directionZ, fade, height, resolution, shoaling, size, travel };
}
