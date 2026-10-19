import { Group, Vector3, Vector4 } from "three";
import type { Node, UniformNode } from "three/src/nodes/Nodes.js";
import * as tsl from "three/tsl";
import {
  type ComputeNode,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Storage3DTexture,
} from "three/webgpu";
import { GPUReadback } from "./gpu-readback.js";
import type { IRendererLike } from "./renderer.js";

type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];
/**
 * A TSL node as the solver handles it: vectors, scalars and storage elements through swizzles that
 * three's types refuse for a storage element or an atomic result. Confined to this module.
 */
// quality-allow: the solver is arithmetic over TSL nodes, which three 0.185 types per-swizzle.
// biome-ignore lint/suspicious/noExplicitAny: three's TSL types refuse the swizzles the kernels read.
type TslNode = Record<string, any>;
type TslVar = TslNode;
// quality-allow: the whole TSL namespace is read through one loose record; see TslNode.
// biome-ignore lint/suspicious/noExplicitAny: see TslNode.
const tslNodes: Record<string, any> = tsl;
const {
  Fn,
  If,
  Loop,
  Return,
  abs,
  atomicAdd,
  atomicLoad,
  atomicMax,
  atomicMin,
  atomicStore,
  ceil,
  clamp,
  dot,
  exp,
  float,
  floor,
  hash,
  instanceIndex,
  instancedArray,
  int,
  ivec3,
  length,
  max,
  min,
  select,
  storageTexture,
  textureStore,
  uint,
  uniform,
  uniformArray,
  uvec3,
  vec3,
  vec4,
} = tslNodes;

export interface IFluidBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** An obstacle the water flows around. Boxes carry an xyzw quaternion; spheres have no orientation. */
export type IFluidCollider =
  | { readonly kind: "sphere"; readonly center: Vec3; readonly radius: number }
  | {
      readonly kind: "box";
      readonly center: Vec3;
      readonly halfExtents: Vec3;
      readonly rotation?: Vec4;
    };

export interface IFluidParticlesOptions {
  /** Particle slots. The solver never holds more than this many live particles. */
  readonly capacity: number;
  /** Rest spacing in metres. The smoothing radius is twice this. */
  readonly spacing?: number;
  /** The container. Particles are projected back inside it every iteration. */
  readonly bounds?: IFluidBounds;
  /** Density-constraint iterations per fixed step, 0 to 8. */
  readonly iterations?: number;
  readonly viscosity?: number;
  readonly cohesion?: number;
  readonly vorticity?: number;
  readonly gravity?: number;
  /** Vector speed limit in m/s. Prediction projects radius-sized segments; this is not swept CCD. */
  readonly maxSpeed?: number;
  readonly timeStep?: number;
  /** Colliders updated per step through `setColliders`. */
  readonly maxColliders?: number;
  /** Queued `fill`/`emit` calls consumed per step. Extra calls return `false`. */
  readonly maxSpawns?: number;
  /** Voxel edge of the density volume, in metres. Defaults to half the spacing. */
  readonly voxelSize?: number;
  /** Fixed steps between GPU-to-CPU copies of stats and column heights. */
  readonly readbackEvery?: number;
  /** Extra acceleration (m/s²) added to every particle, from the game's own TSL. */
  readonly force?: (position: Node<"vec3">, velocity: Node<"vec3">, time: Node<"float">) => Node;
}

export interface IFluidParticlesStats {
  readonly count: number;
  /** Mean of `max(0, density - 1)` over live particles; 0 is incompressible. */
  readonly meanCompression: number;
  readonly maxSpeed: number;
  readonly min: Vec3;
  readonly max: Vec3;
  /** Fixed steps between the GPU state these numbers describe and now. */
  readonly staleFrames: number;
}

const DEFAULT_SPACING = 0.22;
const DEFAULT_BOUNDS: IFluidBounds = { min: [-2.9, 0.0968, -1.6], max: [2.9, 4.65, 1.6] };
const CELL_CAPACITY = 32;
const STAT_WORDS = 9;
const READOUT_HEADER = 16;
const MAX_STIRS = 4;
const MAX_DRAINS = 4;
const FIXED_POINT = 1000;
const COMPRESSION_SCALE = 100000;
/** Column height of a column whose water is roofed by a collider; `sample` reads past it. */
const COVERED = -1e30;
const COVERED_SEARCH = 8;
/** Half-width, in columns, of the box filter `sample` averages. */
const SURFACE_FILTER = 2;
const MIN_OPEN_COLUMNS = 4;

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`FluidParticles3D.${name} must be positive.`);
}

function nonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`FluidParticles3D.${name} must be non-negative.`);
}

function integerAtLeast(name: string, value: number, least: number): void {
  if (!Number.isInteger(value) || value < least)
    throw new Error(`FluidParticles3D.${name} must be an integer of at least ${least}.`);
}

function finiteVec(name: string, value: readonly number[], length: number): void {
  if (value.length !== length || !value.every(Number.isFinite))
    throw new Error(`FluidParticles3D.${name} must be ${length} finite numbers.`);
}

function nodeVar(node: TslNode): TslVar {
  return node.toVar();
}

function computeKernel(name: string, count: number, body: () => void): ComputeNode {
  const node = Fn(body)().compute(count);
  node.setName(name);
  return node;
}

/** Rotate `vector` by the inverse quaternion's rows, one world-to-local basis row per axis. */
function basisRows(rotation: Vec4): readonly [Vec3, Vec3, Vec3] {
  finiteVec("collider.rotation", rotation, 4);
  const [x, y, z, w] = rotation;
  const length2 = x * x + y * y + z * z + w * w;
  if (length2 < 1e-12) throw new Error("FluidParticles3D collider rotation must be non-zero.");
  const k = 2 / length2;
  const xx = x * x * k;
  const yy = y * y * k;
  const zz = z * z * k;
  const xy = x * y * k;
  const xz = x * z * k;
  const yz = y * z * k;
  const wx = w * x * k;
  const wy = w * y * k;
  const wz = w * z * k;
  // Columns of R; the rows of R^T are the world-to-local axes.
  return [
    [1 - yy - zz, xy + wz, xz - wy],
    [xy - wz, 1 - xx - zz, yz + wx],
    [xz + wy, yz - wx, 1 - xx - yy],
  ];
}

