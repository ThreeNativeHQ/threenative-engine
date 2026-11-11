import {
  Box2,
  Box3,
  type Camera,
  type Color,
  type CoordinateSystem,
  CubeCamera,
  Frustum,
  Matrix4,
  Mesh,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector2,
  Vector3,
} from "three";
import {
  Fn,
  abs,
  clamp,
  cubeTexture,
  float,
  floor,
  int,
  length,
  normalWorld,
  normalize,
  positionWorld,
  select,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
  viewportCoordinate,
} from "three/tsl";
import {
  ClampToEdgeWrapping,
  CubeRenderTarget,
  Data3DTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NodeMaterial,
  RGBAFormat,
  RenderTarget,
  RenderTarget3D,
} from "three/webgpu";
import type { Node, TextureNode } from "three/webgpu";
import type { IComputeDriven } from "../compute-driven.js";
import type { IRendererLike } from "../renderer.js";
import {
  BACKFACE_REJECTION_SHARE,
  type ILightingKey,
  type IProbeTraceKernels,
  type IProbeTraceLighting,
  type IProbeTraceScene,
  applyTraceLighting,
  createProbeTraceKernels,
  fillRejectedProbes,
  lightingKey,
  lightingStepped,
  threadScene,
  writeMaterialTable,
} from "./probe-trace.js";

/** The atlas has one copied edge texel on either side of each packed SH sub-volume. */
export const ATLAS_PADDING = 1;

/** The machine-readable marker emitted whenever the probe state changes. */
export const PROBE_VOLUME_MARKER = "TN_PROBE_VOLUME";

const SH_COEFFICIENT_COUNT = 9;
const SH_CHANNEL_COUNT = 3;
const PACKED_SUB_VOLUME_COUNT = 7;
const CUBE_FACE_COUNT = 6;
const CAPTURE_WORK_ITEMS_PER_PROBE = CUBE_FACE_COUNT + 2;
// The upstream shader ABI always samples a one-texel-padded layout. Keeping this independent from
// the storage constant makes a storage mutation observable at the public sampling boundary.
const SAMPLE_ATLAS_PADDING = 1;
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;
const BYTES_PER_TEXEL = 4 * BYTES_PER_FLOAT;
/** A traced refresh starts at the PRD-603 gate's 16 probes a frame, then follows the measured GPU cost. */
const TRACE_START_PROBES = 16;
const BAKE_BUDGET_SLACK_MS = 0.5;
const SCENE_WARMUP_TIMEOUT_MS = 2_000;

type IVector3Like = { readonly x: number; readonly y: number; readonly z: number };
type IProbePosition = Vector3 | Node<"vec3">;

/** One RGB L2 spherical-harmonic coefficient, in the upstream probe ordering. */
export interface IProbeVolumeCoefficient {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Probe density in probes per world unit, either isotropic or per-axis. */
export type ProbeVolumeDensity = number | readonly [number, number, number] | IVector3Like;

export interface IProbeVolumeOptions {
  /** World-space bounds; the volume does not move with the object after construction. */
  readonly bounds: Box3 | { readonly min: IVector3Like; readonly max: IVector3Like };
  /** Probe spacing expressed as probes per world unit. */
  readonly density: ProbeVolumeDensity;
  /**
   * Where the atlas is rendered. `auto` (default) probes the device: a host that rejects a 3D render
   * attachment (wgpu-native) renders each slice into a 2D target and copies it into the 3D atlas,
   * and a host that accepts one renders into the atlas directly. `render3d` and `copy` force a path.
   */
  readonly atlasTarget?: "auto" | "render3d" | "copy";
  /** Optional device limit supplied by a host that knows it before construction. */
  readonly maxTextureDimension3D?: number;
  /** Alias for integrations that expose the WebGPU limit under a device-oriented name. */
  readonly deviceTextureLimit?: number;
  /**
   * Maximum wall-clock work per render phase, in milliseconds. A work item that outruns it fails the
   * bake, except on a CPU rasteriser (the renderer's `softwareAdapter`), where `bakeCostMs` reports it.
   */
  readonly bakeBudgetMs?: number;
  /** Additional guard that keeps a clock-less host from processing an unbounded queue. */
  readonly maxWorkItemsPerFrame?: number;
  /** Resolution of each captured cube face. The static-lighting default is intentionally small. */
  readonly cubemapSize?: number;
  readonly near?: number;
  readonly far?: number;
  /** Additional indirect passes after the direct-light pass. */
  readonly bounces?: number;
  /** Injectable clock for deterministic scheduling tests. */
  readonly now?: () => number;
  readonly report?: (line: string) => void;
  /**
   * Refresh probes by tracing a GPUSceneBVH (PRD-603) instead of drawing the scene six times per probe.
   * The default is `trace` when `trace` inputs are given and `capture` otherwise. `capture` is the named
   * override for scenes that need textured albedo or local lights in their bounce.
   */
  readonly update?: "capture" | "trace";
  /** The traced refresh's inputs: the packed scene, and the sun and sky the game already holds. */
  readonly trace?: IProbeVolumeTrace;
  /** Most probes one frame traces (Unreal's r.Lumen.RadianceCache.NumProbesToTraceBudget, 100). */
  readonly numProbesToTraceBudget?: number;
  /**
   * A fixed batch: probes traced a frame, up to `numProbesToTraceBudget`, whatever the GPU reports. Unset, the batch follows
   * the measured GPU time toward `bakeBudgetMs` and stays at 16 where the adapter reports none (the owned engine today). A
   * capture that must trace a whole field before its frame sets it; a game leaves it unset.
   */
  readonly probesPerFrame?: number;
  /**
   * Rays per probe along one side: `probeResolution` squared rays. The default is 8 (64 rays), the cost gate's
   * figure: an Intel Xe traces about 0.09 ms a probe at 8 and 0.41 ms at 32 (1,024 rays, Unreal's radiance-cache
   * ProbeResolution). A small emitter far from a probe needs the larger value to be hit at all.
   */
  readonly probeResolution?: number;
  /**
   * Cells per side of an octahedral radiance map per probe, beside the SH: the traced rays binned by direction, as
   * Unreal's radiance cache stores 32 x 32 radiance per probe (UE 5.8.3:
   * Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp:641, GRadianceCacheProbeResolution).
   * `sampleRadianceNode` then reads the map, sharp where SH L2 smears a coloured wall across the sphere. 0 (the default)
   * keeps SH only. Traced refresh only.
   */
  readonly radianceProbeResolution?: number;
  /**
   * Weight each of the eight probes a read blends by Unreal's depth test: a probe whose map depth toward the read point is
   * shorter than the point's distance sees a surface first, so it sits behind a wall and drops out (UE 5.8.3:
   * Engine/Shaders/Private/Lumen/LumenRadianceCacheInterpolation.ush:390, `StepHitDistanceFromProbe` against
   * `StepRayDistanceFromProbeSq`). Stops light leaking through a wall thinner than a probe spacing. Needs
   * `radianceProbeResolution`. Off by default.
   */
  readonly probeVisibility?: boolean;
}

/** What a traced refresh reads. Every value is the game's: the volume owns no light and no colour. */
export interface IProbeVolumeTrace {
  /** A GPUSceneBVH, or anything with its CPU snapshot and version. */
  readonly bvh: { readonly traceScene: IProbeTraceScene; readonly version: number };
  /** World direction toward the sun, its linear colour and its intensity; read every frame. */
  readonly sun: { readonly direction: Vector3; readonly color: Color; readonly intensity: number };
  /** Radiance of a ray that leaves the scene; black for a closed interior. Read every frame. */
  readonly sky: Color;
  /** Point lights read every frame; the first `points.length` at build are traced (see `IProbeTraceLighting`). */
  readonly points?: IProbeTraceLighting["points"];
  /** The view whose frustum marks probes as in use, so they refresh first. Absent: none ranks first. */
  readonly camera?: Camera;
}

export interface IProbeVolumeBakeProgress {
  readonly completed: number;
  readonly total: number;
  readonly fraction: number;
  readonly probesCompleted: number;
  readonly probesTotal: number;
  readonly pass: number;
  readonly passes: number;
}

export interface IProbeVolumeObservation {
  readonly marker: typeof PROBE_VOLUME_MARKER;
  readonly status: "unbaked" | "baking" | "ready";
  readonly stale: boolean;
  readonly unbaked: boolean;
  /** `null` means no completed bake has established an age yet. */
  readonly stalenessFrames: number | null;
  readonly probeCount: number;
  readonly atlasBytes: number;
  readonly atlas: { readonly width: number; readonly height: number; readonly depth: number };
  readonly bakeProgress: IProbeVolumeBakeProgress;
  /** Wall-clock time spent by the most recent incremental render-phase slice. */
  readonly bakeCostMs: number;
  readonly bakeBudgetMs: number;
  /** True while pass zero samples a black texture instead of a previous bake. */
  readonly samplingIsolated: boolean;
  /** Which refresh ran: `capture` (six scene draws a probe) or `trace` (one dispatch). Absent means capture. */
  readonly update?: "capture" | "trace";
  /** Trace path: probes traced in the last frame. */
  readonly probesTraced?: number;
  /** Trace path: probes of the last field that sat inside a solid or behind a wall, filled from open neighbours. */
  readonly probesRejected?: number;
  /** Trace path: frames since the least recently traced probe was traced, `null` while one never was. */
  readonly oldestProbeAgeFrames?: number | null;
  /** Trace path: materials whose texture or node graph the flat material table ignored. */
  readonly ignoredTextureMaterials?: number;
}

/** Read a complete marker-shaped observation without accepting malformed data. */
export function readProbeVolumeObservation(value: unknown): IProbeVolumeObservation | undefined {
  return isProbeVolumeObservation(value) ? value : undefined;
}

interface IProbeDevice {
  readonly limits?: Record<string, unknown>;
  readonly createTexture?: (descriptor: unknown) => { readonly destroy?: () => void };
  readonly popErrorScope?: () => Promise<unknown>;
  readonly pushErrorScope?: (filter: string) => void;
}

interface IProbeRenderer {
  readonly autoClear?: boolean;
  readonly compileAsync?: (scene: Object3D, camera: Camera) => Promise<void>;
  readonly coordinateSystem?: CoordinateSystem;
  readonly backend?: { readonly device?: IProbeDevice };
  readonly device?: IProbeDevice;
  readonly initTexture?: (texture: unknown) => void;
  readonly shadowMap?: { autoUpdate: boolean; needsUpdate: boolean };
  readonly toneMapping?: number;
  readonly toneMappingExposure?: number;
  readonly getRenderTarget?: () => unknown;
  readonly getActiveCubeFace?: () => number;
  readonly getActiveMipmapLevel?: () => number;
  readonly reversedDepthBuffer?: boolean;
  readonly clearDepth?: () => void;
  readonly render: (scene: Object3D, camera: Camera) => void;
  readonly copyTextureToTexture?: (
    source: unknown,
    destination: unknown,
    sourceRegion?: unknown,
    destinationPosition?: unknown,
  ) => void;
  readonly setRenderTarget: (
    target: unknown,
    activeCubeFace?: number,
    activeMipmapLevel?: number,
  ) => void;
  readonly xr?: { enabled: boolean };
}

interface IPendingBake {
  readonly scene: Scene;
  passes: number;
  pass: number;
  phase: "capture" | "project" | "copy" | "repack";
  cubeFaceIndex: number;
  probeIndex: number;
  repackIndex: number;
  completedWork: number;
  completedProbes: number;
  totalWork: number;
}

interface IBakePromise {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface ISceneState {
  readonly scene: Scene;
  readonly matrixWorldAutoUpdate: boolean;
  readonly shadowAutoUpdate?: boolean;
}

const PACKED_CHANNELS: readonly (readonly [number, number] | null)[] = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [2, 0],
  [2, 1],
  [2, 2],
  [3, 0],
  [3, 1],
  [3, 2],
  [4, 0],
  [4, 1],
  [4, 2],
  [5, 0],
  [5, 1],
  [5, 2],
  [6, 0],
  [6, 1],
  [6, 2],
  [7, 0],
  [7, 1],
  [7, 2],
  [8, 0],
  [8, 1],
  [8, 2],
  null,
];

/**
 * A WebGPU irradiance probe volume.
 *
 * The volume owns placement, GPU bake scheduling and a single padded atlas. It owns no light,
 * material or colour: every coefficient comes from the scene rendered by its cube cameras. Add it
 * through `ctx.add()` so `process()` runs in the render phase measured by `FrameBudget`.
 *
 * Bakes are static-lighting-first and explicit. Call `requestBake(scene)` after lights and static
 * geometry are authored; a completed bake is reused until the game requests another one.
 */
export class ProbeVolume extends Object3D implements IComputeDriven {
  readonly isProbeVolume = true;
  readonly processCadence = "render" as const;
  readonly warmupNodes: readonly unknown[] = [];
  readonly boundingBox: Box3;
  readonly resolution: Vector3;
  readonly #boundsSize: Vector3;
  readonly #density: Vector3;
  readonly #atlasDepth: number;
  readonly #atlasBytes: number;
  readonly #probeCount: number;
  readonly #atlasData: Float32Array;
  readonly #coefficients: Float32Array;
  readonly #atlasNode;
  readonly #emptyAtlasTexture: Data3DTexture;
  readonly #boundsMinNode;
  readonly #boundsSizeNode;
  readonly #report: (line: string) => void;
  readonly #now: () => number;
  readonly #bakeBudgetMs: number;
  readonly #maxWorkItemsPerFrame: number;
  readonly #cubemapSize: number;
  readonly #near: number;
  readonly #far: number;
  readonly #bounces: number;
  #bakePasses: number;
  #atlasTexture: Data3DTexture;
  #renderer: IRendererLike | undefined;
  #cubeRenderTarget: CubeRenderTarget | undefined;
  #cubeCamera: CubeCamera | undefined;
  #projectionTarget: RenderTarget | undefined;
  #batchTarget: RenderTarget | undefined;
  #atlasTarget: RenderTarget3D | undefined;
  #sliceTarget: RenderTarget | undefined;
  readonly #requestedAtlasTarget: "auto" | "render3d" | "copy";
  #atlasMode: "render3d" | "copy" | undefined;
  #atlasProbeStarted = false;
  #atlasUploaded = false;
  #quadScene: Scene | undefined;
  #quadCamera: OrthographicCamera | undefined;
  #quadMesh: Mesh | undefined;
  #projectionMaterial: NodeMaterial | undefined;
  #repackMaterials: NodeMaterial[] | undefined;
  #repackSlice = uniform(0, "int");
  #batchTextureNode: TextureNode | undefined;
  #gpuWarmupStarted = false;
  #gpuWarmupSettled = true;
  #sceneWarmupStarted = false;
  #sceneWarmupSettled = true;
  #pending: IPendingBake | undefined;
  #bakePromise: IBakePromise | undefined;
  #sceneState: ISceneState | undefined;
  #status: IProbeVolumeObservation["status"] = "unbaked";
  #stalenessFrames: number | null = null;
  #lastBakeCostMs = 0;
  #maxWorkItemCostMs = 0;
  #samplingIsolated = false;
  #lastReported = "";
  #released = false;
  // The traced refresh (PRD-603). Undefined on a capture volume.
  readonly #trace: IProbeVolumeTrace | undefined;
  readonly #traceBudget: number;
  /** Probes traced a frame now: it follows the measured GPU cost toward `bakeBudgetMs`, up to the budget. */
  #traceRate = 0;
  /** `probesPerFrame` was set: the GPU reading never moves the batch. */
  readonly #fixedTraceRate: boolean;
  /** The last four batch sizes: a timestamp arrives frames late, so a reading is charged to the smallest of them. */
  #recentBatches: number[] = [];
  readonly #raysPerProbe: number;
  readonly #mapResolution: number;
  readonly #visibility: boolean;
  #radianceMapTexture?: DataTexture;
  #kernels: IProbeTraceKernels | undefined;
  #kernelVersion = -1;
  #ignoredTextureMaterials = 0;
  /** Per probe: 1 while it waits for a trace. */
  #lightingKey: ILightingKey | undefined;
  #traceStale: Uint8Array;
  /** Per probe: the frame of its last trace, -1 before the first. */
  #lastTraced: Int32Array;
  /** Per probe: the last frame it sat inside the camera frustum, -1 before. */
  #lastUsed: Int32Array;
  #frame = 0;
  #probesTraced = 0;
  #tracePass = 0;
  #tracePasses = 1;
  #traceCompleted = 0;
  #generations = 0;
  #dispatchSerial = 0;
  #readbackSerial = 0;
  /** Probes of the last traced field that sat inside a solid or behind a wall, filled from their open neighbours. */
  #probesRejected = 0;
  #readbackInFlight = false;
  #passSerial = -1;
  readonly #frustum = new Frustum();
  readonly #viewProjection = new Matrix4();

