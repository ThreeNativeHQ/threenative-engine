/**
 * Renderer-independent bookkeeping for virtual shadow pages.
 *
 * Four pieces, none of which know a GPU exists: stable virtual page addresses and a bounded
 * physical page pool with LRU eviction (`PhysicalPagePool`), camera-centred clip windows snapped
 * to whole pages in a light-space basis (`DirectionalClipmap`), the pages a frame needs from
 * receiver points and visible caster bounds (`ReceiverDemandPass`), and the pages a moving caster
 * dirties (`ShadowInvalidationTracker`). `VirtualShadowNode` in `virtual-shadow.ts` is the only
 * consumer; everything here is pure so its rules are provable in a node-environment spec.
 *
 * Fail closed: malformed input throws at the boundary instead of producing a page that samples
 * nothing.
 */

const EPSILON = 1e-9;

/** A plain `{x, y, z}` triple; three's `Vector3` satisfies it without a copy. */
export interface IVector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** An axis-aligned world-space box as two corners. */
export interface IBoundsLike {
  readonly min: IVector3Like;
  readonly max: IVector3Like;
}

/** A point in the light-space basis: `u` and `v` across the light, `w` toward it. */
export interface ILightSpacePoint {
  readonly u: number;
  readonly v: number;
  readonly w: number;
}

/** The address of one virtual page: a clip level and integer page coordinates. */
export interface IVirtualPageAddress {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly key: string;
}

function assertInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer; received ${String(value)}`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer; received ${String(value)}`);
  }
}

function assertFiniteVector(name: string, vector: IVector3Like | null | undefined): void {
  if (
    !vector ||
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  ) {
    throw new TypeError(`${name} must contain finite x, y and z values`);
  }
}

/** Build the string key of a virtual page. */
export function makePageKey(level: number, x: number, y: number): string {
  assertInteger("level", level);
  assertInteger("x", x);
  assertInteger("y", y);
  return `${level}:${x}:${y}`;
}

/** Parse a key produced by {@link makePageKey}; throws on anything else. */
export function parsePageKey(key: string): { level: number; x: number; y: number } {
  if (typeof key !== "string") throw new TypeError("page key must be a string");
  const parts = key.split(":").map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value))) {
    throw new TypeError(`invalid page key: ${key}`);
  }
  return { level: parts[0] as number, x: parts[1] as number, y: parts[2] as number };
}

/** One resident physical page. `slot` is the atlas layer that holds it. */
export interface IPhysicalPageEntry {
  readonly key: string;
  readonly slot: number;
  pinned: boolean;
  dirty: boolean;
  readonly generation: number;
  lastUsedFrame: number;
}

export interface IPhysicalPageAllocation {
  readonly entry: IPhysicalPageEntry;
  readonly reused: boolean;
  readonly evictedKey: string | null;
}

/**
 * A bounded set of physical page slots with deterministic least-recently-used eviction.
 *
 * Pinned entries and entries named in `protectedKeys` are never evicted; when nothing else can
 * go, `allocate` returns `null` and counts an overflow rather than silently reusing a page.
 */
export class PhysicalPagePool {
  readonly capacity: number;
  evictions = 0;
  overflow = 0;
  #generation = 0;
  readonly #resident = new Map<string, IPhysicalPageEntry>();
  #freeSlots: number[];

  constructor(capacity: number) {
    assertPositiveInteger("capacity", capacity);
    this.capacity = capacity;
    this.#freeSlots = Array.from({ length: capacity }, (_, slot) => slot);
  }

  get size(): number {
    return this.#resident.size;
  }

  has(key: string): boolean {
    return this.#resident.has(key);
  }

  get(key: string): IPhysicalPageEntry | undefined {
    return this.#resident.get(key);
  }

