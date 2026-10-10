import { Box3, type Camera, Frustum, Matrix4, Sphere, Sprite, Vector3 } from "three";
import { Fn, Loop, instanceIndex, instancedArray, max, min, vec3, vec4 } from "three/tsl";
import type { ComputeNode, SpriteNodeMaterial, StorageBufferNode } from "three/webgpu";
import type { IComputeDriven } from "./compute-driven.js";
import { GPUReadback } from "./gpu-readback.js";
import type { IBudgetCandidate } from "./particle-significance.js";
import type { IRendererLike } from "./renderer.js";

export interface IGPUParticles3DBuffers {
  readonly positions: StorageBufferNode<"vec3">;
  readonly velocities: StorageBufferNode<"vec3">;
}

export interface IGPUParticles3DOptions {
  readonly amount: number;
  readonly material: SpriteNodeMaterial;
  readonly start: (buffers: IGPUParticles3DBuffers) => ComputeNode;
  readonly process: (buffers: IGPUParticles3DBuffers) => ComputeNode;
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

export class GPUParticles3D extends Sprite implements IComputeDriven {
  readonly amount: number;
  readonly buffers: IGPUParticles3DBuffers;
  readonly processCadence = "render" as const;
  readonly warmupNodes: readonly ComputeNode[];
  emitting = true;
  #start: ComputeNode;
  #process: ComputeNode;
  #renderer: IRendererLike | undefined;
  #released = false;
  readonly #boundsOverride: Box3 | undefined;
  #measuredBounds: Box3 | undefined;
  readonly #padding: number | undefined;
  readonly #onCull: "pause" | "clear";
  #graceSeconds = 1;
  readonly #boundsEveryFrames: number;
  readonly #partials: StorageBufferNode<"vec4"> | undefined;
  readonly #reduce: ComputeNode | undefined;
  readonly #readback: GPUReadback | undefined;
  #frame = 0;
  #lastMeasure = 0;
  #lands = 0;
  #dispatches = 0;
  #outsideSince: number | undefined;
  #hiddenByCull = false;
  #yielded = false;
  #state: "running" | "paused" | "cleared" = "running";
  #reason: "outside-view" | "over-budget" | undefined;
  #transitions = 0;

  /** Cooperate with measured frame-budget shedding without changing particle storage. */
  readonly budget: IBudgetCandidate = {
    significance: (camera) => {
      if (this.#released || !this.emitting || this.#reason === "outside-view") return undefined;
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
    if (typeof options.start !== "function")
      throw new Error("GPUParticles3D.start must be a function.");
    if (typeof options.process !== "function")
      throw new Error("GPUParticles3D.process must be a function.");
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
    this.#boundsOverride = options.bounds;
    this.#padding = options.padding;
    this.#onCull = options.onCull ?? "pause";
    this.graceSeconds = options.graceSeconds ?? 1;
    this.#boundsEveryFrames = boundsEveryFrames;
    this.amount = options.amount;
    this.buffers = {
      positions: instancedArray(options.amount, "vec3"),
      velocities: instancedArray(options.amount, "vec3"),
    };
    options.material.positionNode = this.buffers.positions.toAttribute();
    this.count = options.amount;
    // Three tests a Sprite as a unit quad, ignoring the particle cloud.
    this.frustumCulled = false;
    this.#start = computeNode("start", options.start(this.buffers));
    this.#process = computeNode("process", options.process(this.buffers));
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
    this.warmupNodes =
      this.#reduce === undefined
        ? [this.#start, this.#process]
        : [this.#start, this.#process, this.#reduce];
    this.addEventListener("removed", this.#onRemoved);
  }

  get released(): boolean {
    return this.#released;
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
    renderer.compute(this.#start);
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

  process(renderer = this.#renderer, camera?: Camera): void {
    if (this.#released || !this.emitting) return;
    if (renderer === undefined) throw new Error("GPUParticles3D is not attached to a renderer.");
    const readback = this.#readback;
    if (readback !== undefined && readback.stats.lands !== this.#lands) {
      this.#lands = readback.stats.lands;
      this.#measuredBounds = readback.data === undefined ? undefined : foldBounds(readback.data);
    }
    let reason: "outside-view" | "over-budget" | undefined;
    if (camera !== undefined && !this.castShadow && (this.visible || this.#hiddenByCull)) {
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
          const now = performance.now() / 1000;
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
    }
    this.#reason = reason;
    if (reason !== undefined) {
      this.visible = false;
      this.#hiddenByCull = true;
      return;
    }
    if (this.#hiddenByCull) {
      this.visible = true;
      this.#hiddenByCull = false;
    }
    renderer.compute(this.#process);
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

  restart(): void {
    if (this.#released) throw new Error("GPUParticles3D cannot restart after release.");
    if (this.#renderer === undefined)
      throw new Error("GPUParticles3D is not attached to a renderer.");
    this.#renderer.compute(this.#start);
  }

  detach(): void {
    if (this.#released) return;
    this.#renderer = undefined;
    this.#start.dispose();
    this.#process.dispose();
    this.#reduce?.dispose();
    this.#readback?.dispose();
    this.#partials?.value.dispose();
    this.buffers.positions.value.dispose();
    this.buffers.velocities.value.dispose();
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();
}