  constructor(options: IProbeVolumeOptions) {
    super();
    this.#report = options.report ?? ((line) => console.info(line));
    this.#now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.#bakeBudgetMs = positiveNumber(options.bakeBudgetMs ?? 2, "bakeBudgetMs");
    this.#requestedAtlasTarget = options.atlasTarget ?? "auto";
    this.#maxWorkItemsPerFrame = positiveInteger(
      options.maxWorkItemsPerFrame ?? 1,
      "maxWorkItemsPerFrame",
    );
    this.#cubemapSize = positiveInteger(options.cubemapSize ?? 8, "cubemapSize");
    this.#near = positiveNumber(options.near ?? 0.1, "near");
    this.#far = positiveNumber(options.far ?? 100, "far");
    if (this.#far <= this.#near) throw new Error("ProbeVolume far must be greater than near.");
    this.#bounces = nonNegativeInteger(options.bounces ?? 0, "bounces");
    this.#bakePasses = this.#bounces + 1;
    const update = options.update ?? (options.trace === undefined ? "capture" : "trace");
    if (update !== "capture" && update !== "trace")
      throw new Error(
        `ProbeVolume update must be "capture" or "trace", received ${String(update)}.`,
      );
    if (update === "trace" && options.trace === undefined)
      throw new Error('ProbeVolume update "trace" needs trace inputs: { bvh, sun, sky }.');
    this.#trace = update === "trace" ? options.trace : undefined;
    this.#traceBudget = positiveInteger(
      options.numProbesToTraceBudget ?? 100,
      "numProbesToTraceBudget",
    );
    this.#fixedTraceRate = options.probesPerFrame !== undefined;
    this.#traceRate = Math.min(
      this.#traceBudget,
      options.probesPerFrame === undefined
        ? TRACE_START_PROBES
        : positiveInteger(options.probesPerFrame, "probesPerFrame"),
    );
    const probeResolution = positiveInteger(options.probeResolution ?? 8, "probeResolution");
    this.#raysPerProbe = probeResolution * probeResolution;
    this.#mapResolution =
      options.radianceProbeResolution === undefined || options.radianceProbeResolution === 0
        ? 0
        : positiveInteger(options.radianceProbeResolution, "radianceProbeResolution");
    this.#visibility = options.probeVisibility === true;
    if (this.#visibility && this.#mapResolution === 0)
      throw new Error(
        "ProbeVolume probeVisibility needs radianceProbeResolution (the map holds the depth).",
      );

    const normalizedBounds = normalizeBounds(options.bounds);
    this.boundingBox = normalizedBounds;
    this.#boundsSize = normalizedBounds.max.clone().sub(normalizedBounds.min);
    this.#density = normalizeDensity(options.density);
    this.resolution = new Vector3(
      resolutionForAxis(this.#boundsSize.x, this.#density.x, "x"),
      resolutionForAxis(this.#boundsSize.y, this.#density.y, "y"),
      resolutionForAxis(this.#boundsSize.z, this.#density.z, "z"),
    );
    this.#atlasDepth = checkedAtlasDepth(this.resolution.z);
    const maximumDimension = Math.max(this.resolution.x, this.resolution.y, this.#atlasDepth);
    const suppliedLimit = options.maxTextureDimension3D ?? options.deviceTextureLimit;
    if (suppliedLimit !== undefined) {
      validateTextureLimit(suppliedLimit);
      assertTextureLimit(maximumDimension, suppliedLimit);
    }
    this.#probeCount = checkedIntegerProduct(
      this.resolution.x,
      this.resolution.y,
      this.resolution.z,
      "probe count",
    );
    const texelCount = checkedIntegerProduct(
      this.resolution.x,
      this.resolution.y,
      this.#atlasDepth,
      "atlas texel count",
    );
    this.#atlasBytes = texelCount * BYTES_PER_TEXEL;
    this.#atlasData = new Float32Array(texelCount * 4);
    this.#coefficients = new Float32Array(
      this.#probeCount * SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT,
    );
    this.#atlasTexture = createCpuAtlas(this.#atlasData, this.resolution, this.#atlasDepth);
    this.#emptyAtlasTexture = createCpuAtlas(new Float32Array(4), new Vector3(1, 1, 1), 1);
    this.#atlasNode = texture3D(this.#atlasTexture);
    this.#traceStale = new Uint8Array(this.#probeCount);
    this.#lastTraced = new Int32Array(this.#probeCount).fill(-1);
    this.#lastUsed = new Int32Array(this.#probeCount).fill(-1);
    this.#boundsMinNode = uniform(this.boundingBox.min.clone());
    this.#boundsSizeNode = uniform(this.#boundsSize.clone());
    this.#publish(true);
  }

  get texture(): Data3DTexture {
    return this.#atlasTexture;
  }

  /** The atlas render path in use; `undefined` until the device probe settles. */
  get atlasTarget(): "render3d" | "copy" | undefined {
    return this.#atlasMode;
  }

  get atlasDepth(): number {
    return this.#atlasDepth;
  }

  get atlasBytes(): number {
    return this.#atlasBytes;
  }

  get probeCount(): number {
    return this.#probeCount;
  }

  get released(): boolean {
    return this.#released;
  }

  get atlasData(): Float32Array {
    return this.#atlasData.slice();
  }

  get observation(): IProbeVolumeObservation {
    if (this.#trace !== undefined) return this.#traceObservation();
    const progress = this.#pending;
    const total = progress?.totalWork ?? this.totalWork;
    const completed = progress?.completedWork ?? (this.#status === "ready" ? total : 0);
    return {
      atlas: {
        depth: this.#atlasDepth,
        height: this.resolution.y,
        width: this.resolution.x,
      },
      atlasBytes: this.#atlasBytes,
      bakeBudgetMs: this.#bakeBudgetMs,
      bakeCostMs: this.#lastBakeCostMs,
      bakeProgress: {
        completed,
        fraction: total === 0 ? 1 : completed / total,
        pass: progress?.pass ?? (this.#status === "ready" ? this.#bakePasses - 1 : 0),
        passes: this.#bakePasses,
        probesCompleted:
          progress?.completedProbes ?? (this.#status === "ready" ? this.#probeCount : 0),
        probesTotal: this.#probeCount * this.#bakePasses,
        total,
      },
      marker: PROBE_VOLUME_MARKER,
      probeCount: this.#probeCount,
      samplingIsolated: this.#samplingIsolated,
      stale: this.#status !== "ready",
      stalenessFrames: this.#stalenessFrames,
      status: this.#status,
      unbaked: this.#status === "unbaked",
    };
  }

  #traceObservation(): IProbeVolumeObservation {
    const perPass = this.#probeCount + 1;
    const passes = this.#tracePasses;
    const ready = this.#status === "ready";
    const baking = this.#status === "baking";
    const pass = ready ? passes - 1 : baking ? this.#tracePass : 0;
    const total = passes * perPass;
    const completed = ready ? total : baking ? pass * perPass + this.#traceCompleted : 0;
    let oldest: number | null = 0;
    for (const traced of this.#lastTraced) {
      if (traced < 0) {
        oldest = null;
        break;
      }
      oldest = Math.max(oldest, this.#frame - traced);
    }
    return {
      atlas: { depth: this.#atlasDepth, height: this.resolution.y, width: this.resolution.x },
      atlasBytes: this.#atlasBytes,
      bakeBudgetMs: this.#bakeBudgetMs,
      bakeCostMs: this.#lastBakeCostMs,
      bakeProgress: {
        completed,
        fraction: completed / total,
        pass,
        passes,
        probesCompleted: ready
          ? this.#probeCount * passes
          : baking
            ? pass * this.#probeCount + this.#traceCompleted
            : 0,
        probesTotal: this.#probeCount * passes,
        total,
      },
      ignoredTextureMaterials: this.#ignoredTextureMaterials,
      marker: PROBE_VOLUME_MARKER,
      oldestProbeAgeFrames: oldest,
      probeCount: this.#probeCount,
      probesRejected: this.#probesRejected,
      probesTraced: this.#probesTraced,
      samplingIsolated: false,
      stale: !ready,
      stalenessFrames: this.#stalenessFrames,
      status: this.#status,
      unbaked: this.#status === "unbaked",
      update: "trace",
    };
  }

  /** Attach the active renderer; only WebGPU has the 3D render-target contract this class needs. */
  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("ProbeVolume.attachRenderer called after detach().");
    if (renderer.kind !== "webgpu") {
      throw new Error(`ProbeVolume requires a WebGPURenderer, received ${renderer.kind}.`);
    }
    if (this.#renderer !== undefined && this.#renderer !== renderer) {
      throw new Error("ProbeVolume cannot attach to two renderers.");
    }
    this.#renderer = renderer;
    const raw = renderer.raw as IProbeRenderer;
    const deviceLimit = readTextureLimit(raw);
    if (deviceLimit !== undefined) assertTextureLimit(this.maximumDimension, deviceLimit);
    // The traced refresh writes the CPU atlas: no cube camera, no render target, no repack draw.
    if (this.#trace !== undefined) return;
    this.#startAtlasProbe(raw);
    this.#ensureGpuResources();
    if (this.#pending !== undefined) this.#prepareBake(this.#pending.scene, this.#pending.passes);
  }

  /** Start or coalesce an incremental static bake for a scene. */
  requestBake(scene: Scene, options: { readonly bounces?: number } = {}): Promise<void> {
    if (this.#released) throw new Error("ProbeVolume.requestBake called after detach().");
    if (!(scene instanceof Scene)) throw new Error("ProbeVolume.requestBake requires a Scene.");
    const bounces = options.bounces ?? this.#bounces;
    nonNegativeInteger(bounces, "bounces");
    if (this.#trace !== undefined) return this.#requestTrace(bounces + 1);
    if (this.#pending !== undefined && this.#bakePromise !== undefined)
      return this.#bakePromise.promise;
    this.#bakePasses = bounces + 1;
    this.#maxWorkItemCostMs = 0;
    this.#status = "baking";
    this.#stalenessFrames = this.#stalenessFrames === null ? null : this.#stalenessFrames;
    this.#bakePromise = deferred();
    this.#pending = {
      completedProbes: 0,
      completedWork: 0,
      cubeFaceIndex: 0,
      pass: 0,
      passes: bounces + 1,
      phase: "capture",
      probeIndex: 0,
      repackIndex: 0,
      scene,
      totalWork:
        (bounces + 1) *
        (this.#probeCount * CAPTURE_WORK_ITEMS_PER_PROBE +
          PACKED_SUB_VOLUME_COUNT * this.paddedSlices),
    };
    this.#clearPreviousBake();
    this.#setSamplingIsolated(true);
    this.#publish(true);
    if (this.#renderer !== undefined) this.#prepareBake(scene, bounces + 1);
    return this.#bakePromise.promise;
  }

  /** Alias that reads naturally at call sites that want an awaitable bake request. */
  bake(scene: Scene, options?: { readonly bounces?: number }): Promise<void>;
  bake(
    renderer: IRendererLike,
    scene: Scene,
    options?: { readonly bounces?: number },
  ): Promise<void>;
  bake(
    rendererOrScene: IRendererLike | Scene,
    sceneOrOptions?: Scene | { readonly bounces?: number },
    suppliedOptions: { readonly bounces?: number } = {},
  ): Promise<void> {
    if (isRendererLike(rendererOrScene)) {
      this.attachRenderer(rendererOrScene);
      return this.requestBake(sceneOrOptions as Scene, suppliedOptions);
    }
    return this.requestBake(
      rendererOrScene,
      (sceneOrOptions as { readonly bounces?: number }) ?? {},
    );
  }

  /**
   * Return the L2 irradiance node for a world position and world normal.
   *
   * `sample()` with no arguments is the material-friendly form and reads `positionWorld` and
   * `normalWorld`. Passing numeric vectors is reserved for diagnostics and deterministic tests;
   * it evaluates the same SH coefficients held by the atlas packer.
   */
  sample(): Node<"vec3">;
  sample(position: Vector3, normal: Vector3): Vector3;
  sample(position: IProbePosition, normal?: Vector3 | Node<"vec3">): Vector3 | Node<"vec3">;
  sample(
    position: IProbePosition = positionWorld,
    normal: Vector3 | Node<"vec3"> = normalWorld,
  ): Vector3 | Node<"vec3"> {
    if (position instanceof Vector3 && normal instanceof Vector3) {
      return this.sampleIrradiance(position, normal);
    }
    return this.sampleNode(position as Node<"vec3">, normal as Node<"vec3">);
  }

  sampleIrradiance(position: Vector3, normal: Vector3): Vector3 {
    return this.#evaluateCpu(position, normal, SH_IRRADIANCE_WEIGHTS, "sampleIrradiance");
  }

  /**
   * The radiance arriving along `direction` (the SH itself, not convolved with a cosine lobe), clamped at zero. A
   * screen gather subtracts this per ray, because a hit replaces the cache's radiance along that ray: Lumen reads its
   * radiance cache per ray direction (UE 5.8.3: Engine/Shaders/Private/Lumen/LumenScreenProbeTracing.usf:831).
   */
  sampleRadiance(position: Vector3, direction: Vector3): Vector3 {
    return this.#evaluateCpu(position, direction, SH_RADIANCE_WEIGHTS, "sampleRadiance");
  }

  #evaluateCpu(position: Vector3, normal: Vector3, weights: IShWeights, name: string): Vector3 {
    if (!(position instanceof Vector3) || !(normal instanceof Vector3)) {
      throw new Error(`ProbeVolume.${name} requires Vector3 position and normal values.`);
    }
    const coefficients = this.#samplePackedCoefficients(position);
    const direction = normal.clone().normalize();
    const result = new Vector3();
    result.x = evaluateShChannel(coefficients, 0, direction, weights);
    result.y = evaluateShChannel(coefficients, 1, direction, weights);
    result.z = evaluateShChannel(coefficients, 2, direction, weights);
    return result.max(new Vector3());
  }

  /**
   * The irradiance averaged over every normal at a point, for a surface or a sample that has no side facing the light:
   * a translucent pane (Unreal's default Volumetric NonDirectional lighting) and a fog sample (its isotropic term). It
   * is the L0 coefficient, `0.886227 * c0`, so it is the mean of `sample(position, n)` over any set of normals that
   * integrates the L2 basis, the six axes among them. It reads one atlas texel, where `sample` reads seven.
   *
   * Divide by pi for the mean radiance a fog sample scatters, and multiply by the colour for a pane: the volume owns
   * no colour.
   */
  sampleNonDirectional(position: Vector3): Vector3;
  sampleNonDirectional(position?: Node<"vec3">): Node<"vec3">;
  sampleNonDirectional(position: IProbePosition = positionWorld): Vector3 | Node<"vec3"> {
    if (position instanceof Vector3) {
      const c = this.#samplePackedCoefficients(position);
      return new Vector3(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0)
        .multiplyScalar(0.886227)
        .max(new Vector3());
    }
    return this.#atlasNode.sample(this.#atlasAt(position)(0)).rgb.mul(0.886227).max(0);
  }

  /** The atlas coordinate of a world position inside each packed sub-volume. */
  #atlasAt(position: Node<"vec3">): (subVolume: number) => Node<"vec3"> {
    const local = clamp(vec3(position).sub(this.#boundsMinNode).div(this.#boundsSizeNode), 0, 1);
    const atlasX = local.x
      .mul(this.resolution.x - 1)
      .add(0.5)
      .div(this.resolution.x);
    const atlasY = local.y
      .mul(this.resolution.y - 1)
      .add(0.5)
      .div(this.resolution.y);
    const sliceStride = this.resolution.z + 2 * SAMPLE_ATLAS_PADDING;
    return (subVolume) =>
      vec3(
        atlasX,
        atlasY,
        local.z
          .mul(this.resolution.z - 1)
          .add(SAMPLE_ATLAS_PADDING + 0.5 + subVolume * sliceStride)
          .div(this.#atlasDepth),
      );
  }

  /** The GPU graph used by `sample`; exposed so generated materials can compose it explicitly. */
  sampleNode(
    position: Node<"vec3"> = positionWorld,
    normal: Node<"vec3"> = normalWorld,
  ): Node<"vec3"> {
    return this.#shNode(position, normal, SH_IRRADIANCE_WEIGHTS);
  }

  /** The GPU graph of `sampleRadiance`: the radiance arriving along `direction`, clamped at zero. */
  sampleRadianceNode(
    position: Node<"vec3"> = positionWorld,
    direction: Node<"vec3"> = normalWorld,
  ): Node<"vec3"> {
    return this.#mapResolution > 0
      ? this.#radianceMapNode(position, direction)
      : this.#shNode(position, direction, SH_RADIANCE_WEIGHTS);
  }

  /**
   * The octahedral maps laid out as one 2D texture: probe (x, y, z) holds the R x R block at column x and row z * ny + y.
   * Rejected probes hold their open neighbours' maps (`fillRejectedProbes`), so a reader weights all eight corners.
   */
  #packRadianceMap(map: Float32Array, shares: Float32Array): void {
    const r = this.#mapResolution;
    // A rejected probe sits inside a solid: depth 0, so the visibility test never weights it.
    for (let probe = 0; probe < this.#probeCount; probe += 1)
      if ((shares[probe] ?? 0) > BACKFACE_REJECTION_SHARE)
        for (let cell = 0; cell < r * r; cell += 1) map[(probe * r * r + cell) * 4 + 3] = 0;
    const { x: nx, y: ny } = this.resolution;
    const width = nx * r;
    const texture = this.#ensureRadianceMapTexture();
    const data = texture.image.data as Float32Array;
    for (let probe = 0; probe < this.#probeCount; probe += 1) {
      const ix = probe % nx;
      const iy = Math.floor(probe / nx) % ny;
      const iz = Math.floor(probe / (nx * ny));
      for (let cell = 0; cell < r * r; cell += 1) {
        const column = ix * r + (cell % r);
        const row = (iz * ny + iy) * r + Math.floor(cell / r);
        const source = (probe * r * r + cell) * 4;
        data.set(map.subarray(source, source + 4), (row * width + column) * 4);
      }
    }
    texture.needsUpdate = true;
  }

  #ensureRadianceMapTexture(): DataTexture {
    if (this.#radianceMapTexture !== undefined) return this.#radianceMapTexture;
    const r = this.#mapResolution;
    const { x: nx, y: ny, z: nz } = this.resolution;
    const map = new DataTexture(
      new Float32Array(nx * r * ny * nz * r * 4),
      nx * r,
      ny * nz * r,
      RGBAFormat,
      FloatType,
    );
    map.minFilter = NearestFilter;
    map.magFilter = NearestFilter;
    map.generateMipmaps = false;
    map.needsUpdate = true;
    this.#radianceMapTexture = map;
    return map;
  }

  /** The (column, row) of a direction's cell in an R x R octahedral map, as `octahedralCell` folds it on the CPU. */
  #octahedralCellNode(direction: Node<"vec3">): Node<"vec2"> {
    const r = this.#mapResolution;
    const d = normalize(vec3(direction));
    const flat = d.xy.div(abs(d.x).add(abs(d.y)).add(abs(d.z)));
    const sign = (v: Node<"float">) => select(v.greaterThanEqual(0), float(1), float(-1));
    const folded = vec2(
      float(1).sub(abs(flat.y)).mul(sign(flat.x)),
      float(1).sub(abs(flat.x)).mul(sign(flat.y)),
    );
    const octahedron = select(d.z.lessThan(0), folded, flat);
    return clamp(floor(octahedron.mul(0.5).add(0.5).mul(r)), vec2(0), vec2(r - 1));
  }

  /** The map texel of `cell` in probe `probe` (grid index), as a texture coordinate. */
  #mapTexelNode(probe: Node<"vec3">, cell: Node<"vec2">): Node<"vec2"> {
    const r = this.#mapResolution;
    const { x: nx, y: ny, z: nz } = this.resolution;
    return vec2(probe.x.mul(r).add(cell.x), probe.z.mul(ny).add(probe.y).mul(r).add(cell.y))
      .add(0.5)
      .div(vec2(nx * r, ny * nz * r));
  }

  /**
   * The eight probes around `position`: each one's grid index and weight, trilinear and, with `probeVisibility`, times
   * the depth test (a floor of 1e-3 keeps a point that every probe fails lit by plain trilinear). `total` is the sum.
   */
  #cornersNode(position: Node<"vec3">): {
    readonly corners: readonly { readonly probe: Node<"vec3">; readonly weight: Node<"float"> }[];
    readonly total: Node<"float">;
  } {
    const { x: nx, y: ny, z: nz } = this.resolution;
    const min = this.boundingBox.min;
    const size = this.#boundsSize;
    const spacing = [
      size.x / Math.max(1, nx - 1),
      size.y / Math.max(1, ny - 1),
      size.z / Math.max(1, nz - 1),
    ] as const;
    const step = vec3(...spacing);
    const origin = vec3(min.x, min.y, min.z);
    const top = vec3(Math.max(0, nx - 1), Math.max(0, ny - 1), Math.max(0, nz - 1));
    const local = clamp(vec3(position).sub(origin).div(step), vec3(0), top);
    const base = clamp(
      floor(local),
      vec3(0),
      vec3(Math.max(0, nx - 2), Math.max(0, ny - 2), Math.max(0, nz - 2)),
    );
    const fraction = clamp(local.sub(base), vec3(0), vec3(1));
    // The depth test's soft band: a quarter of the smallest spacing past the stored depth fades the probe out.
    const band = 0.25 * Math.max(1e-4, Math.min(...spacing));
    const map = this.#visibility ? this.#ensureRadianceMapTexture() : undefined;
    let total: Node<"float"> = float(0);
    const corners = Array.from({ length: 8 }, (_, corner) => {
      const dx = corner & 1;
      const dy = (corner >> 1) & 1;
      const dz = (corner >> 2) & 1;
      const probe = clamp(base.add(vec3(dx, dy, dz)), vec3(0), top);
      let weight: Node<"float"> = (dx ? fraction.x : float(1).sub(fraction.x))
        .mul(dy ? fraction.y : float(1).sub(fraction.y))
        .mul(dz ? fraction.z : float(1).sub(fraction.z));
      if (map !== undefined) {
        const toPoint = vec3(position).sub(origin.add(probe.mul(step)));
        const distance = length(toPoint);
        const depth = texture(
          map,
          this.#mapTexelNode(probe, this.#octahedralCellNode(toPoint.add(vec3(1e-5, 2e-5, 3e-5)))),
        ).a;
        const visible = clamp(depth.add(band).sub(distance).div(band), 0, 1);
        weight = weight.mul(visible.max(1e-3));
      }
      total = total.add(weight);
      return { probe, weight };
    });
    return { corners, total };
  }

  /** The map's radiance along `direction`: the direction's cell in each of the eight probes around `position`. */
  #radianceMapNode(position: Node<"vec3">, direction: Node<"vec3">): Node<"vec3"> {
    const map = this.#ensureRadianceMapTexture();
    const cell = this.#octahedralCellNode(direction);
    const { corners, total } = this.#cornersNode(position);
    let sum: Node<"vec3"> = vec3(0);
    for (const { probe, weight } of corners)
      sum = sum.add(texture(map, this.#mapTexelNode(probe, cell)).rgb.mul(weight));
    return sum.div(total.max(1e-6)).max(0);
  }

  #shNode(position: Node<"vec3">, normal: Node<"vec3">, w: IShWeights): Node<"vec3"> {
    const atlasAt = this.#atlasAt(position);
    const packed = this.#visibility
      ? this.#visiblePacked(position)
      : (subVolume: number) => this.#atlasNode.sample(atlasAt(subVolume));
    const packedValues = Array.from({ length: PACKED_SUB_VOLUME_COUNT }, (_, index) =>
      packed(index),
    );
    const packedAt = (index: number) => valueAt(packedValues, index, "packed probe value");
    const coefficients = [
      vec3(packedAt(0).x, packedAt(0).y, packedAt(0).z),
      vec3(packedAt(0).w, packedAt(1).x, packedAt(1).y),
      vec3(packedAt(1).z, packedAt(1).w, packedAt(2).x),
      vec3(packedAt(2).y, packedAt(2).z, packedAt(2).w),
      vec3(packedAt(3).x, packedAt(3).y, packedAt(3).z),
      vec3(packedAt(3).w, packedAt(4).x, packedAt(4).y),
      vec3(packedAt(4).z, packedAt(4).w, packedAt(5).x),
      vec3(packedAt(5).y, packedAt(5).z, packedAt(5).w),
      vec3(packedAt(6).x, packedAt(6).y, packedAt(6).z),
    ];
    const direction = normalize(vec3(normal));
    const coefficientAt = (index: number) => valueAt(coefficients, index, "SH coefficient");
    const value = coefficientAt(0)
      .mul(w.l0)
      .add(coefficientAt(1).mul(direction.y).mul(w.l1))
      .add(coefficientAt(2).mul(direction.z).mul(w.l1))
      .add(coefficientAt(3).mul(direction.x).mul(w.l1))
      .add(coefficientAt(4).mul(direction.x.mul(direction.y)).mul(w.l2))
      .add(coefficientAt(5).mul(direction.y.mul(direction.z)).mul(w.l2))
      .add(coefficientAt(6).mul(direction.z.mul(direction.z).mul(w.l20).sub(w.l20Offset)))
      .add(coefficientAt(7).mul(direction.x.mul(direction.z)).mul(w.l2))
      .add(
        coefficientAt(8)
          .mul(direction.x.mul(direction.x).sub(direction.y.mul(direction.y)))
          .mul(w.l22),
      );
    return value.max(0);
  }

  /**
   * The packed SH at `position` blended over the eight corner probes with the depth-tested weights: each corner's texel
   * centre (where the atlas's linear filter returns that probe alone), weighted and renormalised.
   */
  #visiblePacked(position: Node<"vec3">): (subVolume: number) => Node<"vec4"> {
    const { x: nx, y: ny, z: nz } = this.resolution;
    const sliceStride = nz + 2 * SAMPLE_ATLAS_PADDING;
    const { corners, total } = this.#cornersNode(position);
    const inverse = float(1).div(total.max(1e-6));
    return (subVolume) => {
      let sum: Node<"vec4"> = vec4(0);
      for (const { probe, weight } of corners)
        sum = sum.add(
          this.#atlasNode
            .sample(
              vec3(
                probe.x.add(0.5).div(nx),
                probe.y.add(0.5).div(ny),
                probe.z
                  .add(SAMPLE_ATLAS_PADDING + 0.5 + subVolume * sliceStride)
                  .div(this.#atlasDepth),
              ),
            )
            .mul(weight),
        );
      return sum.mul(inverse);
    };
  }

  /** Internal data seam used by unit/conformance fixtures to seed a known SH atlas without a GPU. */
  setProbeCoefficients(
    ix: number,
    iy: number,
    iz: number,
    coefficients: readonly IProbeVolumeCoefficient[],
  ): void {
    if (this.#pending !== undefined)
      throw new Error("ProbeVolume cannot edit coefficients during a bake.");
    validateProbeIndex(ix, this.resolution.x, "ix");
    validateProbeIndex(iy, this.resolution.y, "iy");
    validateProbeIndex(iz, this.resolution.z, "iz");
    if (coefficients.length !== SH_COEFFICIENT_COUNT) {
      throw new Error(`ProbeVolume coefficients must contain ${SH_COEFFICIENT_COUNT} entries.`);
    }
    const probe = ix + iy * this.resolution.x + iz * this.resolution.x * this.resolution.y;
    const offset = probe * SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT;
    coefficients.forEach((value, coefficientIndex) => {
      for (let channel = 0; channel < SH_CHANNEL_COUNT; channel += 1) {
        const key = valueAt(["r", "g", "b"] as const, channel, "SH channel");
        const channelValue = value[key];
        if (!Number.isFinite(channelValue)) {
          throw new Error(`ProbeVolume coefficient ${coefficientIndex}.${key} must be finite.`);
        }
        this.#coefficients[offset + coefficientIndex * SH_CHANNEL_COUNT + channel] = channelValue;
      }
    });
    this.#packCpuAtlas();
    this.#setSamplingIsolated(false);
    this.#status = "ready";
    this.#stalenessFrames = 0;
    this.#publish(true);
  }

  /** One bounded render-phase slice. The game loop calls this through IComputeDriven. */
  process(renderer: IRendererLike): void {
    this.#assertProcessRenderer(renderer);
    if (this.#renderer === undefined) this.attachRenderer(renderer);
    if (this.#renderer !== renderer)
      throw new Error("ProbeVolume.process received a different renderer.");
    if (this.#trace !== undefined) {
      this.#processTrace(renderer, this.#trace);
      return;
    }
    if (this.#pending === undefined) {
      this.#publishIdleFrame();
      return;
    }
    if (!this.#gpuWarmupSettled || !this.#sceneWarmupSettled) {
      this.#lastBakeCostMs = 0;
      this.#publish(false);
      return;
    }
    this.#ensureGpuResources();
    if (this.#sceneState === undefined)
      this.#prepareBake(this.#pending.scene, this.#pending.passes);
    this.#processPending(this.#pending);
  }

  #assertProcessRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("ProbeVolume.process called after detach().");
    if (renderer.kind !== "webgpu") {
      throw new Error(`ProbeVolume requires a WebGPURenderer, received ${renderer.kind}.`);
    }
  }

  #publishIdleFrame(): void {
    if (this.#status === "ready" && this.#stalenessFrames !== null) this.#stalenessFrames += 1;
    this.#lastBakeCostMs = 0;
    this.#publish(false);
  }

  #processPending(pending: IPendingBake): void {
    const started = this.#now();
    const softwareRaster = this.#renderer?.softwareAdapter !== undefined;
    let workItems = 0;
    try {
      while (this.#pending !== undefined && workItems < this.#maxWorkItemsPerFrame) {
        const elapsedBefore = Math.max(0, this.#now() - started);
        if (workItems > 0 && elapsedBefore + this.#maxWorkItemCostMs > this.#bakeBudgetMs) break;
        const itemStarted = this.#now();
        this.#runWorkItem(pending);
        const itemCostMs = Math.max(0, this.#now() - itemStarted);
        this.#maxWorkItemCostMs = Math.max(this.#maxWorkItemCostMs, itemCostMs);
        const elapsed = Math.max(0, this.#now() - started);
        // A CPU rasteriser cannot hold a hardware frame budget: one cube-face draw costs 12 to 18 ms on
        // SwiftShader. The bake still runs one measured item at a time; `bakeCostMs` reports the overrun.
        if (!softwareRaster && itemCostMs > this.#bakeBudgetMs + BAKE_BUDGET_SLACK_MS) {
          throw new Error(
            `ProbeVolume bake work item cost ${itemCostMs}ms exceeds bakeBudgetMs ${this.#bakeBudgetMs}ms plus ${BAKE_BUDGET_SLACK_MS}ms scheduling slack.`,
          );
        }
        if (!softwareRaster && elapsed > this.#bakeBudgetMs + BAKE_BUDGET_SLACK_MS) {
          throw new Error(
            `ProbeVolume bake frame cost ${elapsed}ms exceeds bakeBudgetMs ${this.#bakeBudgetMs}ms plus ${BAKE_BUDGET_SLACK_MS}ms scheduling slack.`,
          );
        }
        workItems += 1;
        if (elapsed >= this.#bakeBudgetMs) break;
      }
    } catch (error) {
      this.#failBake(error);
      throw error;
    }
    this.#lastBakeCostMs = Math.max(0, this.#now() - started);
    this.#publish(true);
  }

  /**
   * Mark every probe stale for `passes` full refreshes. The old field stays readable until each probe is
   * replaced, and a request made while one runs restarts its passes under the same promise.
   */
  #requestTrace(passes: number): Promise<void> {
    this.#bakePromise ??= deferred();
    this.#startTracePasses(passes);
    this.#publish(true);
    return this.#bakePromise.promise;
  }

  #startTracePasses(passes: number): void {
    this.#tracePasses = passes;
    this.#tracePass = 0;
    this.#traceCompleted = 0;
    this.#passSerial = -1;
    this.#traceStale.fill(1);
    this.#status = "baking";
  }

  #processTrace(renderer: IRendererLike, trace: IProbeVolumeTrace): void {
    this.#frame += 1;
    this.#probesTraced = 0;
    let started = this.#now();
    try {
      const kernels = this.#ensureKernels(trace, renderer);
      started = this.#now();
      const lighting = {
        color: trace.sun.color,
        direction: trace.sun.direction,
        intensity: trace.sun.intensity,
        sky: trace.sky,
        points: trace.points,
      };
      applyTraceLighting(kernels, lighting);
      this.#watchLighting(lighting);
      this.#refreshMaterials(trace, kernels);
      this.#markUsed(trace.camera);
      if (this.#status === "baking") this.#dispatchTrace(renderer, kernels);
      this.#startReadback(renderer, kernels);
    } catch (error) {
      this.#failTrace(error);
      throw error;
    }
    if (this.#status === "ready" && this.#stalenessFrames !== null) this.#stalenessFrames += 1;
    this.#lastBakeCostMs = Math.max(0, this.#now() - started);
    this.#publish(this.#probesTraced > 0);
  }

  /**
   * A small sun drift is served by the old field. The first step past the threshold, measured from the last
   * step, marks every probe stale: the budget stays, and the old values stay readable until replaced.
   */
  #watchLighting(lighting: IProbeTraceLighting): void {
    const key = lightingKey(lighting);
    const previous = this.#lightingKey;
    if (previous === undefined) {
      this.#lightingKey = key;
      return;
    }
    if (this.#status === "unbaked" || !lightingStepped(previous, key)) return;
    this.#lightingKey = key;
    this.#startTracePasses(this.#tracePasses);
  }

  #ensureKernels(trace: IProbeVolumeTrace, renderer: IRendererLike): IProbeTraceKernels {
    const version = trace.bvh.version;
    if (this.#kernels !== undefined && this.#kernelVersion === version) return this.#kernels;
    const previous = this.#kernels;
    const threaded = threadScene(trace.bvh.traceScene);
    this.#ignoredTextureMaterials = threaded.ignoredTextureMaterials;
    this.#kernels = createProbeTraceKernels(
      threaded,
      {
        min: this.boundingBox.min,
        probeCount: this.#probeCount,
        resolution: this.resolution,
        size: this.#boundsSize,
      },
      this.#raysPerProbe,
      Math.min(this.#traceBudget, this.#probeCount),
      trace.points?.length ?? 0,
      this.#mapResolution,
    );
    // Carry the field across a scene rebuild, so the new kernels bounce from the old light.
    if (previous !== undefined) {
      (this.#kernels.coefficients.array as Float32Array).set(
        previous.coefficients.array as Float32Array,
      );
      if (previous.radianceMap !== undefined)
        (this.#kernels.radianceMap?.array as Float32Array | undefined)?.set(
          previous.radianceMap.array as Float32Array,
        );
      previous.dispose();
    }
    if (this.#kernelVersion >= 0 && this.#status !== "unbaked")
      this.#startTracePasses(this.#tracePasses);
    this.#kernelVersion = version;
    // First-use pipeline work belongs to scene entry, not to a bounded refresh slice: an empty dispatch builds both.
    this.#kernels.batchSize.value = 0;
    renderer.compute(this.#kernels.trace);
    renderer.compute(this.#kernels.project);
    if (this.#kernels.octahedral !== undefined) renderer.compute(this.#kernels.octahedral);
    return this.#kernels;
  }

  /** A material the game changed (a lamp switched on) re-uploads the table and refreshes every probe. */
  #refreshMaterials(trace: IProbeVolumeTrace, kernels: IProbeTraceKernels): void {
    // ponytail: every material each frame; a dirty flag from the game when scenes carry thousands.
    const table = writeMaterialTable(
      trace.bvh.traceScene.materials,
      kernels.materials.array as Float32Array,
    );
    this.#ignoredTextureMaterials = table.ignored;
    if (!table.changed) return;
    kernels.materials.needsUpdate = true;
    if (this.#status !== "unbaked") this.#startTracePasses(this.#tracePasses);
  }

  /** A probe is in use while it sits inside the camera frustum: Unreal's last-used frame. */
  #markUsed(camera: Camera | undefined): void {
    if (camera === undefined) return;
    camera.updateMatrixWorld();
    this.#viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#viewProjection, camera.coordinateSystem);
    const point = new Vector3();
    for (let probe = 0; probe < this.#probeCount; probe += 1) {
      this.#probeAt(probe, point);
      if (this.#frustum.containsPoint(point)) this.#lastUsed[probe] = this.#frame;
    }
  }

  #probeAt(probe: number, target: Vector3): Vector3 {
    const nx = this.resolution.x;
    const ny = this.resolution.y;
    return this.probePosition(
      probe % nx,
      Math.floor(probe / nx) % ny,
      Math.floor(probe / (nx * ny)),
      target,
    );
  }

  /**
   * The stale probes this frame traces, at most the budget: never-traced first, then the largest gap between
   * last use and last trace (Unreal's priority, UE 5.8.3: LumenRadianceCacheUpdate.usf:221-241), then index.
   */
  selectStaleProbes(): number[] {
    const candidates: number[] = [];
    for (let probe = 0; probe < this.#probeCount; probe += 1) {
      if (this.#traceStale[probe] === 1) candidates.push(probe);
    }
    // ponytail: a full sort per frame; a bucketed partial selection when volumes reach 1e5 probes.
    const priority = (probe: number) =>
      (this.#lastTraced[probe] ?? 0) < 0
        ? Number.POSITIVE_INFINITY
        : (this.#lastUsed[probe] ?? -1) - (this.#lastTraced[probe] ?? 0);
    candidates.sort((a, b) => priority(b) - priority(a) || a - b);
    return candidates.slice(0, Math.min(this.#traceRate, this.#probeCount));
  }

  /**
   * One frame traces the probes its GPU compute time allows: the measured cost of the last batch, per probe,
   * against `bakeBudgetMs`. A slow adapter shrinks the batch at once; a fast one doubles it a frame, so a stale
   * reading cannot jump the cost. With no timestamp reading the batch stays at its start of 16 probes.
   */
  #adaptTraceRate(renderer: IRendererLike): void {
    if (this.#fixedTraceRate) return;
    const gpuMs = (renderer as { gpuComputeMs?: () => number | undefined }).gpuComputeMs?.();
    if (gpuMs === undefined || !(gpuMs > 0) || this.#recentBatches.length === 0) return;
    const fit = Math.floor((this.#bakeBudgetMs * Math.min(...this.#recentBatches)) / gpuMs);
    const ceiling = Math.min(this.#traceBudget, this.#probeCount);
    const next = fit > this.#traceRate ? Math.min(fit, this.#traceRate * 2) : fit;
    this.#traceRate = Math.max(1, Math.min(ceiling, next));
  }

  #dispatchTrace(renderer: IRendererLike, kernels: IProbeTraceKernels): void {
    this.#adaptTraceRate(renderer);
    const batch = this.selectStaleProbes();
    if (batch.length > 0) {
      batch.forEach((probe, slot) => {
        (kernels.probeList.array as Float32Array)[slot * 4] = probe;
      });
      kernels.probeList.needsUpdate = true;
      kernels.batchSize.value = batch.length;
      kernels.bounce.value = this.#generations > 0 ? 1 : 0;
      renderer.compute(kernels.trace);
      renderer.compute(kernels.project);
      if (kernels.octahedral !== undefined) renderer.compute(kernels.octahedral);
      for (const probe of batch) {
        this.#traceStale[probe] = 0;
        this.#lastTraced[probe] = this.#frame;
      }
      this.#probesTraced = batch.length;
      this.#recentBatches = [...this.#recentBatches, batch.length].slice(-4);
      this.#traceCompleted += batch.length;
      this.#dispatchSerial += 1;
    }
    if (this.#traceCompleted < this.#probeCount) return;
    // Every probe of this pass is dispatched. The next pass bounces from it; the last waits for its readback.
    if (this.#tracePass + 1 < this.#tracePasses) {
      this.#generations += 1;
      this.#tracePass += 1;
      this.#traceCompleted = 0;
      this.#traceStale.fill(1);
      return;
    }
    if (this.#passSerial < 0) this.#passSerial = this.#dispatchSerial;
  }

  /** Copy the field back into the CPU atlas: one readback at a time, so the atlas never holds half a refresh. */
  #startReadback(renderer: IRendererLike, kernels: IProbeTraceKernels): void {
    if (this.#readbackInFlight || this.#readbackSerial >= this.#dispatchSerial) return;
    const serial = this.#dispatchSerial;
    this.#readbackInFlight = true;
    Promise.all([
      renderer.readback(kernels.coefficients),
      kernels.radianceMap === undefined ? undefined : renderer.readback(kernels.radianceMap),
    ]).then(
      ([bytes, map]) => {
        this.#readbackInFlight = false;
        if (this.#released || this.#kernels !== kernels) return;
        this.#acceptReadback(
          new Float32Array(bytes),
          serial,
          map === undefined ? undefined : new Float32Array(map),
        );
      },
      (error: unknown) => {
        this.#readbackInFlight = false;
        this.#failTrace(error);
      },
    );
  }

  #acceptReadback(field: Float32Array, serial: number, map?: Float32Array): void {
    for (let index = 0; index < this.#probeCount * SH_COEFFICIENT_COUNT; index += 1) {
      for (let channel = 0; channel < SH_CHANNEL_COUNT; channel += 1) {
        this.#coefficients[index * SH_CHANNEL_COUNT + channel] = field[index * 4 + channel] ?? 0;
      }
    }
    // The first coefficient's w is the share of the probe's rays that met a surface from behind.
    const shares = new Float32Array(this.#probeCount);
    for (let probe = 0; probe < this.#probeCount; probe += 1)
      shares[probe] = field[probe * SH_COEFFICIENT_COUNT * 4 + 3] ?? 0;
    const cells = this.#mapResolution * this.#mapResolution;
    const radianceMap = map?.slice(0, this.#probeCount * cells * 4);
    this.#probesRejected = fillRejectedProbes(
      this.#coefficients,
      shares,
      this.resolution,
      radianceMap === undefined ? [] : [{ data: radianceMap, stride: cells * 4 }],
    );
    if (radianceMap !== undefined) this.#packRadianceMap(radianceMap, shares);
    this.#packCpuAtlas();
    this.#readbackSerial = serial;
    if (this.#passSerial < 0 || serial < this.#passSerial || this.#status !== "baking") return;
    this.#generations += 1;
    this.#status = "ready";
    this.#stalenessFrames = 0;
    this.#passSerial = -1;
    const promise = this.#bakePromise;
    this.#bakePromise = undefined;
    this.#publish(true);
    promise?.resolve();
  }

  #failTrace(error: unknown): void {
    const promise = this.#bakePromise;
    this.#bakePromise = undefined;
    this.#status = "unbaked";
    this.#publish(true);
    promise?.reject(error);
  }

  detach(): void {
    if (this.#released) return;
    this.#released = true;
    if (this.#pending !== undefined) {
      this.#bakePromise?.reject(new Error("ProbeVolume detached while a bake was pending."));
      this.#pending = undefined;
      this.#bakePromise = undefined;
    }
    if (this.#trace !== undefined)
      this.#bakePromise?.reject(new Error("ProbeVolume detached while a bake was pending."));
    this.#bakePromise = undefined;
    this.#kernels?.dispose();
    this.#kernels = undefined;
    this.#restoreSceneState();
    this.#cubeRenderTarget?.dispose();
    this.#projectionTarget?.dispose();
    this.#batchTarget?.dispose();
    this.#atlasTarget?.dispose();
    this.#sliceTarget?.dispose();
    this.#emptyAtlasTexture.dispose();
    this.#projectionMaterial?.dispose();
    for (const material of this.#repackMaterials ?? []) material.dispose();
    this.#quadMesh?.geometry.dispose();
    this.#atlasTexture.dispose();
    this.#radianceMapTexture?.dispose();
    this.#radianceMapTexture = undefined;
    this.#cubeRenderTarget = undefined;
    this.#projectionTarget = undefined;
    this.#batchTarget = undefined;
    this.#atlasTarget = undefined;
    this.#sliceTarget = undefined;
    this.#projectionMaterial = undefined;
    this.#repackMaterials = undefined;
    this.#atlasTexture = createCpuAtlas(this.#atlasData, this.resolution, this.#atlasDepth);
  }

  get paddedSlices(): number {
    return this.resolution.z + 2 * ATLAS_PADDING;
  }

  get maximumDimension(): number {
    return Math.max(this.resolution.x, this.resolution.y, this.#atlasDepth);
  }

  get totalWork(): number {
    if (this.#trace !== undefined) return this.#tracePasses * (this.#probeCount + 1);
    return (
      this.#bakePasses *
      (this.#probeCount * CAPTURE_WORK_ITEMS_PER_PROBE +
        PACKED_SUB_VOLUME_COUNT * this.paddedSlices)
    );
  }

  /**
   * Ask the device whether it accepts a 3D render attachment, as the atlas target needs one. WebGPU
   * names no capability for it, so the probe creates the texture inside a validation scope. The bake
   * waits for the answer through `#gpuWarmupSettled`; a host with no error scopes keeps the 3D path.
   */
  #startAtlasProbe(raw: IProbeRenderer): void {
    if (this.#atlasMode !== undefined || this.#atlasProbeStarted) return;
    const device = raw.backend?.device ?? raw.device;
    const { createTexture, popErrorScope, pushErrorScope } = device ?? {};
    if (this.#requestedAtlasTarget !== "auto") {
      this.#atlasMode = this.#requestedAtlasTarget;
    } else if (
      device === undefined ||
      createTexture === undefined ||
      popErrorScope === undefined ||
      pushErrorScope === undefined
    ) {
      this.#atlasMode = "render3d";
    } else {
      this.#atlasProbeStarted = true;
      this.#gpuWarmupSettled = false;
      let probe: { readonly destroy?: () => void } | undefined;
      let created = true;
      pushErrorScope.call(device, "validation");
      try {
        // GPUTextureUsage.TEXTURE_BINDING | RENDER_ATTACHMENT, the usage of the atlas render target.
        probe = createTexture.call(device, {
          dimension: "3d",
          format: "rgba32float",
          size: [1, 1, 1],
          usage: 0x04 | 0x10,
        });
      } catch {
        created = false;
      }
      popErrorScope.call(device).then(
        (error) =>
          this.#settleAtlasProbe(created && (error === null || error === undefined), probe),
        () => this.#settleAtlasProbe(true, probe),
      );
    }
  }

  #settleAtlasProbe(accepted: boolean, probe: { readonly destroy?: () => void } | undefined): void {
    probe?.destroy?.();
    this.#atlasMode = accepted ? "render3d" : "copy";
    this.#gpuWarmupSettled = true;
  }

  #ensureGpuResources(): void {
    if (this.#cubeRenderTarget !== undefined) return;
    const atlasMode = this.#atlasMode;
    if (atlasMode === undefined) return;
    this.#cubeRenderTarget = new CubeRenderTarget(this.#cubemapSize, {
      depthBuffer: true,
      generateMipmaps: false,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      type: HalfFloatType,
    });
    this.#cubeCamera = new CubeCamera(this.#near, this.#far, this.#cubeRenderTarget);
    this.#projectionTarget = new RenderTarget(9, 1, {
      depthBuffer: false,
      generateMipmaps: false,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      type: FloatType,
    });
    this.#batchTarget = new RenderTarget(9, this.#probeCount, {
      depthBuffer: false,
      generateMipmaps: false,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      type: FloatType,
    });
    if (atlasMode === "render3d") {
      this.#atlasTarget = new RenderTarget3D(
        this.resolution.x,
        this.resolution.y,
        this.#atlasDepth,
        {
          depthBuffer: false,
          generateMipmaps: false,
          magFilter: LinearFilter,
          minFilter: LinearFilter,
          type: FloatType,
        },
      );
      this.#atlasTexture = this.#atlasTarget.texture as Data3DTexture;
      this.#atlasTexture.format = RGBAFormat;
    } else {
      // The atlas stays the plain 3D texture made at construction; slices are rendered here and copied in.
      this.#sliceTarget = new RenderTarget(this.resolution.x, this.resolution.y, {
        depthBuffer: false,
        generateMipmaps: false,
        magFilter: NearestFilter,
        minFilter: NearestFilter,
        type: FloatType,
      });
    }
    this.#setSamplingIsolated(this.#samplingIsolated);
    this.#quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.#quadMesh = new Mesh(new PlaneGeometry(2, 2));
    this.#quadScene = new Scene();
    this.#quadScene.add(this.#quadMesh);
    this.#projectionMaterial = createProjectionMaterial(this.#cubeRenderTarget, this.#cubemapSize);
    this.#batchTextureNode = texture(this.#batchTarget.texture);
    this.#repackMaterials = createRepackMaterials(
      this.#batchTextureNode,
      this.#repackSlice,
      this.resolution,
      this.#probeCount,
    );
    this.#startGpuWarmup();
  }

  /** Compile the private projection/repack graphs outside the presented frame budget. */
  #startGpuWarmup(): void {
    if (this.#gpuWarmupStarted) return;
    const projectionTarget = this.#projectionTarget;
    const projectionMaterial = this.#projectionMaterial;
    const atlasTarget = this.#atlasTarget ?? this.#sliceTarget;
    const repackMaterials = this.#repackMaterials;
    if (
      projectionTarget === undefined ||
      projectionMaterial === undefined ||
      atlasTarget === undefined ||
      repackMaterials === undefined
    )
      throw new Error("ProbeVolume warm-up resources were not initialized.");
    this.#gpuWarmupStarted = true;
    // First-use shader work belongs to scene entry, before bounded bake slices are presented.
    this.#renderQuad(projectionTarget, projectionMaterial);
    repackMaterials.forEach((material, index) => {
      this.#renderQuad(
        atlasTarget,
        material,
        this.#atlasTarget === undefined ? undefined : index * this.paddedSlices,
      );
    });
  }

  /** Compile every scene material through the six cube-camera views before the first capture. */
  #startSceneWarmup(scene: Scene): void {
    if (this.#sceneWarmupStarted) return;
    this.#sceneWarmupStarted = true;
    const renderer = this.#renderer;
    const raw = renderer?.raw as IProbeRenderer | undefined;
    const cubeCamera = this.#cubeCamera;
    if (
      renderer === undefined ||
      typeof renderer.compileAsync !== "function" ||
      cubeCamera === undefined
    )
      return;
    const coordinateSystem = raw?.coordinateSystem;
    if (coordinateSystem !== undefined && cubeCamera.coordinateSystem !== coordinateSystem) {
      cubeCamera.coordinateSystem = coordinateSystem;
      cubeCamera.updateCoordinateSystem();
    }
    const cameras = cubeCamera.children.filter(
      (child): child is Camera => (child as Camera).isCamera === true,
    );
    if (cameras.length === 0) return;
    this.#sceneWarmupSettled = false;
    void (async () => {
      try {
        const compile = (async () => {
          for (const camera of cameras) await renderer.compileAsync(scene, camera);
        })();
        await Promise.race([
          compile,
          new Promise<void>((resolve) => setTimeout(resolve, SCENE_WARMUP_TIMEOUT_MS)),
        ]);
      } catch {
        // A failed warm-up is not a failed bake. The first bounded capture surfaces the renderer
        // error, while a host without a settling compile promise still reaches the same path.
      } finally {
        this.#sceneWarmupSettled = true;
      }
    })();
  }

  #prepareBake(scene: Scene, passes: number): void {
    if (this.#sceneState !== undefined) return;
    this.#ensureGpuResources();
    const raw = this.#rawRenderer();
    const matrixWorldAutoUpdate = scene.matrixWorldAutoUpdate;
    if (matrixWorldAutoUpdate) {
      scene.updateMatrixWorld(true);
      scene.matrixWorldAutoUpdate = false;
    }
    const shadowAutoUpdate = raw.shadowMap?.autoUpdate;
    if (raw.shadowMap !== undefined) {
      raw.shadowMap.autoUpdate = false;
      raw.shadowMap.needsUpdate = true;
    }
    this.#sceneState = {
      matrixWorldAutoUpdate,
      scene,
      ...(shadowAutoUpdate === undefined ? {} : { shadowAutoUpdate }),
    };
    this.#startSceneWarmup(scene);
    if (this.#pending !== undefined && this.#pending.passes !== passes) {
      throw new Error("ProbeVolume cannot change bake passes after a bake has started.");
    }
  }

  #runWorkItem(pending: IPendingBake): void {
    if (pending.phase === "capture") {
      this.#runCaptureWorkItem(pending);
    } else if (pending.phase === "project") {
      this.#runProjectWorkItem(pending);
    } else if (pending.phase === "copy") {
      this.#runCopyWorkItem(pending);
    } else if (this.#runRepackWorkItem(pending)) {
      return;
    }
    pending.completedWork += 1;
  }

  #runCaptureWorkItem(pending: IPendingBake): void {
    this.#captureProbeFace(pending.scene, pending.probeIndex, pending.cubeFaceIndex);
    pending.cubeFaceIndex += 1;
    if (pending.cubeFaceIndex >= CUBE_FACE_COUNT) pending.phase = "project";
  }

  #runProjectWorkItem(pending: IPendingBake): void {
    this.#projectProbe();
    pending.phase = "copy";
  }

  #runCopyWorkItem(pending: IPendingBake): void {
    this.#copyProjectedProbe(pending.probeIndex);
    pending.probeIndex += 1;
    pending.completedProbes += 1;
    if (pending.probeIndex >= this.#probeCount) {
      pending.phase = "repack";
      pending.repackIndex = 0;
    } else {
      pending.phase = "capture";
      pending.cubeFaceIndex = 0;
    }
  }

  #runRepackWorkItem(pending: IPendingBake): boolean {
    this.#repackSliceToAtlas(pending.repackIndex);
    pending.repackIndex += 1;
    if (pending.repackIndex < PACKED_SUB_VOLUME_COUNT * this.paddedSlices) return false;
    if (pending.pass + 1 < pending.passes) {
      pending.pass += 1;
      pending.phase = "capture";
      pending.cubeFaceIndex = 0;
      pending.probeIndex = 0;
      if (pending.pass === 1) this.#setSamplingIsolated(false);
      return false;
    }
    this.#finishBake();
    return true;
  }

  #captureProbeFace(scene: Scene, probeIndex: number, cubeFaceIndex: number): void {
    const ix = probeIndex % this.resolution.x;
    const iy = Math.floor(probeIndex / this.resolution.x) % this.resolution.y;
    const iz = Math.floor(probeIndex / (this.resolution.x * this.resolution.y));
    const position = this.probePosition(ix, iy, iz);
    const cubeCamera = this.#cubeCamera;
    const cubeTarget = this.#cubeRenderTarget;
    if (cubeCamera === undefined || cubeTarget === undefined) {
      throw new Error("ProbeVolume bake resources were not initialized.");
    }
    cubeCamera.position.copy(position);
    cubeCamera.updateMatrixWorld(true);
    const raw = this.#rawRenderer();
    if (
      raw.coordinateSystem !== undefined &&
      cubeCamera.coordinateSystem !== raw.coordinateSystem
    ) {
      cubeCamera.coordinateSystem = raw.coordinateSystem;
      cubeCamera.updateCoordinateSystem();
    }
    const camera = valueAt(
      cubeCamera.children.filter((child): child is Camera => (child as Camera).isCamera === true),
      cubeFaceIndex,
      "cube camera face",
    );
    const previousTarget = raw.getRenderTarget?.() ?? null;
    const previousFace = raw.getActiveCubeFace?.() ?? 0;
    const previousMip = raw.getActiveMipmapLevel?.() ?? 0;
    const previousXr = raw.xr?.enabled;
    if (raw.xr !== undefined) raw.xr.enabled = false;
    raw.setRenderTarget(cubeTarget, cubeFaceIndex, cubeCamera.activeMipmapLevel);
    try {
      if (raw.reversedDepthBuffer === true && raw.autoClear === false) raw.clearDepth?.();
      raw.render(scene, camera);
    } finally {
      raw.setRenderTarget(previousTarget, previousFace, previousMip);
      if (raw.xr !== undefined && previousXr !== undefined) raw.xr.enabled = previousXr;
    }
    if (cubeFaceIndex === CUBE_FACE_COUNT - 1) cubeTarget.texture.needsPMREMUpdate = true;
  }

  #projectProbe(): void {
    const projectionTarget = this.#projectionTarget;
    const projectionMaterial = this.#projectionMaterial;
    if (projectionTarget === undefined || projectionMaterial === undefined) {
      throw new Error("ProbeVolume projection resources were not initialized.");
    }
    this.#renderQuad(projectionTarget, projectionMaterial);
  }

  #copyProjectedProbe(probeIndex: number): void {
    const projectionTarget = this.#projectionTarget;
    const batchTarget = this.#batchTarget;
    if (projectionTarget === undefined || batchTarget === undefined) {
      throw new Error("ProbeVolume copy resources were not initialized.");
    }
    const raw = this.#rawRenderer();
    if (raw.copyTextureToTexture === undefined) {
      throw new Error(
        "ProbeVolume requires WebGPU texture-to-texture copies for its staging rows.",
      );
    }
    raw.copyTextureToTexture(
      projectionTarget.texture,
      batchTarget.texture,
      new Box2(new Vector2(0, 0), new Vector2(9, 1)),
      new Vector2(0, probeIndex),
    );
  }

  #repackSliceToAtlas(repackIndex: number): void {
    const atlasTarget = this.#atlasTarget ?? this.#sliceTarget;
    const materials = this.#repackMaterials;
    if (atlasTarget === undefined || materials === undefined) {
      throw new Error("ProbeVolume repack resources were not initialized.");
    }
    const subVolume = Math.floor(repackIndex / this.paddedSlices);
    const localSlice = repackIndex % this.paddedSlices;
    const sourceSlice = Math.min(this.resolution.z - 1, Math.max(0, localSlice - ATLAS_PADDING));
    this.#repackSlice.value = sourceSlice;
    atlasTarget.viewport.set(0, 0, this.resolution.x, this.resolution.y);
    atlasTarget.scissorTest = false;
    const material = valueAt(materials, subVolume, "repack material");
    const atlasSlice = subVolume * this.paddedSlices + localSlice;
    if (this.#atlasTarget !== undefined) {
      this.#renderQuad(atlasTarget, material, atlasSlice);
      return;
    }
    this.#renderQuad(atlasTarget, material);
    this.#copySliceToAtlas(atlasSlice);
  }

  /** The atlas path for a device with no 3D render attachment: the 2D slice target joins the 3D atlas. */
  #copySliceToAtlas(atlasSlice: number): void {
    const raw = this.#rawRenderer();
    const source = this.#sliceTarget;
    if (source === undefined || raw.copyTextureToTexture === undefined) {
      throw new Error(
        "ProbeVolume requires WebGPU texture-to-texture copies for its atlas slices.",
      );
    }
    if (!this.#atlasUploaded) {
      // The copy needs the GPU atlas to exist; its first upload is the zero-filled CPU atlas.
      raw.initTexture?.(this.#atlasTexture);
      this.#atlasUploaded = true;
    }
    raw.copyTextureToTexture(
      source.texture,
      this.#atlasTexture,
      new Box2(new Vector2(0, 0), new Vector2(this.resolution.x, this.resolution.y)),
      new Vector3(0, 0, atlasSlice),
    );
  }

  #renderQuad(target: RenderTarget | RenderTarget3D, material: NodeMaterial, slice?: number): void {
    const raw = this.#rawRenderer();
    const previousTarget = raw.getRenderTarget?.() ?? null;
    const previousFace = raw.getActiveCubeFace?.() ?? 0;
    const previousMip = raw.getActiveMipmapLevel?.() ?? 0;
    const mesh = this.#quadMesh;
    const camera = this.#quadCamera;
    const scene = this.#quadScene;
    if (mesh === undefined || camera === undefined || scene === undefined) {
      throw new Error("ProbeVolume quad resources were not initialized.");
    }
    mesh.material = material;
    raw.setRenderTarget(target, slice ?? 0, 0);
    try {
      raw.render(scene, camera);
    } finally {
      raw.setRenderTarget(previousTarget, previousFace, previousMip);
    }
  }

  #finishBake(): void {
    this.#restoreSceneState();
    this.#setSamplingIsolated(false);
    this.#status = "ready";
    this.#stalenessFrames = 0;
    const promise = this.#bakePromise;
    this.#pending = undefined;
    this.#bakePromise = undefined;
    promise?.resolve();
  }

  #failBake(error: unknown): void {
    this.#restoreSceneState();
    this.#pending = undefined;
    const promise = this.#bakePromise;
    this.#bakePromise = undefined;
    promise?.reject(error);
    this.#status = "unbaked";
    this.#publish(true);
  }

  #restoreSceneState(): void {
    const state = this.#sceneState;
    if (state === undefined) return;
    state.scene.matrixWorldAutoUpdate = state.matrixWorldAutoUpdate;
    const raw = this.#renderer === undefined ? undefined : (this.#renderer.raw as IProbeRenderer);
    if (raw?.shadowMap !== undefined && state.shadowAutoUpdate !== undefined) {
      raw.shadowMap.autoUpdate = state.shadowAutoUpdate;
    }
    this.#sceneState = undefined;
  }

  #rawRenderer(): IProbeRenderer {
    if (this.#renderer === undefined)
      throw new Error("ProbeVolume needs an attached WebGPURenderer.");
    return this.#renderer.raw as IProbeRenderer;
  }

  #clearPreviousBake(): void {
    this.#coefficients.fill(0);
    this.#atlasData.fill(0);
    if (this.#atlasTarget === undefined && this.#sliceTarget === undefined) {
      this.#atlasTexture.needsUpdate = true;
    }
  }

  #setSamplingIsolated(isolated: boolean): void {
    this.#samplingIsolated = isolated;
    this.#atlasNode.value = isolated ? this.#emptyAtlasTexture : this.#atlasTexture;
  }

  #publish(force: boolean): void {
    const observation = this.observation;
    const line = `${PROBE_VOLUME_MARKER}:${JSON.stringify(observation)}`;
    if (!force && line === this.#lastReported) return;
    this.#lastReported = line;
    this.#report(line);
  }

  #packCpuAtlas(): void {
    for (let subVolume = 0; subVolume < PACKED_SUB_VOLUME_COUNT; subVolume += 1) {
      packCpuSubVolume(
        this.#atlasData,
        this.#coefficients,
        this.resolution,
        this.paddedSlices,
        subVolume,
      );
    }
    this.#atlasTexture.image.data = this.#atlasData;
    this.#atlasTexture.needsUpdate = true;
  }

  #samplePackedCoefficients(position: Vector3): Float32Array {
    const local = normalizedPosition(position, this.boundingBox.min, this.#boundsSize);
    const atlasX = (local.x * (this.resolution.x - 1) + 0.5) / this.resolution.x;
    const atlasY = (local.y * (this.resolution.y - 1) + 0.5) / this.resolution.y;
    const sampleStride = this.resolution.z + 2 * SAMPLE_ATLAS_PADDING;
    const packed = Array.from({ length: PACKED_SUB_VOLUME_COUNT }, (_, subVolume) =>
      sampleAtlas(
        this.#atlasData,
        this.resolution.x,
        this.resolution.y,
        this.#atlasDepth,
        atlasX,
        atlasY,
        (local.z * (this.resolution.z - 1) +
          SAMPLE_ATLAS_PADDING +
          0.5 +
          subVolume * sampleStride) /
          this.#atlasDepth,
      ),
    );
    const result = new Float32Array(SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT);
    for (let subVolume = 0; subVolume < PACKED_SUB_VOLUME_COUNT; subVolume += 1) {
      const texel = valueAt(packed, subVolume, "sampled atlas sub-volume");
      for (let channel = 0; channel < 4; channel += 1) {
        const packedChannel = valueAt(PACKED_CHANNELS, subVolume * 4 + channel, "packed channel");
        if (packedChannel !== null) {
          const [coefficient, component] = packedChannel;
          result[coefficient * SH_CHANNEL_COUNT + component] = valueAt(
            texel,
            channel,
            "sampled atlas channel",
          );
        }
      }
    }
    return result;
  }

  probePosition(ix: number, iy: number, iz: number, target = new Vector3()): Vector3 {
    return target.set(
      this.boundingBox.min.x + (ix * this.#boundsSize.x) / (this.resolution.x - 1),
      this.boundingBox.min.y + (iy * this.#boundsSize.y) / (this.resolution.y - 1),
      this.boundingBox.min.z + (iz * this.#boundsSize.z) / (this.resolution.z - 1),
    );
  }
}

function packCpuSubVolume(
  atlasData: Float32Array,
  coefficients: Float32Array,
  resolution: Vector3,
  paddedSlices: number,
  subVolume: number,
): void {
  const nx = resolution.x;
  const ny = resolution.y;
  const nz = resolution.z;
  const base = subVolume * paddedSlices;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const probe = x + y * nx + z * nx * ny;
        writeAtlasTexel(
          atlasData,
          nx,
          ny,
          base + ATLAS_PADDING + z,
          x,
          y,
          packedCoefficients(coefficients, probe, subVolume),
        );
      }
    }
  }
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const first = packedCoefficients(coefficients, x + y * nx, subVolume);
      const lastProbe = x + y * nx + (nz - 1) * nx * ny;
      const last = packedCoefficients(coefficients, lastProbe, subVolume);
      for (let pad = 0; pad < ATLAS_PADDING; pad += 1) {
        writeAtlasTexel(atlasData, nx, ny, base + pad, x, y, first);
        writeAtlasTexel(atlasData, nx, ny, base + ATLAS_PADDING + nz + pad, x, y, last);
      }
    }
  }
}

function writeAtlasTexel(
  atlasData: Float32Array,
  width: number,
  height: number,
  z: number,
  x: number,
  y: number,
  values: readonly number[],
): void {
  const offset = ((z * height + y) * width + x) * 4;
  atlasData.set(values, offset);
}

function packedCoefficients(
  coefficients: Float32Array,
  probe: number,
  subVolume: number,
): number[] {
  const result = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel += 1) {
    const packedChannel = valueAt(PACKED_CHANNELS, subVolume * 4 + channel, "packed channel");
    if (packedChannel === null) continue;
    const [coefficient, component] = packedChannel;
    result[channel] =
      coefficients[
        probe * SH_COEFFICIENT_COUNT * SH_CHANNEL_COUNT + coefficient * SH_CHANNEL_COUNT + component
      ] ?? 0;
  }
  return result;
}

function normalizedPosition(position: Vector3, minimum: Vector3, size: Vector3): Vector3 {
  const local = position.clone().sub(minimum);
  local.x = Math.min(1, Math.max(0, local.x / size.x));
  local.y = Math.min(1, Math.max(0, local.y / size.y));
  local.z = Math.min(1, Math.max(0, local.z / size.z));
  return local;
}

function sampleAtlas(
  data: Float32Array,
  width: number,
  height: number,
  depth: number,
  u: number,
  v: number,
  w: number,
): number[] {
  const x = clampedTextureCoordinate(u, width);
  const y = clampedTextureCoordinate(v, height);
  const z = clampedTextureCoordinate(w, depth);
  const lowerX = Math.floor(x);
  const lowerY = Math.floor(y);
  const lowerZ = Math.floor(z);
  const upperX = Math.min(width - 1, lowerX + 1);
  const upperY = Math.min(height - 1, lowerY + 1);
  const upperZ = Math.min(depth - 1, lowerZ + 1);
  const result = [0, 0, 0, 0];
  for (const sampleZ of uniquePair(lowerZ, upperZ)) {
    for (const sampleY of uniquePair(lowerY, upperY)) {
      for (const sampleX of uniquePair(lowerX, upperX)) {
        const weight =
          interpolationFactor(sampleX, lowerX, upperX, x - lowerX) *
          interpolationFactor(sampleY, lowerY, upperY, y - lowerY) *
          interpolationFactor(sampleZ, lowerZ, upperZ, z - lowerZ);
        const offset = ((sampleZ * height + sampleY) * width + sampleX) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          result[channel] =
            valueAt(result, channel, "atlas result channel") +
            (data[offset + channel] ?? 0) * weight;
        }
      }
    }
  }
  return result;
}

function clampedTextureCoordinate(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value * size - 0.5));
}

