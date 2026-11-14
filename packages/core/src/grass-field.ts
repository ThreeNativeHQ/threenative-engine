import {
  Box3,
  BufferAttribute,
  type BufferGeometry,
  type Camera,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type Material,
  Mesh,
  Sphere,
  Vector3,
  Vector4,
} from "three";
import { float, uniform, vec2, vec3 } from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";

const MAX_PUSHERS = 4;
const DEG = Math.PI / 180;
/** A chunk is built inside this many draw distances, so it exists before it is seen. */
const CREATE_BAND = 1.3;
/** A chunk is discarded only past this many draw distances, so a camera on the edge never thrashes. */
const DISCARD_BAND = 1.4;

/** The instance attributes every chunk carries; the game's material reads them by these names. */
export const GRASS_FIELD_ATTRIBUTES = {
  /** vec3: the blade's root, chunk-local (the chunk mesh sits at its corner). */
  root: "grassRoot",
  /** vec4: facing 0..1, height 0..1, thinning priority 0..1, coverage scale 0..1. */
  rand: "grassRand",
  /** vec4: angle away from the tuft centre, tuft random 0..1, ground normal x, ground normal z. */
  clump: "grassClump",
} as const;

export interface IGrassFieldBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** The blade shape the game built: every LOD level packed in one geometry, each a draw range. */
export interface IGrassFieldBlade {
  readonly geometry: BufferGeometry;
  /** Index ranges near to far; `lodDistances` picks between them. */
  readonly lods: readonly { readonly start: number; readonly count: number }[];
  /** The tallest a blade can stand, metres: pads each chunk's bounds so culling never clips a tip. */
  readonly reach: number;
}

/** TSL uniforms the field keeps current; the game's material reads them so its thinning matches the CPU trim. */
export interface IGrassFieldNodes {
  readonly thinStart: UniformNode<"float", number>;
  readonly thinEnd: UniformNode<"float", number>;
  readonly farDensity: UniformNode<"float", number>;
  readonly fadeStart: UniformNode<"float", number>;
  readonly drawDistance: UniformNode<"float", number>;
  readonly pushers: readonly UniformNode<"vec4", Vector4>[];
  /**
   * The pushers' pull on a root, as vec3(push x, push z, press): push is the summed unit direction
   * away from each pusher times its falloff, press the strongest falloff 0..1. `pressAt` mirrors it.
   */
  push(rootWorld: Node<"vec3">): Node<"vec3">;
}

export interface IGrassField3DOptions {
  readonly blade: IGrassFieldBlade;
  /** Builds the game's blade material from the field's uniforms. Called once. */
  readonly material: (nodes: IGrassFieldNodes) => Material;
  /** Ground height at (x, z), field-local metres. */
  readonly getHeight: (x: number, z: number) => number;
  /** Coverage 0..1 at (x, z, height, normal y): paths, clearings, biome masks. */
  readonly getDensity?: (x: number, z: number, height: number, normalY: number) => number;
  readonly bounds?: IGrassFieldBounds | null;
  /** Blades per square metre at full coverage. */
  readonly density?: number;
  readonly chunkSize?: number;
  readonly seed?: number;
  readonly heightSampleSpacing?: number;
  /** Degrees: no grass steeper than `maxSlope`, thinning over `slopeFade` degrees before it. */
  readonly maxSlope?: number;
  readonly slopeFade?: number;
  readonly minAltitude?: number;
  readonly maxAltitude?: number;
  /** Tuft size, metres: blades in one tuft share a centre to lean from. */
  readonly clumpSize?: number;
  readonly drawDistance?: number;
  /** Share of `drawDistance` over which blades sink away at the far edge. */
  readonly fadeRange?: number;
  /** Distances at which the next blade LOD takes over: `blade.lods.length - 1` of them. */
  readonly lodDistances?: readonly number[];
  readonly thinStart?: number;
  readonly thinEnd?: number;
  /** The share of blades left past `thinEnd`. */
  readonly farDensity?: number;
  /** Milliseconds per frame allowed for building chunks; one chunk always builds. */
  readonly buildBudgetMs?: number;
  readonly receiveShadow?: boolean;
  /** Scales every density at once, as Unreal's `grass.densityScale`. */
  readonly densityScale?: number;
  /** Scales every distance at once, as Unreal's `grass.CullDistanceScale`. */
  readonly cullDistanceScale?: number;
}

