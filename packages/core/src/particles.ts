import { Sprite, Vector3 } from "three";
import type { Node, UniformNode } from "three/src/nodes/Nodes.js";
import { Fn, If, deltaTime, instanceIndex, instancedArray, time, uint, uniform } from "three/tsl";
import type { ComputeNode, SpriteNodeMaterial, StorageBufferNode } from "three/webgpu";
import type { IComputeDriven } from "./compute-driven.js";
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
    super(options.material);
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
    this.warmupNodes = [
      ...(this.#start === undefined ? [] : [this.#start]),
      ...(this.#spawn === undefined
        ? []
        : [this.#spawn.reset, this.#spawn.stamp, this.#spawn.spawn]),
      this.#process,
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

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("GPUParticles3D cannot be attached after release.");
    if (this.#renderer === renderer) return;
    this.#renderer = renderer;
    this.#runStart(renderer);
  }

  process(renderer = this.#renderer): void {
    if (this.#released || !this.emitting) return;
    if (renderer === undefined) throw new Error("GPUParticles3D is not attached to a renderer.");
    renderer.compute(this.#process);
    this.#spawnedThisFrame = 0;
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