  /** Resident entries ordered by slot. */
  entries(): IPhysicalPageEntry[] {
    return [...this.#resident.values()].sort((a, b) => a.slot - b.slot);
  }

  allocate(
    key: string,
    {
      frame = 0,
      pinned = false,
      protectedKeys = new Set<string>(),
    }: { frame?: number; pinned?: boolean; protectedKeys?: ReadonlySet<string> } = {},
  ): IPhysicalPageAllocation | null {
    assertInteger("frame", frame);
    const resident = this.#resident.get(key);
    if (resident) {
      resident.lastUsedFrame = frame;
      resident.pinned ||= pinned;
      return { entry: resident, reused: true, evictedKey: null };
    }

    let slot = this.#freeSlots.shift();
    let evictedKey: string | null = null;
    if (slot === undefined) {
      const candidate = this.entries()
        .filter((entry) => !entry.pinned && !protectedKeys.has(entry.key))
        .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame || a.slot - b.slot)[0];
      if (!candidate) {
        this.overflow += 1;
        return null;
      }
      slot = candidate.slot;
      evictedKey = candidate.key;
      this.#resident.delete(candidate.key);
      this.evictions += 1;
    }

    this.#generation += 1;
    const entry: IPhysicalPageEntry = {
      key,
      slot,
      pinned,
      dirty: true,
      generation: this.#generation,
      lastUsedFrame: frame,
    };
    this.#resident.set(key, entry);
    return { entry, reused: false, evictedKey };
  }

  touch(key: string, frame: number): boolean {
    assertInteger("frame", frame);
    const entry = this.#resident.get(key);
    if (!entry) return false;
    entry.lastUsedFrame = frame;
    return true;
  }

  markDirty(key: string): boolean {
    const entry = this.#resident.get(key);
    if (!entry) return false;
    entry.dirty = true;
    return true;
  }

  /** Dirty every resident page; returns how many there were. */
  markAllDirty(): number {
    for (const entry of this.#resident.values()) entry.dirty = true;
    return this.#resident.size;
  }

  release(key: string): boolean {
    const entry = this.#resident.get(key);
    if (!entry) return false;
    this.#resident.delete(key);
    this.#freeSlots.push(entry.slot);
    this.#freeSlots.sort((a, b) => a - b);
    return true;
  }

  clear(): void {
    this.#resident.clear();
    this.#freeSlots = Array.from({ length: this.capacity }, (_, slot) => slot);
  }
}

/** One clip level's window of `pagesPerAxis²` virtual pages around the centre. */
export interface IClipWindow {
  readonly level: number;
  readonly extent: number;
  readonly pageWorldSize: number;
  /** Pages a window trails its followed centre by before it moves and re-renders. */
  readonly refreshPages: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface IDirectionalClipmapOptions {
  /** Unit-free direction *toward* the source; normalised here. */
  readonly direction: IVector3Like;
  /** Half-width of each level's window in world units, finest first. */
  readonly clipExtents: readonly number[];
  /** Texels per window edge: one value for every level, or one per level finest first. */
  readonly pagesPerAxis: number | readonly number[];
  /**
   * Fraction of an extent inside which a point selects that level, `(0, 1]`, default 0.9. One value
   * for every level, or one per level finest first, the last entry standing in for the rest.
   */
  readonly selectionGuard?: number | readonly number[];
  /**
   * Fraction of an extent a level's window may trail its followed centre by before it re-renders,
   * `[0, 1)`, default 0.125. Rounded to whole texels with one texel reserved for a deferred render;
   * `0` keeps the old one-texel step. Larger steps re-render a level less often as the camera walks. One value
   * for every level, or one per level finest first, the last entry standing in for the rest.
   */
  readonly refreshStep?: number | readonly number[];
  /**
   * The smallest ratio of a window's light-space height to its width, `(0, 1]`, default 1. A low
   * sun stretches a texel along the light's V axis by `1 / sin(elevation)` of floor, so a window
   * the same height as it is wide would make every shadow edge across the floor that much blurrier.
   * A ratio below 1 shrinks the height to `sin(elevation)`, never under this value, and the texels
   * then cover the same floor area at any sun height. A sun within 18 degrees of the zenith keeps
   * square windows. Page coordinates stay square: `v` counts pages in that shrunken height.
   */
  readonly minAspect?: number;
}

function dot(a: IVector3Like, b: IVector3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: IVector3Like, b: IVector3Like): IVector3Like {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(vector: IVector3Like): IVector3Like {
  const magnitude = Math.sqrt(dot(vector, vector));
  if (magnitude <= EPSILON) throw new RangeError("direction must have non-zero length");
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function cornersOfBounds(bounds: IBoundsLike): IVector3Like[] {
  if (!bounds?.min || !bounds?.max) throw new TypeError("bounds must provide min and max vectors");
  assertFiniteVector("bounds.min", bounds.min);
  assertFiniteVector("bounds.max", bounds.max);
  const corners: IVector3Like[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) corners.push({ x, y, z });
    }
  }
  return corners;
}

/**
 * Camera-centred clip windows in a light-space basis, snapped to whole pages.
 *
 * The basis is right-handed (`U × V = W`). A page camera placed along `+W` with `up = V` then
 * renders screen X = `V × W` = `+U`, which is the axis the sampler reads the atlas along. The
 * prototype this was ported from built `V = U × W` and every page came out mirrored.
 */
export class DirectionalClipmap {
  readonly clipExtents: readonly number[];
  /** Texels per window edge, one per level, finest first. */
  #pages: number[] = [];
  /**
   * Per level, finest first; the last entry stands in for every level past it. Mutable through
   * {@link setRefreshStep} so a level whose own render is expensive can be stepped further, which
   * is fewer grid positions for its window rather than a different grid.
   */
  refreshStep: number[];
  /** Per level, finest first; the last entry stands in for every level past it. */
  readonly selectionGuard: readonly number[];
  readonly levelCount: number;
  basisU: IVector3Like;
  basisV: IVector3Like;
  basisW: IVector3Like;
  /** Window height over width: `v` is metres along `basisV` divided by this. 1 is a square window. */
  vScale = 1;
  readonly minAspect: number;
  centerWorld: IVector3Like = { x: 0, y: 0, z: 0 };
  centerLight: ILightSpacePoint = { u: 0, v: 0, w: 0 };
  #windows: IClipWindow[] = [];