export interface IGrassFieldStats {
  chunks: number;
  visibleChunks: number;
  blades: number;
  triangles: number;
  pending: number;
  /** Chunks built since the field was made. */
  built: number;
}

interface IChunk {
  readonly ix: number;
  readonly iz: number;
  seen: number;
  readonly count: number;
  readonly mesh: Mesh | null;
  readonly priority: Float32Array | null;
  readonly radius: number;
}

/**
 * Streamed, seeded, instanced grass around the camera; the game owns the blade and the material.
 *
 * Square chunks around the camera, each one instanced draw, built nearest first inside
 * `buildBudgetMs` per frame. A chunk is built inside 1.3 × the draw distance and discarded past
 * 1.4 ×, Unreal Landscape grass's guard band (UE 5.8.3:
 * Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:88, :94), so the edge never thrashes.
 * Each blade carries a priority; the material shrinks low-priority blades away with distance through
 * `thinStart`/`thinEnd`/`farDensity`, and the CPU only trims the instances the shader already hid.
 * Blade LOD is a draw-range switch on `blade.lods`. Up to four pushers flatten grass around them.
 *
 * The node creates no colour, shading or blade shape: `blade` and `material` come from the game's
 * `src/render/grass.ts`, which reads `GRASS_FIELD_ATTRIBUTES` and the `nodes` uniforms.
 *
 * @situation Grass that sways and parts around the player across a large terrain.
 * @situation Stream instanced ground cover in chunks around the camera under a frame budget.
 * @situation Meadow, lawn or field grass with distance thinning and LOD that does not pop.
 * @constraint Call `update(camera)` once per rendered frame, from `ctx.beforeRender`.
 * @constraint Rotating or scaling the field is not supported; translating it is.
 * @example
 * import { GrassField3D } from "@threenative/core";
 * // grassBlade and grassMaterial come from the game's own src/render/grass.ts.
 * const grass = new GrassField3D({ blade: grassBlade(), material: grassMaterial, getHeight: height });
 * ctx.add(grass);
 * ctx.beforeRender(() => { grass.pushers[0]?.set(hero.x, hero.y, hero.z, 1.2); grass.update(camera); });
 */
export class GrassField3D extends Group {
  readonly blade: IGrassFieldBlade;
  readonly material: Material;
  readonly nodes: IGrassFieldNodes;
  /** x, y, z world position and w radius (0 = off) of what flattens the grass. */
  readonly pushers: readonly Vector4[];
  readonly stats: IGrassFieldStats = {
    chunks: 0,
    visibleChunks: 0,
    blades: 0,
    triangles: 0,
    pending: 0,
    built: 0,
  };
  getHeight: (x: number, z: number) => number;
  getDensity: ((x: number, z: number, height: number, normalY: number) => number) | null;
  bounds: IGrassFieldBounds | null;
  density: number;
  chunkSize: number;
  seed: number;
  heightSampleSpacing: number;
  maxSlope: number;
  slopeFade: number;
  minAltitude: number;
  maxAltitude: number;
  clumpSize: number;
  drawDistance: number;
  fadeRange: number;
  lodDistances: readonly number[];
  thinStart: number;
  thinEnd: number;
  farDensity: number;
  buildBudgetMs: number;
  override receiveShadow: boolean;
  densityScale: number;
  cullDistanceScale: number;
  readonly #chunks = new Map<number, IChunk>();
  readonly #queue: { ix: number; iz: number; d: number; k: number }[] = [];
  #frame = 0;
  #version = 0;
  #layout = "";
  #prewarm = false;