function uniquePair(lower: number, upper: number): readonly number[] {
  return lower === upper ? [lower] : [lower, upper];
}

function interpolationFactor(
  sample: number,
  lower: number,
  upper: number,
  fraction: number,
): number {
  if (lower === upper) return 1;
  return sample === lower ? 1 - fraction : fraction;
}

function createCpuAtlas(data: Float32Array, resolution: Vector3, depth: number): Data3DTexture {
  const atlas = new Data3DTexture(data, resolution.x, resolution.y, depth);
  atlas.type = FloatType;
  atlas.format = RGBAFormat;
  atlas.minFilter = LinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.wrapR = ClampToEdgeWrapping;
  atlas.generateMipmaps = false;
  atlas.needsUpdate = true;
  return atlas;
}

function createProjectionMaterial(cubeTarget: CubeRenderTarget, cubemapSize: number): NodeMaterial {
  const environment = cubeTexture(cubeTarget.texture);
  const coefficientIndex = int(floor(viewportCoordinate.x));
  const projection = Fn(() => {
    const accum = Array.from({ length: SH_COEFFICIENT_COUNT }, () => vec3(0).toVar());
    const accumAt = (index: number) => valueAt(accum, index, "SH accumulation");
    const totalWeight = float(0).toVar();
    const pixelSize = 2 / cubemapSize;
    for (let face = 0; face < 6; face += 1) {
      for (let iy = 0; iy < cubemapSize; iy += 1) {
        for (let ix = 0; ix < cubemapSize; ix += 1) {
          const col = (ix + 0.5) * pixelSize - 1;
          const row = 1 - (iy + 0.5) * pixelSize;
          const coordinate = cubeFaceCoordinate(face, col, row);
          const lengthSquared =
            coordinate.x * coordinate.x + coordinate.y * coordinate.y + coordinate.z * coordinate.z;
          const weight = 4 / (Math.sqrt(lengthSquared) * lengthSquared);
          const direction = new Vector3(coordinate.x, coordinate.y, coordinate.z).normalize();
          const weighted = environment
            .sample(vec3(coordinate.x, coordinate.y, coordinate.z))
            .rgb.mul(weight);
          totalWeight.addAssign(weight);
          accumAt(0).addAssign(weighted.mul(0.282095));
          accumAt(1).addAssign(weighted.mul(0.488603 * direction.y));
          accumAt(2).addAssign(weighted.mul(0.488603 * direction.z));
          accumAt(3).addAssign(weighted.mul(0.488603 * direction.x));
          accumAt(4).addAssign(weighted.mul(1.092548 * direction.x * direction.y));
          accumAt(5).addAssign(weighted.mul(1.092548 * direction.y * direction.z));
          accumAt(6).addAssign(weighted.mul(0.315392 * (3 * direction.z * direction.z - 1)));
          accumAt(7).addAssign(weighted.mul(1.092548 * direction.x * direction.z));
          accumAt(8).addAssign(
            weighted.mul(0.546274 * (direction.x * direction.x - direction.y * direction.y)),
          );
        }
      }
    }
    const norm = float(4 * Math.PI).div(totalWeight);
    let selected: Node<"vec3"> = accumAt(8);
    for (let index = SH_COEFFICIENT_COUNT - 2; index >= 0; index -= 1) {
      selected = coefficientIndex.equal(index).select(accumAt(index), selected) as Node<"vec3">;
    }
    return vec4(selected.mul(norm), 1);
  })();
  const material = new NodeMaterial();
  material.fragmentNode = projection;
  material.toneMapped = false;
  material.depthTest = false;
  material.depthWrite = false;
  return material;
}