  /** The per-level entry of a scalar-or-array option, the last entry standing in. */
  #perLevel(values: readonly number[], level: number): number {
    return values[Math.min(level, values.length - 1)] as number;
  }

  constructor({
    direction,
    clipExtents,
    pagesPerAxis,
    selectionGuard = 0.9,
    refreshStep = 0.125,
    minAspect = 1,
  }: IDirectionalClipmapOptions) {
    assertFiniteVector("direction", direction);
    if (!Number.isFinite(minAspect) || minAspect <= 0 || minAspect > 1) {
      throw new RangeError(`minAspect must be in the range (0, 1], got ${String(minAspect)}`);
    }
    this.minAspect = minAspect;
    if (!Array.isArray(clipExtents) || clipExtents.length === 0) {
      throw new TypeError("clipExtents must be a non-empty array");
    }
    if (clipExtents.some((extent) => !Number.isFinite(extent) || extent <= 0)) {
      throw new RangeError("every clip extent must be positive");
    }
    for (let level = 1; level < clipExtents.length; level += 1) {
      if ((clipExtents[level] as number) <= (clipExtents[level - 1] as number)) {
        throw new RangeError("clipExtents must increase from the finest level to the coarsest");
      }
    }
    // `selectionGuard` and `refreshStep` take one value per level, finest first, the last entry
    // standing in for every level past it. One step for all of them spends the hysteresis the fine
    // level can least afford on the coarse one, and the fine level is the one a walking camera
    // re-renders most: at 20 m/s over 24/96/320 m extents a shared 0.125 re-rendered the fine window
    // about 9 times a second to hold a shadow the eye reads at 1/8 of its own width.
    const perLevel = (
      value: number | readonly number[],
      name: string,
      valid: (v: number) => boolean,
    ) => {
      const values = Array.isArray(value) ? [...(value as readonly number[])] : [value as number];
      for (const entry of values) {
        if (!valid(entry)) {
          throw new RangeError(`every ${name} must satisfy ${String(valid)}, got ${String(entry)}`);
        }
      }
      return values;
    };
    const guards = perLevel(
      selectionGuard,
      "selectionGuard",
      (v) => Number.isFinite(v) && v > 0 && v <= 1,
    );
    const steps = perLevel(
      refreshStep,
      "refreshStep",
      (v) => Number.isFinite(v) && v >= 0 && v < 1,
    );
    for (let level = 0; level < guards.length; level += 1) {
      if ((steps[level] as number) >= (guards[level] as number)) {
        throw new RangeError(
          `refreshStep must stay below selectionGuard, got ${String(steps[level])} >= ${String(guards[level])}`,
        );
      }
    }
    this.clipExtents = [...clipExtents];
    this.setPagesPerAxis(pagesPerAxis);
    this.refreshStep = clipExtents.map((_, level) => this.#perLevel(steps, level));
    this.selectionGuard = guards;
    this.levelCount = clipExtents.length;
    this.basisW = normalize(direction);
    this.basisU = { x: 1, y: 0, z: 0 };
    this.basisV = { x: 0, y: 0, z: 1 };
    this.setDirection(direction);
  }

  /** Re-orient the basis; returns true when it changed enough that cached pages are stale. */
  setDirection(direction: IVector3Like): boolean {
    assertFiniteVector("direction", direction);
    const nextW = normalize(direction);
    const unchanged = this.#windows.length > 0 && Math.abs(dot(nextW, this.basisW) - 1) <= 1e-9;
    this.basisW = nextW;
    const reference: IVector3Like =
      Math.abs(this.basisW.y) > 0.95 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    this.basisU = normalize(cross(this.basisW, reference));
    this.basisV = normalize(cross(this.basisW, this.basisU));
    // Only a sun low enough that V is the ground's slope axis: near the zenith the basis turns to
    // the +z reference and V is no longer the direction a floor texel stretches along.
    this.vScale =
      Math.abs(this.basisW.y) > 0.95
        ? 1
        : Math.min(1, Math.max(this.minAspect, Math.abs(this.basisW.y)));
    if (!unchanged) this.#windows = [];
    this.updateCenter(this.centerWorld);
    return !unchanged;
  }

  project(worldPoint: IVector3Like): ILightSpacePoint {
    assertFiniteVector("worldPoint", worldPoint);
    return {
      u: dot(worldPoint, this.basisU),
      v: dot(worldPoint, this.basisV) / this.vScale,
      w: dot(worldPoint, this.basisW),
    };
  }

  unproject({ u, v, w = 0 }: { u: number; v: number; w?: number }): IVector3Like {
    if (![u, v, w].every(Number.isFinite)) {
      throw new TypeError("light-space coordinates must be finite");
    }
    const along = v * this.vScale;
    return {
      x: this.basisU.x * u + this.basisV.x * along + this.basisW.x * w,
      y: this.basisU.y * u + this.basisV.y * along + this.basisW.y * w,
      z: this.basisU.z * u + this.basisV.z * along + this.basisW.z * w,
    };
  }

  /** Re-step one level's window: the trail its followed centre may move before it re-renders. */
  setRefreshStep(level: number, step: number): void {
    assertInteger("level", level);
    if (level < 0 || level >= this.levelCount) throw new RangeError(`invalid clip level: ${level}`);
    if (!Number.isFinite(step) || step < 0 || step >= 1) {
      throw new RangeError(`refreshStep must stay in the range [0, 1), got ${String(step)}`);
    }
    this.refreshStep[level] = step;
  }

  /** Texels per edge of `level`'s window. */
  pagesAt(level: number): number {
    return this.#perLevel(this.#pages, level);
  }

  /** Resize the windows (one value, or one per level); every window is placed afresh. */
  setPagesPerAxis(pagesPerAxis: number | readonly number[]): void {
    const pages = typeof pagesPerAxis === "number" ? [pagesPerAxis] : [...pagesPerAxis];
    if (pages.length === 0) throw new TypeError("pagesPerAxis must not be empty");
    for (const value of pages) assertPositiveInteger("pagesPerAxis", value);
    this.#pages = pages;
    this.#windows = [];
  }

  updateCenter(worldPoint: IVector3Like): readonly IClipWindow[] {
    assertFiniteVector("worldPoint", worldPoint);
    const previousCenter = this.centerLight;
    this.centerWorld = { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z };
    this.centerLight = this.project(worldPoint);
    this.#windows = this.clipExtents.map((extent, level) => {
      const pages = this.pagesAt(level);
      const halfPages = Math.floor(pages / 2);
      const pageWorldSize = (extent * 2) / pages;
      // The step is a drift threshold, never the grid spacing. Changing it alone cannot move a
      // stationary window. When either axis crosses the threshold, recenter the whole window on
      // this level's fixed texel grid; `refreshStep: 0` keeps the old one-page floor addressing.
      const step = this.#perLevel(this.refreshStep, level);
      // Begin the refresh one texel inside the trail: the node grants one level render per frame,
      // so a coarse window may wait behind the fine one while the followed centre keeps moving.
      const refreshPages =
        step === 0 ? 1 : Math.max(1, Math.round((step * extent) / pageWorldSize) - 1);
      const previous = this.#windows[level];
      const minX = Math.floor(this.centerLight.u / pageWorldSize) - halfPages;
      const minY = Math.floor(this.centerLight.v / pageWorldSize) - halfPages;
      if (
        previous &&
        ((this.centerLight.u === previousCenter.u && this.centerLight.v === previousCenter.v) ||
          (Math.max(Math.abs(minX - previous.minX), Math.abs(minY - previous.minY)) <
            refreshPages &&
            Math.max(
              Math.abs(this.centerLight.u - (previous.minX + halfPages) * pageWorldSize),
              Math.abs(this.centerLight.v - (previous.minY + halfPages) * pageWorldSize),
            ) <
              refreshPages * pageWorldSize))
      ) {
        return { ...previous, refreshPages };
      }
      return {
        level,
        extent,
        pageWorldSize,
        refreshPages,
        minX,
        minY,
        maxX: minX + pages,
        maxY: minY + pages,
      };
    });
    return this.#windows;
  }

