/** A tile is built inside this many draw distances, so it exists before it is seen. */
export const CREATE_BAND = 1.3;
/** A tile is discarded only past this many draw distances, so a camera on the edge never thrashes. */
export const DISCARD_BAND = 1.4;

export interface ITileBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/**
 * What a `TileRing` needs from the field it streams: the live settings every frame reads, one tile
 * builder, and the three things to do to a live tile. The field keeps the ground query, the look and
 * the level-of-detail rule; the ring keeps the ring.
 */
export interface ITileRingField<TTile> {
  readonly chunkSize: number;
  readonly drawDistance: number;
  readonly buildBudgetMs: number;
  /** Whether a column is inside the field's bounds; the ring asks before queueing it. */
  inBounds(ix: number, iz: number): boolean;
  /** Builds one tile. Resolve an empty tile by returning `null`; it is remembered, not rebuilt. */
  build(ix: number, iz: number): TTile | null;
  /** The tile is live and inside the draw distance: show it and pick its level of detail. */
  show(tile: TTile, distance: number): void;
  /** The tile is live but outside the draw distance, and not yet discarded. */
  hide(tile: TTile): void;
  dispose(tile: TTile): void;
}

export interface ITileRingStats {
  /** Live tiles, built or remembered empty. */
  tiles: number;
  /** Tiles the last `update` showed. */
  visible: number;
  /** Tiles queued but not built at the end of the last `update`. */
  pending: number;
  /** Tiles built since the ring was made. */
  built: number;
}

interface ITile<TTile> {
  readonly ix: number;
  readonly iz: number;
  /** `null` when the builder found nothing to place: remembered so it is not rebuilt every frame. */
  readonly tile: TTile | null;
  seen: number;
}

/**
 * Square tiles streamed round a moving follow point, nearest first, under a per-frame build budget.
 *
 * A tile is built inside 1.3 × the draw distance and discarded past 1.4 ×, Unreal Landscape grass's
 * guard band (UE 5.8.3: Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:88, :94), so a
 * follow point on the edge never thrashes. One tile always builds, so the ring advances even under a
 * budget smaller than one build; the rest wait nearest first. The field supplies what a tile is, how
 * it looks at a distance and how it is freed, so grass blades and scattered props stream through the
 * same loop.
 *
 * @constraint call `update(x, z)` once per rendered frame
 * @constraint rotating or scaling the owning group is not supported; translating it is
 */
export class TileRing<TTile> {
  readonly stats: ITileRingStats = { built: 0, pending: 0, tiles: 0, visible: 0 };
  readonly #field: ITileRingField<TTile>;
  readonly #tiles = new Map<number, ITile<TTile>>();
  readonly #queue: { d: number; ix: number; iz: number; k: number }[] = [];
  #frame = 0;
  #prewarm = false;

  constructor(field: ITileRingField<TTile>) {
    this.#field = field;
  }

  /** Every live tile, for a field that has to re-scatter or re-key its own build. */
  tiles(): IterableIterator<ITile<TTile>> {
    return this.#tiles.values();
  }

  /** Builds every tile in range on the next `update` regardless of budget: on load or after a teleport. */
  prewarm(): void {
    this.#prewarm = true;
  }

  /** Drops every live tile: the field's density or layout changed. */
  clear(): void {
    for (const entry of this.#tiles.values())
      if (entry.tile !== null) this.#field.dispose(entry.tile);
    this.#tiles.clear();
  }

  /** Frees the tiles touching a rectangle, so only what changed re-scatters. */
  disposeInside(rect: ITileBounds): void {
    const S = this.#field.chunkSize;
    for (const [k, entry] of this.#tiles) {
      if (
        entry.ix * S > rect.maxX ||
        (entry.ix + 1) * S < rect.minX ||
        entry.iz * S > rect.maxZ ||
        (entry.iz + 1) * S < rect.minZ
      )
        continue;
      if (entry.tile !== null) this.#field.dispose(entry.tile);
      this.#tiles.delete(k);
    }
  }

  /** Streams, shows and frees the tiles round `(cx, cz)`. Call once per rendered frame. */
  update(cx: number, cz: number): void {
    const field = this.#field;
    const R = field.drawDistance;
    const frame = ++this.#frame;
    this.stats.visible = 0;
    this.#visit(cx, cz, R, frame);
    this.#buildQueued(frame);
    this.#prewarm = false;
    this.#evict(cx, cz, R, frame);
    this.stats.tiles = this.#tiles.size;
  }

  /** Marks the tiles inside the create band and queues the missing ones. */
  #visit(cx: number, cz: number, R: number, frame: number): void {
    const S = this.#field.chunkSize;
    const reach = R * CREATE_BAND;
    const queue = this.#queue;
    queue.length = 0;
    for (let iz = Math.floor((cz - reach) / S); iz <= Math.floor((cz + reach) / S); iz++) {
      for (let ix = Math.floor((cx - reach) / S); ix <= Math.floor((cx + reach) / S); ix++) {
        const d = tileDistance(ix, iz, cx, cz, S);
        if (d >= reach || !this.#field.inBounds(ix, iz)) continue;
        const k = tileKey(ix, iz);
        const entry = this.#tiles.get(k);
        if (!entry) {
          queue.push({ d, ix, iz, k });
          continue;
        }
        entry.seen = frame;
        if (entry.tile !== null) this.#field.show(entry.tile, d);
      }
    }
  }

  /** Builds queued tiles nearest first; one always builds, the rest only inside the budget. */
  #buildQueued(frame: number): void {
    const queue = this.#queue;
    queue.sort((a, c) => a.d - c.d);
    const budget = this.#prewarm ? Number.POSITIVE_INFINITY : this.#field.buildBudgetMs;
    const t0 = performance.now();
    let built = 0;
    for (const q of queue) {
      if (built > 0 && performance.now() - t0 > budget) break;
      const tile = this.#field.build(q.ix, q.iz);
      this.#tiles.set(q.k, { ix: q.ix, iz: q.iz, seen: frame, tile });
      if (tile !== null) this.#field.show(tile, q.d);
      built++;
    }
    this.stats.built += built;
    this.stats.pending = queue.length - built;
  }

