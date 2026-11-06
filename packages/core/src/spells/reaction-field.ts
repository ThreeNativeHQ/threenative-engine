/**
 * Where the world keeps what a spell did to it.
 *
 * A fireball that only draws a fireball has not landed anywhere. Upstream keeps this in
 * `GroundField.js`: every spell paints a patch of floor with heat, char, water, frost, a crack or a
 * residual glow, and the floor's own shader reads those channels back. The arena SDF is what makes
 * that file impossible to reuse, so this is the same idea with the arena removed — the game says
 * where the floor is, and the game's material decides what heat looks like.
 *
 * Same contract as `RippleField`: it draws nothing, owns no mesh and no colour. It reports values,
 * the game reads them, and a game that never looks at a channel pays a float array for it and
 * nothing else.
 *
 * The solve is a CPU grid because a game reads it for combos: "cast ice on wet floor" has to be a
 * branch, not a GPU readback that arrives two frames late.
 */

/** The channels a spell writes. Each is independent and decays on its own clock. */
export const REACTION_CHANNELS = [
  /** Fire, lightning and lava: what a floor reads as "still burning". */
  "heat",
  /** Burnt floor. Decays far slower than heat and is what a scorch looks like. */
  "char",
  /** Water and ice melt: a puddle a lightning spell spreads across. */
  "wet",
  /** Ice. Reads cold, and a fire spell wants to melt it back. */
  "frost",
  /** A fissure or a shattered floor: a crack pattern whose strength fades. */
  "crack",
  /** Residual magic light, for a floor that glows after impact. */
  "glow",
] as const;

export type ReactionChannel = (typeof REACTION_CHANNELS)[number];

/** Where a splat landed and how much of it the spell laid down. Every channel is 0..1. */
export interface IReactionSplat {
  readonly x: number;
  readonly z: number;
  /** Metres. The Gaussian reaches about three of these. */
  readonly radius: number;
  /** `radial` fades from the centre; `ring` leaves a rim; `streak` is stretched along `angle`. */
  readonly pattern?: ReactionPattern;
  /** Radians. Turns the `streak` axis, and is ignored by every other pattern. */
  readonly angle?: number;
  /** Pattern seed, so two impacts of the same spell are not the same mark. */
  readonly seed?: number;
  readonly heat?: number;
  readonly char?: number;
  readonly wet?: number;
  readonly frost?: number;
  readonly crack?: number;
  readonly glow?: number;
}

export type ReactionPattern = "radial" | "ring" | "streak";

/** A whole-cell rectangle of changed cells, in grid indices. */
export interface IReactionDirty {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
}

export interface IReactionFieldOptions {
  /** Cells per side. Cost is quadratic in this; 96 over a 120 m patch is ~1.25 m per cell. */
  readonly resolution?: number;
  /** Width of the patch in metres. */
  readonly size?: number;
  /** Per-channel seconds for a full-strength value to halve. `char` is the slow one. */
  readonly halfLife?: Partial<Readonly<Record<ReactionChannel, number>>>;
}

const DEFAULT_HALF_LIFE: Readonly<Record<ReactionChannel, number>> = {
  // ponytail: one half-life per channel and no wave transport. Upgrade to a GPU solve with
  // advection if a game needs fire to spread uphill or water to run across a floor.
  heat: 3.5,
  char: 24,
  crack: 40,
  frost: 8,
  glow: 1.6,
  wet: 12,
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
};

/** A small integer hash, so a seed alone reproduces the mark without touching `Math.random`. */
const hash2 = (x: number, y: number, seed: number): number => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
};

/**
 * A patch of world that spells leave marks on.
 *
 * One float array per channel, decayed on `update`, written by `splat`. `consumeDirty` reports the
 * cells that changed since the last call, so a material uploads a strip instead of the whole grid.
 */
export class ReactionField {
  readonly resolution: number;
  readonly size: number;
  readonly dx: number;
  /** Patch centre in world metres. */
  centerX = 0;
  centerZ = 0;
  /** Bumped whenever any cell changes, so an upload can skip an unchanged frame. */
  version = 0;