  getWindow(level: number): IClipWindow {
    const window = this.#windows[level];
    if (!window) throw new RangeError(`invalid clip level: ${level}`);
    return { ...window };
  }

  pageWorldSize(level: number): number {
    return this.getWindow(level).pageWorldSize;
  }

  containsPage(level: number, x: number, y: number): boolean {
    const window = this.#windows[level];
    return (
      window !== undefined &&
      x >= window.minX &&
      x < window.maxX &&
      y >= window.minY &&
      y < window.maxY
    );
  }

  worldToPage(worldPoint: IVector3Like, level: number): IVirtualPageAddress {
    const window = this.#windows[level];
    if (!window) throw new RangeError(`invalid clip level: ${level}`);
    const projected = this.project(worldPoint);
    const x = Math.floor(projected.u / window.pageWorldSize);
    const y = Math.floor(projected.v / window.pageWorldSize);
    return { level, x, y, key: makePageKey(level, x, y) };
  }

  /** The finest level whose guarded extent contains the point, else the coarsest. */
  selectLevel(worldPoint: IVector3Like): number {
    const projected = this.project(worldPoint);
    const distance = Math.max(
      Math.abs(projected.u - this.centerLight.u),
      Math.abs(projected.v - this.centerLight.v),
    );
    for (let level = 0; level < this.levelCount; level += 1) {
      if (
        distance <=
        (this.clipExtents[level] as number) * this.#perLevel(this.selectionGuard, level)
      )
        return level;
    }
    return this.levelCount - 1;
  }

