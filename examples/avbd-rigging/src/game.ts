import {
  type ICtx,
  type ISoftBody3DOptions,
  Scene,
  SoftBody3D,
  defineGame,
  warmUpScene,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  rapier,
  softBodyCollision,
} from "@threenative/physics";
import {
  type IPlaytestBridgeHost,
  PLAYTEST_BRIDGE_GLOBAL,
  requestedPlaytestClockMode,
} from "@threenative/playtest/protocol";
import { Group, Mesh } from "three";
import { MeshBasicNodeMaterial, ReadbackBuffer, StorageBufferAttribute } from "three/webgpu";
import { AvbdRigging } from "./physics/avbd-adapter.js";
import {
  RiggingBenchmark,
  publishRiggingRows,
  riggingComparison,
  riggingRuns,
  summarizeRiggingRun,
} from "./physics/benchmark.js";
import { observeCloth } from "./physics/cloth-observation.js";
import {
  type IStorageObservation,
  RiggingRegistrations,
  observeStorage,
} from "./physics/lifetime.js";
import {
  type IProxyContactWitness,
  type IRiggingSampleChecks,
  measurePositions,
  measureProxyPenetration,
  measureSailPositions,
  riggingPositions,
  riggingSampleChecks,
} from "./physics/measure.js";
import type { IRiggingProxy } from "./physics/model.js";
import { GpuResourceScope } from "./physics/resources.js";
import { SpringTimings, candidateTimingReceipt } from "./physics/timing-arms.js";
import type { ISecondaryFrameSample } from "./physics/timing-window.js";
import { buildRiggingTopology, referenceRigging } from "./physics/topology.js";
import { requiredAt } from "./physics/vendor/required-at.js";
import {
  candidateDraw,
  disposeDraw,
  patchGeometry,
  proxyDraw,
  riggingStage,
} from "./render/rigging.js";

interface IRiggingState extends Record<string, unknown> {
  mode: string;
  steps: number;
  measured: number;
  sailStretch: number;
  sailEdgeError: number;
  ropeExtension: number;
  penetration: number;
  penetrationMaximum: number;
  penetrationPeak: IRiggingPenetrationPeak | null;
  sampleChecks: Partial<IRiggingSampleChecks>;
  anchorX: number;
  windSpeed: number;
  gustStrength: number;
  staleTicks: number;
  readbackBytes: number;
  readbackFailures: number;
  finiteTicks: number;
  nonfinitePositions: number;
  nonfiniteRotations: number;
  overflow: number;
  colorClashes: number;
  fixedColorsValidated: number;
  contactsMaximum: number;
  acceptedAnchorVelocity: number;
  acceptedAnchorMoving: boolean;
  acceptedAnchorDelta: number;
  anchorMoveRequests: number;
  anchorMoving: number;
  requestedAnchorX: number;
  paused: number;
  pauseKeyHeld: number;
  pausedAdditionalSteps: number;
  completedCycles: number;
  releasedBuffers: number;
  releasedBytes: number;
  releasedStorage: number;
  releasedQuerySets: number;
  registryCount: number;
  registryBaseline: number;
  deviceMismatch: number;
  lifecycleFailures: number;
  lifecycleObserved: number;
  cleanupFailed: number;
  observationFailures: number;
}

interface IRiggingPenetrationPeak extends IProxyContactWitness {
  solverRevision: string;
  frame: "solver z-up → authored y-up: [x,z,-y]";
  generation: number;
  sampledFixedStep: number;
  observedFixedStep: number;
  staleTicks: number;
  bytes: number;
  totalBytes: number;
}

const initial: IRiggingState = {
  mode: "candidate",
  steps: 0,
  measured: 0,
  sailStretch: 1e9,
  sailEdgeError: 1e9,
  ropeExtension: 1e9,
  penetration: 1e9,
  penetrationMaximum: 1e9,
  penetrationPeak: null,
  sampleChecks: {},
  anchorX: 0,
  windSpeed: 0,
  gustStrength: 0,
  staleTicks: 0,
  readbackBytes: 0,
  readbackFailures: 0,
  finiteTicks: 0,
  nonfinitePositions: 0,
  nonfiniteRotations: 0,
  overflow: 0,
  colorClashes: 0,
  fixedColorsValidated: 0,
  contactsMaximum: 0,
  acceptedAnchorVelocity: 0,
  acceptedAnchorMoving: false,
  acceptedAnchorDelta: 0,
  anchorMoveRequests: 0,
  anchorMoving: 0,
  requestedAnchorX: 0,
  paused: 0,
  pauseKeyHeld: 0,
  pausedAdditionalSteps: 0,
  completedCycles: 0,
  releasedBuffers: -1,
  releasedBytes: -1,
  releasedStorage: -1,
  releasedQuerySets: -1,
  registryCount: -1,
  registryBaseline: -1,
  deviceMismatch: 0,
  lifecycleFailures: 0,
  lifecycleObserved: 0,
  cleanupFailed: 0,
  observationFailures: 0,
};
const proxyInputs: readonly IRiggingProxy[] = [
  { name: "wall", size: [6, 4, 0.2], position: [0, 4, 0.7] },
  { name: "floor", size: [12, 0.2, 8], position: [0, -0.1, 0] },
];
export const registrations = new RiggingRegistrations((object) => object instanceof AvbdRigging);
const lifetime = {
  completed: 0,
  buffers: -1,
  bytes: -1,
  storage: -1,
  queries: -1,
  failed: 0,
  deviceMismatch: 0,
  lifecycleFailures: 0,
  device: undefined as object | undefined,
};
const cycleReceipts: Record<string, unknown>[] = [];
const retirements: Promise<void>[] = [];
let benchmarkIndex = -1;
let benchmarkFailures = 0;
const benchmarkResults: Record<string, unknown>[] = [];
function benchmarkFailure(error: unknown): void {
  benchmarkFailures += 1;
  game.pause();
  console.error(`TN_AVBD_BENCHMARK_FAILED:${String(error)}`);
}