function createRepackMaterials(
  batchTextureNode: TextureNode,
  slice: Node<"int">,
  dimensions: Vector3,
  probeCount: number,
): NodeMaterial[] {
  const ix = floor(viewportCoordinate.x);
  const iy = floor(viewportCoordinate.y);
  const probe = ix.add(iy.mul(dimensions.x)).add(int(slice).mul(dimensions.x * dimensions.y));
  const uv = vec2(probe.add(0.5).div(probeCount), 0);
  const samples = Array.from({ length: SH_COEFFICIENT_COUNT }, (_, index) =>
    batchTextureNode.sample(vec2((index + 0.5) / SH_COEFFICIENT_COUNT, uv.x)),
  );
  const sampleAt = (index: number) => valueAt(samples, index, "repack sample");
  const values = [
    [sampleAt(0).x, sampleAt(0).y, sampleAt(0).z, sampleAt(1).x],
    [sampleAt(1).y, sampleAt(1).z, sampleAt(2).x, sampleAt(2).y],
    [sampleAt(2).z, sampleAt(3).x, sampleAt(3).y, sampleAt(3).z],
    [sampleAt(4).x, sampleAt(4).y, sampleAt(4).z, sampleAt(5).x],
    [sampleAt(5).y, sampleAt(5).z, sampleAt(6).x, sampleAt(6).y],
    [sampleAt(6).z, sampleAt(7).x, sampleAt(7).y, sampleAt(7).z],
    [sampleAt(8).x, sampleAt(8).y, sampleAt(8).z, 0],
  ];
  return values.map((value) => {
    const material = new NodeMaterial();
    material.fragmentNode = vec4(
      valueAt(value, 0, "repack red channel"),
      valueAt(value, 1, "repack green channel"),
      valueAt(value, 2, "repack blue channel"),
      valueAt(value, 3, "repack alpha channel"),
    );
    material.toneMapped = false;
    material.depthTest = false;
    material.depthWrite = false;
    return material;
  });
}

