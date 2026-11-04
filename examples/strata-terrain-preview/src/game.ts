import {
  BlendSpace1D,
  type IAssetLoader,
  type ICtx,
  type IGamePluginRuntime,
  Scene,
  SkeletalMesh3D,
  VirtualShadowNode,
  defineGame,
  markStatic,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { Heightfield, type WorldCells } from "@threenative/core/world";
import {
  CharacterBody3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  ScatterColliders,
  rapier,
} from "@threenative/physics";
import {
  type AnimationClip,
  CapsuleGeometry,
  Float32BufferAttribute,
  Frustum,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import { BENCHMARK, type ViewName } from "./render/benchmark.js";
import { BIOMES, type IWorldBiome, type WorldName, measureBiome } from "./render/biomes.js";
import { createGroundSampler } from "./render/groundSampler.js";
import {
  type HorizonSurroundings,
  horizonWalkGeometry,
  setHorizonSurroundings,
} from "./render/horizon.js";
import { createLoadingScreen } from "./render/loading.js";
import { createOcean, createWaterMesh } from "./render/ocean.js";
import {
  CAMERA_RIG,
  type IOrbitCamera,
  type WallProbe,
  createOrbitCamera,
} from "./render/orbitCamera.js";
import {
  type ICanopyComparison,
  SIGHT_RADIUS,
  loadPack,
  loadSkyLight,
  sightLine,
} from "./render/pack.js";
import { fetchBakedFile, loadPlacements } from "./render/placements.js";
import { loadPreparedProps } from "./render/prepared.js";
import { createPropSurfaces } from "./render/propMaterials.js";
import {
  type IPropPreparationProgress,
  createStreamedProps,
  invalidatePropShadows,
} from "./render/propStreaming.js";
import {
  type PropGroundQuery,
  buildPropVariants,
  flatPropMaterials,
  variantFor,
} from "./render/props.js";
import { type IRiverWater, WATER_LAYER, createLakes, createRivers } from "./render/river.js";
import { type IOutdoorSky, createOutdoorSky, installOutdoorOcclusion } from "./render/sky.js";
import { type IBakedWorld, createTerrain } from "./render/terrain.js";
import { preparePropTextures } from "./render/texturePreparation.js";
import { sampleActiveWaterProof, waterProofEnabled } from "./render/waterProof.js";
import {
  beginViewVisit,
  medianOfGrowingSamples as median,
  retainViewWindow,
} from "./viewStatistics.js";
import {
  type ForestStageWorld,
  addForestStage,
  forestStageArm,
  forestStageTerrainTargets,
} from "./world/forestStage.js";
import { waterCurrentAt, waterSurfaceAt } from "./world/water.js";

/** The last closed frame-budget window, published into state by the scene. */
const budget = {
  drawCalls: 0,
  frameMs: 0,
  tasksAvailable: false,
  longestTaskMs: -1,
  afterFirstFrameTaskMs: -1,
};
const launchedAt =
  typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now();

/**
 * Per-view frame cost, latched across the windows that closed while that camera was up.
 *
 * `budget` alone cannot answer "did the trees cost more at the meadow or at the overview": a playtest
 * cycles the cameras faster than a window closes, so the one number it holds belongs to whichever
 * view happened to be current. This keeps every window grouped by the view that was on screen, and
 * reports the median of each group's p50s and the worst p99 — the worst, because a LOD band that pops
 * once is a one-frame cost the median hides.
 */
interface IViewWindow {
  readonly view: string;
  readonly p50s: number[];
  readonly p99s: number[];
  /** Presented-frame interval p95 per window: the whole frame the player sees, GPU included. */
  readonly presentedP95s: number[];
  readonly triangles: number[];
  readonly gpuMs: number[];
  readonly gpuMain: number[];
  readonly gpuShadow: number[];
  readonly gpuOther: number[];
  readonly passes: Record<string, { triangles: number; draws: number }>[];
  readonly surfaces: { scale: number; samples: number }[];
}
const viewBudgets = new Map<string, IViewWindow>();
let currentView = "";
let viewVisit = beginViewVisit();
let measuredView = "";
let firstViewGpuFrame = Number.POSITIVE_INFINITY;
const renderedFrames: Record<WorldName, number> = {
  forest: 0,
  coastal: 0,
  alpine: 0,
  desert: 0,
  tundra: 0,
};
/**
 * The baked terrain arrays, fetched rather than imported: as JSON modules the 7–12 MB files cost
 * about 3 s each to compile before the first frame. Forest and coastal share `baked.json`.
 */
async function loadBakedWorld(
  assets: Pick<IAssetLoader, "resolve">,
  world: WorldName,
): Promise<IBakedWorld> {
  const shared = world === "forest" || world === "coastal";
  const response = await fetchBakedFile(assets, `world/${shared ? "baked" : world}.json`);
  const json = await response.json();
  return shared
    ? (json as Record<"forest" | "coastal", IBakedWorld>)[world]
    : (json as IBakedWorld);
}
let horizonLoad: Promise<void> | undefined;

const initialState = {
  elevationMin: 0,
  elevationMax: 0,
  snowFrom: 0,
  snowTo: 0,
  canopyComparison: { normals: "authored", specular: "disabled" } as ICanopyComparison,
  showcase: false,
  worldReady: false,
  spawnReadiness: [] as Array<Record<string, string | number | boolean>>,
  loadingError: "",
  spawnCellsRequired: 0,
  spawnCellsLoaded: 0,
  streamingResidentCells: 0,
  streamingLoadedCells: 0,
  streamingEvictions: 0,
  streamingInstances: 0,
  streamingFailures: 0,
  streamingPendingPrewarm: 0,
  streamingLoadsInFlight: 0,
  streamingAdmissionMs: 0,
  streamingAdmissionBacklog: 0,
  timeToReadyMs: -1,
  enterMs: -1,
  tasksAvailable: false,
  longestLoadTaskMs: -1,
  afterFirstFrameTaskMs: -1,
  maxViewGpuMs: -1,
  measuredGpuViewCount: 0,
  viewGpu: [] as {
    view: string;
    gpuMs: number;
    gpuMain: number;
    gpuShadow: number;
    gpuOther: number;
    windows: number;
    passes: Record<string, { triangles: number; draws: number }>;
    scale: number;
    samples: number;
  }[],
  world: "forest",
  groundBiome: "baked",
  terrainTransportBound: false,
  erosionFlowSamples: 0,
  erosionDepositSamples: 0,
  frames: 0,
  travel: 0,
  edgeOvershoot: Number.NEGATIVE_INFINITY,
  grounded: false,
  /** Rock and trunk bodies resident around the player (`ScatterColliders`). */
  propColliders: 0,
  /** Frames the player's capsule crossed into a rock or trunk; 0 while props are solid. */
  propOverlapFrames: 0,
  swimming: false,
  immersionDepth: 0,
  swimSamples: 0,
  swimFloatSamples: 0,
  swimExits: 0,
  /** Metres the river current carried the player along itself, while swimming. */
  swimDrift: 0,
  contactSamples: 0,
  maxContactError: 0,
  bilinearDifference: 0,
  oceanSteps: 0,
  waveSamples: 0,
  waveRange: 0,
  sampleSlopeRange: 0,
  lakePlacementError: 1,
  lakeSurfaceCount: 0,
  riverSurfaceCount: 0,
  lakeTriangles: 0,
  lakeFootprintError: 1,
  sunX: -180,
  propDraws: 0,
  propInstances: 0,
  propTriangles: 0,
  preparedLodBaseSpread: 0,
  compressedTexturesPrepared: 0,
  preparedLevelsWithoutSolid: 0,
  view: "player",
  revealComplete: false,
  windowDrawCalls: 0,
  windowFrameMs: 0,
  currentViewWindows: 0,
  viewFrameP50s: [] as { view: string; p50: number; presentedP95: number; windows: number }[],
  maxViewFrameP50: 0,
  maxViewPresentedP95: 0,
  measuredViewCount: 0,
  riverFrameP50: 0,
  playerFrameP50: 0,
  meadowFrameP50: 0,
  meadowFrameP99: 0,
  meadowTriangles: 0,
  overviewFrameP50: 0,
  overviewFrameP99: 0,
  overviewTriangles: 0,
  alpineRenderedFrames: 0,
  desertRenderedFrames: 0,
  tundraRenderedFrames: 0,
  alpineFrameP50: 0,
  desertFrameP50: 0,
  tundraFrameP50: 0,
  alpineOverviewFrameP50: 0,
  desertOverviewFrameP50: 0,
  tundraOverviewFrameP50: 0,
};
type TerrainState = typeof initialState;
type TerrainCtx = ICtx<TerrainState, IPhysicsContext>;

/** The starter kit's mannequin (Quaternius Universal Animation Library, CC0). */
interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}
const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  run: "Jog_Fwd_Loop",
  fall: "Jump_Loop",
  swim: "Swim_Fwd_Loop",
  tread: "Swim_Idle_Loop",
};
/**
 * The same rig's two swim clips (Universal Animation Library 1, CC0; see CREDITS.md). They are
 * authored with the root on the waterline, so a swimming figure's root rides the water surface.
 */
const SWIM_CLIPS = new URL("./world/mannequin-swim.glb", import.meta.url).href;
/** The mannequin's root sits at the capsule's bottom: 0.5 m half height + 0.35 m radius, sunk 1 cm. */
const FEET = -0.86;
/** Ground speeds in m/s: the jog the clip was authored for, and the Shift sprint. */
const JOG = 6;
const SPRINT = 9;