/** A genuine hanging load: the four 0.4 kg ropes have free lower ends (3.924 N self-weight each). */
export function hangingRigging() {
  const input = referenceRigging();
  for (const rope of input.ropes) rope.pinned = [0];
  return input;
}

/** SoftBody's existing transform input is applied from Rapier's accepted pose at dispatch time. */
export class AnchoredCloth extends SoftBody3D {
  #acceptedAnchor: () => number;
  #source: Parameters<SoftBody3D["attachRenderer"]>[0] | undefined;
  #observedRenderer: Parameters<SoftBody3D["attachRenderer"]>[0] | undefined;
  #bytes = 0;
  #observationsEnabled: boolean;
  #timings: SpringTimings | undefined;
  #pending = new Set<Promise<unknown>>();
  #cleanupFailures: unknown[] = [];
  #retiring = false;
  #retirement: Promise<void> | undefined;

  constructor(mesh: Mesh, options: ISoftBody3DOptions, acceptedAnchor: () => number) {
    super(mesh, options);
    this.#acceptedAnchor = acceptedAnchor;
    this.#observationsEnabled = (options.readbackEveryFrames ?? 0) > 0;
  }

  override attachRenderer(renderer: Parameters<SoftBody3D["attachRenderer"]>[0]): void {
    const observedRenderer = new Proxy(renderer, {
      get: (target, key) => {
        if (key !== "readback") return Reflect.get(target, key, target);
        return (attribute: unknown, supplied?: ReadbackBuffer) => {
          if (this.released) throw new Error("TN_RIGGING_OBSERVATION_STALE: cloth has retired.");
          const owned =
            supplied ?? new ReadbackBuffer(this.geometry.getAttribute("position").count * 16);
          let request: Promise<ArrayBuffer>;
          try {
            request = target.readback(attribute, owned);
          } catch (error) {
            if (supplied === undefined) this.#releaseTarget(owned);
            throw error;
          }
          const pending = request
            .then((bytes) => {
              if (!this.released) this.#bytes += bytes.byteLength;
              return bytes;
            })
            .finally(() => {
              try {
                if (supplied === undefined) this.#releaseTarget(owned);
              } finally {
                this.#pending.delete(pending);
              }
            });
          this.#pending.add(pending);
          return pending;
        };
      },
    });
    super.attachRenderer(observedRenderer);
    this.#source = renderer;
    this.#observedRenderer = observedRenderer;
  }

  override get released(): boolean {
    return this.#retiring || super.released;
  }