function cubeFaceCoordinate(face: number, col: number, row: number): IVector3Like {
  if (face === 0) return { x: 1, y: row, z: -col };
  if (face === 1) return { x: -1, y: row, z: col };
  if (face === 2) return { x: col, y: 1, z: -row };
  if (face === 3) return { x: col, y: -1, z: row };
  if (face === 4) return { x: col, y: row, z: 1 };
  return { x: -col, y: row, z: -1 };
}

/** The SH L2 basis constants per band, times each band's lobe weight. */
interface IShWeights {
  readonly l0: number;
  readonly l1: number;
  readonly l2: number;
  readonly l20: number;
  readonly l20Offset: number;
  readonly l22: number;
}

/** The basis convolved with a cosine lobe (bands times pi, 2 pi / 3 and pi / 4): irradiance E for a normal. */
const SH_IRRADIANCE_WEIGHTS: IShWeights = {
  l0: 0.886227,
  l1: 1.023328,
  l2: 0.858086,
  l20: 0.743125,
  l20Offset: 0.247708,
  l22: 0.429043,
};

/** The bare basis: the radiance arriving along a direction. */
const SH_RADIANCE_WEIGHTS: IShWeights = {
  l0: 0.282095,
  l1: 0.488603,
  l2: 1.092548,
  l20: 0.946176,
  l20Offset: 0.315392,
  l22: 0.546274,
};

