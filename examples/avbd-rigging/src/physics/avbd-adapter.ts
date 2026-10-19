import { GPUReadback, type IComputeDriven } from "@threenative/core";
import { Group } from "three";
import { StorageBufferAttribute } from "three/webgpu";
import { RiggingChecks } from "./checks.js";
import { assertRiggingColors, riggingColors } from "./colors.js";
import { toSolverPoint, toSolverRotation } from "./frame.js";
import { GpuTimingBatches, type IGpuTimingReceipt } from "./gpu-timing.js";
import { type IRiggingModel, type IRiggingProxy, buildRiggingModel } from "./model.js";
import { GpuResourceScope } from "./resources.js";
import type { IRiggingInput, IRiggingLimits } from "./topology.js";
import { BODY_FLOATS } from "./vendor/avbd3d/gpu/layout.js";
import { GpuSolver3D, type IGpuParams3D, type IGpuStepTiming } from "./vendor/avbd3d/gpu/solver.js";
import { isSail } from "./vendor/avbd3d/shapes.js";
import { requiredAt } from "./vendor/required-at.js";

type ComputeRenderer = Parameters<IComputeDriven["process"]>[0];
type StorageLease = ReturnType<NonNullable<ComputeRenderer["storageBuffer"]>>;
export interface ISecondarySolver {
  readonly params: IGpuParams3D;
  readonly fixedColors?: Uint32Array | null;
  readonly contactStorage: { counters: GPUBuffer };
  stepTiming?: IGpuStepTiming;
  step(): void;
  setWorldAnchor(slot: number, position: ArrayLike<number>): void;
  rewriteFixed(
    indices: ArrayLike<number>,
    positions: ArrayLike<number>,
    size: ArrayLike<number>,
    friction: number,
    rotations?: ArrayLike<number>,
  ): void;
}
export interface IRiggingSnapshot {
  readonly anchors: readonly [number, number, number][];
  readonly proxies: readonly {
    position: [number, number, number];
    rotation: [number, number, number, number];
  }[];
}
export interface IAvbdOptions {
  readonly input: IRiggingInput;
  readonly proxies: readonly IRiggingProxy[];
  readonly limits?: Partial<IRiggingLimits>;
  /** Called inline after Rapier's plugin update has applied accepted transforms. */
  readonly snapshot: (model: IRiggingModel) => IRiggingSnapshot;
  /** Zero disables body observations for the separately measured timing arm. */
  readonly readbackEveryTicks?: number;
  /** Correctness mode adds a measured, separately reported GPU diagnostic pass each tick. */
  readonly finiteChecks?: boolean;
  /** Qualification only; default off and complete receipts never use the pinned single-map profiler. */
  readonly timings?: boolean;
  readonly solverFactory?: (
    device: GPUDevice,
    model: IRiggingModel,
    bodyBuffer: GPUBuffer,
  ) => ISecondarySolver;
}

function createSolver(
  device: GPUDevice,
  model: IRiggingModel,
  bodyBuffer: GPUBuffer,
): ISecondarySolver {
  const names = [
    "createBuffer",
    "createBindGroupLayout",
    "createPipelineLayout",
    "createComputePipeline",
    "createShaderModule",
    "createBindGroup",
    "createCommandEncoder",
  ] as const;
  for (const name of names)
    if (typeof device[name] !== "function")
      throw new Error(`TN_AVBD_UNSUPPORTED: GPUDevice.${name} is required.`);
  if (
    !Number.isSafeInteger(device.limits.maxStorageBuffersPerShaderStage) ||
    !Number.isSafeInteger(device.limits.maxComputeInvocationsPerWorkgroup) ||
    device.limits.maxStorageBuffersPerShaderStage < 8 ||
    device.limits.maxComputeInvocationsPerWorkgroup < 256
  )
    throw new Error(
      "TN_AVBD_UNSUPPORTED: eight storage bindings and 256 workgroup invocations are required.",
    );
  if (typeof device.features?.has !== "function")
    throw new Error("TN_AVBD_UNSUPPORTED: device feature observations are unavailable.");
  if (device.features.has("timestamp-query") && typeof device.createQuerySet !== "function")
    throw new Error("TN_AVBD_UNSUPPORTED: timestamp-query requires GPUDevice.createQuerySet.");
  const colors = riggingColors(model);
  const possiblePairs = model.secondaryCount * model.proxies.length;
  const solver = new GpuSolver3D(device, model.solver, {
    bodyBuffer,
    profileTimings: false,
    spatialSort: false,
    hulls: false,
    capacity: {
      joints: model.solver.forces.length,
      pairs: possiblePairs,
      manifolds: possiblePairs,
      contacts: possiblePairs * 8,
    },
  });
  solver.splitPasses = true; // Frozen for correctness, calibration, timed and untimed runs.
  solver.params.windGust = 0;
  solver.fixedColors = colors;
  const indices = new Uint32Array(model.solver.bodies.length).map((_, i) => i);
  const groups = indices.map((i) => (i < model.secondaryCount ? 1 : 2));
  const masks = indices.map((i) => (i < model.secondaryCount ? 2 : 1));
  solver.setFilters(indices, groups, masks);
  return solver;
}