  override detach(): void {
    if (this.#retiring) return;
    this.#retiring = true;
    this.#source = undefined;
    this.#observedRenderer = undefined;
    const release = () => {
      super.detach();
      if (this.#cleanupFailures.length !== 0)
        throw new AggregateError(
          this.#cleanupFailures,
          "TN_RIGGING_READBACK_RELEASE: owned staging cleanup failed.",
        );
    };
    if (this.#pending.size === 0) {
      try {
        release();
        this.#retirement = Promise.resolve();
      } catch (error) {
        this.#retirement = Promise.reject(error);
      }
    } else this.#retirement = Promise.allSettled([...this.#pending]).then(release);
    void this.#retirement.catch(() => undefined);
  }
  whenReleased(): Promise<void> {
    if (this.#retirement === undefined)
      throw new Error("TN_RIGGING_RELEASE: detach before awaiting retirement.");
    return this.#retirement;
  }
  observePositions(vertices: number): ReturnType<typeof observeCloth> {
    if (this.#observedRenderer === undefined)
      throw new Error("TN_RIGGING_OBSERVATION_STALE: cloth has retired.");
    const pending = observeCloth(this, this.#observedRenderer, vertices)
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("TN_RIGGING_READBACK_RELEASE"))
          this.#cleanupFailures.push(error);
        throw error;
      })
      .finally(() => {
        this.#pending.delete(pending);
      });
    this.#pending.add(pending);
    return pending;
  }
  #releaseTarget(target: ReadbackBuffer): void {
    try {
      target.dispose();
    } catch (cause) {
      const error = new Error("TN_RIGGING_READBACK_RELEASE: periodic staging cleanup failed.", {
        cause,
      });
      this.#cleanupFailures.push(error);
      throw error;
    }
  }

  get readbackBytes(): number {
    return this.#bytes;
  }
  get readbackFailures(): number {
    if (!this.#observationsEnabled) return 0;
    const stats = this.debug().readbackStats;
    if (
      typeof stats !== "object" ||
      stats === null ||
      !("failures" in stats) ||
      typeof stats.failures !== "number" ||
      !Number.isSafeInteger(stats.failures) ||
      stats.failures < 0
    )
      throw new Error("TN_RIGGING_MEASUREMENT: baseline readback failures are unobserved.");
    return stats.failures;
  }

  enableTimings(timings: SpringTimings): void {
    if (this.#observationsEnabled || this.#timings !== undefined)
      throw new Error(
        "TN_RIGGING_TIMING_INVALID: primary spring timing requires disabled readback and one timing arm.",
      );
    this.#timings = timings;
  }

  override process(renderer = this.#source): void {
    if (this.released) return;
    if (renderer !== this.#source || this.#observedRenderer === undefined)
      throw new Error("TN_RIGGING_BASELINE: dispatch on the attached renderer only.");
    const observedRenderer = this.#observedRenderer;
    if (this.#timings !== undefined) {
      this.#timings.process(this.name, () => {
        this.position.x = this.#acceptedAnchor();
        super.process(observedRenderer);
      });
      return;
    }
    this.position.x = this.#acceptedAnchor();
    super.process(observedRenderer);
  }
}

export class RiggingScene extends Scene<IRiggingState, IPhysicsContext> {
  static override readonly initialState = initial;
  protected readonly mode: "candidate" | "spring" = "candidate";
  #input = hangingRigging();
  #topology = buildRiggingTopology(this.#input);
  #rigging: AvbdRigging | undefined;
  #cloth: AnchoredCloth[] = [];
  #mast = new Group();
  #proxies = new Map<string, Mesh>();
  #draw = new Group();
  #moving = false;
  #speed = 0;
  #gust = 0;
  #paused = false;
  #pauseHeld = false;
  #pausedAt = 0;
  #cycling = false;
  #cycleTarget = 0;
  #checking = false;
  #checks: Partial<IRiggingState> = {};
  #observedStep = -1;
  #observationFailures = 0;
  #penetrationMaximum: number | undefined;
  #penetrationPeak: IRiggingPenetrationPeak | null = null;
  #sampleMeasures: { ropeExtensionMaximum: number; sailStretchP95: number } | undefined;
  #previousAcceptedAnchor = 0;
  #acceptedAnchorVelocity = 0;
  #acceptedAnchorDelta = 0;
  #anchorMoveRequests = 0;
  #requestedAnchorX = 0;
  #anchorInputPending = false;
  #anchorInputLogged = false;
  #anchorAcceptedLogged = false;
  #storageBaseline: IStorageObservation | undefined;
  #renderer: ICtx<IRiggingState, IPhysicsContext>["renderer"] | undefined;
  #benchmarkRun = riggingRuns[benchmarkIndex];
  #benchmark: RiggingBenchmark | undefined;
  #readyStarted = false;
  #readiness: Record<string, unknown> | undefined;
  #springTimings: SpringTimings | undefined;
  #springScope: GpuResourceScope | undefined;
  #springLease:
    | ReturnType<NonNullable<ICtx<IRiggingState, IPhysicsContext>["renderer"]["storageBuffer"]>>
    | undefined;
  #exited = false;

  override async load(ctx: ICtx<IRiggingState, IPhysicsContext>): Promise<void> {
    await Promise.all(retirements.splice(0));
    if (rendererControl === undefined) {
      // The initial world is empty. Prime only Three's persistent output resources on this renderer.
      const before = observeStorage(ctx.renderer.info);
      ctx.renderer.render(ctx.scene, ctx.camera);
      rendererControl = { before, after: observeStorage(ctx.renderer.info), solverAllocations: 0 };
      console.log(`TN_AVBD_RENDERER_CONTROL:${JSON.stringify(rendererControl)}`);
    }
    this.#mast.position.set(0, 3.5, 0);
    for (const proxy of proxyInputs)
      this.#proxies.set(proxy.name, proxyDraw(proxy.size, proxy.position));
    if (this.#benchmarkRun !== undefined && this.#benchmarkRun.arm !== this.mode)
      throw new Error("TN_RIGGING_TIMING_MEMBERSHIP: frozen arm/scene identity differs.");
    if (this.mode === "spring") {
      if (this.#benchmarkRun !== undefined) {
        if (ctx.renderer.storageBuffer === undefined)
          throw new Error("TN_RIGGING_TIMING_UNSUPPORTED: shared device lease is unavailable.");
        try {
          this.#springLease = ctx.renderer.storageBuffer(
            new StorageBufferAttribute(new Float32Array(4), 4),
          );
          this.#springScope = new GpuResourceScope(
            this.#springLease.device as GPUDevice,
            1024 * 1024,
          );
          this.#springTimings = new SpringTimings(
            ctx.renderer,
            this.#springScope.device,
            this.#benchmarkRun.id,
          );
          await this.#springScope.finish();
          if (this.#springLease.device !== lifetime.device)
            throw new Error("TN_RIGGING_TIMING_STALE: spring received a different shared device.");
        } catch (error) {
          try {
            await this.#releaseSpringTimings();
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "TN_RIGGING_TIMING_INITIALIZATION: setup/cleanup failed.",
            );
          }
          throw error;
        }
      }
      return;
    }
    this.#rigging = new AvbdRigging({
      input: this.#input,
      proxies: proxyInputs,
      finiteChecks: this.#benchmarkRun === undefined || this.#benchmarkRun.diagnostics,
      readbackEveryTicks:
        this.#benchmarkRun === undefined || this.#benchmarkRun.diagnostics ? 120 : 0,
      timings: this.#benchmarkRun !== undefined,
      snapshot: (model) => {
        const acceptedX = this.#mast.position.x;
        this.#acceptedAnchorDelta = acceptedX - this.#previousAcceptedAnchor;
        this.#acceptedAnchorVelocity = this.#acceptedAnchorDelta * 60;
        if (this.#anchorInputPending) {
          console.log(
            `TN_AVBD_ANCHOR_ACCEPTED:${JSON.stringify({
              solverStep: this.#rigging?.steps ?? 0,
              requestedX: this.#requestedAnchorX,
              previousAcceptedX: this.#previousAcceptedAnchor,
              acceptedX,
              acceptedDelta: this.#acceptedAnchorDelta,
              acceptedVelocity: this.#acceptedAnchorVelocity,
              moving: this.#moving,
              clock: requestedPlaytestClockMode() ?? "fixed-step",
            })}`,
          );
          this.#anchorInputPending = false;
          this.#anchorAcceptedLogged = true;
        }
        if (this.#benchmarkRun === undefined) {
          // Exact fixed-step polling observes accepted physics before another render is required.
          ctx.state.set({
            anchorX: acceptedX,
            acceptedAnchorVelocity: this.#acceptedAnchorVelocity,
            acceptedAnchorMoving:
              Number.isFinite(this.#acceptedAnchorVelocity) && this.#acceptedAnchorVelocity >= 0.24,
            acceptedAnchorDelta: this.#acceptedAnchorDelta,
            anchorMoveRequests: this.#anchorMoveRequests,
            anchorMoving: Number(this.#moving),
            requestedAnchorX: this.#requestedAnchorX,
          });
          // The existing store reads this patch immediately; publish subscribers after dispatch.
        }
        this.#previousAcceptedAnchor = acceptedX;
        return {
          // The physics plugin has already applied accepted transforms to these objects.
          anchors: model.anchors.map((a) => [
            a.position[0] + this.#mast.position.x,
            a.position[1] + this.#mast.position.y - 3.5,
            a.position[2] + this.#mast.position.z,
          ]),
          proxies: model.proxies.map((proxy) => {
            const object = this.#proxies.get(proxy.name);
            if (object === undefined) throw new Error(`TN_RIGGING_PROXY_MISSING: ${proxy.name}`);
            return { position: object.position.toArray(), rotation: object.quaternion.toArray() };
          }),
        };
      },
    });
    this.#renderer = ctx.renderer;
    this.#storageBaseline = observeStorage(ctx.renderer.info);
    await this.#rigging.prepare(ctx.renderer);
    const device = this.#rigging.sharedDevice;
    if (lifetime.device === undefined) lifetime.device = device;
    else if (lifetime.device !== device) lifetime.deviceMismatch += 1;
  }