  readonly #channels: Record<ReactionChannel, Float32Array>;
  readonly #halfLife: Record<ReactionChannel, number>;
  #dirty: { minX: number; minZ: number; maxX: number; maxZ: number } | undefined;
  #empty = true;

  constructor(options: IReactionFieldOptions = {}) {
    const resolution = options.resolution ?? 96;
    if (!Number.isInteger(resolution) || resolution < 16 || resolution > 512)
      throw new RangeError("resolution must be an integer in 16..512");
    const size = options.size ?? 120;
    if (!Number.isFinite(size) || size <= 0) throw new RangeError("size must be a positive length");
    this.resolution = resolution;
    this.size = size;
    this.dx = size / resolution;
    const count = resolution * resolution;
    this.#channels = {} as Record<ReactionChannel, Float32Array>;
    this.#halfLife = { ...DEFAULT_HALF_LIFE };
    for (const channel of REACTION_CHANNELS) {
      this.#channels[channel] = new Float32Array(count);
      const halfLife = options.halfLife?.[channel];
      if (halfLife !== undefined) {
        if (!Number.isFinite(halfLife) || halfLife <= 0)
          throw new RangeError(`halfLife.${channel} must be positive and finite`);
        this.#halfLife[channel] = halfLife;
      }
    }
  }

  /** The live values of one channel, row-major from the patch's -x/-z corner. Read-only to a game. */
  data(channel: ReactionChannel): Float32Array {
    return this.#channels[channel];
  }

  /** True while every cell of every channel is exactly zero. */
  get empty(): boolean {
    return this.#empty;
  }

  /** True while the point is inside the patch, `margin` metres in from its rim. */
  contains(x: number, z: number, margin = 0): boolean {
    const half = this.size / 2 - margin;
    return Math.abs(x - this.centerX) < half && Math.abs(z - this.centerZ) < half;
  }