/**
 * Simulate liquid as particles on the GPU and expose the data, never the look.
 *
 * It is a Position Based Fluids solver (density constraints, XSPH viscosity, cohesion, vorticity
 * confinement) whose passes run as compute kernels every fixed step. Nothing is drawn: `positions`
 * and `velocities` are storage nodes (`.w` of `positions` is the live flag, `.w` of `velocities`
 * is a 0..1 foam hint), `density` is a 3D texture of smoothed particle density a game raymarches
 * or thresholds, and `sample(x, z)` is the free-surface height a `Buoyancy3D` consumes.
 * Appearance — refraction, absorption, foam, spray — stays in the game's `src/render/` code.
 * @situation pour, splash, or dam-break water that fills a container and flows around obstacles
 * @situation simulate water or another liquid as particles in a fluid simulation
 * @situation drop a ball or box into liquid and let it displace and float on the water
 * @situation emit a stream or waterfall of particle fluid and drain it somewhere else
 * @situation sample particle-fluid density or surface height in a game-owned render node
 * @constraint add the fluid through `ctx.add` so renderer attachment, fixed-step dispatch, and release are automatic
 * @constraint a renderer without WebGPU compute throws a named error at attach; it never draws nothing
 * @constraint `emit` recycles the oldest slot once `capacity` slots have been used; `fill` stops at capacity
 * @constraint `sample` and `stats` read a throttled GPU copy and report `staleFrames`; they are never live
 * @override iterations, viscosity, cohesion, vorticity, gravity and maxSpeed tune the solver without changing its pass order
 * @example const water = new FluidParticles3D({ capacity: 6000 });
 * ctx.add(water);
 * water.fill([-2.8, 0.1, -1.5], [-0.6, 3, 1.5]);
 */
export class FluidParticles3D extends Group {
  readonly capacity: number;
  readonly spacing: number;
  readonly bounds: IFluidBounds;
  readonly iterations: number;
  readonly maxSpeed: number;
  readonly timeStep: number;
  readonly maxColliders: number;
  readonly maxSpawns: number;
  readonly processCadence = "fixed" as const;
  readonly warmupNodes: readonly ComputeNode[];
  /** vec4 per slot: xyz position, w = 1 live / 0 free. */
  readonly positions: ReturnType<typeof instancedArray>;
  /** vec4 per slot: xyz velocity, w = foam 0..1. */
  readonly velocities: ReturnType<typeof instancedArray>;
  /** Smoothed particle density, ~1 inside water; sample it with `texture3D`. */
  readonly density: Storage3DTexture;
  /** Voxel counts of `density`. */
  readonly volumeSize: Vec3;
  /** World-space corner of voxel (0,0,0) and the edge length of one voxel. */
  readonly volumeOrigin: Vec3;
  readonly voxelSize: number;

  readonly #viscosity: UniformNode<"float", number>;
  readonly #cohesion: UniformNode<"float", number>;
  readonly #vorticity: UniformNode<"float", number>;
  readonly #gravity: UniformNode<"float", number>;
  readonly #time: UniformNode<"float", number>;
  readonly #slots: UniformNode<"uint", number>;
  readonly #spawnCount: UniformNode<"uint", number>;
  readonly #spawnA: TslNode;
  readonly #spawnB: TslNode;
  readonly #spawnC: TslNode;
  readonly #drainCount: UniformNode<"uint", number>;
  readonly #drainMin: TslNode;
  readonly #drainMax: TslNode;
  readonly #stirCount: UniformNode<"uint", number>;
  readonly #stirA: TslNode;
  readonly #stirB: TslNode;
  readonly #colliderCount: UniformNode<"uint", number>;
  readonly #colliderA: TslNode;
  readonly #colliderB: TslNode;
  readonly #colliderRows: readonly [TslNode, TslNode, TslNode];
  readonly #readout: ReturnType<typeof instancedArray>;
  readonly #buffers: readonly ReturnType<typeof instancedArray>[];
  readonly #readback: GPUReadback;
  readonly #columns: readonly [number, number];
  readonly #inject: ComputeNode;
  readonly #predict: ComputeNode;
  readonly #gridClear: ComputeNode;
  readonly #gridBuild: ComputeNode;
  readonly #lambda: ComputeNode;
  readonly #delta: ComputeNode;
  readonly #apply: ComputeNode;
  readonly #velocity: ComputeNode;
  readonly #smooth: ComputeNode;
  readonly #confine: ComputeNode;
  readonly #statsClear: ComputeNode;
  readonly #statsFinalize: ComputeNode;
  readonly #volume: ComputeNode;
  readonly #columnHeights: ComputeNode;
  #renderer: IRendererLike | undefined;
  #cursor = 0;
  #used = 0;
  #queuedSpawns = 0;
  #queuedDrains = 0;
  #queuedStirs = 0;
  #colliders = 0;
  #steps = 0;
  #released = false;

