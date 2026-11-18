import {
  type BufferGeometry,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";
import {
  type ITileBounds,
  type ITileRingField,
  TileRing,
  clamp01,
  groundGrid,
  hashInt,
  mulberry32,
  sample,
  shuffled,
  smoothstep,
} from "./tile-ring.js";

const DEG = Math.PI / 180;

/** One part of the scattered mesh — a glTF primitive — and the baked levels to draw it at. */
export interface IScatterPart {
  /** Near to far: `lods[0]` is the full mesh, the last is the farthest level. */
  readonly lods: readonly BufferGeometry[];
  /** The game's material for this part. The field chooses neither geometry nor look. */
  readonly material: Material;
}

/** The ground under a candidate, in field-local metres, with its unit normal. */
export interface IScatterPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** Where a candidate goes. The game writes the transform; the field owns `priority`. */
export interface IScatterPlacement {
  x: number;
  y: number;
  z: number;
  /** Radians about the ground normal, so a prop's own facing is the game's choice. */
  yaw: number;
  /** Uniform scale on the baked metres. */
  scale: number;
  /** 0..1: the candidate's order in the seeded shuffle. Lower instances thin away first. */
  readonly priority: number;
}

export type IScatterFieldBounds = ITileBounds;

export interface IScatterField3DOptions {
  /** One entry per part of the baked mesh; a log's bark and its foliage are two. */
  readonly parts: readonly IScatterPart[];
  /**
   * Decides one candidate: write `out` and return true to place it, or return false to leave the
   * spot empty (a path, a rock, a stump's own footprint). Called once per candidate per tile build.
   */
  readonly place: (point: IScatterPoint, out: IScatterPlacement) => boolean;
  /** Ground height at (x, z), field-local metres. */
  readonly getHeight: (x: number, z: number) => number;
  /** Coverage 0..1 at (x, z, height, normal y): paths, clearings, biome masks. */
  readonly getDensity?: (x: number, z: number, height: number, normalY: number) => number;
  readonly bounds?: IScatterFieldBounds | null;
  /** Candidates per square metre at full coverage. */
  readonly density?: number;
  readonly chunkSize?: number;
  readonly seed?: number;
  readonly heightSampleSpacing?: number;
  /** Degrees: nothing is placed on ground steeper than `maxSlope`, thinning over `slopeFade`. */
  readonly maxSlope?: number;
  readonly slopeFade?: number;
  readonly minAltitude?: number;
  readonly maxAltitude?: number;
  readonly drawDistance?: number;
  /** Distances at which the next level takes over, one per step down a part's `lods`. */
  readonly lodDistances?: readonly number[];
  readonly thinStart?: number;
  readonly thinEnd?: number;
  /** The share of instances left past `thinEnd`. */
  readonly farDensity?: number;
  /** Milliseconds per frame allowed for building tiles; one tile always builds. */
  readonly buildBudgetMs?: number;
  /** Tilt each instance onto the ground normal. Off keeps every instance upright. */
  readonly alignToGround?: boolean;
  readonly receiveShadow?: boolean;
  readonly castShadow?: boolean;
  /** Scales every density at once, as Unreal's `grass.densityScale`. */
  readonly densityScale?: number;
  /** Scales every distance at once, as Unreal's `grass.CullDistanceScale`. */
  readonly cullDistanceScale?: number;
}

export interface IScatterFieldStats {
  tiles: number;
  visibleTiles: number;
  instances: number;
  pending: number;
  /** Tiles built since the field was made. */
  built: number;
}

interface IScatterTile {
  /** One mesh per part, then per level; parts need not have the same number of levels. */
  readonly meshes: InstancedMesh[][];
  /** Per instance, in buffer order: the shuffled prefix the thinning rule walks. */
  readonly priority: Float32Array;
  readonly count: number;
}

const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchTilt = new Quaternion();
const scratchMatrix = new Matrix4();
const up = new Vector3(0, 1, 0);
const normal = new Vector3();

/**
 * Streamed, seeded, instanced scatter of any baked mesh around a follow point; the game owns the
 * mesh, the material and where each instance lands.
 *
 * Square tiles round the follow point, built nearest first inside `buildBudgetMs` through the same
 * ring `GrassField3D` uses (`TileRing`): a tile is built inside 1.3 × the draw distance and freed
 * past 1.4 ×, Unreal Landscape grass's guard band (UE 5.8.3:
 * Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:88, :94). Each part draws one
 * `InstancedMesh` per level, so swapping detail is a visibility toggle on a baked level the game
 * loaded. Thinning is a plain instance count: the ring's tiles hold instances in the seeded shuffle
 * order, so any prefix covers the tile evenly and the far edge keeps a share of them.
 *
 * The field creates no colour, shading or shape: `parts` and `place` come from the game, and so does
 * every appearance constant.
 *
 * @situation scatter fallen logs, twigs, leaf litter, stones and ferns over a forest floor
 * @situation stream instanced props of any baked mesh round the player without one draw per prop
 * @situation place rocks, debris or plants on a heightfield with distance thinning and level of detail
 * @alias scatter rocks, debris and plants over terrain
 * @constraint call `update(follow)` once per rendered frame
 * @constraint `place` runs once per candidate per tile build: return false for paths and clearings
 * @constraint rotating or scaling the field is not supported; translating it is
 * @example
 * import { ScatterField3D } from "@threenative/core";
 * const floor = new ScatterField3D({
 *   parts: [{ lods: [logLod0, logLod1], material }],
 *   getHeight: (x, z) => height(x, z),
 *   density: 0.05,
 *   place: (point, out) => { out.x = point.x; out.y = point.y; out.z = point.z; out.yaw = point.x * 0.7; out.scale = 1; return !onPath(point.x, point.z); },
 * });
 * ctx.add(floor);
 * ctx.beforeRender(() => floor.update(hero.position));
 */
export class ScatterField3D extends Group {
  readonly parts: readonly IScatterPart[];
  place: (point: IScatterPoint, out: IScatterPlacement) => boolean;
  getHeight: (x: number, z: number) => number;
  getDensity: ((x: number, z: number, height: number, normalY: number) => number) | null;
  bounds: IScatterFieldBounds | null;
  density: number;
  chunkSize: number;
  seed: number;
  heightSampleSpacing: number;
  maxSlope: number;
  slopeFade: number;
  minAltitude: number;
  maxAltitude: number;
  drawDistance: number;
  lodDistances: readonly number[];
  thinStart: number;
  thinEnd: number;
  farDensity: number;
  buildBudgetMs: number;
  alignToGround: boolean;
  override receiveShadow: boolean;
  override castShadow: boolean;
  densityScale: number;
  cullDistanceScale: number;
  readonly #ring: TileRing<IScatterTile>;
  readonly #shown = { instances: 0, visibleTiles: 0 };
  #version = 0;
  #layout = "";

  constructor(options: IScatterField3DOptions) {
    super();
    this.name = "ScatterField3D";
    if (typeof options.place !== "function")
      throw new Error("ScatterField3D.place must be a function (point, out) => boolean.");
    if (typeof options.getHeight !== "function")
      throw new Error("ScatterField3D.getHeight must be a function (x, z) => height.");
    if (!Array.isArray(options.parts) || options.parts.length === 0)
      throw new Error("ScatterField3D.parts must list at least one part.");
    options.parts.forEach((part, index) => {
      if (!Array.isArray(part.lods) || part.lods.length === 0)
        throw new Error(`ScatterField3D.parts[${index}].lods must list at least one geometry.`);
      if (!part.material)
        throw new Error(`ScatterField3D.parts[${index}] has no material; the game owns the look.`);
    });
    this.parts = options.parts;
    this.place = options.place;
    this.getHeight = options.getHeight;
    this.getDensity = options.getDensity ?? null;
    this.bounds = options.bounds ?? null;
    this.density = options.density ?? 0.1;
    this.chunkSize = options.chunkSize ?? 16;
    this.seed = options.seed ?? 1337;
    this.heightSampleSpacing = options.heightSampleSpacing ?? 0.75;
    this.maxSlope = options.maxSlope ?? 42;
    this.slopeFade = options.slopeFade ?? 12;
    this.minAltitude = options.minAltitude ?? Number.NEGATIVE_INFINITY;
    this.maxAltitude = options.maxAltitude ?? Number.POSITIVE_INFINITY;
    this.drawDistance = options.drawDistance ?? 60;
    this.lodDistances = options.lodDistances ?? [20, 45];
    this.thinStart = options.thinStart ?? 10;
    this.thinEnd = options.thinEnd ?? 50;
    this.farDensity = options.farDensity ?? 0.3;
    this.buildBudgetMs = options.buildBudgetMs ?? 4;
    this.alignToGround = options.alignToGround ?? true;
    this.receiveShadow = options.receiveShadow ?? true;
    this.castShadow = options.castShadow ?? true;
    this.densityScale = options.densityScale ?? 1;
    this.cullDistanceScale = options.cullDistanceScale ?? 1;
    this.#validate();
    this.#ring = new TileRing<IScatterTile>(this.#hooks());
  }

  get stats(): IScatterFieldStats {
    return {
      built: this.#ring.stats.built,
      instances: this.#shown.instances,
      pending: this.#ring.stats.pending,
      tiles: this.#ring.stats.tiles,
      visibleTiles: this.#shown.visibleTiles,
    };
  }

  /** Builds every tile in range on the next `update` regardless of budget: on load or after a teleport. */
  prewarm(): void {
    this.#ring.prewarm();
  }

  /** Re-scatter after the ground or the coverage changed: all tiles, or those touching a rectangle. */
  refresh(rect?: IScatterFieldBounds): void {
    if (rect === undefined) {
      this.#version++;
      return;
    }
    this.#ring.disposeInside(rect);
  }

  /** Streams, thins and LODs the tiles round `follow`. Call once per rendered frame. */
  update(follow: Vector3): void {
    this.#validate();
    const layout = this.#layoutKey();
    if (layout !== this.#layout) {
      this.#ring.clear();
      this.#layout = layout;
    }
    scratchPosition.copy(follow);
    this.worldToLocal(scratchPosition);
    this.#shown.visibleTiles = this.#shown.instances = 0;
    this.#ring.update(scratchPosition.x, scratchPosition.z);
  }

  override dispose(): void {
    this.#ring.clear();
  }

  #hooks(): ITileRingField<IScatterTile> {
    const field = this;
    return {
      build: (ix, iz) => this.#build(ix, iz),
      get buildBudgetMs() {
        return field.buildBudgetMs;
      },
      get chunkSize() {
        return field.chunkSize;
      },
      get drawDistance() {
        return field.drawDistance * field.cullDistanceScale;
      },
      dispose: (tile) => this.#disposeTile(tile),
      hide: (tile) => {
        for (const part of tile.meshes)
          for (const mesh of part) if (mesh.visible) mesh.visible = false;
      },
      inBounds: (ix, iz) => this.#inBounds(ix, iz),
      show: (tile, distance) => this.#show(tile, distance),
    };
  }

  #validate(): void {
    if (!(this.chunkSize > 0))
      throw new Error(`ScatterField3D.chunkSize must be > 0, got ${this.chunkSize}.`);
    if (!(this.density >= 0))
      throw new Error(`ScatterField3D.density must be >= 0, got ${this.density}.`);
    if (!(this.drawDistance > 0))
      throw new Error(`ScatterField3D.drawDistance must be > 0, got ${this.drawDistance}.`);
    if (!(this.buildBudgetMs >= 0))
      throw new Error(`ScatterField3D.buildBudgetMs must be >= 0, got ${this.buildBudgetMs}.`);
    if (!(this.densityScale >= 0) || !(this.cullDistanceScale > 0))
      throw new Error("ScatterField3D.densityScale must be >= 0 and cullDistanceScale > 0.");
    const b = this.bounds;
    if (b === null) return;
    for (const key of ["minX", "minZ", "maxX", "maxZ"] as const)
      if (!Number.isFinite(b[key])) throw new Error(`ScatterField3D.bounds.${key} must be finite.`);
    if (b.minX >= b.maxX) throw new Error("ScatterField3D.bounds.minX must be below bounds.maxX.");
    if (b.minZ >= b.maxZ) throw new Error("ScatterField3D.bounds.minZ must be below bounds.maxZ.");
  }

  #layoutKey(): string {
    return [
      this.#version,
      this.density * this.densityScale,
      this.chunkSize,
      this.seed,
      this.heightSampleSpacing,
      this.maxSlope,
      this.slopeFade,
      this.minAltitude,
      this.maxAltitude,
      this.alignToGround,
      this.parts.length,
    ].join("|");
  }

  #inBounds(ix: number, iz: number): boolean {
    const b = this.bounds;
    const S = this.chunkSize;
    return (
      b === null ||
      !(ix * S >= b.maxX || (ix + 1) * S <= b.minX || iz * S >= b.maxZ || (iz + 1) * S <= b.minZ)
    );
  }

  #pointInBounds(x: number, z: number): boolean {
    const b = this.bounds;
    return b === null || (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);
  }

  /** Slope limit times the game's coverage mask, 0..1. */
  #coverage(x: number, z: number, y: number, ny: number, cosMax: number, span: number): number {
    const m = clamp01((ny - cosMax) / span);
    return m > 0 && this.getDensity ? m * clamp01(this.getDensity(x, z, y, ny)) : m;
  }

  /** The thinning cut-off at a tile's nearest point: the same rule the material cannot apply here. */
  #kept(tile: IScatterTile, distance: number): number {
    const k = this.cullDistanceScale;
    const thinEnd = Math.max(this.thinEnd, this.thinStart + 0.01) * k;
    const edge = 1.1 + (this.farDensity - 1.1) * smoothstep(this.thinStart * k, thinEnd, distance);
    if (edge >= 1) return tile.count;
    // Instances sit in the seeded shuffle order, so the kept ones are a prefix of the buffer.
    const pr = tile.priority;
    let lo = 0;
    let hi = tile.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pr[mid] as number) < edge) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #show(tile: IScatterTile, distance: number): void {
    const R = this.drawDistance * this.cullDistanceScale;
    const k = this.cullDistanceScale;
    const n = this.#kept(tile, distance);
    const inRange = n > 0 && distance < R;
    if (inRange) {
      this.#shown.visibleTiles++;
      this.#shown.instances += n;
    }
    for (let part = 0; part < this.parts.length; part++) {
      const meshes = tile.meshes[part] as InstancedMesh[];
      let level = 0;
      while (
        level < meshes.length - 1 &&
        distance >= (this.lodDistances[level] ?? Number.POSITIVE_INFINITY) * k
      )
        level++;
      for (let l = 0; l < meshes.length; l++) {
        const mesh = meshes[l] as InstancedMesh;
        // Every write below is guarded: a standing follow point re-plans nothing on the owned engine.
        const visible = inRange && l === level;
        if (mesh.visible !== visible) mesh.visible = visible;
        if (mesh.count !== n) mesh.count = n;
        if (mesh.receiveShadow !== this.receiveShadow) mesh.receiveShadow = this.receiveShadow;
        if (mesh.castShadow !== this.castShadow) mesh.castShadow = this.castShadow;
      }
    }
  }

  #build(ix: number, iz: number): IScatterTile | null {
    const S = this.chunkSize;
    const ox = ix * S;
    const oz = iz * S;
    const rng = mulberry32(hashInt(ix, iz, this.seed | 0));
    const ground = groundGrid(this.getHeight, ox, oz, S, this.heightSampleSpacing);
    const n = Math.max(1, Math.ceil(Math.sqrt(this.density * this.densityScale * S * S)));
    const total = this.density * this.densityScale > 0 ? n * n : 0;
    const cell = S / n;
    const order = shuffled(total, rng);
    const matrices: Matrix4[] = [];
    const priority = new Float32Array(total);
    const cosMax = Math.cos(this.maxSlope * DEG);
    const slopeSpan = Math.max(
      Math.cos(Math.max(this.maxSlope - this.slopeFade, 0) * DEG) - cosMax,
      1e-5,
    );
    // Mutable in here, readonly to the game: the field owns `priority`.
    const out = { priority: 0, scale: 1, x: 0, y: 0, z: 0, yaw: 0 };
    let k = 0;
    for (let q = 0; q < total; q++) {
      const c = order[q] as number;
      const lx = ((c % n) + rng()) * cell;
      const lz = (((c / n) | 0) + rng()) * cell;
      const rKeep = rng();
      const wx = ox + lx;
      const wz = oz + lz;
      if (!this.#pointInBounds(wx, wz)) continue;
      ground.sample(lx, lz);
      const y = sample[0] as number;
      const dx = sample[1] as number;
      const dz = sample[2] as number;
      if (y < this.minAltitude || y > this.maxAltitude) continue;
      const ny = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      const m = this.#coverage(wx, wz, y, ny, cosMax, slopeSpan);
      if (m <= 0.001 || rKeep > m * 2) continue;
      out.x = wx;
      out.y = y;
      out.z = wz;
      out.yaw = 0;
      out.scale = 1;
      out.priority = q / total;
      const placed = this.place({ nx: -dx * ny, ny, nz: -dz * ny, x: wx, y, z: wz }, out);
      if (!placed) continue;
      if (!Number.isFinite(out.scale) || out.scale <= 0 || !Number.isFinite(out.yaw))
        throw new Error(
          `ScatterField3D.place returned scale ${out.scale} and yaw ${out.yaw} at (${wx}, ${wz}); both must be finite and the scale positive.`,
        );
      priority[k] = q / total;
      scratchPosition.set(out.x, out.y, out.z);
      scratchScale.setScalar(out.scale);
      if (this.alignToGround) {
        normal.set(-dx, 1, -dz).normalize();
        scratchTilt.setFromUnitVectors(up, normal);
        scratchQuaternion.setFromAxisAngle(up, out.yaw);
        scratchQuaternion.premultiply(scratchTilt);
      } else {
        scratchQuaternion.setFromAxisAngle(up, out.yaw);
      }
      matrices.push(
        scratchMatrix.clone().compose(scratchPosition, scratchQuaternion, scratchScale),
      );
      k++;
    }
    // Remembered as empty by the ring, so it is not rebuilt every frame.
    if (k === 0) return null;
    const meshes: InstancedMesh[][] = [];
    for (let part = 0; part < this.parts.length; part++) {
      const source = this.parts[part] as IScatterPart;
      const levels: InstancedMesh[] = [];
      for (let l = 0; l < source.lods.length; l++) {
        const geometry = source.lods[l] as BufferGeometry;
        const mesh = new InstancedMesh(geometry, source.material, k);
        mesh.name = `scatter part${part} lod${l} ${ix},${iz}`;
        for (let i = 0; i < k; i++) mesh.setMatrixAt(i, matrices[i] as Matrix4);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.position.set(ox, 0, oz);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.visible = false;
        mesh.raycast = () => {};
        // InstancedMesh's own bounds, not the shared geometry's: a tile culls by the instances it holds.
        mesh.computeBoundingSphere();
        this.add(mesh);
        levels.push(mesh);
      }
      meshes.push(levels);
    }
    return { count: k, meshes, priority: priority.slice(0, k) };
  }

  #disposeTile(tile: IScatterTile): void {
    for (const part of tile.meshes)
      for (const mesh of part) {
        this.remove(mesh);
        // The geometry belongs to the game: only the instance buffer this tile allocated is freed.
        mesh.dispose();
      }
  }
}