function evaluateShChannel(
  coefficients: Float32Array,
  channel: number,
  normal: Vector3,
  w: IShWeights,
): number {
  const c = (index: number) => coefficients[index * SH_CHANNEL_COUNT + channel] ?? 0;
  return (
    c(0) * w.l0 +
    c(1) * normal.y * w.l1 +
    c(2) * normal.z * w.l1 +
    c(3) * normal.x * w.l1 +
    c(4) * normal.x * normal.y * w.l2 +
    c(5) * normal.y * normal.z * w.l2 +
    c(6) * (normal.z * normal.z * w.l20 - w.l20Offset) +
    c(7) * normal.x * normal.z * w.l2 +
    c(8) * (normal.x * normal.x - normal.y * normal.y) * w.l22
  );
}

function normalizeBounds(value: IProbeVolumeOptions["bounds"]): Box3 {
  const min = new Vector3(value.min.x, value.min.y, value.min.z);
  const max = new Vector3(value.max.x, value.max.y, value.max.z);
  for (const [name, vector] of [
    ["min", min],
    ["max", max],
  ] as const) {
    if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
      throw new Error(`ProbeVolume bounds.${name} must contain finite x, y, and z values.`);
    }
  }
  if (!(min.x < max.x && min.y < max.y && min.z < max.z)) {
    throw new Error(
      "ProbeVolume bounds must be non-degenerate and min must be below max on every axis.",
    );
  }
  return new Box3(min, max);
}