  constructor(options: IGrassField3DOptions) {
    super();
    this.name = "GrassField3D";
    if (typeof options.getHeight !== "function")
      throw new Error("GrassField3D.getHeight must be a function (x, z) => height.");
    if (typeof options.material !== "function")
      throw new Error("GrassField3D.material must be a function (nodes) => Material.");
    const lods = options.blade?.lods;
    if (!Array.isArray(lods) || lods.length === 0)
      throw new Error("GrassField3D.blade.lods must list at least one draw range.");
    this.blade = options.blade;
    this.getHeight = options.getHeight;
    this.getDensity = options.getDensity ?? null;
    this.bounds = options.bounds ?? null;
    this.density = options.density ?? 30;
    this.chunkSize = options.chunkSize ?? 12;
    this.seed = options.seed ?? 1337;
    this.heightSampleSpacing = options.heightSampleSpacing ?? 0.75;
    this.maxSlope = options.maxSlope ?? 42;
    this.slopeFade = options.slopeFade ?? 12;
    this.minAltitude = options.minAltitude ?? Number.NEGATIVE_INFINITY;
    this.maxAltitude = options.maxAltitude ?? Number.POSITIVE_INFINITY;
    this.clumpSize = options.clumpSize ?? 1.4;
    this.drawDistance = options.drawDistance ?? 75;
    this.fadeRange = options.fadeRange ?? 0.3;
    this.lodDistances = options.lodDistances ?? [16, 38];
    this.thinStart = options.thinStart ?? 10;
    this.thinEnd = options.thinEnd ?? 62;
    this.farDensity = options.farDensity ?? 0.22;
    this.buildBudgetMs = options.buildBudgetMs ?? 4;
    this.receiveShadow = options.receiveShadow ?? true;
    this.densityScale = options.densityScale ?? 1;
    this.cullDistanceScale = options.cullDistanceScale ?? 1;
    this.#validate();
    this.pushers = Array.from({ length: MAX_PUSHERS }, () => new Vector4());
    const pushers = this.pushers.map((v) => uniform(v));
    this.nodes = {
      thinStart: uniform(0),
      thinEnd: uniform(0),
      farDensity: uniform(0),
      fadeStart: uniform(0),
      drawDistance: uniform(0),
      pushers,
      push: (root: Node<"vec3">): Node<"vec3"> => {
        let dir: Node<"vec2"> = vec2(0, 0);
        let press: Node<"float"> = float(0);
        for (const pu of pushers) {
          const d = root.sub(pu.xyz);
          const f = float(1)
            .sub(d.length().div(pu.w.max(1e-3)).smoothstep(0, 1))
            .mul(pu.w.step(1e-3).oneMinus());
          dir = dir.add(d.xz.add(vec2(1e-4, 1e-4)).normalize().mul(f));
          press = press.max(f);
        }
        return vec3(dir.x, dir.y, press);
      },
    };
    this.#syncNodes();
    this.material = options.material(this.nodes);
  }

  /** The pushers' press 0..1 at a world point: the CPU mirror of `nodes.push`'s z. */
  pressAt(x: number, y: number, z: number): number {
    let press = 0;
    for (const pu of this.pushers) {
      if (pu.w < 1e-3) continue;
      const f = 1 - smoothstep(0, 1, Math.hypot(x - pu.x, y - pu.y, z - pu.z) / pu.w);
      press = Math.max(press, f);
    }
    return press;
  }

  /** Builds every chunk in range on the next `update` regardless of budget: on load or after a teleport. */
  prewarm(): void {
    this.#prewarm = true;
  }

  /** Re-scatter after the ground or the density changed: all chunks, or those touching a rectangle. */
  refresh(rect?: IGrassFieldBounds): void {
    if (rect === undefined) {
      this.#version++;
      return;
    }
    const S = this.chunkSize;
    for (const [k, chunk] of this.#chunks) {
      if (
        chunk.ix * S > rect.maxX ||
        (chunk.ix + 1) * S < rect.minX ||
        chunk.iz * S > rect.maxZ ||
        (chunk.iz + 1) * S < rect.minZ
      )
        continue;
      this.#dispose(chunk);
      this.#chunks.delete(k);
    }
  }