  /** Nearest-neighbour read at a world point, 0 outside the patch. Cheap enough for a combo check. */
  sample(channel: ReactionChannel, x: number, z: number): number {
    if (!this.contains(x, z)) return 0;
    const n = this.resolution;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((x - this.centerX) / this.size + 0.5) * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(((z - this.centerZ) / this.size + 0.5) * n)));
    return (this.#channels[channel] as Float32Array)[j * n + i] as number;
  }

  /** Strongest channel at a point, for a game that only asks "is anything happening here". */
  strongest(x: number, z: number): ReactionChannel | undefined {
    let best: ReactionChannel | undefined;
    let bestValue = 0;
    for (const channel of REACTION_CHANNELS) {
      const value = this.sample(channel, x, z);
      if (value > bestValue) {
        bestValue = value;
        best = channel;
      }
    }
    return best;
  }

  /**
   * Lay a mark on the patch. Every channel is additive and saturates at 1, so two fireballs on the
   * same cell burn hotter than one but never past the top of the range. Off-patch splats return
   * false and change nothing.
   */
  splat(splat: IReactionSplat): boolean {
    // Validate before anything else: off-patch and malformed are different answers, and a caller
    // that hands in a NaN must be told so rather than silently told "off patch".
    const radius = validateSplat(splat);
    if (!this.contains(splat.x, splat.z)) return false;
    const amounts = amountsOf(splat);
    if (amounts === undefined) return true;
    const { cells, hiX, hiZ, ix, iz, loX, loZ } = this.#cellRect(splat, radius);
    const seed = splat.seed ?? 0;
    const shape = {
      angleCos: Math.cos(splat.angle ?? 0),
      angleSin: Math.sin(splat.angle ?? 0),
      cells,
      pattern: splat.pattern ?? "radial",
    };
    const n = this.resolution;
    for (let j = loZ; j <= hiZ; j++) {
      for (let i = loX; i <= hiX; i++) {
        const shaped = cellShape(shape, i - ix, j - iz);
        if (shaped <= 0.002) continue;
        // A per-cell wobble keeps a mark from reading as an airbrushed circle.
        const grain = 0.7 + 0.6 * ((hash2(i, j, seed) & 0xffff) / 0xffff);
        const index = j * n + i;
        for (const [channel, amount] of amounts) {
          const data = this.#channels[channel];
          data[index] = clamp01((data[index] as number) + amount * shaped * grain);
        }
      }
    }
    this.#markDirty(loX, loZ, hiX, hiZ);
    this.#empty = false;
    return true;
  }

  /** Forget everything now, and report one last full-patch upload. */
  clear(): void {
    for (const channel of REACTION_CHANNELS) (this.#channels[channel] as Float32Array).fill(0);
    this.#empty = true;
    this.#markDirty(0, 0, this.resolution - 1, this.resolution - 1);
  }

  /** Move the patch with the action. Newly exposed cells arrive clean. */
  recenter(x: number, z: number): void {
    finite(x, "x");
    finite(z, "z");
    const di = Math.round((x - this.centerX) / this.dx);
    const dj = Math.round((z - this.centerZ) / this.dx);
    if (di === 0 && dj === 0) return;
    this.centerX += di * this.dx;
    this.centerZ += dj * this.dx;
    if (this.#empty) return;
    if (Math.abs(di) >= this.resolution || Math.abs(dj) >= this.resolution) {
      for (const channel of REACTION_CHANNELS) (this.#channels[channel] as Float32Array).fill(0);
      this.#empty = true;
    } else {
      const scratch = new Float32Array(this.resolution * this.resolution);
      for (const channel of REACTION_CHANNELS)
        shift(this.#channels[channel], this.resolution, di, dj, scratch);
    }
    this.#markDirty(0, 0, this.resolution - 1, this.resolution - 1);
  }

  /** Decay every channel on its own half-life. Time passing on a clean patch changes no cell. */
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("ReactionField.update delta must be finite and non-negative");
    if (this.#empty || dt === 0) return;
    let live = false;
    for (const channel of REACTION_CHANNELS) live = this.#decay(channel, dt) || live;
    if (!live) this.#empty = true;
  }

  /**
   * Hand back the cells that changed since the last call, and forget them.
   * `undefined` means nothing changed, so an upload can be skipped whole.
   */
  consumeDirty(): IReactionDirty | undefined {
    const dirty = this.#dirty;
    this.#dirty = undefined;
    if (dirty === undefined) return undefined;
    return {
      height: dirty.maxZ - dirty.minZ + 1,
      width: dirty.maxX - dirty.minX + 1,
      x: dirty.minX,
      z: dirty.minZ,
    };
  }

  /** The cells a splat can reach, and the splat's centre in grid coordinates. */
  #cellRect(
    splat: IReactionSplat,
    radius: number,
  ): {
    ix: number;
    iz: number;
    cells: number;
    loX: number;
    hiX: number;
    loZ: number;
    hiZ: number;
  } {
    const n = this.resolution;
    const ix = ((splat.x - this.centerX) / this.size + 0.5) * n - 0.5;
    const iz = ((splat.z - this.centerZ) / this.size + 0.5) * n - 0.5;
    const cells = Math.max(0.75, radius / this.dx);
    // A streak stretches 2.4x along its axis, so its reach has to cover that or the mark is cut off.
    const reach = 2.2 * cells * (splat.pattern === "streak" ? 2.4 : 1);
    return {
      cells,
      hiX: Math.min(n - 1, Math.ceil(ix + reach)),
      hiZ: Math.min(n - 1, Math.ceil(iz + reach)),
      ix,
      iz,
      loX: Math.max(0, Math.floor(ix - reach)),
      loZ: Math.max(0, Math.floor(iz - reach)),
    };
  }

  /** Decay one channel for a step. True while any cell is still lit. */
  #decay(channel: ReactionChannel, dt: number): boolean {
    const data = this.#channels[channel];
    // exp2(-dt / halfLife): the fraction still left after this step.
    const keep = 2 ** (-dt / (this.#halfLife[channel] as number));
    const extent = { hiX: -1, hiZ: -1, loX: this.resolution, loZ: this.resolution };
    const live = decayCells(data, keep, this.resolution, extent);
    // Only the cells that were lit changed, so an upload stays a strip and not the whole patch.
    if (extent.hiX >= 0) this.#markDirty(extent.loX, extent.loZ, extent.hiX, extent.hiZ);
    return live;
  }

  #markDirty(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.version += 1;
    const dirty = this.#dirty;
    if (dirty === undefined) this.#dirty = { maxX, maxZ, minX, minZ };
    else {
      dirty.minX = Math.min(dirty.minX, minX);
      dirty.minZ = Math.min(dirty.minZ, minZ);
      dirty.maxX = Math.max(dirty.maxX, maxX);
      dirty.maxZ = Math.max(dirty.maxZ, maxZ);
    }
  }
}

/** Decay one channel's cells in place, recording the lit rectangle and whether anything survives. */
function decayCells(
  data: Float32Array,
  keep: number,
  n: number,
  extent: { loX: number; loZ: number; hiX: number; hiZ: number },
): boolean {
  let live = false;
  for (let index = 0; index < data.length; index++) {
    const value = data[index] as number;
    if (value === 0) continue;
    const next = value * keep;
    data[index] = next < 1e-4 ? 0 : next;
    const i = index % n;
    const j = (index - i) / n;
    if (i < extent.loX) extent.loX = i;
    if (i > extent.hiX) extent.hiX = i;
    if (j < extent.loZ) extent.loZ = j;
    if (j > extent.hiZ) extent.hiZ = j;
    if (data[index] !== 0) live = true;
  }
  return live;
}

/** Reject a splat that is not a real mark, before any of it is applied. */
function validateSplat(splat: IReactionSplat): number {
  const radius = finite(splat.radius, "splat.radius");
  if (!(radius > 0)) throw new RangeError("splat.radius must be positive");
  if (!Number.isFinite(splat.x)) throw new TypeError("splat.x must be finite");
  if (!Number.isFinite(splat.z)) throw new TypeError("splat.z must be finite");
  if (splat.angle !== undefined && !Number.isFinite(splat.angle))
    throw new TypeError("splat.angle must be finite");
  // A NaN amount would saturate nothing and never decay, leaving the patch permanently dirty.
  for (const channel of REACTION_CHANNELS) {
    const amount = splat[channel];
    if (amount !== undefined && !Number.isFinite(amount))
      throw new TypeError(`splat.${channel} must be finite`);
  }
  return radius;
}

/** The channels a splat actually writes, or undefined when it asks for none. */
function amountsOf(splat: IReactionSplat): [ReactionChannel, number][] | undefined {
  const amounts: [ReactionChannel, number][] = [];
  for (const channel of REACTION_CHANNELS) {
    const amount = splat[channel] ?? 0;
    if (amount !== 0) amounts.push([channel, amount]);
  }
  return amounts.length === 0 ? undefined : amounts;
}

/** How much of a splat lands on one cell, from the pattern and the distance to its centre. */
function cellShape(
  shape: {
    readonly pattern: ReactionPattern;
    readonly cells: number;
    readonly angleCos: number;
    readonly angleSin: number;
  },
  ddx: number,
  ddz: number,
): number {
  const { cells, pattern } = shape;
  if (pattern === "streak") {
    // Stretch along the impact direction, so a slid-in spell leaves a line, not a disc.
    const along = (ddx * shape.angleCos + ddz * shape.angleSin) / 2.4;
    const across = (-ddx * shape.angleSin + ddz * shape.angleCos) / 0.8;
    return Math.exp(-((along * along + across * across) / (cells * cells)));
  }
  const q = (ddx * ddx + ddz * ddz) / (cells * cells);
  return pattern === "ring" ? Math.exp(-((Math.sqrt(q) - 0.8) ** 2) * 6) : Math.exp(-q);
}

function shift(data: Float32Array, n: number, di: number, dj: number, scratch: Float32Array): void {
  scratch.fill(0);
  const i0 = Math.max(0, -di);
  const i1 = Math.min(n, n - di);
  const j0 = Math.max(0, -dj);
  const j1 = Math.min(n, n - dj);
  for (let j = j0; j < j1; j++) {
    const source = (j + dj) * n + i0 + di;
    scratch.set(data.subarray(source, source + (i1 - i0)), j * n + i0);
  }
  data.set(scratch);
}
