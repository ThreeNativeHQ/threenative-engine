import { Box3, type Camera, Frustum, Matrix4, Sphere, Sprite, Vector3 } from "three";
import type { Node, UniformNode } from "three/src/nodes/Nodes.js";
import {
  Fn,
  If,
  Loop,
  deltaTime,
  instanceIndex,
  instancedArray,
  max,
  min,
  time,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import type { ComputeNode, SpriteNodeMaterial, StorageBufferNode } from "three/webgpu";
import type { IComputeDriven } from "./compute-driven.js";
import { GPUReadback } from "./gpu-readback.js";
import type { IBudgetCandidate } from "./particle-significance.js";
import type { IRendererLike } from "./renderer.js";

/** A slot that was never spawned: far enough in the past that every age reads as "dead". */
const DEAD_BIRTH = -1e6;

export interface IGPUParticles3DBuffers {
  readonly positions: StorageBufferNode<"vec3">;
  readonly velocities: StorageBufferNode<"vec3">;
  /** Emitter-clock second of each slot's last spawn. Present only when `spawn` is given. */
  readonly births?: StorageBufferNode<"float">;
}

/** The engine clock, as TSL nodes, handed to `process` as its second argument. */
export interface IGPUParticles3DRuntime {
  readonly time: Node<"float">;
  readonly delta: Node<"float">;
}

/** Engine-owned uniforms for one `emitParticle` call. The slot is `(first + instanceIndex) % amount`. */
export interface IGPUParticles3DSpawnRequest {
  readonly first: UniformNode<"uint", number>;
  readonly count: UniformNode<"uint", number>;
  readonly origin: UniformNode<"vec3", Vector3>;
  readonly direction: UniformNode<"vec3", Vector3>;
  readonly seed: UniformNode<"float", number>;
  readonly time: Node<"float">;
}

/** Buffers a spawn-driven emitter's kernels receive: `births` always exists. */
export interface IGPUParticles3DSpawnBuffers extends IGPUParticles3DBuffers {
  readonly births: StorageBufferNode<"float">;
}

interface IGPUParticles3DBaseOptions {
  readonly amount: number;
  readonly material: SpriteNodeMaterial;
  /** World space when `spawn` is given, emitter space otherwise. */
  readonly localCoords?: boolean;
  /**
   * Override the local bounds from frame zero and skip GPU measurement.
   * @situation Supply known bounds for a particle cloud.
   * @constraint Must be a finite, non-empty box in the emitter's local space.
   */
  readonly bounds?: Box3;
  /**
   * Metres added around the world box. Defaults to half the largest world scale.
   * @situation Cover the sprite quad; name padding when the material uses scaleNode.
   * @constraint Must be finite and non-negative, in world metres.
   */
  readonly padding?: number;
  /**
   * Keep buffers on pause, or restart on return with clear. Defaults to pause.
   * @situation Choose whether a returning effect continues or starts again.
   * @constraint Must be pause or clear.
   */
  readonly onCull?: "pause" | "clear";
  /**
   * Seconds continuously outside the view before culling. Defaults to 1.
   * @situation Avoid toggling effects near the view edge; Infinity disables view culling.
   * @constraint Must be non-negative; Infinity is allowed.
   */
  readonly graceSeconds?: number;
  /**
   * Frames between GPU bounds measurements. Defaults to 8.
   * @situation Trade readback cost for a delayed view of the cloud bounds.
   * @constraint Must be a positive integer; paused emitters do not measure.
   */
  readonly boundsEveryFrames?: number;
}

/** The closed-form tier: every particle is a function of time, `start` seeds the buffers. */
export interface IGPUParticles3DClosedFormOptions extends IGPUParticles3DBaseOptions {
  readonly start: (buffers: IGPUParticles3DBuffers) => ComputeNode;
  readonly process: (
    buffers: IGPUParticles3DBuffers,
    runtime: IGPUParticles3DRuntime,
  ) => ComputeNode;
  readonly spawn?: undefined;
  readonly lifetime?: undefined;
  readonly maxSpawnPerFrame?: undefined;
}

/** The spawn tier: a burst is a request, and the engine owns the slots and the birth stamps. */
export interface IGPUParticles3DSpawnOptions extends IGPUParticles3DBaseOptions {
  /** Optional here: the engine already resets every birth. */
  readonly start?: (buffers: IGPUParticles3DSpawnBuffers) => ComputeNode;
  readonly process: (
    buffers: IGPUParticles3DSpawnBuffers,
    runtime: IGPUParticles3DRuntime,
  ) => ComputeNode;
  /**
   * Writes one burst. Dispatched over `amount` threads per `emitParticle`: a thread with
   * `instanceIndex >= request.count` returns at once. ponytail: costs `amount` threads per emit;
   * upgrade to an indirect dispatch of `count` threads if `amount` passes about 100,000.
   */
  readonly spawn: (
    buffers: IGPUParticles3DSpawnBuffers,
    request: IGPUParticles3DSpawnRequest,
  ) => ComputeNode;
  /** Game-owned longest life in seconds. Lets `stats.recycledLive` count slots recycled while alive. */
  readonly lifetime?: number;
  /** Cap on particles spawned between two `process` calls. Defaults to `amount`. */
  readonly maxSpawnPerFrame?: number;
}

export type IGPUParticles3DOptions = IGPUParticles3DClosedFormOptions | IGPUParticles3DSpawnOptions;

export interface IEmitParticleRequest {
  readonly count?: number;
  readonly origin?: { readonly x: number; readonly y: number; readonly z: number };
  readonly direction?: { readonly x: number; readonly y: number; readonly z: number };
  readonly seed?: number;
}

export interface IGPUParticles3DStats {
  /** Particles requested but not spawned (over `amount` or over `maxSpawnPerFrame`). */
  readonly clamped: number;
  /** Particles spawned. */
  readonly spawned: number;
  /** Live slots overwritten by the ring. `undefined` without the `lifetime` option, never `0`. */
  readonly recycledLive: number | undefined;
}

const LANES = 256;
const worldBox = new Box3();
const viewProjection = new Matrix4();
const frustum = new Frustum();
const sphere = new Sphere();
const cameraPosition = new Vector3();

/** Fold GPU lane extrema into local bounds; reject missing or non-finite samples. */
export function foldBounds(data: Float32Array): Box3 | undefined {
  if (data.length === 0 || data.length % 8 !== 0 || !data.every(Number.isFinite)) return undefined;
  const lanes = data.length / 8;
  const box = new Box3();
  for (let lane = 0; lane < lanes; lane += 1) {
    const lo = lane * 4;
    const hi = (lane + lanes) * 4;
    const lowX = data[lo];
    const highX = data[hi];
    if (lowX === undefined || highX === undefined) return undefined;
    if (lowX > highX) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      const low = data[lo + axis];
      const high = data[hi + axis];
      if (low === undefined || high === undefined) return undefined;
      box.min.setComponent(axis, Math.min(box.min.getComponent(axis), low));
      box.max.setComponent(axis, Math.max(box.max.getComponent(axis), high));
    }
  }
  return box.isEmpty() ? undefined : box;
}