  /** Streams, thins and LODs the chunks around `camera`. Call once per rendered frame. */
  update(camera: Camera): void {
    this.#validate();
    this.#syncNodes();
    const layout = this.#layoutKey();
    if (layout !== this.#layout) {
      for (const chunk of this.#chunks.values()) this.#dispose(chunk);
      this.#chunks.clear();
      this.#layout = layout;
    }
    camera.getWorldPosition(scratch);
    this.worldToLocal(scratch);
    const R = this.drawDistance * this.cullDistanceScale;
    const frame = ++this.#frame;
    this.stats.visibleChunks = this.stats.blades = this.stats.triangles = 0;
    this.#visit(scratch.x, scratch.z, R, frame);
    this.#buildQueued(R, frame);
    this.#prewarm = false;
    this.#evict(scratch.x, scratch.z, R, frame);
    this.stats.chunks = this.#chunks.size;
  }

  /** Marks the chunks inside the create band and queues the missing ones. */
  #visit(cx: number, cz: number, R: number, frame: number): void {
    const S = this.chunkSize;
    const reach = R * CREATE_BAND;
    const queue = this.#queue;
    queue.length = 0;
    for (let iz = Math.floor((cz - reach) / S); iz <= Math.floor((cz + reach) / S); iz++) {
      for (let ix = Math.floor((cx - reach) / S); ix <= Math.floor((cx + reach) / S); ix++) {
        const d = chunkDistance(ix, iz, cx, cz, S);
        if (d >= reach || !this.#inBounds(ix, iz)) continue;
        const k = chunkKey(ix, iz);
        const chunk = this.#chunks.get(k);
        if (!chunk) {
          queue.push({ ix, iz, d, k });
          continue;
        }
        chunk.seen = frame;
        this.#applyLod(chunk, d, R);
      }
    }
  }

  #inBounds(ix: number, iz: number): boolean {
    const b = this.bounds;
    const S = this.chunkSize;
    return (
      b === null ||
      !(ix * S >= b.maxX || (ix + 1) * S <= b.minX || iz * S >= b.maxZ || (iz + 1) * S <= b.minZ)
    );
  }