  /** Hides tiles that left the view radius and frees those past the discard band. */
  #evict(cx: number, cz: number, R: number, frame: number): void {
    const S = this.#field.chunkSize;
    for (const [k, entry] of this.#tiles) {
      if (entry.seen === frame) continue;
      if (tileDistance(entry.ix, entry.iz, cx, cz, S) > R * DISCARD_BAND) {
        if (entry.tile !== null) this.#field.dispose(entry.tile);
        this.#tiles.delete(k);
      } else if (entry.tile !== null) this.#field.hide(entry.tile);
    }
  }
}

/** The distance from a point to a tile's nearest corner, in the ground plane. */
export function tileDistance(ix: number, iz: number, cx: number, cz: number, S: number): number {
  const dx = Math.max(ix * S - cx, 0, cx - (ix + 1) * S);
  const dz = Math.max(iz * S - cz, 0, cz - (iz + 1) * S);
  return Math.sqrt(dx * dx + dz * dz);
}

/** A tile column's key: unique for ix and iz in ±32767. */
export const tileKey = (ix: number, iz: number): number => (ix + 0x8000) * 0x10000 + (iz + 0x8000);

/** A seeded 32-bit integer hash of a column and a salt. */
export function hashInt(x: number, y: number, s: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The seeded generator both fields scatter their instances from. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 0..total-1 in a seeded random order. Visiting a jittered grid in this order means any prefix
 * covers the tile evenly, so distance thinning is a plain instance count.
 */
export function shuffled(total: number, rng: () => number): Uint32Array {
  const order = new Uint32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  for (let i = total - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }
  return order;
}

/** Height, d/dx and d/dz of the last `groundGrid` sample. */
export const sample = new Float64Array(3);

/**
 * Ground height on a grid one ring wider than a tile, for gradients; `sample` reads it bilinearly.
 * Heights come from the game's own `getHeight`, so a tilt on a prop follows the ground the game
 * draws, not a second copy of it.
 */
export function groundGrid(
  getHeight: (x: number, z: number) => number,
  ox: number,
  oz: number,
  S: number,
  spacing: number,
): { sample(lx: number, lz: number): void } {
  const G = Math.max(1, Math.ceil(S / Math.max(spacing, 0.05)));
  const gs = S / G;
  const N = G + 3;
  const hg = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++)
      hg[j * N + i] = getHeight(ox + (i - 1) * gs, oz + (j - 1) * gs) || 0;
  const gx = new Float32Array(N * N);
  const gz = new Float32Array(N * N);
  const inv2 = 1 / (2 * gs);
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const o = j * N + i;
      gx[o] = ((hg[o + 1] as number) - (hg[o - 1] as number)) * inv2;
      gz[o] = ((hg[o + N] as number) - (hg[o - N] as number)) * inv2;
    }
  return {
    sample(lx, lz) {
      const fx = lx / gs + 1;
      const fz = lz / gs + 1;
      const i0 = Math.min(fx | 0, G);
      const j0 = Math.min(fz | 0, G);
      const u = fx - i0;
      const v = fz - j0;
      const o = j0 * N + i0;
      // Bilinear weights once, no closure per call: this runs for every candidate.
      const w00 = (1 - u) * (1 - v);
      const w10 = u * (1 - v);
      const w01 = (1 - u) * v;
      const w11 = u * v;
      const o1 = o + 1;
      const oN = o + N;
      const oN1 = oN + 1;
      sample[0] =
        (hg[o] as number) * w00 +
        (hg[o1] as number) * w10 +
        (hg[oN] as number) * w01 +
        (hg[oN1] as number) * w11;
      sample[1] =
        (gx[o] as number) * w00 +
        (gx[o1] as number) * w10 +
        (gx[oN] as number) * w01 +
        (gx[oN1] as number) * w11;
      sample[2] =
        (gz[o] as number) * w00 +
        (gz[o1] as number) * w10 +
        (gz[oN] as number) * w01 +
        (gz[oN1] as number) * w11;
    },
  };
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-6));
  return t * t * (3 - 2 * t);
}