function computeNode(name: string, value: unknown): ComputeNode {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { isComputeNode?: unknown }).isComputeNode !== true
  ) {
    throw new Error(`GPUParticles3D.${name} must return a TSL compute node.`);
  }
  return value as ComputeNode;
}

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new Error(`GPUParticles3D.${name} must be a finite number.`);
  return value;
}

function setVector(
  uniformNode: UniformNode<"vec3", Vector3>,
  name: string,
  v: { readonly x: number; readonly y: number; readonly z: number } | undefined,
): void {
  const target = uniformNode.value as Vector3;
  if (v === undefined) return void target.set(0, 0, 0);
  target.set(finite(`${name}.x`, v.x), finite(`${name}.y`, v.y), finite(`${name}.z`, v.z));
}

interface ISpawnState {
  readonly births: StorageBufferNode<"float">;
  readonly request: IGPUParticles3DSpawnRequest;
  readonly spawn: ComputeNode;
  readonly stamp: ComputeNode;
  readonly reset: ComputeNode;
}

export class GPUParticles3D extends Sprite implements IComputeDriven {
  readonly amount: number;
  readonly buffers: IGPUParticles3DBuffers;
  readonly processCadence = "render" as const;
  readonly warmupNodes: readonly ComputeNode[];
  readonly localCoords: boolean;
  emitting = true;
  #start: ComputeNode | undefined;
  #process: ComputeNode;
  #spawn: ISpawnState | undefined;
  #renderer: IRendererLike | undefined;
  #released = false;
  #lifetime: number | undefined;
  #maxPerFrame: number;
  #cursor = 0;
  #spawnedThisFrame = 0;
  #seed = 0;
  #clamped = 0;
  #spawned = 0;
  #recycledLive = 0;
  #warned = false;
  /** Recent requests: wall-clock second, first ring sequence number, count. Pruned past `lifetime`. */
  #log: { at: number; first: number; count: number }[] = [];
  readonly #boundsOverride: Box3 | undefined;
  #measuredBounds: Box3 | undefined;
  readonly #padding: number | undefined;
  readonly #onCull: "pause" | "clear";
  #graceSeconds = 1;
  readonly #boundsEveryFrames: number;
  readonly #partials: StorageBufferNode<"vec4"> | undefined;
  readonly #reduce: ComputeNode | undefined;
  #readback: GPUReadback | undefined;
  #frame = 0;
  #lastMeasure = 0;
  #lands = 0;
  #dispatches = 0;
  #outsideSince: number | undefined;
  #authoredVisible = true;
  #hiddenByCull = false;
  #yielded = false;
  #state: "running" | "paused" | "cleared" = "running";
  #reason: "outside-view" | "over-budget" | undefined;
  #transitions = 0;