  /** Builds queued chunks nearest first; one always builds, the rest only inside the budget. */
  #buildQueued(R: number, frame: number): void {
    const queue = this.#queue;
    queue.sort((a, c) => a.d - c.d);
    const budget = this.#prewarm ? Number.POSITIVE_INFINITY : this.buildBudgetMs;
    const t0 = performance.now();
    let built = 0;
    for (const q of queue) {
      if (built > 0 && performance.now() - t0 > budget) break;
      const chunk = this.#build(q.ix, q.iz);
      chunk.seen = frame;
      this.#chunks.set(q.k, chunk);
      this.#applyLod(chunk, q.d, R);
      built++;
    }
    this.stats.built += built;
    this.stats.pending = queue.length - built;
  }

  /** Hides chunks that left the view radius and frees those past the discard band. */
  #evict(cx: number, cz: number, R: number, frame: number): void {
    for (const [k, chunk] of this.#chunks) {
      if (chunk.seen === frame) continue;
      if (chunkDistance(chunk.ix, chunk.iz, cx, cz, this.chunkSize) > R * DISCARD_BAND) {
        this.#dispose(chunk);
        this.#chunks.delete(k);
      } else if (chunk.mesh?.visible) chunk.mesh.visible = false;
    }
  }

  override dispose(): void {
    for (const chunk of this.#chunks.values()) this.#dispose(chunk);
    this.#chunks.clear();
    this.material.dispose();
  }

  #validate(): void {
    if (!(this.chunkSize > 0))
      throw new Error(`GrassField3D.chunkSize must be > 0, got ${this.chunkSize}.`);
    if (!(this.density >= 0))
      throw new Error(`GrassField3D.density must be >= 0, got ${this.density}.`);
    if (!(this.drawDistance > 0))
      throw new Error(`GrassField3D.drawDistance must be > 0, got ${this.drawDistance}.`);
    if (!(this.buildBudgetMs >= 0))
      throw new Error(`GrassField3D.buildBudgetMs must be >= 0, got ${this.buildBudgetMs}.`);
    if (!(this.densityScale >= 0) || !(this.cullDistanceScale > 0))
      throw new Error("GrassField3D.densityScale must be >= 0 and cullDistanceScale > 0.");
    const b = this.bounds;
    if (b === null) return;
    for (const key of ["minX", "minZ", "maxX", "maxZ"] as const)
      if (!Number.isFinite(b[key])) throw new Error(`GrassField3D.bounds.${key} must be finite.`);
    if (b.minX >= b.maxX) throw new Error("GrassField3D.bounds.minX must be below bounds.maxX.");
    if (b.minZ >= b.maxZ) throw new Error("GrassField3D.bounds.minZ must be below bounds.maxZ.");
  }

  #syncNodes(): void {
    const k = this.cullDistanceScale;
    const n = this.nodes;
    // Only on change: on the owned engine each uniform write crosses into the engine.
    setIfChanged(n.thinStart, this.thinStart * k);
    setIfChanged(n.thinEnd, Math.max(this.thinEnd, this.thinStart + 0.01) * k);
    setIfChanged(n.farDensity, this.farDensity);
    setIfChanged(n.drawDistance, this.drawDistance * k);
    setIfChanged(
      n.fadeStart,
      this.drawDistance * k * (1 - Math.min(Math.max(this.fadeRange, 0.01), 1)),
    );
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
      this.clumpSize,
    ].join("|");
  }

  #applyLod(chunk: IChunk, d: number, R: number): void {
    const mesh = chunk.mesh;
    if (!mesh || !chunk.priority) return;
    const k = this.cullDistanceScale;
    const geo = mesh.geometry as InstancedBufferGeometry;
    // The same cut-off the material applies, at the chunk's nearest point: only hidden blades go.
    const thinEnd = Math.max(this.thinEnd, this.thinStart + 0.01) * k;
    const edge = 1.1 + (this.farDensity - 1.1) * smoothstep(this.thinStart * k, thinEnd, d);
    let n = chunk.count;
    if (edge < 1) {
      const pr = chunk.priority;
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((pr[mid] as number) < edge) lo = mid + 1;
        else hi = mid;
      }
      n = lo;
    }
    // Every write below is guarded: a standing camera re-plans nothing on the owned engine.
    if (geo.instanceCount !== n) geo.instanceCount = n;
    const visible = n > 0 && d < R;
    if (mesh.visible !== visible) mesh.visible = visible;
    if (!visible) return;
    const lods = this.blade.lods;
    let lod = 0;
    while (lod < lods.length - 1 && d >= (this.lodDistances[lod] ?? Number.POSITIVE_INFINITY) * k)
      lod++;
    const range = lods[lod] as { start: number; count: number };
    if (geo.drawRange.start !== range.start || geo.drawRange.count !== range.count)
      geo.setDrawRange(range.start, range.count);
    if (mesh.receiveShadow !== this.receiveShadow) mesh.receiveShadow = this.receiveShadow;
    this.stats.visibleChunks++;
    this.stats.blades += n;
    this.stats.triangles += n * (range.count / 3);
  }

  #build(ix: number, iz: number): IChunk {
    const S = this.chunkSize;
    const ox = ix * S;
    const oz = iz * S;
    const seed = this.seed | 0;
    const rng = mulberry32(hashInt(ix, iz, seed));
    const ground = groundGrid(this.getHeight, ox, oz, S, this.heightSampleSpacing);
    // A jittered grid visited in a seeded random order: any prefix covers the chunk evenly, so
    // thinning by distance is a plain instance count.
    const n = Math.max(1, Math.ceil(Math.sqrt(this.density * this.densityScale * S * S)));
    const total = this.density * this.densityScale > 0 ? n * n : 0;
    const cell = S / n;
    const order = shuffled(total, rng);
    const pos = new Float32Array(total * 3);
    const rand = new Float32Array(total * 4);
    const clump = new Float32Array(total * 4);
    const priority = new Float32Array(total);
    const cosMax = Math.cos(this.maxSlope * DEG);
    const slopeSpan = Math.max(
      Math.cos(Math.max(this.maxSlope - this.slopeFade, 0) * DEG) - cosMax,
      1e-5,
    );
    const cs = Math.max(this.clumpSize, 0.05);
    prepareTufts(ox, oz, S, cs, seed);
    let k = 0;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let q = 0; q < total; q++) {
      const c = order[q] as number;
      const lx = ((c % n) + rng()) * cell;
      const lz = (((c / n) | 0) + rng()) * cell;
      const rFacing = rng();
      const rHeight = rng();
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
      nearestTuft(wx, wz, cs);
      pos[k * 3] = lx;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = lz;
      priority[k] = q / total;
      rand[k * 4] = rFacing;
      rand[k * 4 + 1] = rHeight;
      rand[k * 4 + 2] = q / total;
      rand[k * 4 + 3] = 0.45 + 0.55 * m;
      clump[k * 4] = fastAtan2(wz - (tuft[1] as number), wx - (tuft[0] as number));
      clump[k * 4 + 1] = tuft[2] as number;
      clump[k * 4 + 2] = -dx * ny;
      clump[k * 4 + 3] = -dz * ny;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      k++;
    }
    if (k === 0)
      // Remembered as empty so it is not rebuilt every frame.
      return { ix, iz, seen: 0, count: 0, mesh: null, priority: null, radius: 0 };
    const blade = this.blade.geometry;
    const geo = new InstancedBufferGeometry();
    // The blade's arrays are shared; each chunk wraps them in its own attribute so disposing one
    // chunk never frees another's buffers.
    if (blade.index) geo.setIndex(new BufferAttribute(blade.index.array, 1));
    for (const [name, attr] of Object.entries(blade.attributes))
      geo.setAttribute(name, new BufferAttribute(attr.array, attr.itemSize, attr.normalized));
    geo.setAttribute(
      GRASS_FIELD_ATTRIBUTES.root,
      new InstancedBufferAttribute(pos.slice(0, k * 3), 3),
    );
    geo.setAttribute(
      GRASS_FIELD_ATTRIBUTES.rand,
      new InstancedBufferAttribute(rand.slice(0, k * 4), 4),
    );
    geo.setAttribute(
      GRASS_FIELD_ATTRIBUTES.clump,
      new InstancedBufferAttribute(clump.slice(0, k * 4), 4),
    );
    geo.instanceCount = k;
    const halfY = (maxY - minY) / 2;
    const radius = Math.sqrt(S * S * 0.5 + halfY * halfY);
    const pad = Math.max(this.blade.reach, 0) * 1.5 + 1;
    geo.boundingSphere = new Sphere(new Vector3(S / 2, minY + halfY, S / 2), radius + pad);
    geo.boundingBox = new Box3(
      new Vector3(-pad, minY - 1, -pad),
      new Vector3(S + pad, maxY + pad, S + pad),
    );
    const mesh = new Mesh(geo, this.material);
    mesh.name = `grass ${ix},${iz}`;
    mesh.position.set(ox, 0, oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.raycast = () => {};
    this.add(mesh);
    return { ix, iz, seen: 0, count: k, mesh, priority: priority.slice(0, k), radius };
  }

  #pointInBounds(x: number, z: number): boolean {
    const b = this.bounds;
    return b === null || (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);
  }

  /** Slope limit times the game's mask, 0..1. */
  #coverage(x: number, z: number, y: number, ny: number, cosMax: number, span: number): number {
    const m = clamp01((ny - cosMax) / span);
    return m > 0 && this.getDensity ? m * clamp01(this.getDensity(x, z, y, ny)) : m;
  }

  #dispose(chunk: IChunk): void {
    if (!chunk.mesh) return;
    this.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
  }
}