  constructor(options: IFluidParticlesOptions) {
    integerAtLeast("capacity", options.capacity, 1);
    if (options.capacity > 65536)
      throw new Error("FluidParticles3D.capacity must be at most 65536.");
    const spacing = options.spacing ?? DEFAULT_SPACING;
    const bounds = options.bounds ?? DEFAULT_BOUNDS;
    const iterations = options.iterations ?? 3;
    const viscosity = options.viscosity ?? 0.008;
    const cohesion = options.cohesion ?? 0.03;
    const vorticity = options.vorticity ?? 0.015;
    const gravity = options.gravity ?? 9.81;
    const maxSpeed = options.maxSpeed ?? 18;
    const timeStep = options.timeStep ?? 1 / 60;
    const maxColliders = options.maxColliders ?? 8;
    const maxSpawns = options.maxSpawns ?? 16;
    const voxelSize = options.voxelSize ?? spacing / 2;
    const readbackEvery = options.readbackEvery ?? 4;
    positive("spacing", spacing);
    positive("maxSpeed", maxSpeed);
    positive("timeStep", timeStep);
    positive("voxelSize", voxelSize);
    nonNegative("viscosity", viscosity);
    nonNegative("cohesion", cohesion);
    nonNegative("vorticity", vorticity);
    nonNegative("gravity", gravity);
    if (!Number.isInteger(iterations) || iterations < 0 || iterations > 8)
      throw new Error("FluidParticles3D.iterations must be an integer from 0 to 8.");
    integerAtLeast("maxColliders", maxColliders, 1);
    integerAtLeast("maxSpawns", maxSpawns, 1);
    integerAtLeast("readbackEvery", readbackEvery, 1);
    finiteVec("bounds.min", bounds.min, 3);
    finiteVec("bounds.max", bounds.max, 3);
    for (let axis = 0; axis < 3; axis += 1)
      if ((bounds.max[axis] as number) - (bounds.min[axis] as number) < spacing * 2)
        throw new Error(
          "FluidParticles3D.bounds must be at least two spacings wide on every axis.",
        );

    super();
    this.capacity = options.capacity;
    this.spacing = spacing;
    this.bounds = bounds;
    this.iterations = iterations;
    this.maxSpeed = maxSpeed;
    this.timeStep = timeStep;
    this.maxColliders = maxColliders;
    this.maxSpawns = maxSpawns;
    this.voxelSize = voxelSize;

    // Kernel constants of the reference solver: h = 2 spacing, unit rest density.
    const radius = spacing * 0.44;
    const h = spacing * 2;
    const h2 = h * h;
    const volumeOfParticle = spacing ** 3;
    const poly6 = 315 / (64 * Math.PI * h ** 9);
    const spiky = -45 / (Math.PI * h ** 6);
    const wSelf = poly6 * h ** 6;
    const wReference = poly6 * (h2 - (0.3 * h) ** 2) ** 3;
    const relaxation = 0.03;
    const wallFriction = 0.08;
    const min3 = bounds.min;
    const max3 = bounds.max;

    const gridOrigin: Vec3 = [min3[0] - h, min3[1] - h, min3[2] - h];
    const gridDims: Vec3 = [
      Math.ceil((max3[0] - min3[0]) / h) + 3,
      Math.ceil((max3[1] - min3[1]) / h) + 3,
      Math.ceil((max3[2] - min3[2]) / h) + 3,
    ];
    const cells = gridDims[0] * gridDims[1] * gridDims[2];
    this.volumeSize = [
      Math.ceil((max3[0] - min3[0]) / voxelSize),
      Math.ceil((max3[1] - min3[1]) / voxelSize),
      Math.ceil((max3[2] - min3[2]) / voxelSize),
    ];
    this.volumeOrigin = min3;
    const [vx, vy, vz] = this.volumeSize;
    const voxels = vx * vy * vz;
    if (voxels > 4_000_000)
      throw new Error("FluidParticles3D.voxelSize makes a density volume over 4M voxels.");
    this.#columns = [vx, vz];

    const capacity = this.capacity;
    this.positions = instancedArray(capacity, "vec4");
    this.velocities = instancedArray(capacity, "vec4");
    const previous = instancedArray(capacity, "vec4");
    const deltas = instancedArray(capacity, "vec4");
    const omega = instancedArray(capacity, "vec4");
    const lambdas = instancedArray(capacity, "float");
    const densities = instancedArray(capacity, "float");
    const cellCount = instancedArray(cells, "uint").toAtomic();
    const cellItems = instancedArray(cells * CELL_CAPACITY, "uint");
    const stats = instancedArray(STAT_WORDS, "uint").toAtomic();
    const volumeBuffer = instancedArray(voxels, "float");
    this.#readout = instancedArray(READOUT_HEADER + vx * vz, "float");
    this.#buffers = [
      this.positions,
      this.velocities,
      previous,
      deltas,
      omega,
      lambdas,
      densities,
      cellCount,
      cellItems,
      stats,
      volumeBuffer,
      this.#readout,
    ];
    const readout = this.#readout;
    const positions = this.positions;
    const velocities = this.velocities;

    this.density = new Storage3DTexture(vx, vy, vz);
    this.density.format = RGBAFormat;
    this.density.type = HalfFloatType;
    this.density.minFilter = LinearFilter;
    this.density.magFilter = LinearFilter;
    this.density.generateMipmaps = false;
    this.density.needsUpdate = true;