function normalizeDensity(value: ProbeVolumeDensity): Vector3 {
  let density: Vector3;
  if (typeof value === "number") {
    density = new Vector3(value, value, value);
  } else if ("x" in value) {
    density = new Vector3(value.x, value.y, value.z);
  } else {
    density = new Vector3(value[0] ?? Number.NaN, value[1] ?? Number.NaN, value[2] ?? Number.NaN);
  }
  if (![density.x, density.y, density.z].every((axis) => Number.isFinite(axis) && axis > 0)) {
    throw new Error("ProbeVolume density must be finite and greater than zero on every axis.");
  }
  return density;
}

function resolutionForAxis(size: number, density: number, axis: string): number {
  const resolution = Math.ceil(size * density) + 1;
  if (!Number.isSafeInteger(resolution) || resolution < 2) {
    throw new Error(`ProbeVolume density on ${axis} produces an invalid probe resolution.`);
  }
  return resolution;
}

function checkedAtlasDepth(zResolution: number): number {
  const depth = PACKED_SUB_VOLUME_COUNT * (zResolution + 2 * ATLAS_PADDING);
  if (!Number.isSafeInteger(depth)) {
    throw new Error("ProbeVolume maxTextureDimension3D would be exceeded by the atlas depth.");
  }
  return depth;
}