const scratch = new Vector3();

function setIfChanged(node: { value: number }, value: number): void {
  if (node.value !== value) node.value = value;
}
/** Height, d/dx and d/dz of the last `groundGrid` sample. */
const sample = new Float64Array(3);
/** x, z and random of the last `nearestTuft` centre. */
const tuft = new Float64Array(3);

/** Ground height on a grid one ring wider than the chunk, for gradients; `sample` reads it bilinearly. */
function groundGrid(
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
      // Bilinear weights once, no closure per call: this runs for every candidate blade.
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

/** 0..total-1 in a seeded random order (Fisher-Yates). */
function shuffled(total: number, rng: () => number): Uint32Array {
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

/** Tuft centres (x, z, random) of the cells round one chunk, hashed once per cell, not per blade. */
let tuftCells = new Float64Array(0);
let tuftX0 = 0;
let tuftZ0 = 0;
let tuftW = 0;

/** Fills `tuftCells` for every tuft cell a blade in `[ox, ox + S]²` can reach (its own and the ring round it). */
function prepareTufts(ox: number, oz: number, S: number, cs: number, seed: number): void {
  tuftX0 = Math.floor(ox / cs) - 1;
  tuftZ0 = Math.floor(oz / cs) - 1;
  tuftW = Math.floor((ox + S) / cs) - tuftX0 + 2;
  const rows = Math.floor((oz + S) / cs) - tuftZ0 + 2;
  if (tuftCells.length < tuftW * rows * 3) tuftCells = new Float64Array(tuftW * rows * 3);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < tuftW; c++) {
      const cx = tuftX0 + c;
      const cz = tuftZ0 + r;
      const h = hashInt(cx, cz, seed + 7919);
      const o = (r * tuftW + c) * 3;
      tuftCells[o] = (cx + (h & 1023) / 1023) * cs;
      tuftCells[o + 1] = (cz + ((h >>> 10) & 1023) / 1023) * cs;
      tuftCells[o + 2] = ((h >>> 20) & 1023) / 1023;
    }
}

/** The nearest tuft centre on a jittered world grid, continuous across chunks, into `tuft`. */
function nearestTuft(wx: number, wz: number, cs: number): void {
  const ccx = Math.floor(wx / cs);
  const ccz = Math.floor(wz / cs);
  let best = Number.POSITIVE_INFINITY;
  for (let jz = -1; jz <= 1; jz++)
    for (let jx = -1; jx <= 1; jx++) {
      const o = ((ccz + jz - tuftZ0) * tuftW + (ccx + jx - tuftX0)) * 3;
      const px = tuftCells[o] as number;
      const pz = tuftCells[o + 1] as number;
      const dd = (px - wx) * (px - wx) + (pz - wz) * (pz - wz);
      if (dd >= best) continue;
      best = dd;
      tuft[0] = px;
      tuft[1] = pz;
      tuft[2] = tuftCells[o + 2] as number;
    }
}

function chunkDistance(ix: number, iz: number, cx: number, cz: number, S: number): number {
  const dx = Math.max(ix * S - cx, 0, cx - (ix + 1) * S);
  const dz = Math.max(iz * S - cz, 0, cz - (iz + 1) * S);
  return Math.sqrt(dx * dx + dz * dz);
}

const chunkKey = (ix: number, iz: number): number => (ix + 0x8000) * 0x10000 + (iz + 0x8000);

/**
 * `Math.atan2` within 1e-5 rad at a fraction of its cost: a blade's tuft angle runs once per
 * candidate blade, and the material only reads it through cos and sin.
 */
export function fastAtan2(y: number, x: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const hi = Math.max(ax, ay);
  if (hi === 0) return 0;
  const a = Math.min(ax, ay) / hi;
  const s = a * a;
  let r =
    ((((-0.01348047 * s + 0.057477314) * s - 0.121239071) * s + 0.195635925) * s - 0.332994597) *
      s *
      a +
    0.99999563 * a;
  if (ay > ax) r = 1.57079637 - r;
  if (x < 0) r = 3.14159274 - r;
  return y < 0 ? -r : r;
}

function hashInt(x: number, y: number, s: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-6));
  return t * t * (3 - 2 * t);
}