  /** Light-space extent and world centre (at `w = 0`) of one page. */
  pageBounds(level: number, x: number, y: number) {
    const pageWorldSize = this.pageWorldSize(level);
    const minU = x * pageWorldSize;
    const minV = y * pageWorldSize;
    const centerU = minU + pageWorldSize * 0.5;
    const centerV = minV + pageWorldSize * 0.5;
    return {
      level,
      x,
      y,
      minU,
      minV,
      maxU: minU + pageWorldSize,
      maxV: minV + pageWorldSize,
      centerU,
      centerV,
      pageWorldSize,
      centerWorld: this.unproject({ u: centerU, v: centerV, w: 0 }),
    };
  }

  boundsToPageRange(bounds: IBoundsLike, level: number) {
    const window = this.#windows[level];
    if (!window) throw new RangeError(`invalid clip level: ${level}`);
    const projected = cornersOfBounds(bounds).map((corner) => this.project(corner));
    const minU = Math.min(...projected.map(({ u }) => u));
    const maxU = Math.max(...projected.map(({ u }) => u));
    const minV = Math.min(...projected.map(({ v }) => v));
    const maxV = Math.max(...projected.map(({ v }) => v));
    const pageSize = window.pageWorldSize;
    return {
      minX: Math.floor(minU / pageSize),
      maxX: Math.floor((maxU - EPSILON) / pageSize),
      minY: Math.floor(minV / pageSize),
      maxY: Math.floor((maxV - EPSILON) / pageSize),
    };
  }

  boundsToPageKeys(bounds: IBoundsLike, level: number): string[] {
    const range = this.boundsToPageRange(bounds, level);
    const keys: string[] = [];
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) keys.push(makePageKey(level, x, y));
    }
    return keys;
  }

  windowPages(level: number): IVirtualPageAddress[] {
    const window = this.#windows[level];
    if (!window) throw new RangeError(`invalid clip level: ${level}`);
    const pages: IVirtualPageAddress[] = [];
    for (let x = window.minX; x < window.maxX; x += 1) {
      for (let y = window.minY; y < window.maxY; y += 1) {
        pages.push({ level, x, y, key: makePageKey(level, x, y) });
      }
    }
    return pages;
  }
}