  /** Cooperate with measured frame-budget shedding without changing particle storage. */
  readonly budget: IBudgetCandidate = {
    significance: (camera) => {
      if (
        this.#released ||
        !this.emitting ||
        !this.#authoredVisible ||
        this.castShadow ||
        this.#reason === "outside-view"
      )
        return undefined;
      this.updateWorldMatrix(true, false);
      if (camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
      if (this.measuredBounds === undefined) {
        sphere.center.setFromMatrixPosition(this.matrixWorld);
        sphere.radius = 0;
      } else {
        this.measuredBounds.getBoundingSphere(sphere).applyMatrix4(this.matrixWorld);
      }
      cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      return (
        (sphere.radius + this.#worldPadding) /
        Math.max(sphere.center.distanceTo(cameraPosition), 1e-3)
      );
    },
    yield: (yielded) => {
      this.#yielded = yielded;
    },
  };

  constructor(options: IGPUParticles3DOptions) {
    if (!Number.isInteger(options.amount) || options.amount <= 0)
      throw new Error("GPUParticles3D.amount must be a positive integer.");
    if (options.material === undefined) throw new Error("GPUParticles3D.material is required.");
    if (options.spawn !== undefined && typeof options.spawn !== "function")
      throw new Error("GPUParticles3D.spawn must be a function.");
    if (options.start !== undefined || options.spawn === undefined) {
      if (typeof options.start !== "function")
        throw new Error("GPUParticles3D.start must be a function.");
    }
    if (typeof options.process !== "function")
      throw new Error("GPUParticles3D.process must be a function.");
    if (options.lifetime !== undefined && !(options.lifetime > 0))
      throw new Error("GPUParticles3D.lifetime must be a positive number.");
    const maxPerFrame = options.maxSpawnPerFrame ?? options.amount;
    if (!Number.isInteger(maxPerFrame) || maxPerFrame <= 0)
      throw new Error("GPUParticles3D.maxSpawnPerFrame must be a positive integer.");
    const boundsEveryFrames = options.boundsEveryFrames ?? 8;
    if (!Number.isInteger(boundsEveryFrames) || boundsEveryFrames <= 0)
      throw new Error("GPUParticles3D.boundsEveryFrames must be a positive integer.");
    if (options.padding !== undefined && (!Number.isFinite(options.padding) || options.padding < 0))
      throw new Error("GPUParticles3D.padding must be finite and non-negative.");
    if (options.onCull !== undefined && options.onCull !== "pause" && options.onCull !== "clear")
      throw new Error("GPUParticles3D.onCull must be pause or clear.");
    if (
      options.bounds !== undefined &&
      (options.bounds.isBox3 !== true ||
        options.bounds.isEmpty() ||
        ![...options.bounds.min.toArray(), ...options.bounds.max.toArray()].every(Number.isFinite))
    )
      throw new Error("GPUParticles3D.bounds must be a finite, non-empty Box3.");
    super(options.material);
    // Separate authored visibility from culling so a game hide while culled survives recovery.
    Object.defineProperty(this, "visible", {
      configurable: true,
      enumerable: true,
      get: () => this.#authoredVisible && !this.#hiddenByCull,
      set: (visible: boolean) => {
        this.#authoredVisible = visible;
      },
    });
    this.#boundsOverride = options.bounds;
    this.#padding = options.padding;
    this.#onCull = options.onCull ?? "pause";
    this.graceSeconds = options.graceSeconds ?? 1;
    this.#boundsEveryFrames = boundsEveryFrames;
    this.amount = options.amount;
    this.#lifetime = options.lifetime;
    this.#maxPerFrame = maxPerFrame;
    const positions = instancedArray(options.amount, "vec3");
    const velocities = instancedArray(options.amount, "vec3");
    const births =
      options.spawn === undefined ? undefined : instancedArray(options.amount, "float");
    this.buffers =
      births === undefined ? { positions, velocities } : { positions, velocities, births };
    options.material.positionNode = this.buffers.positions.toAttribute();
    this.count = options.amount;
    // Three tests a Sprite as a unit quad, ignoring the particle cloud.
    this.frustumCulled = false;
    this.localCoords = options.localCoords ?? options.spawn === undefined;
    if (!this.localCoords) {
      // Buffer positions are world positions: no parent may move a live particle.
      this.matrixAutoUpdate = false;
      this.matrixWorldAutoUpdate = false;
      this.matrixWorld.identity();
    }
    this.#start =
      options.start === undefined
        ? undefined
        : computeNode(
            "start",
            (options.start as (b: IGPUParticles3DBuffers) => ComputeNode)(this.buffers),
          );
    this.#process = computeNode(
      "process",
      (options.process as (b: IGPUParticles3DBuffers, r: IGPUParticles3DRuntime) => ComputeNode)(
        this.buffers,
        { time: time as Node<"float">, delta: deltaTime as Node<"float"> },
      ),
    );
    if (options.spawn !== undefined && births !== undefined)
      this.#spawn = this.#buildSpawn(options.spawn, births);
    if (options.bounds === undefined) {
      const partials = instancedArray(2 * LANES, "vec4");
      const positions = this.buffers.positions;
      const amount = this.amount;
      this.#partials = partials;
      this.#reduce = Fn(() => {
        const lo = vec3(1e30).toVar();
        const hi = vec3(-1e30).toVar();
        Loop({ start: instanceIndex, end: amount, type: "uint", update: LANES }, ({ i }) => {
          const position = positions.element(i);
          lo.assign(min(lo, position));
          hi.assign(max(hi, position));
        });
        partials.element(instanceIndex).assign(vec4(lo, 0));
        partials.element(instanceIndex.add(LANES)).assign(vec4(hi, 0));
      })().compute(LANES);
      this.#readback = new GPUReadback({ attribute: partials.value, everyFrames: 1 });
    }
    this.warmupNodes = [
      ...(this.#start === undefined ? [] : [this.#start]),
      ...(this.#spawn === undefined
        ? []
        : [this.#spawn.reset, this.#spawn.stamp, this.#spawn.spawn]),
      this.#process,
      ...(this.#reduce === undefined ? [] : [this.#reduce]),
    ];
    this.addEventListener("removed", this.#onRemoved);
  }

  #buildSpawn(
    spawn: IGPUParticles3DSpawnOptions["spawn"],
    births: StorageBufferNode<"float">,
  ): ISpawnState {
    const amount = this.amount;
    const request: IGPUParticles3DSpawnRequest = {
      first: uniform(0, "uint"),
      count: uniform(0, "uint"),
      origin: uniform(new Vector3()),
      direction: uniform(new Vector3()),
      seed: uniform(0),
      time: time as Node<"float">,
    };
    const stamp = Fn(() => {
      If(instanceIndex.lessThan(request.count), () => {
        births.element(request.first.add(instanceIndex).mod(uint(amount))).assign(time);
      });
    })().compute(amount);
    const reset = Fn(() => {
      births.element(instanceIndex).assign(DEAD_BIRTH);
    })().compute(amount);
    return {
      births,
      request,
      reset,
      spawn: computeNode("spawn", spawn({ ...this.buffers, births }, request)),
      stamp,
    };
  }

  get released(): boolean {
    return this.#released;
  }

  get stats(): IGPUParticles3DStats {
    return {
      clamped: this.#clamped,
      recycledLive: this.#lifetime === undefined ? undefined : this.#recycledLive,
      spawned: this.#spawned,
    };
  }

  /** Seconds outside view before culling; Infinity disables it at runtime. */
  get graceSeconds(): number {
    return this.#graceSeconds;
  }

  set graceSeconds(value: number) {
    if ((!Number.isFinite(value) && value !== Number.POSITIVE_INFINITY) || value < 0)
      throw new Error("GPUParticles3D.graceSeconds must be non-negative.");
    this.#graceSeconds = value;
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("GPUParticles3D cannot be attached after release.");
    if (this.#renderer === renderer) return;
    this.#renderer = renderer;
    this.#runStart(renderer);
  }

  /** The override or newest landed local bounds; absent until a valid sample lands. */
  get measuredBounds(): Box3 | undefined {
    return this.#boundsOverride ?? this.#measuredBounds;
  }

  /** Simulation compute calls, excluding starts and bounds reduction. */
  get dispatches(): number {
    return this.#dispatches;
  }

  /** Current cull state and the number of state changes. */
  get cull(): {
    readonly state: "running" | "paused" | "cleared";
    readonly reason: "outside-view" | "over-budget" | undefined;
    readonly transitions: number;
  } {
    return { state: this.#state, reason: this.#reason, transitions: this.#transitions };
  }

  get #worldPadding(): number {
    return this.#padding ?? 0.5 * this.matrixWorld.getMaxScaleOnAxis();
  }

  process(
    renderer = this.#renderer,
    camera?: Camera,
    _covered?: boolean,
    _view?: undefined,
    simulatedSeconds?: number,
  ): void {
    if (this.#released || !this.emitting) return;
    if (renderer === undefined) throw new Error("GPUParticles3D is not attached to a renderer.");
    let readback = this.#readback;
    if (readback !== undefined && readback.stats.lands !== this.#lands) {
      this.#lands = readback.stats.lands;
      this.#measuredBounds = readback.data === undefined ? undefined : foldBounds(readback.data);
    }
    let reason: "outside-view" | "over-budget" | undefined;
    if (camera !== undefined && !this.castShadow && this.#authoredVisible) {
      const bounds = this.measuredBounds;
      if (bounds !== undefined && this.#graceSeconds !== Number.POSITIVE_INFINITY) {
        if (camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
        this.updateWorldMatrix(true, false);
        viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(
          viewProjection,
          camera.coordinateSystem,
          camera.reversedDepth,
        );
        worldBox.copy(bounds).applyMatrix4(this.matrixWorld).expandByScalar(this.#worldPadding);
        // ponytail: bounds lag by boundsEveryFrames; grace delays culling and paused clouds do not move.
        if (frustum.intersectsBox(worldBox)) this.#outsideSince = undefined;
        else {
          // Wall time is only for callers without a loop clock.
          const now = simulatedSeconds ?? performance.now() / 1000;
          this.#outsideSince ??= now;
          if (now - this.#outsideSince >= this.#graceSeconds) reason = "outside-view";
        }
      } else this.#outsideSince = undefined;
      reason ??= this.#yielded ? "over-budget" : undefined;
    } else this.#outsideSince = undefined;
    const state =
      reason === undefined ? "running" : this.#onCull === "clear" ? "cleared" : "paused";
    if (state !== this.#state) {
      this.#transitions += 1;
      if (state === "running" && this.#onCull === "clear") this.restart();
      this.#state = state;
      readback = this.#readback;
    }
    this.#reason = reason;
    if (reason !== undefined) {
      this.#hiddenByCull = true;
      return;
    }
    this.#hiddenByCull = false;
    renderer.compute(this.#process);
    this.#spawnedThisFrame = 0;
    this.#dispatches += 1;
    this.#frame += 1;
    if (
      readback !== undefined &&
      this.#reduce !== undefined &&
      typeof renderer.readback === "function" &&
      !readback.pending &&
      !(readback.stats.failures > 0 && readback.stats.lands === 0) &&
      this.#frame - this.#lastMeasure >= this.#boundsEveryFrames
    ) {
      this.#lastMeasure = this.#frame;
      renderer.compute(this.#reduce);
      readback.request(renderer);
    }
  }

  /**
   * Spawns `count` particles at `origin` (world space unless `localCoords`). Every call gets its own ring
   * slots, so a second burst never touches the first one's live particles. No readback.
   */
  emitParticle(request: IEmitParticleRequest = {}): void {
    if (this.#released) throw new Error("GPUParticles3D cannot emit after release.");
    if (this.#spawn === undefined)
      throw new Error("GPUParticles3D.emitParticle requires a spawn kernel.");
    if (this.#renderer === undefined)
      throw new Error("GPUParticles3D is not attached to a renderer.");
    const asked = request.count ?? 1;
    if (!Number.isInteger(asked) || asked < 0)
      throw new Error("GPUParticles3D.emitParticle count must be a non-negative integer.");
    const { request: uniforms } = this.#spawn;
    setVector(uniforms.origin, "origin", request.origin);
    setVector(uniforms.direction, "direction", request.direction);
    uniforms.seed.value = finite("seed", request.seed ?? this.#seed++);
    const count = Math.min(asked, this.amount, this.#maxPerFrame - this.#spawnedThisFrame);
    if (count < asked) {
      this.#clamped += asked - count;
      if (!this.#warned) {
        this.#warned = true;
        console.warn(
          `GPUParticles3D: spawn request of ${asked} clamped to ${count} (amount ${this.amount}, maxSpawnPerFrame ${this.#maxPerFrame}).`,
        );
      }
    }
    if (count === 0) return;
    this.#countRecycled(count);
    uniforms.first.value = this.#cursor % this.amount;
    uniforms.count.value = count;
    this.#cursor += count;
    this.#spawnedThisFrame += count;
    this.#spawned += count;
    this.#renderer.compute(this.#spawn.stamp);
    this.#renderer.compute(this.#spawn.spawn);
  }

  /** Reruns `start`. A spawn-driven emitter instead kills every particle and rewinds the ring. */
  restart(): void {
    if (this.#released) throw new Error("GPUParticles3D cannot restart after release.");
    if (this.#renderer === undefined)
      throw new Error("GPUParticles3D is not attached to a renderer.");
    this.#runStart(this.#renderer);
    // Restarted positions invalidate old bounds, including a pending copy.
    this.#readback?.dispose();
    this.#readback =
      this.#partials === undefined
        ? undefined
        : new GPUReadback({ attribute: this.#partials.value, everyFrames: 1 });
    this.#measuredBounds = undefined;
    this.#lands = 0;
    this.#outsideSince = undefined;
    this.#lastMeasure = this.#frame - this.#boundsEveryFrames;
  }

  detach(): void {
    if (this.#released) return;
    this.#renderer = undefined;
    this.#start?.dispose();
    this.#process.dispose();
    if (this.#spawn !== undefined) {
      this.#spawn.spawn.dispose();
      this.#spawn.stamp.dispose();
      this.#spawn.reset.dispose();
      this.#spawn.births.value.dispose();
    }
    this.#reduce?.dispose();
    this.#readback?.dispose();
    this.#partials?.value.dispose();
    this.buffers.positions.value.dispose();
    this.buffers.velocities.value.dispose();
    this.#released = true;
  }

  #runStart(renderer: IRendererLike): void {
    if (this.#start !== undefined) renderer.compute(this.#start);
    if (this.#spawn === undefined) return;
    renderer.compute(this.#spawn.reset);
    this.#cursor = 0;
    this.#spawnedThisFrame = 0;
    this.#log = [];
  }

  /** Counts the slots this request overwrites that a recent request filled less than `lifetime` ago. */
  #countRecycled(count: number): void {
    const lifetime = this.#lifetime;
    if (lifetime === undefined) return;
    const now = performance.now() / 1000;
    const first = this.#cursor;
    const overwritten = first - this.amount;
    this.#log = this.#log.filter((entry) => now - entry.at < lifetime);
    for (const entry of this.#log) {
      const lo = Math.max(entry.first, overwritten);
      const hi = Math.min(entry.first + entry.count, overwritten + count);
      if (hi > lo) this.#recycledLive += hi - lo;
    }
    this.#log.push({ at: now, count, first });
  }

  #onRemoved = (): void => this.detach();
}