    this.#viscosity = uniform(viscosity);
    this.#cohesion = uniform(cohesion);
    this.#vorticity = uniform(vorticity);
    this.#gravity = uniform(gravity);
    this.#time = uniform(0);
    this.#slots = uniform(0, "uint");
    const zeros = (count: number): Vector4[] => Array.from({ length: count }, () => new Vector4());
    this.#spawnCount = uniform(0, "uint");
    this.#spawnA = uniformArray(zeros(maxSpawns), "vec4");
    this.#spawnB = uniformArray(zeros(maxSpawns), "vec4");
    this.#spawnC = uniformArray(zeros(maxSpawns), "vec4");
    this.#drainCount = uniform(0, "uint");
    this.#drainMin = uniformArray(zeros(MAX_DRAINS), "vec4");
    this.#drainMax = uniformArray(zeros(MAX_DRAINS), "vec4");
    this.#stirCount = uniform(0, "uint");
    this.#stirA = uniformArray(zeros(MAX_STIRS), "vec4");
    this.#stirB = uniformArray(zeros(MAX_STIRS), "vec4");
    this.#colliderCount = uniform(0, "uint");
    this.#colliderA = uniformArray(zeros(maxColliders), "vec4");
    this.#colliderB = uniformArray(zeros(maxColliders), "vec4");
    this.#colliderRows = [
      uniformArray(zeros(maxColliders), "vec4"),
      uniformArray(zeros(maxColliders), "vec4"),
      uniformArray(zeros(maxColliders), "vec4"),
    ];

    const dt = float(timeStep);
    const live = (index: TslNode): TslNode => positions.element(index).w.greaterThan(0.5);
    const guard = (): void => {
      If(instanceIndex.greaterThanEqual(this.#slots), () => {
        Return();
      });
      If(live(instanceIndex).not(), () => {
        Return();
      });
    };

    const cellOf = (point: TslNode) =>
      ivec3(
        clamp(
          floor(point.sub(vec3(...gridOrigin)).div(h)),
          vec3(1),
          vec3(gridDims[0] - 2, gridDims[1] - 2, gridDims[2] - 2),
        ),
      );
    const cellId = (cell: TslNode): TslNode =>
      cell.x
        .add(cell.y.mul(gridDims[0]))
        .add(cell.z.mul(gridDims[0] * gridDims[1]))
        .toUint();

    /** Visit every particle within the smoothing radius of `point`, `self` excluded. */
    const forNeighbours = (
      point: TslNode,
      self: TslNode,
      body: (other: TslNode, offset: TslNode, r2: TslNode) => void,
    ): void => {
      const cell = cellOf(point);
      Loop(27, ({ i: k }: { i: TslNode }) => {
        const dx = k.mod(3).sub(1);
        const dy = k.div(3).mod(3).sub(1);
        const dz = k.div(9).sub(1);
        const id = cellId(cell.add(ivec3(dx, dy, dz)));
        const inCell = min(atomicLoad(cellCount.element(id)), uint(CELL_CAPACITY)).toVar();
        Loop({ start: uint(0), end: inCell, type: "uint" }, ({ i: slot }: { i: TslNode }) => {
          const other = cellItems.element(id.mul(CELL_CAPACITY).add(slot));
          If(other.notEqual(self), () => {
            const offset = point.sub(positions.element(other).xyz);
            const r2 = dot(offset, offset);
            If(r2.lessThan(h2), () => body(other, offset, r2));
          });
        });
      });
    };
    const kernel = (r2: TslNode): TslNode => float(h2).sub(r2).pow(3).mul(poly6);
    const gradientScale = (r: TslNode): TslNode =>
      float(h)
        .sub(r)
        .pow(2)
        .mul(volumeOfParticle * spiky)
        .div(r);

    const project = (point: TslVar): void => {
      point.assign(clamp(point, vec3(...min3), vec3(...max3)));
      Loop({ start: uint(0), end: this.#colliderCount, type: "uint" }, ({ i }: { i: TslNode }) => {
        const a = this.#colliderA.element(i);
        const b = this.#colliderB.element(i);
        const offset = point.sub(a.xyz);
        If(dot(offset, offset).lessThan(b.w.add(radius).pow(2)), () => {
          If(a.w.lessThan(0.5), () => {
            const reach = b.x.add(radius);
            const distance = length(offset);
            If(distance.lessThan(reach), () => {
              const direction = select(
                distance.lessThan(1e-9),
                vec3(0, 1, 0),
                offset.div(max(distance, 1e-9)),
              );
              point.assign(a.xyz.add(direction.mul(reach)));
            });
          }).Else(() => {
            const rows = this.#colliderRows.map((row) => row.element(i).xyz);
            const local = vec3(
              dot(rows[0] as TslNode, offset),
              dot(rows[1] as TslNode, offset),
              dot(rows[2] as TslNode, offset),
            );
            const half = b.xyz.add(radius);
            const absolute = abs(local);
            If(
              absolute.x
                .lessThan(half.x)
                .and(absolute.y.lessThan(half.y))
                .and(absolute.z.lessThan(half.z)),
              () => {
                const gap = half.sub(absolute);
                const out = nodeVar(local);
                If(gap.x.lessThan(gap.y).and(gap.x.lessThan(gap.z)), () => {
                  out.assign(
                    vec3(select(local.x.lessThan(0), half.x.negate(), half.x), local.y, local.z),
                  );
                })
                  .ElseIf(gap.y.lessThan(gap.z), () => {
                    out.assign(
                      vec3(local.x, select(local.y.lessThan(0), half.y.negate(), half.y), local.z),
                    );
                  })
                  .Else(() => {
                    out.assign(
                      vec3(local.x, local.y, select(local.z.lessThan(0), half.z.negate(), half.z)),
                    );
                  });
                const world = (rows[0] as TslNode)
                  .mul((out as TslNode).x)
                  .add((rows[1] as TslNode).mul((out as TslNode).y))
                  .add((rows[2] as TslNode).mul((out as TslNode).z));
                point.assign(a.xyz.add(world));
              },
            );
          });
        });
      });
      // Colliders push outward, possibly past the container: the container wins.
      point.assign(clamp(point, vec3(...min3), vec3(...max3)));
    };

    this.#inject = computeKernel("fluidParticles.inject", capacity, () => {
      const slot = instanceIndex;
      If(slot.greaterThanEqual(uint(capacity)), () => {
        Return();
      });
      const body = positions.element(slot);
      const motion = velocities.element(slot);
      Loop({ start: uint(0), end: this.#drainCount, type: "uint" }, ({ i }: { i: TslNode }) => {
        const low = this.#drainMin.element(i).xyz;
        const high = this.#drainMax.element(i).xyz;
        const p = body.xyz;
        If(
          body.w
            .greaterThan(0.5)
            .and(p.x.greaterThanEqual(low.x))
            .and(p.x.lessThanEqual(high.x))
            .and(p.y.greaterThanEqual(low.y))
            .and(p.y.lessThanEqual(high.y))
            .and(p.z.greaterThanEqual(low.z))
            .and(p.z.lessThanEqual(high.z)),
          () => {
            body.assign(vec4(p, 0));
            motion.assign(vec4(0));
          },
        );
      });
      Loop({ start: uint(0), end: this.#spawnCount, type: "uint" }, ({ i }: { i: TslNode }) => {
        const a = this.#spawnA.element(i); // min.xyz, first slot
        const b = this.#spawnB.element(i); // lattice dims xyz, particle count
        const c = this.#spawnC.element(i); // velocity.xyz, lattice spacing
        const relative = slot.add(uint(capacity)).sub(a.w.toUint()).mod(uint(capacity));
        If(relative.lessThan(b.w.toUint()), () => {
          const nx = b.x.toUint();
          const nz = b.z.toUint();
          const ix = relative.mod(nx);
          const iz = relative.div(nx).mod(nz);
          const iy = relative.div(nx.mul(nz));
          const jitter = select(
            b.w.greaterThan(1.5),
            vec3(
              hash(slot.add(relative)).sub(0.5),
              hash(slot.add(relative).add(uint(104729))).sub(0.5),
              hash(slot.add(relative).add(uint(7919))).sub(0.5),
            ).mul(c.w.mul(0.1)),
            vec3(0),
          );
          const placed = a.xyz.add(vec3(float(ix), float(iy), float(iz)).mul(c.w)).add(jitter);
          body.assign(vec4(placed, 1));
          motion.assign(vec4(c.xyz, 0));
        });
      });
    });

    this.#predict = computeKernel("fluidParticles.predict", capacity, () => {
      guard();
      const i = instanceIndex;
      const velocity = nodeVar(velocities.element(i).xyz);
      const position = nodeVar(positions.element(i).xyz);
      Loop({ start: uint(0), end: this.#stirCount, type: "uint" }, ({ i: s }: { i: TslNode }) => {
        const centre = this.#stirA.element(s);
        const offset = position.sub(centre.xyz);
        const distance = length(offset);
        If(distance.lessThan(centre.w), () => {
          const t = float(1).sub(distance.div(centre.w)).mul(this.#stirB.element(s).x);
          velocity.assign(
            velocity.add(
              vec3(
                offset.x.div(distance.add(0.15)).mul(t),
                t.mul(0.65),
                offset.z.div(distance.add(0.15)).mul(t),
              ),
            ),
          );
        });
      });
      velocity.assign(velocity.add(vec3(0, this.#gravity.negate().mul(dt), 0)));
      if (options.force !== undefined)
        velocity.assign(
          velocity.add(
            (
              options.force(position as never, velocity as never, this.#time as never) as TslNode
            ).mul(dt),
          ),
        );
      velocity.assign(velocity.mul(float(maxSpeed).div(max(length(velocity), maxSpeed))));
      previous.element(i).assign(vec4(position, 1));
      // A single 18 m/s step can cross the dam gate completely. Project along the path, with
      // segments no longer than the particle radius (at most four at the default speed/step).
      const substeps = clamp(
        ceil(length(velocity).mul(dt).div(radius)),
        1,
        Math.max(1, Math.ceil((maxSpeed * timeStep) / radius)),
      )
        .toUint()
        .toVar("fluidSubsteps");
      Loop({ start: uint(0), end: substeps, type: "uint" }, () => {
        position.assign(position.add(velocity.mul(dt).div(float(substeps))));
        project(position);
      });
      positions.element(i).assign(vec4(position, 1));
      velocities.element(i).assign(vec4(velocity, velocities.element(i).w));
    });

    this.#gridClear = computeKernel("fluidParticles.grid.clear", cells, () => {
      If(instanceIndex.greaterThanEqual(uint(cells)), () => {
        Return();
      });
      atomicStore(cellCount.element(instanceIndex), uint(0));
    });
    this.#gridBuild = computeKernel("fluidParticles.grid.build", capacity, () => {
      guard();
      const id = cellId(cellOf(positions.element(instanceIndex).xyz));
      const slot = atomicAdd(cellCount.element(id), uint(1)).toVar();
      If(slot.lessThan(uint(CELL_CAPACITY)), () => {
        cellItems.element(id.mul(CELL_CAPACITY).add(slot)).assign(instanceIndex);
      });
    });

    this.#lambda = computeKernel("fluidParticles.lambda", capacity, () => {
      guard();
      const i = instanceIndex;
      const p = positions.element(i).xyz;
      const rho = nodeVar(float(volumeOfParticle * wSelf));
      const gradient = nodeVar(vec3(0));
      const sum = nodeVar(float(0));
      forNeighbours(p, i, (_other, offset, r2) => {
        rho.addAssign(kernel(r2).mul(volumeOfParticle));
        const r = r2.sqrt();
        If(r.greaterThan(1e-6), () => {
          const a = offset.mul(gradientScale(r));
          gradient.addAssign(a);
          sum.addAssign(dot(a, a));
        });
      });
      densities.element(i).assign(rho);
      const constraint = max(rho.sub(1), 0);
      lambdas
        .element(i)
        .assign(constraint.negate().div(sum.add(dot(gradient, gradient)).add(relaxation)));
    });

    this.#delta = computeKernel("fluidParticles.delta", capacity, () => {
      guard();
      const i = instanceIndex;
      const p = positions.element(i).xyz;
      const own = lambdas.element(i);
      const total = nodeVar(vec3(0));
      forNeighbours(p, i, (other, offset, r2) => {
        const r = r2.sqrt();
        If(r.greaterThan(1e-6), () => {
          const ratio = kernel(r2).div(wReference);
          const tensile = ratio.pow(4).mul(-0.001);
          const strength = own.add(lambdas.element(other)).add(tensile);
          total.addAssign(offset.mul(strength.mul(gradientScale(r))));
        });
      });
      const limit = spacing * 0.24;
      const magnitude = length(total);
      const scale = select(magnitude.greaterThan(limit), float(limit).div(magnitude), float(1));
      deltas.element(i).assign(vec4(total.mul(scale), 0));
    });

    this.#apply = computeKernel("fluidParticles.apply", capacity, () => {
      guard();
      const i = instanceIndex;
      const p = nodeVar(positions.element(i).xyz.add(deltas.element(i).xyz));
      project(p);
      positions.element(i).assign(vec4(p, 1));
    });

    this.#velocity = computeKernel("fluidParticles.velocity", capacity, () => {
      guard();
      const i = instanceIndex;
      const v = positions.element(i).xyz.sub(previous.element(i).xyz).div(dt);
      velocities.element(i).assign(vec4(v, velocities.element(i).w));
    });

    this.#smooth = computeKernel("fluidParticles.smooth", capacity, () => {
      guard();
      const i = instanceIndex;
      const p = positions.element(i).xyz;
      const v = velocities.element(i).xyz;
      const change = nodeVar(vec3(0));
      const curl = nodeVar(vec3(0));
      const neighbours = nodeVar(float(0));
      forNeighbours(p, i, (other, offset, r2) => {
        const w = kernel(r2).mul(volumeOfParticle);
        const dv = velocities.element(other).xyz.sub(v);
        change.addAssign(
          dv.mul(this.#viscosity.mul(w)).sub(offset.mul(this.#cohesion.mul(w).mul(dt).mul(8))),
        );
        neighbours.addAssign(1);
        const r = r2.sqrt();
        If(r.greaterThan(1e-6), () => {
          const s = gradientScale(r);
          curl.addAssign(
            vec3(
              dv.y.mul(offset.z).sub(dv.z.mul(offset.y)),
              dv.z.mul(offset.x).sub(dv.x.mul(offset.z)),
              dv.x.mul(offset.y).sub(dv.y.mul(offset.x)),
            ).mul(s),
          );
        });
      });
      deltas.element(i).assign(vec4(change, 0));
      omega.element(i).assign(vec4(curl, neighbours));
    });

    this.#confine = computeKernel("fluidParticles.confine", capacity, () => {
      guard();
      const i = instanceIndex;
      const p = positions.element(i).xyz;
      const own = length(omega.element(i).xyz);
      const eta = nodeVar(vec3(0));
      forNeighbours(p, i, (other, offset, r2) => {
        const r = r2.sqrt();
        If(r.greaterThan(1e-6), () => {
          const diff = length(omega.element(other).xyz).sub(own);
          eta.addAssign(offset.mul(gradientScale(r).mul(diff)));
        });
      });
      const w = omega.element(i).xyz;
      const scale = this.#vorticity.mul(dt).div(length(eta).add(1e-5));
      const force = vec3(
        eta.y.mul(w.z).sub(eta.z.mul(w.y)),
        eta.z.mul(w.x).sub(eta.x.mul(w.z)),
        eta.x.mul(w.y).sub(eta.y.mul(w.x)),
      ).mul(scale);
      const limited = clamp(force, vec3(-0.15), vec3(0.15));
      const v = nodeVar(
        velocities
          .element(i)
          .xyz.add(deltas.element(i).xyz)
          .add(select(this.#vorticity.greaterThan(0), limited, vec3(0))),
      );
      const position = positions.element(i).xyz;
      If(position.y.lessThanEqual(min3[1] + 0.002), () => {
        v.assign(vec3(v.x.mul(1 - wallFriction), v.y, v.z.mul(1 - wallFriction)));
      });
      v.assign(v.mul(float(maxSpeed).div(max(length(v), maxSpeed))));
      const speed = length(v);
      const source = clamp(speed.sub(1.5).mul(0.14), 0, 1).mul(
        select(omega.element(i).w.lessThan(22), float(1), float(0.2)),
      );
      const foam = max(velocities.element(i).w.mul(exp(dt.mul(-1.3))), source);
      velocities.element(i).assign(vec4(v, foam));
      atomicAdd(stats.element(0), uint(1));
      atomicAdd(stats.element(1), uint(max(densities.element(i).sub(1), 0).mul(COMPRESSION_SCALE)));
      atomicMax(stats.element(2), uint(speed.mul(FIXED_POINT)));
      for (let axis = 0; axis < 3; axis += 1) {
        const offset = uint(
          max(
            [position.x, position.y, position.z][axis]?.sub(min3[axis] as number).add(1) as TslNode,
            0,
          ).mul(FIXED_POINT),
        );
        atomicMin(stats.element(3 + axis), offset);
        atomicMax(stats.element(6 + axis), offset);
      }
    });

    this.#statsClear = computeKernel("fluidParticles.stats.clear", STAT_WORDS, () => {
      If(instanceIndex.greaterThanEqual(uint(STAT_WORDS)), () => {
        Return();
      });
      const word = instanceIndex;
      atomicStore(
        stats.element(word),
        select(word.greaterThanEqual(3).and(word.lessThan(6)), uint(0xffffffff), uint(0)),
      );
    });
    this.#statsFinalize = computeKernel("fluidParticles.stats.finalize", STAT_WORDS, () => {
      If(instanceIndex.greaterThanEqual(uint(STAT_WORDS)), () => {
        Return();
      });
      const word = instanceIndex;
      const count = float(atomicLoad(stats.element(0)));
      const raw = float(atomicLoad(stats.element(word)));
      const axis = word.sub(3).mod(3);
      const base = select(
        axis.equal(0),
        float(min3[0]),
        select(axis.equal(1), float(min3[1]), float(min3[2])),
      );
      const spatial = select(count.lessThan(0.5), float(0), raw.div(FIXED_POINT).sub(1).add(base));
      const value = select(
        word.equal(0),
        raw,
        select(
          word.equal(1),
          raw.div(COMPRESSION_SCALE).div(max(count, 1)),
          select(word.equal(2), raw.div(FIXED_POINT), spatial),
        ),
      );
      readout.element(word).assign(value);
    });

    this.#volume = computeKernel("fluidParticles.volume", voxels, () => {
      If(instanceIndex.greaterThanEqual(uint(voxels)), () => {
        Return();
      });
      const ix = instanceIndex.mod(uint(vx));
      const iy = instanceIndex.div(uint(vx)).mod(uint(vy));
      const iz = instanceIndex.div(uint(vx * vy));
      const centre = vec3(float(ix), float(iy), float(iz))
        .add(0.5)
        .mul(voxelSize)
        .add(vec3(...min3));
      const total = nodeVar(float(0));
      forNeighbours(centre, uint(0xffffffff), (_other, _offset, r2) => {
        total.addAssign(kernel(r2).mul(volumeOfParticle));
      });
      volumeBuffer.element(instanceIndex).assign(total);
      textureStore(
        storageTexture(this.density).toWriteOnly(),
        uvec3(ix, iy, iz),
        vec4(total, 0, 0, 1),
      ).toWriteOnly();
    });

    /** Is `point` inside any collider? Used to tell a column roofed by a body from open water. */
    const insideCollider = (point: TslNode): TslNode => {
      const inside = nodeVar(float(0));
      Loop({ start: uint(0), end: this.#colliderCount, type: "uint" }, ({ i }: { i: TslNode }) => {
        const a = this.#colliderA.element(i);
        const b = this.#colliderB.element(i);
        const offset = point.sub(a.xyz);
        If(a.w.lessThan(0.5), () => {
          If(length(offset).lessThan(b.x), () => {
            inside.assign(float(1));
          });
        }).Else(() => {
          const rows = this.#colliderRows.map((row) => row.element(i).xyz);
          const local = abs(
            vec3(
              dot(rows[0] as TslNode, offset),
              dot(rows[1] as TslNode, offset),
              dot(rows[2] as TslNode, offset),
            ),
          );
          If(local.x.lessThan(b.x).and(local.y.lessThan(b.y)).and(local.z.lessThan(b.z)), () => {
            inside.assign(float(1));
          });
        });
      });
      return inside;
    };

    this.#columnHeights = computeKernel("fluidParticles.columns", vx * vz, () => {
      If(instanceIndex.greaterThanEqual(uint(vx * vz)), () => {
        Return();
      });
      const ix = instanceIndex.mod(uint(vx));
      const iz = instanceIndex.div(uint(vx));
      const top = nodeVar(float(min3[1]));
      const topLayer = nodeVar(int(-1));
      Loop({ start: int(0), end: int(vy), type: "int" }, ({ i: layer }: { i: TslNode }) => {
        const voxel = ix.add(uint(layer).mul(uint(vx))).add(iz.mul(uint(vx * vy)));
        If(volumeBuffer.element(voxel).greaterThan(0.5), () => {
          top.assign(float(layer).add(1).mul(voxelSize).add(min3[1]));
          topLayer.assign(layer);
        });
      });
      // A body on the column displaces its water: what is left under it is the hull's underside
      // (or the bare floor), not the free surface. Flag such a column so `sample` reads its
      // neighbours. `topLayer + 1` is the first voxel above the water, or the floor when dry.
      const covered = nodeVar(float(0));
      for (const above of [0, 1, 2]) {
        const centre = vec3(
          float(ix).add(0.5).mul(voxelSize).add(min3[0]),
          float(topLayer.add(1 + above))
            .add(0.5)
            .mul(voxelSize)
            .add(min3[1]),
          float(iz).add(0.5).mul(voxelSize).add(min3[2]),
        );
        If(insideCollider(centre).greaterThan(0.5), () => {
          covered.assign(float(1));
        });
      }
      readout
        .element(uint(READOUT_HEADER).add(instanceIndex))
        .assign(select(covered.greaterThan(0.5), float(COVERED), top));
    });

    this.#readback = new GPUReadback({ attribute: readout.value, everyFrames: readbackEvery });
    this.warmupNodes = [
      this.#inject,
      this.#predict,
      this.#gridClear,
      this.#gridBuild,
      this.#lambda,
      this.#delta,
      this.#apply,
      this.#velocity,
      this.#smooth,
      this.#confine,
      this.#statsClear,
      this.#statsFinalize,
      this.#volume,
      this.#columnHeights,
    ];
    this.addEventListener("removed", this.#onRemoved);
  }

  get released(): boolean {
    return this.#released;
  }

  /** Slots handed out so far; never above `capacity`. */
  get used(): number {
    return this.#used;
  }

  get steps(): number {
    return this.#steps;
  }

  get viscosity(): number {
    return this.#viscosity.value;
  }

  set viscosity(value: number) {
    nonNegative("viscosity", value);
    this.#viscosity.value = value;
  }

  get cohesion(): number {
    return this.#cohesion.value;
  }

  set cohesion(value: number) {
    nonNegative("cohesion", value);
    this.#cohesion.value = value;
  }

  get vorticity(): number {
    return this.#vorticity.value;
  }

  set vorticity(value: number) {
    nonNegative("vorticity", value);
    this.#vorticity.value = value;
  }

  get gravity(): number {
    return this.#gravity.value;
  }

  set gravity(value: number) {
    nonNegative("gravity", value);
    this.#gravity.value = value;
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("FluidParticles3D cannot be attached after release.");
    if (this.#renderer === renderer) return;
    if (renderer.kind !== "webgpu")
      throw new Error(
        "FluidParticles3D needs a WebGPU renderer: the solver is compute-only and would draw nothing on this backend.",
      );
    if (this.#renderer !== undefined)
      throw new Error("FluidParticles3D is already attached to a renderer.");
    this.#renderer = renderer;
  }

  /**
   * Place a lattice of particles in `[min, max]`, one per `spacing`, and return how many fit.
   * Particles never wrap: a full solver places none.
   */
  fill(min: Vec3, max: Vec3, velocity: Vec3 = [0, 0, 0]): number {
    this.#assertLive("fill");
    finiteVec("fill.min", min, 3);
    finiteVec("fill.max", max, 3);
    finiteVec("fill.velocity", velocity, 3);
    const dims = [0, 1, 2].map(
      (axis) =>
        Math.floor(((max[axis] as number) - (min[axis] as number)) / this.spacing + 1e-6) + 1,
    ) as [number, number, number];
    if (dims.some((dim) => dim < 1)) throw new Error("FluidParticles3D.fill needs max >= min.");
    const wanted = dims[0] * dims[1] * dims[2];
    const room = this.capacity - this.#cursor;
    const placed = Math.min(wanted, room);
    if (placed <= 0 || this.#queuedSpawns >= this.maxSpawns) return 0;
    this.#queueSpawn(min, dims, placed, velocity, this.spacing);
    this.#cursor += placed;
    this.#used = Math.min(this.#cursor, this.capacity);
    return placed;
  }

  /** Spawn one particle. Once every slot has been used the oldest slot is recycled. */
  emit(position: Vec3, velocity: Vec3 = [0, 0, 0]): boolean {
    this.#assertLive("emit");
    finiteVec("emit.position", position, 3);
    finiteVec("emit.velocity", velocity, 3);
    if (this.#queuedSpawns >= this.maxSpawns) return false;
    const slot = this.#cursor % this.capacity;
    this.#queueSpawn(position, [1, 1, 1], 1, velocity, 1, slot);
    this.#cursor += 1;
    this.#used = Math.min(this.#cursor, this.capacity);
    return true;
  }

  /** Free every live particle inside the box on the next step. */
  drain(min: Vec3, max: Vec3): boolean {
    this.#assertLive("drain");
    finiteVec("drain.min", min, 3);
    finiteVec("drain.max", max, 3);
    if (this.#queuedDrains >= MAX_DRAINS) return false;
    (this.#drainMin.array[this.#queuedDrains] as Vector4).set(min[0], min[1], min[2], 0);
    (this.#drainMax.array[this.#queuedDrains] as Vector4).set(max[0], max[1], max[2], 0);
    this.#queuedDrains += 1;
    return true;
  }

  /** Push particles within `radius` of `point` outward and up, strongest at the centre. */
  stir(point: Vec3, strength: number, radius: number): boolean {
    this.#assertLive("stir");
    finiteVec("stir.point", point, 3);
    positive("stir.radius", radius);
    if (!Number.isFinite(strength))
      throw new Error("FluidParticles3D.stir.strength must be finite.");
    if (this.#queuedStirs >= MAX_STIRS) return false;
    (this.#stirA.array[this.#queuedStirs] as Vector4).set(point[0], point[1], point[2], radius);
    (this.#stirB.array[this.#queuedStirs] as Vector4).set(strength, 0, 0, 0);
    this.#queuedStirs += 1;
    return true;
  }

  /** Replace the colliders. Call it every fixed step with the bodies' current transforms. */
  setColliders(colliders: readonly IFluidCollider[]): void {
    this.#assertLive("setColliders");
    if (colliders.length > this.maxColliders)
      throw new Error(`FluidParticles3D.setColliders accepts at most ${this.maxColliders}.`);
    // Validate every collider before writing any, so a throw leaves the previous set intact.
    const rows = colliders.map((collider) => {
      finiteVec("collider.center", collider.center, 3);
      if (collider.kind === "sphere") {
        positive("collider.radius", collider.radius);
        return undefined;
      }
      finiteVec("collider.halfExtents", collider.halfExtents, 3);
      if (collider.halfExtents.some((half) => half <= 0))
        throw new Error("FluidParticles3D.collider.halfExtents must be positive.");
      return basisRows(collider.rotation ?? [0, 0, 0, 1]);
    });
    colliders.forEach((collider, index) => {
      const a = this.#colliderA.array[index] as Vector4;
      const b = this.#colliderB.array[index] as Vector4;
      if (collider.kind === "sphere") {
        a.set(...collider.center, 0);
        b.set(collider.radius, 0, 0, collider.radius);
        return;
      }
      a.set(...collider.center, 1);
      b.set(...collider.halfExtents, new Vector3(...collider.halfExtents).length());
      (rows[index] as readonly Vec3[]).forEach((row, axis) =>
        (this.#colliderRows[axis]?.array[index] as Vector4).set(row[0], row[1], row[2], 0),
      );
    });
    this.#colliders = colliders.length;
  }

  /**
   * Free-surface height near `(x, z)`, box-filtered over open columns of the newest landed GPU
   * copy; `bounds.min.y` where no water is near or nothing has landed yet. Shaped for `Buoyancy3D`'s `surface`.
   */
  sample(x: number, z: number, _time = 0): { readonly height: number } {
    const data = this.#readback.data;
    const floor = this.bounds.min[1];
    if (
      data === undefined ||
      x < this.bounds.min[0] ||
      x > this.bounds.max[0] ||
      z < this.bounds.min[2] ||
      z > this.bounds.max[2]
    )
      return { height: floor };
    const [columns, rows] = this.#columns;
    const minimumOpen = Math.min(MIN_OPEN_COLUMNS, columns * rows);
    const cx = Math.round(
      clampNumber((x - this.bounds.min[0]) / this.voxelSize - 0.5, 0, columns - 1),
    );
    const cz = Math.round(
      clampNumber((z - this.bounds.min[2]) / this.voxelSize - 0.5, 0, rows - 1),
    );
    // A box-filter over the open columns near the point: splash noise averages out, and a column
    // roofed by a body (flagged COVERED) is read through the open water around it, widening until
    // enough of it is found.
    for (let radius = SURFACE_FILTER; radius <= COVERED_SEARCH; radius += 1) {
      let sum = 0;
      let found = 0;
      for (let pz = Math.max(0, cz - radius); pz <= Math.min(rows - 1, cz + radius); pz += 1)
        for (let px = Math.max(0, cx - radius); px <= Math.min(columns - 1, cx + radius); px += 1) {
          const value = data[READOUT_HEADER + px + pz * columns] ?? COVERED;
          if (value > COVERED / 2) {
            sum += value;
            found += 1;
          }
        }
      if (found >= minimumOpen) return { height: sum / found };
    }
    return { height: floor };
  }

  /** Surface height at `(x, z)`; see {@link sample}. */
  heightAt(x: number, z: number): number {
    return this.sample(x, z).height;
  }

  /**
   * Fixed steps between the GPU state the newest copy holds and now; grows until the first copy
   * lands. `sample` and `heightAt` read the same copy, so this is their age too.
   */
  get staleFrames(): number {
    return this.#readback.staleFrames;
  }

  /** Counts and extremes from the newest landed GPU copy, or `undefined` before one lands. */
  get stats(): IFluidParticlesStats | undefined {
    const sample = this.#readback.sample;
    if (sample === undefined) return undefined;
    const d = sample.data;
    return {
      count: d[0] ?? 0,
      meanCompression: d[1] ?? 0,
      maxSpeed: d[2] ?? 0,
      min: [d[3] ?? 0, d[4] ?? 0, d[5] ?? 0],
      max: [d[6] ?? 0, d[7] ?? 0, d[8] ?? 0],
      staleFrames: sample.staleFrames,
    };
  }

  process(renderer = this.#renderer): void {
    if (this.#released) return;
    if (renderer === undefined) throw new Error("FluidParticles3D is not attached to a renderer.");
    this.#time.value += this.timeStep;
    this.#slots.value = this.#used;
    this.#spawnCount.value = this.#queuedSpawns;
    this.#drainCount.value = this.#queuedDrains;
    this.#stirCount.value = this.#queuedStirs;
    this.#colliderCount.value = this.#colliders;
    if (this.#queuedSpawns > 0 || this.#queuedDrains > 0) renderer.compute(this.#inject);
    this.#queuedSpawns = 0;
    this.#queuedDrains = 0;
    if (this.#used > 0) {
      renderer.compute(this.#predict);
      for (let iteration = 0; iteration < this.iterations; iteration += 1) {
        renderer.compute(this.#gridClear);
        renderer.compute(this.#gridBuild);
        renderer.compute(this.#lambda);
        renderer.compute(this.#delta);
        renderer.compute(this.#apply);
      }
      renderer.compute(this.#gridClear);
      renderer.compute(this.#gridBuild);
      renderer.compute(this.#velocity);
      renderer.compute(this.#statsClear);
      renderer.compute(this.#smooth);
      renderer.compute(this.#confine);
      renderer.compute(this.#statsFinalize);
      renderer.compute(this.#volume);
      renderer.compute(this.#columnHeights);
    }
    this.#queuedStirs = 0;
    this.#steps += 1;
    this.#readback.request(renderer);
  }

  detach(): void {
    if (this.#released) return;
    this.#renderer = undefined;
    for (const node of this.warmupNodes) node.dispose();
    this.density.dispose();
    for (const buffer of this.#buffers) buffer.value.dispose();
    this.#readback.dispose();
    this.#released = true;
  }

  #queueSpawn(
    first: Vec3,
    dims: Vec3,
    count: number,
    velocity: Vec3,
    spacing: number,
    slot = this.#cursor % this.capacity,
  ): void {
    const index = this.#queuedSpawns;
    (this.#spawnA.array[index] as Vector4).set(first[0], first[1], first[2], slot);
    (this.#spawnB.array[index] as Vector4).set(dims[0], dims[1], dims[2], count);
    (this.#spawnC.array[index] as Vector4).set(velocity[0], velocity[1], velocity[2], spacing);
    this.#queuedSpawns += 1;
  }

  #assertLive(name: string): void {
    if (this.#released) throw new Error(`FluidParticles3D cannot ${name} after release.`);
  }

  #onRemoved = (): void => {
    if (this.#renderer !== undefined) this.detach();
  };
}

function clampNumber(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