/** One page a frame asks for, ordered by pin, level and distance from the camera. */
export interface IPageRequest extends IVirtualPageAddress {
  readonly pinned: boolean;
  readonly priority: number;
}

export interface IReceiverDemandInput {
  readonly cameraPosition: IVector3Like;
  /** World points a receiver is known to occupy on screen, e.g. from screen-grid rays. */
  readonly receiverPoints: readonly IVector3Like[];
  /** Bounds of casters inside the view, so their pages are resident before they are seen. */
  readonly visibleBounds: readonly IBoundsLike[];
  readonly clipmap: DirectionalClipmap;
}

function boundsSamplePoints(bounds: IBoundsLike): IVector3Like[] {
  const { min, max } = bounds;
  return [
    { x: (min.x + max.x) * 0.5, y: (min.y + max.y) * 0.5, z: (min.z + max.z) * 0.5 },
    ...cornersOfBounds(bounds),
  ];
}

/**
 * Turn the points a frame can see into page requests: each point selects its finest level,
 * requests its page and a guard band around it, and the coarsest window is pinned in full so
 * every fragment has a page to fall back to.
 */
export class ReceiverDemandPass {
  readonly guardBand: number;

  constructor({ guardBand = 1 }: { guardBand?: number } = {}) {
    if (!Number.isInteger(guardBand) || guardBand < 0) {
      throw new TypeError("guardBand must be a non-negative integer");
    }
    this.guardBand = guardBand;
  }

  collect({
    cameraPosition,
    receiverPoints,
    visibleBounds,
    clipmap,
  }: IReceiverDemandInput): IPageRequest[] {
    assertFiniteVector("cameraPosition", cameraPosition);
    const requests = new Map<string, { -readonly [K in keyof IPageRequest]: IPageRequest[K] }>();
    const cameraLight = clipmap.project(cameraPosition);

    const addRequest = (
      { level, x, y, key }: IVirtualPageAddress,
      { pinned = false, priority = 0 }: { pinned?: boolean; priority?: number } = {},
    ) => {
      if (!clipmap.containsPage(level, x, y)) return;
      const existing = requests.get(key);
      if (!existing) {
        requests.set(key, { key, level, x, y, pinned, priority });
        return;
      }
      existing.pinned ||= pinned;
      existing.priority = Math.min(existing.priority, priority);
    };

    const addPoint = (point: IVector3Like) => {
      const level = clipmap.selectLevel(point);
      const page = clipmap.worldToPage(point, level);
      const projected = clipmap.project(point);
      const du = projected.u - cameraLight.u;
      const dv = projected.v - cameraLight.v;
      const basePriority = du * du + dv * dv;
      for (let dx = -this.guardBand; dx <= this.guardBand; dx += 1) {
        for (let dy = -this.guardBand; dy <= this.guardBand; dy += 1) {
          const x = page.x + dx;
          const y = page.y + dy;
          addRequest(
            { level, x, y, key: makePageKey(level, x, y) },
            { priority: basePriority + (dx * dx + dy * dy) * 0.001 },
          );
        }
      }
    };

    for (const point of receiverPoints) addPoint(point);
    for (const bounds of visibleBounds) {
      for (const point of boundsSamplePoints(bounds)) addPoint(point);
    }
    for (const page of clipmap.windowPages(clipmap.levelCount - 1)) {
      addRequest(page, { pinned: true, priority: -1 });
    }

    return [...requests.values()].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.level - b.level ||
        a.priority - b.priority ||
        a.x - b.x ||
        a.y - b.y,
    );
  }
}

function copyBounds(bounds: IBoundsLike): IBoundsLike {
  return { min: { ...bounds.min }, max: { ...bounds.max } };
}

function boundsEqual(a: IBoundsLike, b: IBoundsLike, epsilon = 1e-6): boolean {
  return (["x", "y", "z"] as const).every(
    (axis) =>
      Math.abs(a.min[axis] - b.min[axis]) <= epsilon &&
      Math.abs(a.max[axis] - b.max[axis]) <= epsilon,
  );
}