function validVector(name: string, value: readonly number[], length: number): void {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !Array.from(value).every((v) => typeof v === "number" && Number.isFinite(Math.fround(v)))
  )
    throw new Error(`TN_AVBD_SNAPSHOT: ${name} must contain ${length} finite Float32 coordinates.`);
}

let nextGeneration = 0;
/** Opt-in secondary simulation. The scene owns scheduling; Rapier is never written by this object. */
export class AvbdRigging extends Group implements IComputeDriven {
  readonly warmupNodes: readonly unknown[] = [];
  readonly processCadence = "fixed" as const;
  readonly model: IRiggingModel;
  readonly bodyAttribute: StorageBufferAttribute;
  #options: IAvbdOptions;
  #renderer: ComputeRenderer | undefined;
  #readRenderer: ComputeRenderer | undefined;
  #lease: StorageLease | undefined;
  #scope: GpuResourceScope | undefined;
  #solver: ISecondarySolver | undefined;
  #readback: GPUReadback | undefined;
  #ready = false;
  #fixedColorsValidated = false;
  #released = false;
  #steps = 0;
  #generation = ++nextGeneration;
  #pending = new Set<Promise<ArrayBuffer>>();
  #probes = new Set<Promise<unknown>>();
  #checks: RiggingChecks | undefined;
  #timings: GpuTimingBatches | undefined;
  #timingRows: {
    receipt: IGpuTimingReceipt;
    cpuSubmissionMs: number;
    diagnosticSubmissionMs: number;
  }[] = [];
  #bytes = 0;
  #release: Promise<void> | undefined;
  #releaseFailure: unknown;

  constructor(options: IAvbdOptions) {
    super();
    if (typeof options?.snapshot !== "function")
      throw new Error("TN_AVBD_SNAPSHOT: an accepted-transform source is required.");
    this.model = buildRiggingModel(options.input, options.proxies, options.limits);
    if (this.model.topology.limits.catchUpSteps !== 5)
      throw new Error(
        "TN_AVBD_FIXED_STEP: this game uses the existing fixed loop's bounded five-step catch-up.",
      );
    this.model.solver.iterations = Math.min(12, this.model.topology.limits.iterations);
    this.#options = options;
    this.bodyAttribute = new StorageBufferAttribute(
      new Float32Array(this.model.solver.bodies.length * BODY_FLOATS),
      4,
    );
    const everyTicks = options.readbackEveryTicks ?? 120;
    if (!Number.isSafeInteger(everyTicks) || everyTicks < 0)
      throw new Error("TN_AVBD_READBACK: everyTicks must be zero or a positive safe integer.");
    if (everyTicks > 0)
      this.#readback = new GPUReadback({ attribute: this.bodyAttribute, everyFrames: everyTicks });
  }

  get fixedColorsValidated(): boolean {
    return this.#fixedColorsValidated;
  }
  get released(): boolean {
    return this.#released;
  }
  get steps(): number {
    return this.#steps;
  }
  get generation(): number {
    return this.#generation;
  }
  get sharedDevice(): object {
    if (this.#lease === undefined)
      throw new Error("TN_AVBD_INITIALIZATION: shared device is unavailable before preparation.");
    return this.#lease.device;
  }
  get resources(): { buffers: number; bytes: number; querySets: number; sharedStorage: number } {
    return {
      ...(this.#scope?.stats ?? { buffers: 0, bytes: 0, querySets: 0 }),
      sharedStorage: this.#lease !== undefined && !this.#lease.released ? 1 : 0,
    };
  }

  /** Scene.load awaits compilation/validation before ctx.add makes the rigging reachable. */
  async prepare(renderer: ComputeRenderer): Promise<void> {
    if (this.#released || this.#renderer !== undefined)
      throw new Error("TN_AVBD_INITIALIZATION: rigging cannot be prepared twice or after release.");
    if (renderer.storageBuffer === undefined)
      throw new Error("TN_AVBD_UNSUPPORTED: renderer storage sharing is unavailable.");
    this.#renderer = renderer;
    try {
      this.#lease = renderer.storageBuffer(this.bodyAttribute);
      this.#scope = new GpuResourceScope(this.#lease.device as GPUDevice, 64 * 1024 * 1024);
      this.#solver = (this.#options.solverFactory ?? createSolver)(
        this.#scope.device,
        this.model,
        this.#lease.buffer as GPUBuffer,
      );
      if (this.#solver.fixedColors !== undefined && this.#solver.fixedColors !== null) {
        assertRiggingColors(this.model, this.#solver.fixedColors);
        this.#fixedColorsValidated = true;
      }
      this.#readRenderer = new Proxy(renderer, {
        get: (target, key) => {
          if (key !== "readback") return Reflect.get(target, key, target);
          return (attribute: unknown) => {
            if (
              attribute !== this.bodyAttribute ||
              this.#lease === undefined ||
              this.#scope === undefined
            )
              throw new Error(
                "TN_AVBD_READBACK: only this scene's leased body storage may be copied.",
              );
            this.#lease.assertCurrent();
            const pending = this.#scope.read(this.#lease.buffer as GPUBuffer);
            this.#pending.add(pending);
            void pending.then(
              (bytes) => {
                this.#pending.delete(pending);
                if (!this.#released) this.#bytes += bytes.byteLength;
              },
              () => this.#pending.delete(pending),
            );
            return pending;
          };
        },
      });
      if (this.#options.timings === true)
        this.#timings = new GpuTimingBatches(this.#scope.device, 11);
      if (this.#options.finiteChecks === true)
        this.#checks = new RiggingChecks(
          this.#scope.device,
          this.#lease.buffer as GPUBuffer,
          this.model.solver.bodies.length,
          this.#solver.contactStorage.counters,
        );
      await this.#scope.finish();
      if (this.#released)
        throw new Error("TN_AVBD_INITIALIZATION: scene exited during solver compilation.");
      this.#ready = true;
    } catch (error) {
      this.detach();
      try {
        await this.whenReleased();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "TN_AVBD_INITIALIZATION: solver startup and cleanup failed.",
        );
      }
      throw error;
    }
  }

  attachRenderer(renderer: ComputeRenderer): void {
    if (!this.#ready || this.#released || renderer !== this.#renderer)
      throw new Error("TN_AVBD_INITIALIZATION: prepare on this renderer before ctx.add.");
    this.#lease?.assertCurrent();
  }

  process(renderer: ComputeRenderer): void {
    if (this.#released) return;
    const solver = this.#solver;
    if (!this.#ready || solver === undefined || renderer !== this.#renderer)
      throw new Error("TN_AVBD_INITIALIZATION: fixed dispatch before preparation.");
    this.#lease?.assertCurrent();
    if (solver.params.dt !== 1 / 60 || solver.params.iterations !== this.model.solver.iterations)
      throw new Error("TN_AVBD_FIXED_STEP: dt or iteration bounds changed after construction.");
    const timing = this.#timings?.begin(this.#steps);
    if (timing !== undefined) {
      timing.bookend(0); // Submitted before snapshots and every anchor/proxy/params/fixed-colour upload.
      solver.stepTiming = {
        beforeClears: (encoder) => timing.stamp(encoder, 1),
        phase: (index) => timing.writes(2 + index * 2, 3 + index * 2),
      };
    }
    const submissionStart = timing === undefined ? 0 : performance.now();
    try {
      const snapshot = this.#options.snapshot(this.model);
      this.#validateSnapshot(snapshot);
      for (const [i, anchor] of this.model.anchors.entries())
        solver.setWorldAnchor(anchor.slot, toSolverPoint(requiredAt(snapshot.anchors, i)));
      for (const [i, proxy] of this.model.proxies.entries()) {
        const pose = requiredAt(snapshot.proxies, i);
        solver.rewriteFixed(
          [proxy.index],
          toSolverPoint(pose.position),
          proxy.body.size,
          proxy.body.friction,
          toSolverRotation(pose.rotation),
        );
      }
      solver.step();
      this.#steps += 1;
      const submissionEnd = timing === undefined ? 0 : performance.now();
      this.#checks?.process();
      if (this.#readRenderer !== undefined) this.#readback?.request(this.#readRenderer);
      const diagnosticEnd = timing === undefined ? 0 : performance.now();
      if (timing !== undefined && this.#timings !== undefined) {
        timing.bookend(10);
        this.#timingRows.push({
          receipt: timing.finish(),
          cpuSubmissionMs: submissionEnd - submissionStart,
          // Two back-to-back clock reads around no work can still differ by one timer tick.
          diagnosticSubmissionMs:
            this.#checks === undefined && this.#readback === undefined
              ? 0
              : diagnosticEnd - submissionEnd,
        });
      }
    } catch (error) {
      if (timing !== undefined) timing.abort(error);
      throw error;
    } finally {
      solver.stepTiming = undefined;
    }
  }

  get timingRows(): readonly {
    receipt: IGpuTimingReceipt;
    cpuSubmissionMs: number;
    diagnosticSubmissionMs: number;
  }[] {
    return this.#timingRows;
  }
  settleTimings(): Promise<void> {
    if (this.#timings === undefined)
      throw new Error("TN_AVBD_TIMING_MISSING: timings were not enabled.");
    return this.#timings.settle();
  }

  #validateSnapshot(snapshot: IRiggingSnapshot): void {
    if (
      !Array.isArray(snapshot?.anchors) ||
      snapshot.anchors.length !== this.model.anchors.length ||
      !Array.isArray(snapshot.proxies) ||
      snapshot.proxies.length !== this.model.proxies.length
    )
      throw new Error(
        "TN_AVBD_SNAPSHOT: accepted anchor/proxy counts changed; rebuild outside fixed-step dispatch.",
      );
    for (const [i, position] of snapshot.anchors.entries())
      validVector(`anchor[${i}]`, position, 3);
    for (const [i, proxy] of snapshot.proxies.entries()) {
      validVector(`proxy[${i}].position`, proxy?.position, 3);
      validVector(`proxy[${i}].rotation`, proxy?.rotation, 4);
      if (Math.abs(Math.hypot(...proxy.rotation) - 1) > 1e-4)
        throw new Error(`TN_AVBD_SNAPSHOT: proxy[${i}] rotation is not normalized.`);
    }
  }

  get observation():
    | {
        generation: number;
        fixedStep: number;
        staleTicks: number;
        bytes: number;
        totalBytes: number;
        bodies: Float32Array;
      }
    | undefined {
    if (this.#released) return undefined;
    const sample = this.#readback?.sample;
    if (sample === undefined) return undefined;
    if (sample.data.byteLength !== this.bodyAttribute.array.byteLength)
      throw new Error(
        `TN_AVBD_READBACK: observed ${sample.data.byteLength} bytes, expected ${this.bodyAttribute.array.byteLength}.`,
      );
    return {
      generation: this.#generation,
      fixedStep: this.#steps - sample.staleFrames,
      staleTicks: sample.staleFrames,
      bytes: sample.data.byteLength,
      totalBytes: this.#bytes,
      bodies: sample.data,
    };
  }

  /** Explicit final observation after a timing window; it adds no work to process/render. */
  async observeBodies(): Promise<NonNullable<AvbdRigging["observation"]>> {
    if (this.#released || !this.#ready || this.#readRenderer === undefined)
      throw new Error("TN_AVBD_READBACK_STALE: observe a prepared live generation only.");
    if (this.#probes.size !== 0)
      throw new Error(
        "TN_AVBD_READBACK_PENDING: one explicit diagnostic observation may be in flight.",
      );
    const generation = this.#generation;
    const fixedStep = this.#steps;
    const pending = this.#readRenderer.readback(this.bodyAttribute);
    this.#probes.add(pending);
    try {
      const bytes = await pending;
      if (this.#released || this.#generation !== generation)
        throw new Error("TN_AVBD_READBACK_STALE: generation exited before final observation.");
      if (bytes.byteLength !== this.bodyAttribute.array.byteLength)
        throw new Error(
          `TN_AVBD_READBACK: final bytes ${bytes.byteLength}, expected ${this.bodyAttribute.array.byteLength}.`,
        );
      return {
        generation,
        fixedStep,
        staleTicks: this.#steps - fixedStep,
        bytes: bytes.byteLength,
        totalBytes: this.#bytes,
        bodies: new Float32Array(bytes),
      };
    } finally {
      this.#probes.delete(pending);
    }
  }

  /** An explicit asynchronous observation; never awaited by process or render. */
  async checkFinite(): Promise<{
    generation: number;
    ticks: number;
    nonfinitePositions: number;
    nonfiniteRotations: number;
    overflow: number;
    colorClashes: number;
    contactsMaximum: number;
    bytes: number;
  }> {
    if (this.#released || this.#checks === undefined)
      throw new Error("TN_AVBD_CHECKS_MISSING: enable finiteChecks on a live scene.");
    if (this.#probes.size !== 0)
      throw new Error("TN_AVBD_CHECKS_PENDING: one diagnostic readback may be in flight.");
    const generation = this.#generation;
    const pending = this.#checks.read();
    this.#probes.add(pending);
    try {
      const sample = await pending;
      if (this.#released || this.#generation !== generation)
        throw new Error("TN_AVBD_CHECKS_STALE: generation exited during observation.");
      return { generation, ...sample };
    } finally {
      this.#probes.delete(pending);
    }
  }

  setWind(speed: number, angle: number, gust: number): void {
    if (
      [speed, angle, gust].some((v) => !Number.isFinite(Math.fround(v))) ||
      speed < 0 ||
      gust < 0 ||
      gust > 1
    )
      throw new Error("TN_AVBD_WIND: finite speed >= 0, angle and gust in 0..1 are required.");
    if (!this.#ready || this.#released || this.#solver === undefined)
      throw new Error("TN_AVBD_INITIALIZATION: set wind on a prepared scene.");
    const maximumWind = Math.fround(speed * (1 + 1.35 * gust));
    for (const [i, body] of this.model.solver.bodies.entries()) {
      if (!isSail(body)) continue;
      const pressureArea = Math.fround(
        Math.fround(
          Math.fround(this.#solver.params.windPressure) * Math.fround(requiredAt(body.size, 0)),
        ) * Math.fround(requiredAt(body.size, 1)),
      );
      const drag = Math.fround(pressureArea / Math.fround(body.mass));
      const numerator = Math.fround(Math.fround(drag * maximumWind) * maximumWind);
      if (!Number.isFinite(numerator))
        throw new Error(`TN_AVBD_WIND: body[${i}] wind drag exceeds Float32 representation.`);
    }
    Object.assign(this.#solver.params, { windSpeed: speed, windAngle: angle, windGust: gust });
  }

  detach(): void {
    if (this.#released) return;
    this.#released = true;
    this.#ready = false;
    this.#generation = ++nextGeneration;
    this.#readback?.dispose();
    this.#startRelease();
  }

  #startRelease(): void {
    this.#releaseFailure = undefined;
    this.#release = this.#dispose();
    void this.#release.catch((error: unknown) => {
      this.#releaseFailure = error;
    });
  }

  /** Retry a failed teardown without reattaching or reviving this generation. */
  retryRelease(): Promise<void> {
    if (!this.#released) throw new Error("TN_AVBD_RELEASE: detach before retrying release.");
    if (this.#releaseFailure !== undefined) this.#startRelease();
    return this.whenReleased();
  }

  get readbackStats(): { requests: number; lands: number; failures: number } {
    return this.#readback?.stats ?? { requests: 0, lands: 0, failures: 0 };
  }

  async #dispose(): Promise<void> {
    await this.#timings?.retire();
    await Promise.allSettled([...this.#pending, ...this.#probes]);
    const failures: unknown[] = [];
    try {
      await this.#scope?.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#lease?.dispose();
    } catch (error) {
      failures.push(error);
    }
    this.#solver = undefined;
    this.#renderer = undefined;
    this.#readRenderer = undefined;
    if (failures.length > 0)
      throw new AggregateError(failures, "TN_AVBD_RELEASE: scene resource release failed.");
  }

  whenReleased(): Promise<void> {
    if (!this.#released || this.#release === undefined)
      throw new Error("TN_AVBD_RELEASE: detach before awaiting release.");
    if (this.#releaseFailure !== undefined) return Promise.reject(this.#releaseFailure);
    return this.#release;
  }
}