function checkedIntegerProduct(a: number, b: number, c: number, label: string): number {
  const result = a * b * c;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`ProbeVolume ${label} exceeds the device texture limit.`);
  }
  return result;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`ProbeVolume ${name} must be finite and positive.`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`ProbeVolume ${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`ProbeVolume ${name} must be a non-negative integer.`);
  return value;
}

function validateTextureLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `ProbeVolume maxTextureDimension3D must be a positive integer, received ${String(value)}.`,
    );
  }
}

function assertTextureLimit(dimension: number, limit: number): void {
  if (dimension > limit) {
    throw new Error(
      `ProbeVolume atlas dimension ${dimension} exceeds maxTextureDimension3D device texture limit ${limit}.`,
    );
  }
}

function readTextureLimit(renderer: IProbeRenderer): number | undefined {
  const limit =
    renderer.backend?.device?.limits?.maxTextureDimension3D ??
    renderer.device?.limits?.maxTextureDimension3D;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function isProbeVolumeObservation(value: unknown): value is IProbeVolumeObservation {
  if (!isRecord(value) || value.marker !== PROBE_VOLUME_MARKER) return false;
  const atlas = value.atlas;
  const progress = value.bakeProgress;
  const status = value.status;
  const stale = value.stale;
  const unbaked = value.unbaked;
  const stalenessFrames = value.stalenessFrames;
  const probeCount = value.probeCount;
  const atlasBytes = value.atlasBytes;
  const bakeCostMs = value.bakeCostMs;
  const bakeBudgetMs = value.bakeBudgetMs;
  const samplingIsolated = value.samplingIsolated;
  if (
    !isProbeVolumeStatus(status) ||
    typeof stale !== "boolean" ||
    typeof unbaked !== "boolean" ||
    !isStalenessFrames(stalenessFrames) ||
    !isPositiveIntegerValue(probeCount) ||
    !isPositiveIntegerValue(atlasBytes) ||
    !isFiniteNonNegative(bakeCostMs) ||
    !isFinitePositive(bakeBudgetMs) ||
    typeof samplingIsolated !== "boolean"
  )
    return false;
  if (!isProbeVolumeAtlas(atlas, probeCount, atlasBytes)) return false;
  const trace = observationUpdate(value);
  if (trace === undefined) return false;
  if (!isProbeVolumeBakeProgress(progress, status, probeCount, atlas.depth, trace)) return false;
  if (stale !== (status !== "ready") || unbaked !== (status === "unbaked")) return false;
  // A traced refresh never isolates: the old field serves until each probe is replaced.
  if (trace ? samplingIsolated : status === "baking" && samplingIsolated !== (progress.pass === 0))
    return false;
  return status !== "ready" || (stalenessFrames !== null && !samplingIsolated);
}

/** `true` for a complete trace observation, `false` for a capture one, `undefined` for a malformed one. */
function observationUpdate(value: Record<string, unknown>): boolean | undefined {
  const { update, probesTraced, oldestProbeAgeFrames, ignoredTextureMaterials } = value;
  if (update === undefined || update === "capture") return false;
  if (update !== "trace") return undefined;
  const complete =
    isProgressValue(probesTraced) &&
    isProgressValue(ignoredTextureMaterials) &&
    (oldestProbeAgeFrames === null || isProgressValue(oldestProbeAgeFrames));
  return complete ? true : undefined;
}

/** Work items a probe costs, and the work that closes a pass: the repack slices, or one readback. */
function passWork(trace: boolean, atlasDepth: number): { perProbe: number; tail: number } {
  return trace
    ? { perProbe: 1, tail: 1 }
    : { perProbe: CAPTURE_WORK_ITEMS_PER_PROBE, tail: atlasDepth };
}

function isProbeVolumeAtlas(
  value: unknown,
  probeCount: number,
  atlasBytes: number,
): value is IProbeVolumeObservation["atlas"] {
  if (!isRecord(value)) return false;
  const width = value.width;
  const height = value.height;
  const depth = value.depth;
  if (
    !isPositiveIntegerValue(width) ||
    !isPositiveIntegerValue(height) ||
    !isPositiveIntegerValue(depth) ||
    width < 2 ||
    height < 2 ||
    depth % PACKED_SUB_VOLUME_COUNT !== 0
  )
    return false;
  const paddedSlices = depth / PACKED_SUB_VOLUME_COUNT;
  const resolutionZ = paddedSlices - 2 * ATLAS_PADDING;
  if (!isPositiveIntegerValue(resolutionZ) || resolutionZ < 2) return false;
  const expectedProbeCount = width * height * resolutionZ;
  const expectedAtlasBytes = width * height * depth * BYTES_PER_TEXEL;
  return (
    isPositiveIntegerValue(expectedProbeCount) &&
    isPositiveIntegerValue(expectedAtlasBytes) &&
    probeCount === expectedProbeCount &&
    atlasBytes === expectedAtlasBytes
  );
}

function isProbeVolumeBakeProgress(
  value: unknown,
  status: IProbeVolumeObservation["status"],
  probeCount: number,
  atlasDepth: number,
  trace = false,
): value is IProbeVolumeBakeProgress {
  if (!isProbeVolumeBakeProgressShape(value)) return false;
  const { completed, total, fraction, probesCompleted, probesTotal, pass, passes } = value;
  const expectedProbesTotal = probeCount * passes;
  const { perProbe: itemsPerProbe, tail } = passWork(trace, atlasDepth);
  const workPerPass = probeCount * itemsPerProbe + tail;
  const expectedTotal = workPerPass * passes;
  if (
    !isPositiveIntegerValue(expectedProbesTotal) ||
    !isPositiveIntegerValue(workPerPass) ||
    !isPositiveIntegerValue(expectedTotal) ||
    total !== expectedTotal ||
    probesTotal !== expectedProbesTotal ||
    pass >= passes ||
    completed > total ||
    probesCompleted > probesTotal ||
    fraction !== completed / total
  )
    return false;
  if (status === "ready") {
    return completed === total && probesCompleted === probesTotal && pass === passes - 1;
  }
  if (status === "unbaked") {
    return completed === 0 && probesCompleted === 0 && pass === 0;
  }
  if (completed >= total) return false;
  const passWorkStart = pass * workPerPass;
  const passProbesStart = pass * probeCount;
  if (!Number.isSafeInteger(passWorkStart) || !Number.isSafeInteger(passProbesStart)) return false;
  const currentWork = completed - passWorkStart;
  const currentProbes = probesCompleted - passProbesStart;
  if (
    currentWork < 0 ||
    currentWork >= workPerPass ||
    currentProbes < 0 ||
    currentProbes > probeCount
  )
    return false;
  if (currentProbes === probeCount) return currentWork >= probeCount * itemsPerProbe;
  const minimumWork = currentProbes * itemsPerProbe;
  return currentWork >= minimumWork && currentWork <= minimumWork + itemsPerProbe - 1;
}

function isProbeVolumeBakeProgressShape(value: unknown): value is IProbeVolumeBakeProgress {
  if (!isRecord(value)) return false;
  return (
    isProgressValue(value.completed) &&
    isProgressValue(value.total) &&
    isUnitInterval(value.fraction) &&
    isProgressValue(value.probesCompleted) &&
    isProgressValue(value.probesTotal) &&
    isProgressValue(value.pass) &&
    isPositiveIntegerValue(value.passes)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbeVolumeStatus(value: unknown): value is IProbeVolumeObservation["status"] {
  return value === "unbaked" || value === "baking" || value === "ready";
}

function isStalenessFrames(value: unknown): value is number | null {
  return value === null || isProgressValue(value);
}

function isPositiveIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isProgressValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateProbeIndex(index: number, length: number, name: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new Error(`ProbeVolume ${name} must be an integer in [0, ${length - 1}].`);
  }
}

function valueAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`ProbeVolume ${label} ${index} is missing.`);
  return value;
}

function deferred(): IBakePromise {
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function isRendererLike(value: IRendererLike | Scene): value is IRendererLike {
  return typeof value === "object" && value !== null && "kind" in value && "raw" in value;
}