/**
 * A world AABB resolved onto one clipmap basis axis, as the interval that axis sees. Exact for a
 * box: the extreme points along `axis` are the centre offset by half the box's own size, weighted
 * by the absolute value of each component of the axis, so no corner has to be walked.
 */
export function projectBounds(
  bounds: IBoundsLike,
  axis: IVector3Like,
): { low: number; high: number } {
  const halfX = (bounds.max.x - bounds.min.x) / 2;
  const halfY = (bounds.max.y - bounds.min.y) / 2;
  const halfZ = (bounds.max.z - bounds.min.z) / 2;
  const centreX = (bounds.max.x + bounds.min.x) / 2;
  const centreY = (bounds.max.y + bounds.min.y) / 2;
  const centreZ = (bounds.max.z + bounds.min.z) / 2;
  const reach = Math.abs(axis.x) * halfX + Math.abs(axis.y) * halfY + Math.abs(axis.z) * halfZ;
  const middle = centreX * axis.x + centreY * axis.y + centreZ * axis.z;
  return { low: middle - reach, high: middle + reach };
}

/** An inclusive rectangle of pages on one level, in the clipmap's absolute page coordinates. */
export interface IPageRect {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
}

/**
 * The inclusive pages an interval on one light axis covers, never fewer than one. The same
 * arithmetic as {@link DirectionalClipmap.boundsToPageRange}, applied to a projected interval.
 */
export function pageSpan(
  low: number,
  high: number,
  pageWorldSize: number,
): { max: number; min: number } {
  const min = Math.floor(low / pageWorldSize);
  return { max: Math.max(min, Math.floor((high - EPSILON) / pageWorldSize)), min };
}

/** Pages in a rectangle. */
export function pageArea(rect: IPageRect): number {
  return (rect.maxX - rect.minX + 1) * (rect.maxY - rect.minY + 1);
}