  override enter(ctx: ICtx<IRiggingState, IPhysicsContext>): void {
    ctx.camera.position.set(10, 8, 14);
    ctx.camera.lookAt(0.5, 4, 0);
    this.#draw.add(riggingStage(ctx.scene));
    ctx.add(this.#draw);
    ctx.add(this.#mast);
    new RigidBody3D({
      object: this.#mast,
      physics: ctx.physics,
      shape: CollisionShape3D.box(0.05, 7, 0.05),
      type: "kinematic",
    });
    const bodies: RigidBody3D[] = [];
    for (const proxy of proxyInputs) {
      const object = this.#proxies.get(proxy.name);
      if (object === undefined) throw new Error(`TN_RIGGING_PROXY_MISSING: ${proxy.name}`);
      this.#draw.add(object);
      bodies.push(
        new RigidBody3D({
          object,
          physics: ctx.physics,
          shape: CollisionShape3D.box(...proxy.size),
          type: "fixed",
        }),
      );
    }
    if (this.#rigging !== undefined) {
      this.#rigging.add(
        candidateDraw(this.#input, this.#rigging.model, this.#rigging.bodyAttribute),
      );
      ctx.add(this.#rigging);
    } else {
      for (const patch of this.#input.patches) {
        const mesh = new Mesh(
          patchGeometry(patch),
          new MeshBasicNodeMaterial({
            color: patch.name === "sail" ? 0xe4c592 : 0x5bbdb6,
            side: 2,
            toneMapped: false,
          }),
        );
        const cloth = new AnchoredCloth(
          mesh,
          {
            stiffness: 1000,
            damping: 1.8,
            gravity: [0, -9.81, 0],
            wind: [0, 0, 0],
            pinned: patch.pinned,
            collision: softBodyCollision(...bodies),
            readbackEveryFrames: this.#benchmarkRun === undefined ? 120 : 0,
            timeStep: 1 / 60,
          },
          () => this.#mast.position.x,
        );
        mesh.material.dispose();
        cloth.name = patch.name;
        if (this.#springTimings !== undefined) cloth.enableTimings(this.#springTimings);
        this.#cloth.push(ctx.add(cloth));
      }
    }
    const run = this.#benchmarkRun;
    if (run !== undefined) {
      this.#speed = 6;
      this.#setWind();
      const rigging = this.#rigging;
      const spring = this.#springTimings;
      const source =
        rigging !== undefined
          ? {
              count: () => rigging.timingRows.length,
              receipt: (index: number) =>
                candidateTimingReceipt(requiredAt(rigging.timingRows, index), run.id),
              settle: () => rigging.settleTimings(),
            }
          : spring !== undefined
            ? {
                count: () => spring.rows.length,
                receipt: (index: number) => requiredAt(spring.rows, index),
                settle: () => spring.settle(),
              }
            : undefined;
      if (source === undefined)
        throw new Error("TN_RIGGING_TIMING_MISSING: frozen arm has no timing source.");
      this.#benchmark = new RiggingBenchmark(source, () => {
        this.#pausedAt = this.#rigging?.steps ?? this.#cloth[0]?.steps ?? 0;
        this.#paused = true;
        game.pause();
      });
    }
    ctx.state.set({ ...initial, mode: this.mode, completedCycles: lifetime.completed });
  }

  override update(ctx: ICtx<IRiggingState, IPhysicsContext>, dt: number): void {
    if (this.#benchmarkRun !== undefined) {
      this.#setWind();
      return;
    }
    if (ctx.input.justPressed("benchmark")) {
      if (benchmarkIndex !== -1 || benchmarkResults.length !== 0)
        throw new Error("TN_RIGGING_TIMING_DUPLICATE: each comparison requires a fresh attempt.");
      benchmarkIndex = 0;
      console.log(
        `TN_AVBD_BENCHMARK_PLAN:${JSON.stringify({ frozen: riggingComparison, runs: riggingRuns })}`,
      );
      void ctx.goto("candidate").catch(benchmarkFailure);
      return;
    }
    if (ctx.input.justPressed("candidate")) {
      void ctx.goto("candidate");
      return;
    }
    if (ctx.input.justPressed("spring")) {
      void ctx.goto("spring");
      return;
    }
    if (ctx.input.justPressed("reset")) {
      void ctx.goto(this.mode);
      return;
    }
    if (ctx.input.justPressed("moveAnchor")) {
      this.#moving = true;
      this.#anchorMoveRequests += 1;
      this.#anchorInputPending = this.#rigging !== undefined && !this.#anchorAcceptedLogged;
    }
    if (ctx.input.justPressed("fastStop")) this.#moving = false;
    if (this.#moving) {
      this.#requestedAnchorX = Math.min(1, this.#mast.position.x + dt * 0.25);
      this.#mast.position.x = this.#requestedAnchorX;
    }
    if (this.#anchorInputPending && !this.#anchorInputLogged) {
      this.#anchorInputLogged = true;
      console.log(
        `TN_AVBD_ANCHOR_INPUT:${JSON.stringify({
          solverStep: this.#rigging?.steps ?? this.#cloth[0]?.steps ?? 0,
          edge: ctx.input.justPressed("moveAnchor"),
          held: ctx.input.raw.keys.has("KeyA"),
          requests: this.#anchorMoveRequests,
          moving: this.#moving,
          requestedX: this.#requestedAnchorX,
          previousAcceptedX: this.#previousAcceptedAnchor,
        })}`,
      );
    }
    for (const [action, speed, gust] of [
      ["still", 0, 0],
      ["stepWind", 6, 0],
      ["gustWind", 6, 0.4],
    ] as const)
      if (ctx.input.justPressed(action)) {
        this.#speed = speed;
        this.#gust = gust;
      }
    this.#setWind();
    if (ctx.input.justPressed("probe")) this.#probe(ctx);
    if (ctx.input.justPressed("cycles") && this.#rigging !== undefined) {
      this.#cycling = true;
      this.#cycleTarget = lifetime.completed + 50;
    }
    // One explicit cycle request per scene; the next load awaits the old scene's real GPU teardown.
    if (this.#cycling && this.#rigging !== undefined && this.#rigging.steps >= 2) {
      this.#cycling = false;
      pendingCycleTarget = this.#cycleTarget;
      void ctx.goto("candidate");
    }
  }

  #setWind(): void {
    const tick = this.#rigging?.steps ?? this.#cloth[0]?.steps ?? 0;
    const t = tick / 60;
    // The authored temporal gust drives both arms; pinned spatial gust remains disabled.
    const speed =
      this.#speed *
      (1 +
        this.#gust * (0.5 * Math.sin(1.1 * t) + 0.3 * Math.sin(2.9 * t) + 0.2 * Math.sin(6.1 * t)));
    this.#rigging?.setWind(speed, -Math.PI / 2, 0);
    for (const [i, cloth] of this.#cloth.entries()) {
      const patch = requiredAt(this.#input.patches, i);
      const area =
        (((patch.width / (patch.columns - 1)) * patch.height) / (patch.rows - 1)) * 0.92 ** 2;
      // Initial flat-plate pressure mapping only: uniform spring acceleration differs from AVBD's normal/velocity drag.
      const coefficient = (0.72 * area) / (patch.totalMass / (patch.columns * patch.rows));
      cloth.wind.set(0, 0, coefficient * speed ** 2);
    }
  }

  #probe(ctx: ICtx<IRiggingState, IPhysicsContext>): void {
    if (this.#rigging === undefined || this.#checking) return;
    this.#checking = true;
    const rigging = this.#rigging;
    void rigging
      .checkFinite()
      .then(
        (sample) => {
          if (rigging.released) return;
          this.#checks = {
            finiteTicks: sample.ticks,
            nonfinitePositions: sample.nonfinitePositions,
            nonfiniteRotations: sample.nonfiniteRotations,
            overflow: sample.overflow,
            colorClashes: sample.colorClashes,
            contactsMaximum: sample.contactsMaximum,
          };
          ctx.state.set(this.#checks);
          ctx.state.flush();
        },
        (error: unknown) => {
          if (!rigging.released) {
            this.#observationFailures += 1;
            ctx.state.set({
              observationFailures: this.#observationFailures,
              observationError: String(error),
            });
            ctx.state.flush();
          }
        },
      )
      .finally(() => {
        this.#checking = false;
      });
  }

  override render(ctx: ICtx<IRiggingState, IPhysicsContext>): void {
    const held = ctx.input.raw.keys.has("KeyP");
    if (this.#benchmarkRun === undefined && held && !this.#pauseHeld) {
      this.#paused = !this.#paused;
      this.#pausedAt = this.#rigging?.steps ?? this.#cloth[0]?.steps ?? 0;
      if (this.#paused) game.pause();
      else game.resume();
    }
    this.#pauseHeld = held;
    const rigging = this.#rigging;
    const steps = rigging?.steps ?? this.#cloth[0]?.steps ?? 0;
    const benchmark = this.#benchmark;
    if (benchmark !== undefined && benchmarkFailures === 0) {
      try {
        if (!this.#readyStarted) {
          this.#readyStarted = true;
          void this.#prepareBenchmark(ctx).catch((error: unknown) => {
            if (!this.#exited) benchmarkFailure(error);
          });
        }
        const rows = benchmark.render(performance.now(), this.#paused, {
          ready:
            this.#readiness !== undefined &&
            ctx.startup.phase === "ready" &&
            ctx.startup.compileSettled,
          compiling: ctx.renderer.compiling ?? true,
          compileCount: ctx.renderer.compileCount ?? -1,
          census: ctx.renderer.pipelineCensus?.(),
        });
        if (rows !== undefined)
          void this.#finishBenchmark(ctx, rows).catch((error: unknown) => {
            if (this.#exited) return;
            this.#pausedAt = steps;
            this.#paused = true;
            benchmarkFailure(error);
          });
      } catch (error) {
        this.#pausedAt = steps;
        this.#paused = true;
        benchmarkFailure(error);
      }
    }
    const state: Partial<IRiggingState> = {
      steps,
      benchmarkFrames: benchmark?.frames ?? 0,
      benchmarkCompleted: benchmarkResults.length,
      // Monotone pacing counter for staged scenario waits; a sealed window counts once, via completion.
      benchmarkProgress: benchmarkResults.length * 2100 + ((benchmark?.frames ?? 0) % 2100),
      benchmarkFailures,
      benchmarkRun: this.#benchmarkRun?.id ?? "off",
      benchmarkResults,
      anchorX: this.#mast.position.x,
      acceptedAnchorVelocity: this.#acceptedAnchorVelocity,
      acceptedAnchorMoving:
        Number.isFinite(this.#acceptedAnchorVelocity) && this.#acceptedAnchorVelocity >= 0.24,
      acceptedAnchorDelta: this.#acceptedAnchorDelta,
      anchorMoveRequests: this.#anchorMoveRequests,
      anchorMoving: Number(this.#moving),
      requestedAnchorX: this.#requestedAnchorX,
      fixedColorsValidated: Number(rigging?.fixedColorsValidated ?? false),
      windSpeed: this.#speed,
      gustStrength: this.#gust,
      staleTicks: steps,
      paused: Number(this.#paused),
      pauseKeyHeld: Number(held),
      pausedAdditionalSteps: this.#paused ? steps - this.#pausedAt : 0,
      completedCycles: lifetime.completed,
      releasedBuffers: lifetime.buffers,
      releasedBytes: lifetime.bytes,
      releasedStorage: lifetime.storage,
      releasedQuerySets: lifetime.queries,
      deviceMismatch: lifetime.deviceMismatch,
      lifecycleFailures: lifetime.lifecycleFailures,
      lifecycleObserved: cycleReceipts.length,
      cleanupFailed: lifetime.failed,
      observationFailures: this.#observationFailures,
      readbackFailures: rigging?.readbackStats.failures ?? 0,
      ...this.#checks,
    };
    if (rigging !== undefined) {
      const registry = registrations.snapshot;
      Object.assign(state, {
        registryCount: registry.registrations,
        registryBaseline: registry.baseline,
        cycleReceipts,
        rendererControl,
      });
    }
    const sample = rigging?.observation;
    if (sample !== undefined)
      Object.assign(state, { staleTicks: sample.staleTicks, readbackBytes: sample.totalBytes });
    if (sample !== undefined && rigging !== undefined && sample.fixedStep !== this.#observedStep) {
      this.#observedStep = sample.fixedStep;
      const positions = riggingPositions(rigging.model, sample.bodies);
      const measures = measurePositions(rigging.model, positions);
      const penetration = measureProxyPenetration(rigging.model, sample.bodies, {
        previousMaximum: this.#penetrationMaximum ?? 0,
        capture: (witness) => {
          this.#penetrationPeak = {
            ...witness,
            solverRevision: riggingComparison.solver,
            frame: "solver z-up → authored y-up: [x,z,-y]",
            generation: sample.generation,
            sampledFixedStep: sample.fixedStep,
            observedFixedStep: steps,
            staleTicks: sample.staleTicks,
            bytes: sample.bytes,
            totalBytes: sample.totalBytes,
          };
        },
      });
      this.#sampleMeasures = measures;
      this.#penetrationMaximum = Math.max(this.#penetrationMaximum ?? penetration, penetration);
      Object.assign(state, {
        measured: 1,
        sailStretch: measures.sailStretchP95,
        sailEdgeError: measures.sailEdgeErrorP95,
        ropeExtension: measures.ropeExtensionMaximum,
        penetration,
        penetrationMaximum: this.#penetrationMaximum,
        staleTicks: sample.staleTicks,
        readbackBytes: sample.totalBytes,
        readbackFailures: rigging.readbackStats.failures,
      });
    }
    if (
      sample !== undefined &&
      this.#sampleMeasures !== undefined &&
      this.#penetrationMaximum !== undefined
    ) {
      state.sampleChecks = riggingSampleChecks({
        ...this.#sampleMeasures,
        penetrationMaximum: this.#penetrationMaximum,
        readbackBytes: sample.totalBytes,
        staleTicks: sample.staleTicks,
      });
      state.penetrationPeak = this.#penetrationPeak;
    }
    if (this.mode === "spring") {
      state.readbackFailures = this.#cloth.reduce((sum, cloth) => sum + cloth.readbackFailures, 0);
      state.readbackBytes = this.#cloth.reduce((sum, cloth) => sum + cloth.readbackBytes, 0);
    }
    const sail = this.#cloth.find((cloth) => cloth.name === "sail");
    const springSample = sail?.sample;
    if (springSample !== undefined && sail !== undefined) {
      state.staleTicks = springSample.staleFrames;
      const sampleTick = sail.steps - springSample.staleFrames;
      if (sampleTick !== this.#observedStep) {
        this.#observedStep = sampleTick;
        const measured = measureSailPositions(this.#topology, springSample.data);
        Object.assign(state, {
          measured: 1,
          sailStretch: measured.sailStretchP95,
          sailEdgeError: measured.sailEdgeErrorP95,
        });
      }
      // Ropes and proxy penetration remain unmeasured in this arm; no rest-pose substitute.
    }
    if (pendingCycleTarget > lifetime.completed && !this.#cycling) {
      this.#cycling = true;
      this.#cycleTarget = pendingCycleTarget;
    }
    ctx.state.set(state);
    ctx.state.flush();
  }

  async #prepareBenchmark(ctx: ICtx<IRiggingState, IPhysicsContext>): Promise<void> {
    await ctx.startup.whenReady();
    if (this.#exited) return;
    const warmup = await warmUpScene(ctx.renderer, ctx.scene, ctx.camera);
    if (this.#exited) return;
    if (
      warmup.unsupported ||
      warmup.timedOut ||
      warmup.abandoned !== 0 ||
      warmup.observed.status !== "complete" ||
      warmup.observed.failed !== 0 ||
      warmup.observed.pending !== 0
    )
      throw new Error(
        "TN_RIGGING_TIMING_READINESS: scene pipeline warmup is incomplete or failed.",
      );
    const bridge = (globalThis as IPlaytestBridgeHost)[PLAYTEST_BRIDGE_GLOBAL];
    if (bridge === undefined)
      throw new Error("TN_RIGGING_TIMING_CLOCK: actual producer bridge is absent.");
    const { clock } = await bridge.sample({ entities: [], resources: [] });
    if (this.#exited) return;
    if (
      clock.mode !== "wall-clock" ||
      !Number.isFinite(clock.timeMs) ||
      !Number.isSafeInteger(clock.tick)
    )
      throw new Error(
        "TN_RIGGING_TIMING_CLOCK: actual producer is not an observed live fixed-step pump.",
      );
    this.#readiness = {
      run: this.#benchmarkRun?.id,
      clock,
      warmup,
      startup: {
        phase: ctx.startup.phase,
        compileSettled: ctx.startup.compileSettled,
        timeline: ctx.startup.timeline,
        warmup: ctx.startup.warmup,
      },
      compiling: ctx.renderer.compiling,
      compileCount: ctx.renderer.compileCount,
    };
    console.log(`TN_AVBD_TIMING_READY:${JSON.stringify(this.#readiness)}`);
  }

  async #finishBenchmark(
    ctx: ICtx<IRiggingState, IPhysicsContext>,
    rows: readonly ISecondaryFrameSample[],
  ): Promise<void> {
    const run = this.#benchmarkRun;
    if (run === undefined)
      throw new Error("TN_RIGGING_TIMING_MEMBERSHIP: final run identity is absent.");
    const rigging = this.#rigging;
    let quality: Record<string, unknown>;
    if (rigging !== undefined) {
      const sample = await rigging.observeBodies();
      if (sample.staleTicks !== 0)
        throw new Error("TN_RIGGING_OBSERVATION_STALE: primary window resumed before observation.");
      quality = {
        ...measurePositions(rigging.model, riggingPositions(rigging.model, sample.bodies)),
        proxyPenetration: measureProxyPenetration(rigging.model, sample.bodies),
        fixedStep: sample.fixedStep,
        staleTicks: sample.staleTicks,
        bytes: sample.bytes,
        finite: run.diagnostics ? await rigging.checkFinite() : "separate10000tick correctness run",
      };
    } else {
      const observations = await Promise.all(
        this.#cloth.map((cloth, index) => {
          const patch = requiredAt(this.#input.patches, index);
          return cloth.observePositions(patch.columns * patch.rows);
        }),
      );
      const sail = requiredAt(
        observations,
        this.#cloth.findIndex((cloth) => cloth.name === "sail"),
      );
      if (
        observations.some(
          (sample) => sample.staleTicks !== 0 || sample.fixedStep !== sail.fixedStep,
        )
      )
        throw new Error(
          "TN_RIGGING_OBSERVATION_STALE: independent patches differ in final fixed tick.",
        );
      quality = {
        ...measureSailPositions(this.#topology, sail.positions),
        fixedStep: sail.fixedStep,
        staleTicks: 0,
        bytes: observations.reduce((total, sample) => total + sample.bytes, 0),
        ropeExtensionMaximum: null,
        proxyPenetration: null,
        ropeDisposition: "no incumbent counterpart",
      };
    }
    if (this.#exited) return;
    const result = {
      run,
      summary: summarizeRiggingRun(rows),
      quality,
      frozen: riggingComparison,
      readiness: this.#readiness,
      admission: this.#benchmark?.admission,
    };
    publishRiggingRows(run, rows);
    const text = JSON.stringify(result);
    console.log(`TN_AVBD_TIMING_RESULT:${text}`);
    // Game state must stay JSON-safe for the playtest bridge; keep exactly what the console marker carries.
    benchmarkResults.push(JSON.parse(text) as typeof result);
    benchmarkIndex += 1;
    const next = riggingRuns[benchmarkIndex];
    if (next === undefined) benchmarkIndex = -1;
    // goto retires this scene synchronously; transition failures still belong to the complete attempt.
    await ctx.goto(next?.arm ?? "candidate").catch(benchmarkFailure);
  }

  async #releaseSpringTimings(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#springTimings?.retire();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#springScope?.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#springLease?.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "TN_RIGGING_TIMING_RELEASE: spring owned resources failed to retire.",
      );
  }

  override exit(): void {
    this.#exited = true;
    this.#benchmark?.retire();
    if (this.#springScope !== undefined) {
      const retirement = this.#releaseSpringTimings();
      retirements.push(retirement);
      void retirement.catch(() => undefined);
    }
    game.resume();
    const rigging = this.#rigging;
    if (rigging !== undefined) {
      rigging.detach();
      const retirement = rigging
        .whenReleased()
        .then(() => {
          const owned = rigging.resources;
          lifetime.buffers = owned.buffers;
          lifetime.bytes = owned.bytes;
          lifetime.storage = owned.sharedStorage;
          lifetime.queries = owned.querySets;
          const registry = registrations.snapshot;
          if (this.#renderer === undefined || this.#storageBaseline === undefined)
            throw new Error("TN_RIGGING_RESOURCES: lifecycle baseline is missing.");
          const storage = observeStorage(this.#renderer.info);
          const baseline = this.#storageBaseline;
          const pass =
            owned.buffers === 0 &&
            owned.bytes === 0 &&
            owned.querySets === 0 &&
            owned.sharedStorage === 0 &&
            registry.registrations === registry.baseline &&
            Object.keys(storage).every(
              (key) => Reflect.get(storage, key) === Reflect.get(baseline, key),
            ) &&
            rigging.sharedDevice === lifetime.device;
          if (!pass) lifetime.lifecycleFailures += 1;
          if (cycleReceipts.length >= 256)
            throw new Error(
              "TN_RIGGING_RESOURCES: bounded lifecycle receipt capacity 256 exceeded.",
            );
          const receipt = {
            cycle: lifetime.completed + 1,
            generation: rigging.generation,
            owned,
            registry,
            baseline,
            storage,
            sameDevice: rigging.sharedDevice === lifetime.device,
            pass,
          };
          console.log(`TN_AVBD_LIFETIME:${JSON.stringify(receipt)}`);
          cycleReceipts.push(receipt);
          lifetime.completed += 1;
        })
        .catch((error: unknown) => {
          lifetime.failed += 1;
          throw error;
        });
      retirements.push(retirement);
      void retirement.catch(() => undefined);
      disposeDraw(rigging);
    }
    for (const cloth of this.#cloth) {
      cloth.detach();
      const retirement = cloth.whenReleased().then(() => {
        disposeDraw(cloth);
      });
      retirements.push(retirement);
      void retirement.catch(() => undefined);
    }
    disposeDraw(this.#mast);
    disposeDraw(this.#draw);
    this.#proxies.clear();
  }
}

// The existing harness chooses exact fixed steps by default; timing runs explicitly opt into live clock.
let rendererControl: Record<string, unknown> | undefined;
let pendingCycleTarget = 0;
class SpringScene extends RiggingScene {
  protected override readonly mode = "spring" as const;
}
const game = defineGame<IRiggingState, IPhysicsContext>({
  input: {
    benchmark: { keys: ["KeyB"] },
    candidate: { keys: ["Digit1"] },
    spring: { keys: ["Digit2"] },
    reset: { keys: ["KeyR"] },
    moveAnchor: { keys: ["KeyA"] },
    fastStop: { keys: ["KeyS"] },
    still: { keys: ["KeyZ"] },
    stepWind: { keys: ["Space"] },
    gustWind: { keys: ["KeyG"] },
    probe: { keys: ["KeyC"] },
    cycles: { keys: ["KeyL"] },
  },
  plugins: [
    {
      setup: () => {
        registrations.install();
        return () => registrations.dispose();
      },
    },
    rapier({ deterministicRestart: true }),
    playtest(),
  ],
  render: { preferWebGPU: true, resolutionScale: 1 },
  display: { maxFps: 60 },
  seed: 446,
  scenes: { candidate: RiggingScene, spring: SpringScene },
  start: "candidate",
  step: 1 / 60,
});
export default game;