export function terrainScene(world: WorldName): new () => Scene<TerrainState, IPhysicsContext> {
  return class TerrainScene extends Scene<TerrainState, IPhysicsContext> {
    static override readonly initialState = initialState;
    #data: IBakedWorld | undefined;
    #biome: IWorldBiome | undefined;
    #erosionSamples = { flow: 0, deposition: 0 };
    #scatter: Awaited<ReturnType<typeof loadPlacements>> | undefined;
    #terrain: ReturnType<typeof createTerrain> | undefined;
    #fallbackParts: ReturnType<typeof buildPropVariants> | undefined;
    #stage: ForestStageWorld | undefined;
    #stageLoad = 0;
    #mannequin: IMannequin | undefined;
    #swimClips: readonly AnimationClip[] = [];
    #figure: SkeletalMesh3D | undefined;
    #orbit: IOrbitCamera | undefined;
    #gaits = new BlendSpace1D([1.8, JOG]);
    #heading = new Quaternion();
    #airborne = 0;
    override async load(ctx: TerrainCtx): Promise<void> {
      let swim: IMannequin;
      [this.#data, this.#mannequin, swim] = await Promise.all([
        loadBakedWorld(ctx.assets, world),
        ctx.assets.model<IMannequin>("mannequin.glb"),
        ctx.assets.model<IMannequin>(SWIM_CLIPS),
      ]);
      this.#swimClips = swim.animations;
      this.#biome = measureBiome(BIOMES[world], this.#data.heights);
      // `?stage=before|after` replaces this world's terrain, water, colliders and props with one
      // baked forest kit copy, streamed by the kit's own `addForest`; the sky, camera and views stay.
      const arm =
        world === "forest" ? forestStageArm(globalThis.location?.search ?? "") : undefined;
      if (arm) {
        this.#sky = createOutdoorSky(ctx.camera, this.#biome, ctx.renderer);
        const load = ++this.#stageLoad;
        const stage = await addForestStage(ctx, ctx.camera, arm, () => this.#stageLoad === load);
        if (this.#stageLoad === load) {
          this.#stage = stage;
        }
        return;
      }
      horizonLoad ??= fetchBakedFile(ctx.assets, "world/horizon.json")
        .then((response) => response.json())
        .then((distant) => setHorizonSurroundings(distant as HorizonSurroundings));
      [this.#scatter] = await Promise.all([loadPlacements(ctx.assets, world), horizonLoad]);
      // Prepare scenery while the scene loads; enter only attaches it.
      this.#terrain = createTerrain(this.#data, ctx.assets, this.#biome);
      this.#sky = createOutdoorSky(ctx.camera, this.#biome, ctx.renderer);
      if (world === "coastal") {
        this.#ocean = createOcean();
        this.#water = createWaterMesh(this.#ocean, this.#data);
      }
      this.#lake = createLakes(this.#data.lakes ?? [], this.#terrain.field, world === "forest");
      this.#erosionSamples = {
        flow: this.#data.erosion?.flow.filter((value) => value > 0).length ?? 0,
        deposition: this.#data.erosion?.deposition.filter((value) => value > 0).length ?? 0,
      };
      this.#fallbackParts = buildPropVariants(
        undefined,
        world === "alpine" ? 2 : world === "tundra" ? 1.4 : undefined,
      );
    }
    #player: CharacterBody3D | undefined;
    #surfaces: { advance: (elapsed: number) => void } | undefined;
    #elapsed = 0;
    #sky: IOutdoorSky | undefined;
    #ocean: ReturnType<typeof createOcean> | undefined;
    #water: ReturnType<typeof createWaterMesh> | undefined;
    #river: IRiverWater | undefined;
    #lake: IRiverWater | undefined;

    override exit(ctx: TerrainCtx): void {
      currentView = "";
      viewVisit = beginViewVisit();
      firstViewGpuFrame = Number.POSITIVE_INFINITY;
      measuredView = "";
      ctx.state.set({ currentViewWindows: 0 });
      this.#stageLoad++;
      const stage = this.#stage;
      this.#stage = undefined;
      if (!stage) return;
      stage.world.dispose();
      stage.colliders.detach();
      stage.ground.dispose();
      stage.water?.dispose();
    }

    override enter(ctx: TerrainCtx): void {
      const enterStart = performance.now();
      ctx.add(ctx.camera);
      const data = this.#data;
      if (!data) throw new Error(`World ${world} was not loaded`);
      const sky = this.#sky;
      if (!sky) throw new Error(`World ${world} sky was not loaded`);
      // ctx.goto carries state; camera names from the outgoing biome must not carry with it.
      ctx.state.set({
        view: "player",
        currentViewWindows: 0,
        worldReady: false,
        spawnReadiness: [],
        loadingError: "",
        spawnCellsRequired: 0,
        spawnCellsLoaded: 0,
        compressedTexturesPrepared: 0,
        revealComplete: false,
      });
      let released = false;
      const reveal = {
        startedMs: -1,
        elapsedMs: 0,
        complete: false,
        samples: 0,
        publishedBatchesInView: -1,
        shadowInvalidated: -1,
        impostorPendingPeak: -1,
        pipelinesCreated: -1,
        // A pipeline counter measured the reveal: the census, or the owned engine's compile count.
        pipelineCensusAvailable: false,
        pipelineSource: "none",
        // Device pipeline creations from the reveal to now, for the whole session: a walk and a
        // camera turn must build none either (`playtests/loop.playtest.json`). -1: not measured.
        pipelinesSinceReveal: -1,
      };
      let shadowAtReveal = -1;
      let pipelinesAtReveal: number | undefined;
      // Pipelines built so far, from one source picked at the reveal: the census's device creations
      // on three's backend, else the owned engine's compile count. The owned engine builds its
      // pipelines inside Wasm, where the census sees none and stays incomplete.
      let pipelineSource: "census" | "engine" | undefined;
      const pipelineCount = (source: typeof pipelineSource): number | undefined => {
        if (source === "census") {
          const census = ctx.renderer.pipelineCensus?.();
          return census?.complete === true ? census.counts.deviceCreations : undefined;
        }
        const engine = (ctx.renderer.raw as { info?: { engine?: { compiles?: unknown } } }).info
          ?.engine;
        return source === "engine" && typeof engine?.compiles === "number"
          ? engine.compiles
          : undefined;
      };
      const revealFrustum = new Frustum();
      const revealMatrix = new Matrix4();
      const initializeRevealProbe = (): void => {
        if (released || reveal.complete || reveal.startedMs >= 0) return;
        if (ctx.canvasLayer.opaque || ctx.startup.phase !== "ready")
          throw new Error("Reveal probe requires ready props and an uncovered world");
        const shadows = this.#sky?.sun.shadow.shadowNode;
        if (!(shadows instanceof VirtualShadowNode))
          throw new Error("Reveal probe requires virtual shadows");
        pipelineSource = pipelineCount("census") !== undefined ? "census" : "engine";
        reveal.startedMs = performance.now();
        reveal.publishedBatchesInView = 0;
        shadowAtReveal = shadows.stats.byInvalidation;
        pipelinesAtReveal = pipelineCount(pipelineSource);
        if (pipelinesAtReveal !== undefined) reveal.pipelineSource = pipelineSource;
        ctx.camera.updateMatrixWorld(true);
        revealFrustum.setFromProjectionMatrix(
          revealMatrix.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse),
          ctx.camera.coordinateSystem,
        );
      };
      ctx.afterPhysics(() => {
        if (
          released ||
          reveal.complete ||
          reveal.startedMs < 0 ||
          ctx.canvasLayer.opaque ||
          ctx.startup.phase !== "ready"
        )
          return;
        const shadows = this.#sky?.sun.shadow.shadowNode;
        if (!(shadows instanceof VirtualShadowNode))
          throw new Error("Reveal probe requires virtual shadows");
        const creations = pipelineCount(pipelineSource);
        reveal.samples++;
        reveal.elapsedMs = performance.now() - reveal.startedMs;
        reveal.shadowInvalidated = shadows.stats.byInvalidation - shadowAtReveal;
        reveal.impostorPendingPeak = Math.max(
          reveal.impostorPendingPeak,
          props?.worlds.reduce((sum, stream) => sum + stream.stats().impostor.pending, 0) ?? 0,
        );
        reveal.pipelineCensusAvailable = creations !== undefined && pipelinesAtReveal !== undefined;
        if (creations !== undefined && pipelinesAtReveal !== undefined)
          reveal.pipelinesCreated = creations - pipelinesAtReveal;
        reveal.complete = reveal.elapsedMs >= 3000;
        if (reveal.complete) ctx.state.set({ revealComplete: true });
      });
      ctx.afterPhysics(() => {
        if (released || pipelinesAtReveal === undefined) return;
        const creations = pipelineCount(pipelineSource);
        reveal.pipelinesSinceReveal = creations === undefined ? -1 : creations - pipelinesAtReveal;
      });
      const textureUploads = new AbortController();
      let propsStage = "waiting-for-physics";
      let preparation: IPropPreparationProgress | undefined;
      let buildStartedAt: number | undefined;
      let phaseStartedAt: number | undefined;
      let lastProgressAt: number | undefined;
      let completedPropsWork = 0;
      // One scene-local spawn gate: a single deadline taken here, settled once by the world readiness
      // join, a failure or teardown. `WorldCells.whenSpawnReady` is the data authority and each
      // streamed world's `prewarmed` is the draw gate; no frame polls either.
      const deadlineAt = performance.now() + 120_000;
      let spawnCells = { required: 0, loaded: 0 };
      let spawnReady = false;
      const spawnJoins = new Map<WorldCells, { data: string; prewarm: string }>();
      let spawnError = "";
      let spawnSettled = false;
      let capturingSpawnFailure = false;
      let resolveSpawn: () => void = () => undefined;
      let rejectSpawn: (reason: Error) => void = () => undefined;
      const spawnPromise = new Promise<void>((done, failed) => {
        resolveSpawn = done;
        rejectSpawn = failed;
      });
      function settleSpawn(reason?: Error): void {
        if (spawnSettled || capturingSpawnFailure) return;
        spawnSettled = true;
        clearTimeout(spawnTimer);
        if (reason === undefined) {
          spawnReady = true;
          resolveSpawn();
        } else {
          rejectSpawn(reason);
        }
      }
      function failSpawn(reason: unknown): void {
        if (spawnSettled || capturingSpawnFailure) return;
        const message =
          (reason instanceof Error ? reason.message : String(reason)) || "Strata spawn failed";
        capturingSpawnFailure = true;
        try {
          captureSpawnFailure(message);
        } catch {
          // A diagnostic must never replace the admission failure or leave its promise pending.
        }
        capturingSpawnFailure = false;
        spawnError = message;
        settleSpawn(new Error(message));
        ctx.state.set({ worldReady: spawnReady, loadingError: spawnError });
      }
      const spawnTimer: ReturnType<typeof setTimeout> = setTimeout(
        () => failSpawn("Strata spawn admission exceeded 120000 ms"),
        120_000,
      );
      function captureSpawnFailure(reason: string): void {
        const failedAt = performance.now();
        const sceneStartedAt = deadlineAt - 120_000;
        console.error(
          `TN_STRATA_SPAWN_FAILURE ${JSON.stringify({
            reason: reason.slice(0, 256),
            world,
            stage: (preparation?.phase ?? propsStage).slice(0, 64),
            bucket: preparation?.bucket.slice(0, 64) ?? null,
            added: preparation?.added ?? null,
            total: preparation?.total ?? null,
            deadlineElapsedMs: Math.max(0, Math.round(failedAt - sceneStartedAt)),
            buildStartedMs:
              buildStartedAt === undefined
                ? null
                : Math.max(0, Math.round(buildStartedAt - sceneStartedAt)),
            phaseStartedMs:
              phaseStartedAt === undefined
                ? null
                : Math.max(0, Math.round(phaseStartedAt - sceneStartedAt)),
            lastProgressMs:
              lastProgressAt === undefined
                ? null
                : Math.max(0, Math.round(lastProgressAt - sceneStartedAt)),
          })}`,
        );
      }
      if (ctx.startup.phase !== "ready")
        ctx.startup.hold(
          "strata-spawn",
          spawnPromise,
          120_000,
          () =>
            completedPropsWork +
            (preparation?.prewarmedWorlds ?? 0) +
            (props?.worlds.reduce((sum, stream) => {
              const stats = stream.stats();
              return sum + stats.admissionCompletedUnits + stats.prewarmMinted;
            }, 0) ?? 0) +
            ctx.state.getState().spawnCellsLoaded,
        );
      const loading = createLoadingScreen({
        ...ctx,
        onReveal: initializeRevealProbe,
        keepWorldRendering: false,
        startup: {
          get progress() {
            const state = ctx.state.getState();
            const coverage =
              state.spawnCellsRequired > 0 ? state.spawnCellsLoaded / state.spawnCellsRequired : 0;
            return Math.min(0.99, (ctx.startup.progress + coverage) / 2);
          },
          whenReady: () =>
            Promise.all([ctx.startup.whenReady(), spawnPromise]).then(() => undefined),
        },
      });
      ctx.afterPhysics(() => loading.update());
      const biome = this.#biome;
      if (!biome) throw new Error(`World ${world} elevations were not measured`);
      const stage = this.#stage;
      const terrain = this.#terrain;
      const field = stage?.field ?? terrain?.field;
      if (!field) throw new Error(`World ${world} terrain was not loaded`);
      const mesh = stage ? undefined : terrain?.mesh;
      if (mesh) {
        ctx.add(mesh);
        // Scenery: nothing moves the ground, so its transform is composed once instead of every frame.
        markStatic(mesh);
        const ground = new RigidBody3D({
          object: mesh,
          physics: ctx.physics,
          type: "fixed",
          entity: "terrain",
          // 4: what the player walks on, props included. 8: the ground alone, for ground queries.
          collisionLayer: 4 | 8,
          shape: CollisionShape3D.heightfield(
            field.rows,
            field.columns,
            field.toColliderHeights(),
            {
              x: data.size,
              y: 1,
              z: data.size,
            },
          ),
        });
        // The surveyed hills past the square are ground too, out to the walk band: their collider is
        // the drawn triangles, so feet meet what the eye sees. Four fixed walls 2 m inside the band's
        // outer edge are the level's blocking volumes; past them is only scenery.
        const horizon = mesh.getObjectByName("temperate-distant-ridges");
        if (!(horizon instanceof Mesh)) throw new Error(`World ${world} has no horizon ring`);
        const band = horizonWalkGeometry(horizon.geometry);
        const surroundings = new RigidBody3D({
          physics: ctx.physics,
          type: "fixed",
          entity: "terrain",
          collisionLayer: 4 | 8,
          position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
          shape: CollisionShape3D.fromMesh(new Mesh(band.geometry), "trimesh"),
        });
        const edge = data.size / 2 + band.extent;
        const walls = [-1, 1].flatMap((side) =>
          [
            { x: side * edge, z: 0, width: 4, depth: edge * 2 },
            { x: 0, z: side * edge, width: edge * 2, depth: 4 },
          ].map(
            ({ x, z, width, depth }) =>
              new RigidBody3D({
                physics: ctx.physics,
                type: "fixed",
                collisionLayer: 4,
                position: { x, y: 0, z },
                shape: CollisionShape3D.box(width, 4000, depth),
              }),
          ),
        );
        ctx.entities.add("terrain", {
          mesh,
          dispose: () => {
            for (const wall of walls) wall.dispose();
            surroundings.dispose();
            ground.dispose();
            mesh.geometry.dispose();
            (mesh.material as MeshStandardMaterial).dispose();
          },
        });
      }
      // One rig owns the whole of the sky, the sun, the shadows that follow the eye, the haze the
      // far ridges fade into and the tone curve. It used to be a flat `Color` background, a
      // hand-set `FogExp2`, a sun with a five metre shadow box that missed everything, and no tone
      // mapping at all; the numbers behind all of that now live in `src/render/sky.ts`.
      ctx.add(sky.daylight);
      ctx.add(sky.atmosphere);
      ctx.add(sky.sun);
      this.#sky = sky;
      ctx.entities.add("sun", {
        object: sky.sun,
        debug: () => ({ x: sky.sunX }),
        dispose: installOutdoorOcclusion(ctx, biome),
      });

      const actor = new Mesh(
        new CapsuleGeometry(0.35, 1.0, 6, 12),
        new MeshStandardMaterial({ color: 0xffc76d }),
      );
      const start =
        world === "forest"
          ? [-220, -165]
          : world === "coastal"
            ? [180, 65]
            : world === "alpine"
              ? [180, -190]
              : [180, 160];
      actor.position.set(
        start[0] as number,
        field.heightAt(start[0] as number, start[1] as number) + 2,
        start[1] as number,
      );
      actor.name = "player";
      // Freeze the launch region before gameplay or a review view can move its follow camera.
      const spawn = actor.position
        .clone()
        .add(world === "coastal" ? new Vector3(28, 18, 34) : new Vector3(28, 24, 42));
      ctx.camera.position.copy(spawn);
      ctx.add(actor);
      const player = new CharacterBody3D({
        object: actor,
        physics: ctx.physics,
        entity: "player",
        shape: CollisionShape3D.capsule(0.5, 0.35),
        snapToGround: 0.4,
        // The kit's ground and prop colliders keep the default layer.
        ...(stage ? {} : { collisionMask: 4 }),
      });
      this.#player = player;
      // The starter kit's humanoid rides the capsule: the capsule is the collider, the mannequin is
      // what the player sees. Its feet sit at the capsule's bottom (0.5 m half-height plus 0.35 m
      // radius), sunk 1 cm like the starter's; the model faces +Z.
      const mannequin = this.#mannequin;
      if (!mannequin) throw new Error(`World ${world} mannequin was not loaded`);
      const figure = new SkeletalMesh3D({
        source: mannequin.scene,
        clips: [...mannequin.animations, ...this.#swimClips],
        requiredClips: Object.values(CLIPS),
        strideRoot: actor,
      });
      figure.root.traverse((object) => {
        object.castShadow = true;
      });
      figure.root.position.y = FEET;
      figure.root.rotation.y = Math.PI;
      actor.material.visible = false;
      actor.add(figure.root);
      figure.play(CLIPS.idle);
      this.#figure = figure;
      // Third person: the collectathon kit's orbit camera, with the terrain as its walls. The three
      // vista worlds keep their fixed player framing below.
      const along = new Vector3();
      const probe: WallProbe = (from, to) =>
        along.subVectors(to, from).lengthSq() < 1e-8
          ? undefined
          : ctx.physics.directSpaceState.intersectRay({
              ...(stage ? {} : { collisionMask: 4 }),
              from,
              to,
            })?.distance;
      const orbit = createOrbitCamera(ctx.camera);
      orbit.snap(actor.position, 0, probe);
      this.#orbit = orbit;
      const vista = world === "coastal" || world === "alpine" || world === "desert";
      ctx.afterPhysics((dt) => {
        if (vista || ctx.state.getState().view !== "player") {
          this.#sky?.focusShadows(undefined);
          sightLine.radius.value = 0;
          return;
        }
        // The mouse turns the camera only while the canvas holds the pointer lock a click took.
        if (ctx.input.raw.pointer.captured) {
          const look = ctx.input.vector("look");
          orbit.look(look.x, look.y);
        }
        orbit.update(actor.position, player.velocity, dt, probe);
        sightLine.aim.value.set(
          actor.position.x,
          actor.position.y + CAMERA_RIG.aimHeight,
          actor.position.z,
        );
        sightLine.radius.value = SIGHT_RADIUS;
        // Shadows centre on the hero, not the orbiting eye: a camera turn re-renders no shadow page.
        this.#sky?.focusShadows(actor.position);
      });
      ctx.entities.add("player", {
        mesh: actor,
        debug: () => ({
          grounded: player.grounded,
          position: actor.position.toArray(),
          visible: actor.visible && figure.root.visible,
          horizon: mesh
            ? {
                seamGap: mesh.userData.horizonSeamGap,
                samples: mesh.userData.horizonSeamSamples,
              }
            : { observed: false },
        }),
        dispose: () => {
          player.dispose();
          actor.geometry.dispose();
          actor.material.dispose();
        },
      });

      // A deliberately asymmetric nonplanar fixture, on the same runtime/physics path. It is
      // invisible: it exists to be ray-queried, and at x = 600 there is no terrain under it, so
      // drawing it put a small orange wedge in the sky of every overview capture. The scene picker
      // walks the hierarchy without consulting visibility and the collider is its own body, so
      // both contact paths below still answer for a mesh that is not drawn.
      const fixture = new Heightfield({
        rows: 17,
        columns: 17,
        width: 16,
        depth: 16,
        origin: { x: 0, z: 0 },
        heights: Float32Array.from(
          { length: 17 * 17 },
          (_, i) =>
            ((i % 17) * 13 + Math.floor(i / 17) * 7 + (i % 17) * Math.floor(i / 17) * 3) % 11,
        ),
      });
      const probeMesh = new Mesh(
        fixture.toGeometry(),
        new MeshStandardMaterial({ color: 0xd3a168 }),
      );
      probeMesh.position.x = 600;
      probeMesh.visible = false; // engine-override: the physics fixture must not render
      ctx.add(probeMesh);
      const probeBody = new RigidBody3D({
        object: probeMesh,
        physics: ctx.physics,
        type: "fixed",
        collisionLayer: 2,
        shape: CollisionShape3D.heightfield(17, 17, fixture.toColliderHeights(), {
          x: 16,
          y: 1,
          z: 16,
        }),
      });
      ctx.entities.add("asymmetric-terrain", {
        mesh: probeMesh,
        dispose: () => {
          probeBody.dispose();
          probeMesh.geometry.dispose();
          probeMesh.material.dispose();
        },
      });

      const ocean = this.#ocean ? ctx.add(this.#ocean) : undefined;
      const water = this.#water;
      if (ocean && water) {
        ctx.add(water);
        ctx.entities.add("sea", {
          object: ocean,
          debug: () => ({ steps: ocean.steps, staleFrames: ocean.staleFrames }),
          dispose: () => {
            water.geometry.dispose();
            (water.material as MeshStandardMaterial).dispose();
          },
        });
      }
      // The water in the channels the bake carved. A world with no river gets nothing. Water draws on
      // its own layer so the lake's mirror can leave it out; the eye sees both.
      ctx.camera.layers.enable(WATER_LAYER);
      const lake = this.#lake;
      if (lake) {
        const centre = lake.mesh.geometry.getAttribute("position");
        const at = data.lakes?.[0]?.at;
        let lakeFootprintError = 0;
        if (world === "tundra") {
          const geometry = lake.mesh.geometry;
          for (const [index, group] of geometry.groups.entries()) {
            const pond = data.lakes?.[index];
            if (!pond) throw new Error("A drawn pond has no baked footprint");
            for (let i = group.start; i < group.start + group.count; i++) {
              const vertex = geometry.index?.getX(i) ?? i;
              lakeFootprintError = Math.max(
                lakeFootprintError,
                Math.hypot(
                  centre.getX(vertex) - (pond.at[0] ?? 0),
                  centre.getZ(vertex) - (pond.at[1] ?? 0),
                ) - pond.radius,
              );
            }
          }
        }
        ctx.state.set({
          lakeFootprintError,
          lakeSurfaceCount: Math.max(1, lake.mesh.geometry.groups.length),
          lakeTriangles: (lake.mesh.geometry.index?.count ?? 0) / 3,
          lakePlacementError: Math.hypot(
            centre.getX(0) - (at?.[0] ?? 0),
            centre.getZ(0) - (at?.[1] ?? 0),
          ),
        });
        ctx.add(lake.mesh);
        ctx.entities.add("lake", { mesh: lake.mesh, dispose: () => lake.dispose() });
      }
      // --- the meadow's props -------------------------------------------------------------------
      //
      // Built on the first physics step rather than in `enter`, because both ways of asking the
      // world where the ground is need a world that has been stepped: the ray query walks the
      // heightfield's own triangles and the collider is not in the space until the solver runs.
      // Asking in `enter` returns "no ground here" for every prop on a perfectly solid hillside.
      const erosionFlowSamples = this.#erosionSamples.flow;
      const erosionDepositSamples = this.#erosionSamples.deposition;
      // Every fixed camera stands in a clearing: a trunk a metre from the lens is a green wall, not a
      // framing, and the seed decides where trees land, so the eyes are kept open by rule.
      const river = stage
        ? undefined
        : createRivers(
            data.rivers ?? [],
            field,
            world === "tundra" || world === "forest",
            world === "tundra" ? lake?.reflectionAt : undefined,
          );
      this.#river = river;
      if (river) {
        ctx.state.set({
          riverSurfaceCount: river.mesh.geometry.groups.filter((group) => group.count > 0).length,
        });
        ctx.add(river.mesh);
        ctx.entities.add("river", { mesh: river.mesh, dispose: () => river.dispose() });
      }
      // The player swims in the river and lake drawn above: the same splines, levels and reach.
      // `?swim=off` is the before arm: the water is drawn and the player walks its bed.
      // `?current=off` is the drift before arm: the same water, standing still.
      const params = new URLSearchParams(globalThis.location?.search ?? "");
      if (!stage && params.get("swim") !== "off") {
        const rivers = data.rivers ?? [];
        const lakes = data.lakes ?? [];
        const footprint = world === "tundra" || world === "forest";
        player.water = waterSurfaceAt(rivers, lakes, field, footprint);
        if (params.get("current") !== "off")
          player.waterCurrent = waterCurrentAt(rivers, lakes, field, footprint);
      }
      const scatter = this.#scatter;
      const fallbackParts = this.#fallbackParts;
      let props: Awaited<ReturnType<typeof createStreamedProps>>;
      let propColliders: ScatterColliders | undefined;
      let readyTimePending = false;
      let building = false;
      let preparedDispose: (() => void) | undefined;
      // What the prepared files measured on load. Published rather than thrown on, because a
      // number in the run report says which level is off the ground and a stack trace does not.
      let preparedLodBaseSpread = 0;
      let compressedTexturesPrepared = 0;
      let preparedLevelsWithoutSolid = 0;
      let surfacesDispose: (() => void) | undefined;
      let buildProps: (() => Promise<void>) | undefined;
      if (stage) {
        ctx.entities.add("forest-stage", {
          object: stage.world,
          dispose: () => {
            released = true;
            settleSpawn(new Error("Strata spawn cancelled"));
            loading.finish();
          },
        });
        ctx.canvasLayer.keepWorldRendering = true;
        propsStage = "attached";
        const remaining = deadlineAt - performance.now();
        if (remaining <= 0) failSpawn("Strata spawn admission exceeded 120000 ms");
        else
          void Promise.all([
            stage.world.whenSpawnReady(spawn, 60, remaining),
            stage.world.prewarmed,
          ]).then(
            ([region]) => {
              if (released || spawnSettled) return;
              spawnCells = { required: region.requiredCells, loaded: region.loadedCells };
              settleSpawn();
            },
            (reason) => failSpawn(reason),
          );
      } else {
        if (!mesh || !scatter || scatter.canopy.length !== data.resolution ** 2)
          throw new Error(`World ${world} placements do not match the terrain`);
        if (!fallbackParts) throw new Error(`World ${world} prop variants were not loaded`);
        mesh.geometry.setAttribute("canopy", new Float32BufferAttribute(scatter.canopy, 1));
        const fallbackSaplingHeight = world === "alpine" ? 2 : world === "tundra" ? 1.4 : undefined;
        let propParts = fallbackParts;
        const flat = flatPropMaterials();
        ctx.entities.add("props-lifetime", {
          dispose: () => {
            released = true;
            textureUploads.abort(new Error("Strata scene released during texture preparation."));
            settleSpawn(new Error("Strata spawn cancelled"));
            loading.finish();
            surfacesDispose?.();
            flat.dispose();
            preparedDispose?.();
            props?.dispose();
            propColliders?.dispose();
            for (const parts of propParts.values())
              for (const part of parts) part.geometry.dispose();
          },
        });
        // Ground contact is a ray query against the drawn terrain and the terrain's collider, never
        // the bilinear sampler: a spruce floating a centimetre above the visible surface reads as a
        // mistake at exactly the distance a player spends most of their time at.
        mesh.updateMatrixWorld(true);
        mesh.geometry.computeBoundingBox();
        const top = mesh.geometry.boundingBox?.max.y ?? 0;
        const groundSample = createGroundSampler(field, mesh.geometry, mesh.matrixWorld);
        const groundAt: PropGroundQuery = (placement, at) => {
          const [x, , z] = at;
          let visual = groundSample(x, z);
          if (visual === null) {
            visual =
              ctx.raycast({
                direction: new Vector3(0, -1, 0),
                origin: new Vector3(x, top + 2, z),
                targets: [mesh],
              })?.point.y ?? null;
          }
          const physical = ctx.physics.directSpaceState.intersectRay({
            collisionMask: 8,
            from: { x, y: top + 2, z },
            to: { x, y: -100, z },
          });
          let height = visual ?? physical?.position.y ?? null;
          if (
            height !== null &&
            (world === "forest" || world === "coastal") &&
            ["boulder", "riverrock", "scree", "mountain", "volcanic", "reveal"].includes(
              placement.asset,
            )
          ) {
            const stone = propParts
              .get(`${placement.asset}:${variantFor(placement, placement.asset)}`)
              ?.find((part) => part.role === "stone")?.geometry;
            stone?.computeBoundingBox();
            const box = stone?.boundingBox;
            if (box) {
              // GroundSnap's single lowest point left the downhill footprint hanging on thin stones.
              const reach =
                Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * placement.scale * 0.5;
              for (const [dx, dz] of [
                [-reach, 0],
                [reach, 0],
                [0, -reach],
                [0, reach],
              ]) {
                const footX = x + (dx ?? 0);
                const footZ = z + (dz ?? 0);
                const foot =
                  groundSample(footX, footZ) ??
                  ctx.raycast({
                    direction: new Vector3(0, -1, 0),
                    origin: new Vector3(footX, top + 2, footZ),
                    targets: [mesh],
                  })?.point.y ??
                  null;
                if (foot !== null) height = Math.min(height, foot);
              }
              height -= (box.max.y - box.min.y) * placement.scale * 0.12;
            }
          }
          const [originX, originY, originZ] = placement.position;
          return {
            height,
            offset: originY - field.heightAt(originX, originZ),
          };
        };
        // The prepared art is asked for here rather than in `enter`, and the variants it fills are
        // not built again: a game with the licensed Landscape Pro models has the pack's own pines,
        // shrubs and photoscanned stone, a game without them has the procedural spruce, the
        // procedural boulder and the starter's own clumps, and neither waits on the other. Both
        // loaders run together and fail soft per file, so one missing species costs that species and
        // nothing else. One load, because `afterPhysics` runs every frame.
        buildProps = async (): Promise<void> => {
          // The capsule mesh named "player" (the body has no transform), looked up once, else the eye.
          let actor: Object3D | undefined;
          const followed = () => {
            actor ??= ctx.scene.getObjectByName("player");
            return actor?.position ?? ctx.camera.position;
          };
          buildStartedAt = performance.now();
          propsStage = "assets";
          const [prepared, pack, skyLight] = await Promise.all([
            loadPreparedProps(ctx.assets),
            loadPack(ctx.assets, world, data, ctx.state.getState().canopyComparison, biome),
            ctx.assets ? loadSkyLight(ctx.assets) : Promise.resolve(undefined),
          ]);
          preparedDispose = () => {
            prepared.dispose();
            pack.dispose();
          };
          if (released) {
            preparedDispose();
            return;
          }
          preparedLodBaseSpread = prepared.lodBaseSpread;
          preparedLevelsWithoutSolid = prepared.levelsWithoutSolid;
          const parts = new Map([...prepared.parts, ...pack.parts]);
          // The shipped dry-world stones use both CC0 scans, including the otherwise primitive slot.
          const dryStone = prepared.parts.get("boulder:1");
          if (world === "desert" && dryStone && !pack.parts.has("boulder:0"))
            parts.set("boulder:0", dryStone);
          propParts = buildPropVariants(parts, fallbackSaplingHeight);
          propsStage = "surfaces";
          const surfaces = await createPropSurfaces(ctx.assets, data, biome, skyLight);
          this.#surfaces = surfaces;
          surfacesDispose = surfaces.dispose;
          if (released) {
            surfaces.dispose();
            return;
          }
          propsStage = "textures";
          let preparedTextures = 0;
          await preparePropTextures(
            ctx.renderer,
            [
              ...[...propParts.values()].flatMap((parts) =>
                parts.flatMap((part) => (part.material ? [part.material] : [])),
              ),
              ...Object.values(surfaces.materials),
            ],
            textureUploads.signal,
            (completed) => {
              completedPropsWork += completed - preparedTextures;
              preparedTextures = completed;
            },
            (completed) => {
              compressedTexturesPrepared = completed;
            },
          );
          if (released) return;
          propsStage = "streaming";
          props = await createStreamedProps({
            placements: scatter.placements,
            groundAt,
            parts: propParts,
            materials: surfaces.materials,
            assets: ctx.assets,
            // The player, not the orbiting eye: turning the camera in place must not swap tree LODs.
            follow: {
              get position() {
                return followed();
              },
            },
            size: data.size,
            horizonDistance:
              ctx.camera instanceof PerspectiveCamera || ctx.camera instanceof OrthographicCamera
                ? ctx.camera.far
                : 5000,
            whileCurrent: () => !released,
            onProgress: (progress) => {
              const progressedAt = performance.now();
              const previousPreparation = preparation;
              if (
                previousPreparation === undefined ||
                previousPreparation.phase !== progress.phase ||
                previousPreparation.bucket !== progress.bucket
              )
                phaseStartedAt = progressedAt;
              lastProgressAt = progressedAt;
              const previous =
                preparation?.phase === progress.phase && preparation.bucket === progress.bucket
                  ? preparation.added
                  : 0;
              completedPropsWork += Math.max(0, progress.added - previous);
              preparation = progress;
            },
            onPublication: (bounds) => {
              if (reveal.startedMs < 0 || reveal.complete) return;
              if (revealFrustum.intersectsBox(bounds)) reveal.publishedBatchesInView++;
            },
            invalidateShadows: (region) => {
              const shadows = sky.sun.shadow.shadowNode;
              if (shadows instanceof VirtualShadowNode) invalidatePropShadows(shadows, region);
            },
          });
          if (!props) return;
          if (released) {
            props.dispose();
            return;
          }
          // ctx.add registers render-cadence processing. Never manually update these worlds.
          for (const stream of props.worlds) ctx.add(stream);
          // Rocks and trunks are solid: the stone or bark part each placement is grounded by, with a
          // body near the player. Leaves, needles, grass and flowers have no such part and stay open.
          // Layer 16 holds prop bodies alone, for the overlap measure. `?propCollision=off` is the
          // named override: the bodies leave the player's layer 4 (the before arm of collide.playtest.json).
          const solidProps =
            new URLSearchParams(globalThis.location?.search ?? "").get("propCollision") !== "off";
          propColliders = new ScatterColliders({
            physics: ctx.physics,
            follow: {
              get position() {
                return followed();
              },
            },
            collisionLayer: solidProps ? 4 | 16 : 16,
            instances: [...props.byId.values()].flatMap(({ placement, pose }) => {
              const solid = propParts
                .get(`${placement.asset}:${variantFor(placement, placement.asset)}`)
                ?.find((part) => part.role === "bark" || part.role === "stone");
              return solid ? [{ geometry: solid.geometry, matrix: pose }] : [];
            }),
          });
          // Prewarm borrows actual world draws only after registration. Grounding and package
          // preparation have no attached stream to prewarm and keep the opaque curtain's draw gate.
          ctx.canvasLayer.keepWorldRendering = true;
          propsStage = "attached";
          // Armed once, after the streams attach: the fixed spawn data join plus each draw join,
          // bounded by the deadline taken at scene entry. `WorldCells.whenSpawnReady` owns the data
          // authority and each streamed world's `prewarmed` owns the draw.
          const remaining = deadlineAt - performance.now();
          if (remaining <= 0) {
            failSpawn("Strata spawn admission exceeded 120000 ms");
          } else {
            void Promise.all([
              Promise.all(
                props.worlds.map((stream) => {
                  const status = { data: "pending", prewarm: "pending" };
                  spawnJoins.set(stream, status);
                  const data = stream.whenSpawnReady(spawn, 60, remaining);
                  // Observe settlement without replacing the promises the spawn join awaits.
                  void data.then(
                    () => {
                      status.data = "resolved";
                    },
                    () => {
                      status.data = "rejected";
                    },
                  );
                  void stream.prewarmed.then(
                    () => {
                      status.prewarm = "resolved";
                    },
                    () => {
                      status.prewarm = "rejected";
                    },
                  );
                  return data;
                }),
              ),
              ...props.worlds.map((stream) => stream.prewarmed),
            ]).then(
              ([regions]) => {
                if (released || spawnSettled) return;
                spawnCells = {
                  required: regions.reduce((sum, region) => sum + region.requiredCells, 0),
                  loaded: regions.reduce((sum, region) => sum + region.loadedCells, 0),
                };
                settleSpawn();
              },
              (reason) => failSpawn(reason),
            );
          }

          const alpineCrags =
            world === "alpine"
              ? [...props.byId.values()].filter(
                  (instance) => instance.placement.asset === "mountain",
                )
              : [];
          ctx.entities.add("props", {
            object: props.worlds[0],
            debug: () => ({
              reveal,
              streaming: props?.stats(),
              colliders: propColliders?.stats(),
              boulders: scatter.counts.boulder,
              bushes: scatter.counts.bush,
              ferns: scatter.counts.fern,
              draws: props?.meshes.length ?? 0,
              grass: scatter.counts.grass,
              poppies: scatter.counts.poppy,
              saplings: scatter.counts.sapling,
              scrub: scatter.counts.scrub,
              spruces: scatter.counts.spruce,
              mountains: scatter.counts.mountain,
              volcanic: scatter.counts.volcanic,
              reveals: scatter.counts.reveal,
              licensedCragParts: [...pack.parts]
                .filter(([key]) => /^(mountain|volcanic|reveal):/.test(key))
                .reduce((sum, [, parts]) => sum + parts.length, 0),
              crags: {
                ...(world === "alpine"
                  ? {
                      maxBaseClearance: alpineCrags.length
                        ? Math.max(
                            ...alpineCrags.map((instance) => instance.cragBaseClearance ?? 1),
                          )
                        : 1,
                      baseRingSamples: alpineCrags.reduce(
                        (sum, instance) => sum + (instance.cragRingSamples ?? 0),
                        0,
                      ),
                      count: alpineCrags.length,
                      baseRingBuried:
                        alpineCrags.length > 0 &&
                        alpineCrags.every(
                          (instance) =>
                            (instance.cragBaseClearance ?? 1) <= -0.49 &&
                            (instance.cragRingSamples ?? 0) >= 4,
                        ),
                      baseRingMeasured:
                        alpineCrags.reduce(
                          (sum, instance) => sum + (instance.cragRingSamples ?? 0),
                          0,
                        ) >= 100,
                    }
                  : {}),
                drawn:
                  props?.meshes.some(
                    (draw) => draw.count > 0 && /(mountain|volcanic)/.test(draw.name),
                  ) ?? false,
              },
              totalInstances: props?.meshes.reduce((sum, draw) => sum + draw.count, 0) ?? 0,
              triangles:
                props?.meshes.reduce(
                  (sum, draw) => sum + (draw.count * (draw.geometry.index?.count ?? 0)) / 3,
                  0,
                ) ?? 0,
            }),
          });
        };
      }

      let frames = 0;
      let propCounts = { draws: 0, instances: 0, triangles: 0 };
      let travel = 0;
      // The owner's report, measured the same with or without prop collision: frames in which the
      // player's capsule, less a 5 cm skin, crosses into a rock or trunk body.
      const propProbe = CollisionShape3D.capsule(0.5, 0.3);
      let propOverlapFrames = 0;
      // Metres past the playable square's edge the player reached: onto the surroundings' hills.
      let edgeOvershoot = Number.NEGATIVE_INFINITY;
      // Swimming as the playtest reads it: samples swimming with a swim clip on, those of them off
      // the bed, and how many times the player climbed back out.
      let swimSamples = 0;
      let swimFloatSamples = 0;
      let swimExits = 0;
      let swimDrift = 0;
      let wasSwimming = false;
      currentView = `${world}:player`;
      viewVisit = beginViewVisit();
      firstViewGpuFrame = Number.POSITIVE_INFINITY;
      measuredView = "";
      viewBudgets.set(currentView, {
        view: currentView,
        p50s: [],
        p99s: [],
        presentedP95s: [],
        triangles: [],
        gpuMs: [],
        gpuMain: [],
        gpuShadow: [],
        gpuOther: [],
        passes: [],
        surfaces: [],
      });
      const previous = actor.position.clone();
      let contactSamples = 0;
      let maxContactError = 0;
      let bilinearDifference = 0;
      let waveSamples = 0;
      let minWave = Number.POSITIVE_INFINITY;
      let maxWave = Number.NEGATIVE_INFINITY;
      let minSlope = Number.POSITIVE_INFINITY;
      let maxSlope = Number.NEGATIVE_INFINITY;
      ctx.afterPhysics(() => {
        const dx = actor.position.x - previous.x;
        const dz = actor.position.z - previous.z;
        travel += Math.hypot(dx, dz);
        previous.copy(actor.position);
        // What the water moved, not what the keys moved: the share of this step's travel along the
        // current, counted only while swimming with no input of the player's own. 0 with
        // `?current=off`, which is its before arm.
        if (player.swimming && player.velocity.x === 0 && player.velocity.z === 0) {
          const { x: cx, z: cz } = player.currentVelocity;
          const speed = Math.hypot(cx, cz);
          if (speed > 0) swimDrift += (dx * cx + dz * cz) / speed;
        }
        if (
          propColliders &&
          ctx.physics.directSpaceState.intersectShape({
            shape: propProbe,
            position: actor.position,
            collisionMask: 16,
            maxResults: 1,
          }).length > 0
        )
          propOverlapFrames++;
        // Query actual triangles, not bilinear interpolation, after the shared solver step.
        if (frames === 0) {
          probeMesh.updateMatrixWorld(true);
          mesh?.updateMatrixWorld(true);
          const points = [
            [-7.75, -7.75],
            [-7.25, -7.25],
            [-7.75, -7.25],
            [-7.25, -7.75],
            [-8, -8],
            [-7, -8],
            [0, 0],
            [7.5, 7.5],
          ];
          for (const [x, z] of points) {
            const wx = 600 + (x as number);
            const visual = ctx.raycast({
              origin: new Vector3(wx, 200, z),
              direction: new Vector3(0, -1, 0),
              targets: probeMesh,
            });
            const physical = ctx.physics.directSpaceState.intersectRay({
              from: { x: wx, y: 200, z: z as number },
              to: { x: wx, y: -100, z: z as number },
              collisionMask: 2,
            });
            if (!visual || !physical) throw new Error("Missing asymmetric terrain contact");
            maxContactError = Math.max(
              maxContactError,
              Math.abs(visual.point.y - physical.position.y),
            );
            bilinearDifference = Math.max(
              bilinearDifference,
              Math.abs(visual.point.y - fixture.heightAt(x as number, z as number)),
            );
            contactSamples++;
          }
        }
        // An oblique traversal crosses cells; exact vertical edge/corner probes remain above. A
        // staged world admits no terrain tile before its first update, which the loop's settle
        // steps precede, so its contact is observed once its spawn region is ready.
        // A staged world streams around the camera, so a benchmark view far from the player has no
        // ground under it; the player is held there (see `update`) and its contact is not asked for.
        // Past the square the player stands on the surroundings, whose collider is their drawn
        // triangles (see the walls above): physics alone answers there, and no picking tree is built.
        const onSurroundings =
          !stage &&
          Math.max(Math.abs(actor.position.x), Math.abs(actor.position.z)) > data.size / 2 - 1;
        edgeOvershoot = Math.max(
          edgeOvershoot,
          Math.max(Math.abs(actor.position.x), Math.abs(actor.position.z)) - data.size / 2,
        );
        const clip = this.#figure?.current;
        if (player.swimming && (clip === CLIPS.swim || clip === CLIPS.tread)) swimSamples++;
        if (player.swimming && !player.grounded) swimFloatSamples++;
        if (wasSwimming && !player.swimming) swimExits++;
        wasSwimming = player.swimming;
        if (!stage || (spawnReady && ctx.state.getState().view === "player")) {
          const terrainTargets = stage ? forestStageTerrainTargets(stage.world) : mesh;
          const visual =
            !onSurroundings &&
            terrainTargets &&
            ctx.raycast({
              origin: new Vector3(actor.position.x, 300, actor.position.z),
              direction: new Vector3(1, -400, 1).normalize(),
              targets: terrainTargets,
            });
          // The same line as the visual ray, started a metre above the feet: from 300 m, a stage
          // tree the player stands against is the first body under it, not the ground.
          const start = stage || onSurroundings ? actor.position.y + 1 : 300;
          const lead = (300 - start) / 400;
          const physical = ctx.physics.directSpaceState.intersectRay({
            from: { x: actor.position.x + lead, y: start, z: actor.position.z + lead },
            to: { x: actor.position.x + 1, y: -100, z: actor.position.z + 1 },
            // The kit's ground keeps the default layer; here the ground alone, not a rock beside it.
            collisionMask: stage ? 1 : 8,
          });
          if (
            (!visual && !onSurroundings) ||
            !physical ||
            (stage && physical.body.id !== stage.ground.body.id)
          )
            throw new Error(
              `Missing playable terrain contact: world=${world}, frame=${frames}, player=${actor.position.toArray()}, visual=${!!visual}, physical=${!!physical}, body=${physical?.body.id}:${physical?.body.entity}, expectedGround=${stage?.ground.body.id}, terrain=${mesh?.position.toArray() ?? "stage"}`,
            );
          if (visual) {
            maxContactError = Math.max(
              maxContactError,
              Math.abs(visual.point.y - physical.position.y),
            );
            contactSamples++;
          }
        }
        const wave = ocean?.sampleHeight(130, 140);
        const east = ocean?.sampleHeight(131, 140);
        if (wave && east) {
          waveSamples++;
          minWave = Math.min(minWave, wave.height);
          maxWave = Math.max(maxWave, wave.height);
          // Stale CPU sample slopes are a proxy; they do not qualify rendered normals.
          const slope = east.height - wave.height;
          minSlope = Math.min(minSlope, slope);
          maxSlope = Math.max(maxSlope, slope);
        }
        // The props are placed here rather than in `enter`: their ground query asks the stepped
        // world where the surface is, and neither the ray tree nor the collider answers before the
        // solver has run once.
        propColliders?.update();
        if (buildProps && props === undefined && !building) {
          building = true;
          const work = buildProps();
          if (ctx.startup.phase !== "ready") ctx.startup.hold("strata-props", work);
          void work.catch((error) => {
            if (!released) {
              failSpawn(error);
              ctx.state.set({ worldReady: spawnReady, loadingError: spawnError });
            }
          });
        }
        frames++;
        // `props.meshes` walks every streamed world; three walks per fixed step were 8.3 s of a
        // 15.6 s main-thread stall in a profiled session (PRD-541). Half a second is fresh enough.
        if (frames % 30 === 1) {
          const meshes = stage ? ([] as InstancedMesh[]) : (props?.meshes ?? []);
          if (stage)
            stage.world.traverseVisible((object) => {
              if (object instanceof InstancedMesh && ctx.camera.layers.test(object.layers))
                meshes.push(object);
            });
          propCounts = {
            draws: meshes.length,
            instances: meshes.reduce((sum, draw) => sum + draw.count, 0),
            triangles: meshes.reduce(
              (sum, draw) => sum + (draw.count * (draw.geometry.index?.count ?? 0)) / 3,
              0,
            ),
          };
        }
        const stagedStreaming = stage?.world.stats();
        const streaming = stagedStreaming
          ? {
              ...stagedStreaming,
              admissionMs: stagedStreaming.admission.spentMs,
              admissionBacklog: stagedStreaming.admission.backlog,
            }
          : props?.stats();
        const spawnReadiness = [...spawnJoins].map(([stream, status], index) => {
          if (spawnReady)
            return { name: stream.name, ...ctx.state.getState().spawnReadiness[index], ...status };
          const stats = stream.stats();
          return {
            name: stream.name,
            observedFrame: frames,
            ...status,
            ...stream.readinessAt(spawn, 60),
            admissionBacklog: stats.admission.backlog,
            impostorPending: stats.impostor.pending,
          };
        });
        const worldReady = spawnReady;
        if (spawnError) ctx.state.set({ loadingError: spawnError });
        if (
          worldReady &&
          !released &&
          !readyTimePending &&
          ctx.state.getState().timeToReadyMs < 0
        ) {
          readyTimePending = true;
          void ctx.startup.whenReady().then(() => {
            if (!released) ctx.state.set({ timeToReadyMs: Date.now() - launchedAt });
          });
        }
        const viewFrameP50s = [...viewBudgets.values()].map((group) => ({
          view: group.view,
          p50: median(group.p50s),
          presentedP95: median(group.presentedP95s),
          windows: group.p50s.length,
        }));
        const viewGpu = [...viewBudgets.values()]
          .filter((group) => group.gpuMs.length > 0)
          .map((group) => ({
            view: group.view,
            gpuMs: median(group.gpuMs),
            gpuMain: group.gpuMain.length ? median(group.gpuMain) : -1,
            gpuShadow: group.gpuShadow.length ? median(group.gpuShadow) : -1,
            gpuOther: group.gpuOther.length ? median(group.gpuOther) : -1,
            windows: group.gpuMs.length,
            passes: Object.fromEntries(
              Object.keys(group.passes[0] ?? {}).map((pass) => [
                pass,
                {
                  triangles: median(group.passes.map((window) => window[pass]?.triangles ?? 0)),
                  draws: median(group.passes.map((window) => window[pass]?.draws ?? 0)),
                },
              ]),
            ),
            scale: median(group.surfaces.map((surface) => surface.scale)),
            samples: median(group.surfaces.map((surface) => surface.samples)),
          }));
        ctx.state.set({
          viewGpu,
          elevationMin: biome.elevationRange[0],
          elevationMax: biome.elevationRange[1],
          snowFrom: biome.snowBand[0],
          snowTo: biome.snowBand[1],
          maxViewGpuMs: viewGpu.length ? Math.max(...viewGpu.map((group) => group.gpuMs)) : -1,
          measuredGpuViewCount: viewGpu.length,
          tasksAvailable: budget.tasksAvailable,
          longestLoadTaskMs: budget.longestTaskMs,
          afterFirstFrameTaskMs: budget.afterFirstFrameTaskMs,
          currentViewWindows: viewVisit.windows,
          viewFrameP50s,
          maxViewFrameP50: Math.max(0, ...viewFrameP50s.map((group) => group.p50)),
          maxViewPresentedP95: Math.max(0, ...viewFrameP50s.map((group) => group.presentedP95)),
          measuredViewCount: viewFrameP50s.filter((group) => group.windows > 0).length,
          world,
          groundBiome: mesh
            ? ((mesh.material as MeshStandardMaterial).userData.biome ?? "baked")
            : `stage:${forestStageArm(globalThis.location?.search ?? "")}`,
          worldReady,
          spawnReadiness,
          spawnCellsRequired: spawnCells.required,
          spawnCellsLoaded: spawnCells.loaded,
          streamingResidentCells: streaming?.residentCells ?? 0,
          streamingLoadedCells: streaming?.loadedCells ?? 0,
          streamingEvictions: streaming?.evictions ?? 0,
          streamingInstances: streaming?.instances ?? 0,
          streamingFailures: streaming?.failures ?? 0,
          streamingPendingPrewarm: streaming?.pendingPrewarm ?? 0,
          streamingLoadsInFlight: streaming?.loadsInFlight ?? 0,
          streamingAdmissionMs: streaming?.admissionMs ?? 0,
          streamingAdmissionBacklog: streaming?.admissionBacklog ?? 0,
          terrainTransportBound:
            (mesh?.material as MeshStandardMaterial | undefined)?.userData.erosion === true &&
            erosionFlowSamples > 1000 &&
            erosionDepositSamples > 100,
          erosionFlowSamples,
          erosionDepositSamples,
          sunX: sky.sunX,
          frames,
          travel,
          edgeOvershoot,
          grounded: player.grounded,
          propColliders: propColliders?.stats().resident ?? 0,
          propOverlapFrames,
          swimming: player.swimming,
          immersionDepth: player.immersionDepth,
          swimSamples,
          swimFloatSamples,
          swimExits,
          swimDrift,
          contactSamples,
          maxContactError,
          bilinearDifference,
          oceanSteps: ocean?.steps ?? 0,
          waveSamples,
          waveRange: waveSamples ? maxWave - minWave : 0,
          sampleSlopeRange: waveSamples ? maxSlope - minSlope : 0,
          propDraws: propCounts.draws,
          propInstances: propCounts.instances,
          propTriangles: propCounts.triangles,
          preparedLodBaseSpread,
          compressedTexturesPrepared,
          preparedLevelsWithoutSolid,
          windowDrawCalls: budget.drawCalls,
          windowFrameMs: budget.frameMs,
          // Forest camera costs, published as plain state so the run report
          // carries the numbers rather than a console ring buffer that outlives neither run.
          riverFrameP50: median(viewBudgets.get("forest:river")?.p50s ?? []),
          playerFrameP50: median(viewBudgets.get("forest:player")?.p50s ?? []),
          meadowFrameP50: median(viewBudgets.get("forest:meadow-close")?.p50s ?? []),
          meadowFrameP99: Math.max(0, ...(viewBudgets.get("forest:meadow-close")?.p99s ?? [])),
          meadowTriangles: median(viewBudgets.get("forest:meadow-close")?.triangles ?? []),
          overviewFrameP50: median(viewBudgets.get("forest:overview")?.p50s ?? []),
          overviewFrameP99: Math.max(0, ...(viewBudgets.get("forest:overview")?.p99s ?? [])),
          overviewTriangles: median(viewBudgets.get("forest:overview")?.triangles ?? []),
          alpineRenderedFrames: renderedFrames.alpine,
          desertRenderedFrames: renderedFrames.desert,
          tundraRenderedFrames: renderedFrames.tundra,
          alpineFrameP50: median(viewBudgets.get("alpine:ridge")?.p50s ?? []),
          desertFrameP50: median(viewBudgets.get("desert:mesa")?.p50s ?? []),
          tundraFrameP50: median(viewBudgets.get("tundra:plain")?.p50s ?? []),
          alpineOverviewFrameP50: median(viewBudgets.get("alpine:overview")?.p50s ?? []),
          desertOverviewFrameP50: median(viewBudgets.get("desert:overview")?.p50s ?? []),
          tundraOverviewFrameP50: median(viewBudgets.get("tundra:overview")?.p50s ?? []),
        });
      });
      // --- the fixed benchmark cameras ---------------------------------------------------------
      //
      // Three framings, all fixed in world metres: the one the player walks behind, the eye-height
      // meadow view the rubric asks for, and the overview. They are data rather than a camera rig
      // so a capture at seed 73 is the same picture on every machine.
      // Distance detail, once the camera is placed for this frame: a prepared tree draws from its
      // full geometry inside the near band and from the mid level beyond it, with a fifth of the
      // band of slack so a camera on the boundary does not alternate the tree between two levels.
      const { poses, views } = BENCHMARK[world];
      const at = (x: number, z: number, up: number): Vector3 =>
        new Vector3(x, field.heightAt(x, z) + up, z);
      ctx.beforeRender(() => {
        renderedFrames[world]++;
        viewVisit.ready = ctx.state.getState().worldReady && ctx.startup.phase === "ready";
        if (!viewVisit.ready) viewVisit.discard = true;
        if (
          measuredView !== currentView ||
          !ctx.state.getState().worldReady ||
          ctx.startup.phase !== "ready"
        ) {
          measuredView = currentView;
          firstViewGpuFrame = Number.POSITIVE_INFINITY;
        }
        if (
          firstViewGpuFrame === Number.POSITIVE_INFINITY &&
          ctx.state.getState().worldReady &&
          ctx.startup.phase === "ready"
        ) {
          const sample = ctx.renderer.gpuFrameSample?.();
          const age = ctx.renderer.gpuFrameAge?.();
          if (sample && age !== undefined) firstViewGpuFrame = sample.frame + age + 1;
        }
        const view = ctx.state.getState().view;
        figure.root.visible = view === "player" && !ctx.state.getState().showcase;
        if (view === "player") {
          // Forest and tundra: the orbit camera framed the player after physics.
          if (!vista) return;
          const offset = world === "coastal" ? new Vector3(28, 18, 34) : new Vector3(28, 24, 42);
          ctx.camera.position.copy(actor.position).add(offset);
          if (world === "coastal")
            ctx.camera.lookAt(actor.position.x + 80, 1.5, actor.position.z + 190);
          else if (world === "alpine")
            ctx.camera.lookAt(
              actor.position.x - 200,
              actor.position.y + 170,
              actor.position.z + 170,
            );
          else
            ctx.camera.lookAt(
              actor.position.x - 180,
              actor.position.y + 30,
              actor.position.z - 160,
            );
          return;
        }
        // A view this world has no framing for falls back to its overview rather than throwing:
        // the cycle can only produce framings the world declares, and this is the last line of
        // defence against a state that arrived from somewhere else.
        const pose = poses[view] ?? poses.overview;
        if (pose === undefined) throw new RangeError(`World '${world}' has no overview framing`);
        ctx.camera.position.copy(
          pose.eyeY === undefined
            ? at(pose.at[0], pose.at[1], pose.eye)
            : new Vector3(pose.at[0], pose.eyeY, pose.at[1]),
        );
        ctx.camera.lookAt(
          pose.lookY === undefined
            ? at(pose.look[0], pose.look[1], pose.lookUp)
            : new Vector3(pose.look[0], pose.lookY, pose.look[1]),
        );
        // After the camera is placed, not before: the band is a function of where the eye is, and
        // the framing is what moved it.
      });
      ctx.state.set({ enterMs: performance.now() - enterStart });
    }

    /**
     * Swim, or ease back to land. The swim clips put the root on the waterline, so a swimmer's root
     * rides the surface; out of the water it returns to the capsule's bottom. True while swimming.
     */
    #swim(dt: number, player: CharacterBody3D, figure: SkeletalMesh3D, speed: number): boolean {
      const surface = player.swimming ? player.waterSurface : undefined;
      const target = surface === undefined ? FEET : surface - player.object.position.y;
      figure.root.position.y += (target - figure.root.position.y) * Math.min(1, dt * 8);
      if (surface === undefined) return false;
      figure.play(speed > 0.3 ? CLIPS.swim : CLIPS.tread, { fade: 0.3 });
      return true;
    }
    /** The starter's gait logic: face the travel direction, blend walk and jog by ground speed. */
    #animate(dt: number, player: CharacterBody3D): void {
      const figure = this.#figure;
      if (!figure) return;
      const { x, z } = player.velocity;
      const speed = Math.hypot(x, z);
      if (speed > 0.05) {
        this.#heading.setFromAxisAngle(figure.root.up, Math.atan2(x, z));
        figure.root.quaternion.slerp(this.#heading, Math.min(1, dt * 12));
      }
      this.#airborne = player.grounded ? 0 : this.#airborne + dt;
      if (this.#swim(dt, player, figure, speed)) this.#airborne = 0;
      else if (this.#airborne > 0.2) figure.play(CLIPS.fall, { fade: 0.15 });
      else if (speed > 0.05) {
        const weights = this.#gaits.sample(speed);
        figure.playWeighted([
          { clip: CLIPS.walk, weight: weights[0] ?? 0 },
          { clip: CLIPS.run, weight: weights[1] ?? 0 },
        ]);
      } else figure.play(CLIPS.idle, { fade: 0.2 });
      figure.update(dt);
    }
    override update(ctx: TerrainCtx, dt: number): void {
      this.#elapsed += dt;
      this.#surfaces?.advance(this.#elapsed);
      const playable = ctx.state.getState().worldReady && ctx.startup.phase === "ready";
      if (playable && ctx.input.justPressed("view")) {
        const cycle = BENCHMARK[world].views;
        const current = cycle.indexOf(ctx.state.getState().view as ViewName);
        const next = cycle[(current + 1) % cycle.length] ?? "player";
        // Keyed by world as well as view: `meadow-close` frames a different hillside in each world,
        // so folding them together would report one number for two different pictures.
        currentView = `${world}:${next}`;
        viewVisit = beginViewVisit();
        firstViewGpuFrame = Number.POSITIVE_INFINITY;
        measuredView = "";
        // Cumulative, not reset: a view is entered once per cycle but latched across every pass the
        // run makes through it, so a second visit measures the same framing with more samples behind
        // it rather than starting the count from nothing.
        if (!viewBudgets.has(currentView))
          viewBudgets.set(currentView, {
            view: currentView,
            p50s: [],
            p99s: [],
            presentedP95s: [],
            triangles: [],
            gpuMs: [],
            gpuMain: [],
            gpuShadow: [],
            gpuOther: [],
            passes: [],
            surfaces: [],
          });
        ctx.state.set({
          view: next,
          currentViewWindows: viewVisit.windows,
        });
      }
      this.#ocean?.advance(this.#elapsed);
      this.#river?.advance(this.#elapsed);
      this.#lake?.advance(this.#elapsed);
      if (playable && ctx.input.justPressed("light"))
        this.#sky?.setSunX(this.#sky.sunX < 0 ? 180 : -180);
      const player = this.#player;
      if (!player) return;
      const move = playable ? ctx.input.vector("move") : { x: 0, y: 0 };
      // Camera-relative: up on the stick runs along the ground where the camera looks.
      const yaw = this.#orbit?.yaw ?? 0;
      const [forwardX, forwardZ] = [-Math.sin(yaw), -Math.cos(yaw)];
      const pace = playable && ctx.input.pressed("sprint") ? SPRINT : JOG;
      player.velocity.x = (forwardX * move.y - forwardZ * move.x) * pace;
      player.velocity.z = (forwardZ * move.y + forwardX * move.x) * pace;
      if (playable && ctx.input.justPressed("jump") && player.grounded) player.velocity.y = 5;
      // A staged world streams its ground around the camera: in a benchmark view the player's
      // ground streams out, so the hidden player is held instead of falling through the map.
      if (!this.#stage || ctx.state.getState().view === "player") player.moveAndSlide(dt);
      this.#animate(dt, player);
      if (!playable) return;
      for (const name of Object.keys(BIOMES) as WorldName[])
        if (name !== world && ctx.input.justPressed(name)) {
          void ctx.goto(name);
          return;
        }
      if (ctx.input.justPressed("coast")) void ctx.goto(world === "forest" ? "coastal" : "forest");
    }
  };
}

// The coastal water-contribution proof rides in only when the URL opts in, so a plain run pays for
// no diagnostic attachment and no observation. It contributes one JSON-safe `waterProof` key.
const waterProof = {
  setup(_ctx: TerrainCtx, runtime?: IGamePluginRuntime) {
    if (!waterProofEnabled()) return undefined;
    return runtime?.observations.contribute({
      capabilities: [],
      sample: (request) => sampleActiveWaterProof(request),
    });
  },
};

const game = defineGame<TerrainState, IPhysicsContext>({
  camera: { projection: "perspective", fov: 60, far: 5000 },
  initialState,
  input: {
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    jump: { keys: ["Space"] },
    sprint: { keys: ["ShiftLeft", "ShiftRight"] },
    look: { pointerRelative: true },
    view: { keys: ["KeyV"] },
    coast: { keys: ["KeyC"] },
    light: { keys: ["KeyL"] },
    forest: { keys: ["Digit1"] },
    coastal: { keys: ["Digit2"] },
    alpine: { keys: ["Digit3"] },
    desert: { keys: ["Digit4"] },
    tundra: { keys: ["Digit5"] },
  },
  frameBudget: {
    // A short window so a playtest run actually closes one; the default 300 frames is longer than
    // this scenario runs. The scene reads the result into state, which is what puts the measured
    // draw count and frame cost into the run report rather than only on a console line.
    onWindow: (window) => {
      budget.drawCalls = Object.values(window.passes ?? {}).reduce(
        (sum, pass) => sum + (pass.draws.mean * pass.frames) / window.frames,
        0,
      );
      budget.frameMs = window.frame.p50;
      budget.tasksAvailable = window.longTasks.available;
      if (window.longTasks.available) {
        budget.longestTaskMs = window.longTasks.longestMs;
        budget.afterFirstFrameTaskMs = window.longTasks.afterFirstFrameMs;
      }
      const group = viewBudgets.get(currentView);
      if (group && retainViewWindow(viewVisit, window, firstViewGpuFrame)) {
        if (
          window.gpuMs !== undefined &&
          window.gpuFrames &&
          window.gpuFrames.first >= firstViewGpuFrame &&
          window.surface?.compiling !== true
        ) {
          group.gpuMs.push(window.gpuMs);
          if (window.gpuMain !== undefined) group.gpuMain.push(window.gpuMain);
          if (window.gpuShadow !== undefined) group.gpuShadow.push(window.gpuShadow);
          if (window.gpuOther !== undefined) group.gpuOther.push(window.gpuOther);
          group.passes.push(
            Object.fromEntries(
              Object.entries(window.passes ?? {}).map(([pass, counts]) => [
                pass,
                // A kind can run several times per frame (world + fullscreen AO are nested).
                // Summarising individual calls' p50 hides the world behind the one-triangle quads.
                {
                  triangles: Math.round((counts.triangles.mean * counts.frames) / window.frames),
                  draws: (counts.draws.mean * counts.frames) / window.frames,
                },
              ]),
            ),
          );
          if (window.surface)
            group.surfaces.push({
              scale: window.surface.resolutionScale,
              samples: window.surface.sampleCount,
            });
        }
        group.p50s.push(window.frame.p50);
        group.p99s.push(window.frame.p99);
        group.presentedP95s.push(window.presented.p95);
        group.triangles.push(
          // The world pass is nested beneath AO; its full-screen passes submit one triangle.
          Object.values(window.passes ?? {}).reduce((sum, pass) => sum + pass.triangles.max, 0),
        );
      }
    },
    // Windows close every ten presents, not simulation ticks or seconds. The first window after
    // a view change is discarded; the scenario waits for three kept windows before leaving a view.
    reportEvery: 10,
  },
  plugins: [rapier({ deterministicRestart: true }), playtest(), waterProof],
  // HiDPI displays ask for 2-3x the pixels; the engine scaler trims to what the GPU affords.
  render: {
    preferWebGPU: true,
    resolutionScale:
      forestStageArm(typeof location === "undefined" ? "" : location.search) === undefined
        ? "auto"
        : 1,
  },
  scenes: {
    forest: terrainScene("forest"),
    coastal: terrainScene("coastal"),
    alpine: terrainScene("alpine"),
    desert: terrainScene("desert"),
    tundra: terrainScene("tundra"),
  },
  start: "forest",
});

export default game;