/** Whether `outer` holds every page of `inner`; false when there is no `outer`. */
export function containsPages(outer: IPageRect | undefined, inner: IPageRect): boolean {
  return (
    outer !== undefined &&
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

/** Grow `into` to hold `rect`, or become a copy of it. Returns the grown rectangle. */
export function unionPageRect(into: IPageRect | undefined, rect: IPageRect): IPageRect {
  if (into === undefined) return { ...rect };
  into.minX = Math.min(into.minX, rect.minX);
  into.minY = Math.min(into.minY, rect.minY);
  into.maxX = Math.max(into.maxX, rect.maxX);
  into.maxY = Math.max(into.maxY, rect.maxY);
  return into;
}

/**
 * Remembers each tracked caster's last bounds and dirties every page the old and new bounds
 * cover on every level when they change. Unchanged bounds dirty nothing.
 */
export class ShadowInvalidationTracker {
  readonly clipmap: DirectionalClipmap;
  readonly #tracked = new Map<number | string, IBoundsLike>();
  readonly #invalidated = new Set<string>();

  constructor(clipmap: DirectionalClipmap) {
    if (!clipmap) throw new TypeError("clipmap is required");
    this.clipmap = clipmap;
  }

  /** Dirty page keys not yet consumed by the next shadow render. */
  get pending(): number {
    return this.#invalidated.size;
  }

  get trackedCount(): number {
    return this.#tracked.size;
  }

  #invalidateBounds(bounds: IBoundsLike): void {
    for (let level = 0; level < this.clipmap.levelCount; level += 1) {
      for (const key of this.clipmap.boundsToPageKeys(bounds, level)) this.#invalidated.add(key);
    }
  }

  /** Record a caster's current bounds; returns true when pages were dirtied. */
  update(id: number | string, bounds: IBoundsLike): boolean {
    if (id === undefined || id === null) throw new TypeError("tracked caster id is required");
    const previous = this.#tracked.get(id);
    if (previous && boundsEqual(previous, bounds)) return false;
    if (previous) this.#invalidateBounds(previous);
    this.#invalidateBounds(bounds);
    this.#tracked.set(id, copyBounds(bounds));
    return true;
  }

  has(id: number | string): boolean {
    return this.#tracked.has(id);
  }

  remove(id: number | string): boolean {
    const previous = this.#tracked.get(id);
    if (!previous) return false;
    this.#invalidateBounds(previous);
    this.#tracked.delete(id);
    return true;
  }

  /** Dirty the current coverage of every tracked caster; returns the pending key count. */
  invalidateAll(): number {
    for (const bounds of this.#tracked.values()) this.#invalidateBounds(bounds);
    return this.#invalidated.size;
  }

  /** Drop trackers whose id is not in `liveIds`, dirtying the pages they covered. */
  prune(liveIds: ReadonlySet<number | string>): number {
    let removed = 0;
    for (const id of [...this.#tracked.keys()]) {
      if (!liveIds.has(id) && this.remove(id)) removed += 1;
    }
    return removed;
  }

  consumeInvalidatedKeys(): Set<string> {
    const result = new Set(this.#invalidated);
    this.#invalidated.clear();
    return result;
  }

  clear(): void {
    this.#tracked.clear();
    this.#invalidated.clear();
  }
}

/** What {@link clipmapMapSizes} measures: the levels, and the view that reads them. */
export interface IClipmapSizeRule {
  /** Half-widths, finest first, as the node holds them. */
  readonly clipExtents: readonly number[];
  /** The fraction of each extent a receiver leaves the level at (guard minus refresh step). */
  readonly selectionGuard: readonly number[];
  /** `r.Shadow.Virtual.ResolutionLodBiasDirectional`: -1 halves every texel. */
  readonly resolutionLodBias: number;
  /** `tan(horizontal fov / 2)` of the camera that reads the shadow. */
  readonly tanHalfFov: number;
  /** The camera's viewport width in pixels. */
  readonly viewportWidth: number;
  /** Sizes are whole multiples of this. Default 128, the native page. */
  readonly pageTexels?: number;
  /** The most pages of `pageTexels²` all levels may hold. Default 4096. */
  readonly maxPhysicalPages?: number;
  /** The largest size of one level. Default 4096. */
  readonly maxMapSize?: number;
}

/**
 * Texels per edge of each clip level, from Unreal's clipmap rule. A receiver at distance `d` reads level
 * `floor(log2(d) + bias + log2(LodScale))` with `LodScale = 0.5 tan(hfov / 2) 16384 / width` (UE 5.8.3:
 * Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapClipmap.cpp:245-254,
 * Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapPageMarking.ush:35-39), and that level is
 * 16384 texels across twice its radius on each side (`HalfLevelDim`, VirtualShadowMapClipmap.cpp:363,
 * :452), so a texel is `2^bias` to `2^(1 + bias)` of the receiver's own screen pixels. A level here
 * gets that worst case at the nearest receiver it serves: the guarded edge of the level inside it (the
 * finest, one level step nearer still). When the sizes outgrow the page budget, the bias rises a
 * quarter stop at a time until they fit, as Unreal raises its global bias when the page pool is over
 * budget (VirtualShadowMapCacheManager.cpp:703-717).
 */
export function clipmapMapSizes(rule: IClipmapSizeRule): number[] {
  const { clipExtents, selectionGuard, tanHalfFov, viewportWidth } = rule;
  const page = rule.pageTexels ?? 128;
  const maxPages = rule.maxPhysicalPages ?? 4096;
  const maxSize = rule.maxMapSize ?? 4096;
  if (!(tanHalfFov > 0) || !(viewportWidth > 0) || !Number.isFinite(rule.resolutionLodBias))
    throw new RangeError(
      "clipmapMapSizes needs a positive tanHalfFov and viewportWidth and a finite bias",
    );
  const guard = (level: number): number =>
    selectionGuard[Math.min(level, selectionGuard.length - 1)] as number;
  const first = clipExtents[0] as number;
  const inner = clipExtents.map((extent, level) =>
    level === 0
      ? guard(0) * first * (clipExtents.length > 1 ? first / (clipExtents[1] as number) : 0.5)
      : guard(level - 1) * (clipExtents[level - 1] as number),
  );
  for (let bias = rule.resolutionLodBias; ; bias += 0.25) {
    const sizes = clipExtents.map((extent, level) => {
      const pixel = (2 * (inner[level] as number) * tanHalfFov) / viewportWidth;
      const texels = Math.ceil((2 * extent) / (2 ** (1 + bias) * pixel) / page) * page;
      return Math.min(maxSize, Math.max(page, texels));
    });
    const pages = sizes.reduce((sum, size) => sum + (size / page) ** 2, 0);
    if (pages <= maxPages || sizes.every((size) => size === page)) return sizes;
  }
}
