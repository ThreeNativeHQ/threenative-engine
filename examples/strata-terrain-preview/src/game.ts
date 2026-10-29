import { type ICtx, Scene, VirtualShadowNode, defineGame, markStatic } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { Heightfield } from "@threenative/core/world";
import {
  CharacterBody3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  rapier,
} from "@threenative/physics";
import {
  CapsuleGeometry,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from "three";
import { BIOMES, type WorldName } from "./render/biomes.js";
import {
  createLoadingScreen,
  createSpawnReadiness,
  spawnReadinessSnapshot,
} from "./render/loading.js";
import { createOcean, createWaterMesh } from "./render/ocean.js";
import { type ICanopyComparison, loadPack, loadSkyLight } from "./render/pack.js";
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
import { type IPlacementField, scatterProps } from "./render/scatter.js";
import { type IOutdoorSky, createOutdoorSky, installOutdoorOcclusion } from "./render/sky.js";
import { type IBakedWorld, createTerrain, paintCanopy } from "./render/terrain.js";
import { preparePropTextures } from "./render/texturePreparation.js";
import { medianOfGrowingSamples as median } from "./viewStatistics.js";
import baked from "./world/baked.json";

/**
 * The fixed benchmark framings, in world metres, per world.
 *
 * Fixed rather than relative to the player so a capture at seed 73 is the same picture on every
 * machine, and so the rubric's "close ground/vegetation view" and "landscape overview" are two
 * numbers rather than two moods. `eye` is the height above the terrain under the camera, which is
 * what makes "eye height ~1.7 m" true on a slope instead of true only on a flat.
 *
 * The meadow focus is where the ground is grass with spruces on it and a slope to look along, and
 * it is also where the dense grass goes: ground cover is placed around this point, not around the
 * origin, because a meadow is a place rather than a texture.
 */
/** Every framing the `V` key can hold, whether or not the current world has one for it. */
type ViewName =
  | "ridge"
  | "mesa"
  | "plain"
  | "horizon-sea"
  | "meadow-close"
  | "overview"
  | "player"
  | "river";

interface IBenchmarkPose {
  /** World x and z of the eye, and the height above the terrain under it. */
  readonly at: readonly [number, number];
  readonly eye: number;
  /** Absolute elevation for an overview over surveyed scenery beyond the playable collider. */
  readonly eyeY?: number;
  /** World x and z to look at, and the height above the terrain under *that*. */
  readonly look: readonly [number, number];
  readonly lookUp: number;
  /**
   * An absolute world height to look at instead, for a target with no ground under it: a sea
   * horizon is a direction, and thirty metres below the surface three hundred metres out is how a
   * hillside tips its view down far enough for the water to be a band rather than a line.
   */
  readonly lookY?: number;
}

interface IBenchmark {
  /** Where this world's ground cover is placed. */
  readonly focus: { readonly x: number; readonly z: number };
  readonly poses: Readonly<Record<string, IBenchmarkPose>>;
  /** The order the `V` key walks, and the framings the playtest screenshots. */
  readonly views: readonly ViewName[];
}

const BENCHMARK: Record<WorldName, IBenchmark> = {
  alpine: {
    focus: { x: 180, z: -190 },
    poses: {
      ridge: { at: [220, -220], eye: 150, look: [-75, 40], lookUp: 0, lookY: 320 },
      overview: { at: [850, -1000], eye: 0, eyeY: 760, look: [-55, 35], lookUp: 0, lookY: 330 },
    },
    views: ["player", "ridge", "overview"],
  },
  desert: {
    focus: { x: 170, z: 180 },
    poses: {
      mesa: { at: [195, 190], eye: 3.2, look: [-35, -30], lookUp: 20 },
      overview: { at: [200, 200], eye: 165, look: [-40, -30], lookUp: 10 },
    },
    views: ["player", "mesa", "overview"],
  },
  tundra: {
    focus: { x: 150, z: 160 },
    poses: {
      plain: { at: [166, 180], eye: 2.2, look: [-65, -50], lookUp: 2 },
      overview: { at: [180, 180], eye: 62, look: [-20, -50], lookUp: 2 },
    },
    views: ["player", "plain", "overview"],
  },
  forest: {
    focus: { x: 150, z: -100 },
    poses: {
      "meadow-close": { at: [165, -95], eye: 1.7, look: [-70, -180], lookUp: 2.2 },
      overview: { at: [190, 170], eye: 65, look: [-70, 25], lookUp: 5 },
      river: { at: [-145, -120], eye: 1.7, look: [-110, -185], lookUp: 0 },
    },
    views: ["player", "meadow-close", "overview", "river"],
  },
  coastal: {
    focus: { x: 80, z: 5 },
    poses: {
      "meadow-close": { at: [110, -35], eye: 1.7, look: [155, 100], lookUp: 1.5 },
      overview: { at: [-140, -120], eye: 75, look: [160, 115], lookUp: 0 },
      "horizon-sea": { at: [185, 145], eye: 6, look: [220, 450], lookUp: 0, lookY: 1.5 },
    },
    views: ["player", "meadow-close", "overview", "horizon-sea"],
  },
};

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
let reportedView = "";
let measuredView = "";
let firstViewGpuFrame = Number.POSITIVE_INFINITY;
const renderedFrames: Record<WorldName, number> = {
  forest: 0,
  coastal: 0,
  alpine: 0,
  desert: 0,
  tundra: 0,
};
const worldLoads = {
  alpine: () => import("./world/alpine.json"),
  desert: () => import("./world/desert.json"),
  tundra: () => import("./world/tundra.json"),
};

const initialState = {
  canopyComparison: { normals: "authored", specular: "disabled" } as ICanopyComparison,
  showcase: false,
  worldReady: false,
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
  grounded: false,
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
  preparedLevelsWithoutSolid: 0,
  view: "player",
  windowDrawCalls: 0,
  windowFrameMs: 0,
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

function terrainScene(world: WorldName): new () => Scene<TerrainState, IPhysicsContext> {
  return class TerrainScene extends Scene<TerrainState, IPhysicsContext> {
    static override readonly initialState = initialState;
    #data: IBakedWorld | undefined;
    override async load(): Promise<void> {
      this.#data =
        world === "forest" || world === "coastal"
          ? baked[world]
          : (await worldLoads[world]()).default;
    }
    #player: CharacterBody3D | undefined;
    #surfaces: { advance: (elapsed: number) => void } | undefined;
    #elapsed = 0;
    #sky: IOutdoorSky | undefined;
    #ocean: ReturnType<typeof createOcean> | undefined;
    #river: IRiverWater | undefined;
    #lake: IRiverWater | undefined;

    override enter(ctx: TerrainCtx): void {
      ctx.add(ctx.camera);
      const data = this.#data;
      if (!data) throw new Error(`World ${world} was not loaded`);
      // ctx.goto carries state; camera names from the outgoing biome must not carry with it.
      ctx.state.set({ view: "player", worldReady: false, loadingError: "" });
      let released = false;
      const textureUploads = new AbortController();
      let propsStage = "waiting-for-physics";
      let propsSettled = false;
      let preparation: IPropPreparationProgress | undefined;
      let completedPropsWork = 0;
      const admission = createSpawnReadiness("Strata spawn", 120_000, captureSpawnFailure);
      function captureSpawnFailure(reason: string): void {
        console.error(
          `TN_STRATA_SPAWN_FAILURE ${JSON.stringify(
            spawnReadinessSnapshot({
              reason,
              atMs: performance.now(),
              world,
              sceneUuid: ctx.scene.uuid,
              released,
              gate: admission,
              stage: propsStage,
              propsSettled,
              ...(preparation === undefined ? {} : { preparation }),
              coverage: props?.readinessAt(spawn),
              assets: ctx.assets.progress,
              startup: ctx.startup,
            }),
          )}`,
        );
      }
      const failSpawn = (reason: unknown): void => {
        admission.fail(reason);
        ctx.state.set({ worldReady: admission.ready, loadingError: admission.error });
      };
      if (ctx.startup.phase !== "ready")
        ctx.startup.hold(
          "strata-spawn",
          // Core polls this once per rendered frame, so the gate settles under a playtest's
          // deterministic clock, which advances no fixed step while startup is held.
          () => {
            const region = props?.readinessAt(spawn);
            admission.observe(region?.ready === true, region?.failures ?? 0);
            return admission.ready || admission.error !== "";
          },
          120_000,
          () =>
            completedPropsWork +
            (preparation?.prewarmedWorlds ?? 0) +
            ctx.state.getState().spawnCellsLoaded,
        );
      const loading = createLoadingScreen({
        ...ctx,
        keepWorldRendering: false,
        startup: {
          get progress() {
            const state = ctx.state.getState();
            const coverage =
              state.spawnCellsRequired > 0 ? state.spawnCellsLoaded / state.spawnCellsRequired : 0;
            return Math.min(0.99, (ctx.startup.progress + coverage) / 2);
          },
          whenReady: () =>
            Promise.all([ctx.startup.whenReady(), admission.promise]).then(() => undefined),
        },
      });
      ctx.afterPhysics(() => loading.update());
      const biome = BIOMES[world];
      const { field, mesh } = createTerrain(data, ctx.assets, biome);
      ctx.add(mesh);
      // Scenery: nothing moves the ground, so its transform is composed once instead of every frame.
      markStatic(mesh);
      const ground = new RigidBody3D({
        object: mesh,
        physics: ctx.physics,
        type: "fixed",
        entity: "terrain",
        collisionLayer: 4,
        shape: CollisionShape3D.heightfield(field.rows, field.columns, field.toColliderHeights(), {
          x: data.size,
          y: 1,
          z: data.size,
        }),
      });
      ctx.entities.add("terrain", {
        mesh,
        dispose: () => {
          ground.dispose();
          mesh.geometry.dispose();
          (mesh.material as MeshStandardMaterial).dispose();
        },
      });
      // One rig owns the whole of the sky, the sun, the shadows that follow the eye, the haze the
      // far ridges fade into and the tone curve. It used to be a flat `Color` background, a
      // hand-set `FogExp2`, a sun with a five metre shadow box that missed everything, and no tone
      // mapping at all; the numbers behind all of that now live in `src/render/sky.ts`.
      const sky = createOutdoorSky(ctx.camera, biome);
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
        collisionMask: 4,
      });
      this.#player = player;
      ctx.entities.add("player", {
        mesh: actor,
        debug: () => ({
          grounded: player.grounded,
          position: actor.position.toArray(),
          visible: actor.visible && actor.material.visible,
          horizon: {
            seamGap: mesh.userData.horizonSeamGap,
            samples: mesh.userData.horizonSeamSamples,
          },
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

      const ocean = world === "coastal" ? ctx.add(createOcean()) : undefined;
      this.#ocean = ocean;
      if (ocean) {
        const water = createWaterMesh(ocean, data);
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
      const lake = createLakes(data.lakes ?? [], field, world === "forest");
      this.#lake = lake;
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
      const erosionFlowSamples = data.erosion?.flow.filter((value) => value > 0).length ?? 0;
      const erosionDepositSamples =
        data.erosion?.deposition.filter((value) => value > 0).length ?? 0;
      const propField: IPlacementField = {
        world,
        colors: data.colors,
        erosion: data.erosion,
        field,
        resolution: data.size === 0 ? 0 : field.rows,
        size: data.size,
        waterLevel: data.waterLevel,
        lakes: data.lakes,
        rivers: data.rivers,
      };
      // Every fixed camera stands in a clearing: a trunk a metre from the lens is a green wall, not a
      // framing, and the seed decides where trees land, so the eyes are kept open by rule.
      const river = createRivers(
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
      const scatter = scatterProps(
        propField,
        BENCHMARK[world].focus,
        Object.values(BENCHMARK[world].poses)
          .filter((pose) => pose.eye < 20)
          .map((pose) => [pose.at[0], pose.at[1], 10] as const),
      );
      paintCanopy(mesh, data, scatter.placements);
      const fallbackSaplingHeight = world === "alpine" ? 2 : world === "tundra" ? 1.4 : undefined;
      let propParts = buildPropVariants(undefined, fallbackSaplingHeight);
      const flat = flatPropMaterials();
      let props: Awaited<ReturnType<typeof createStreamedProps>>;
      let readyTimePending = false;
      let building = false;
      let preparedDispose: (() => void) | undefined;
      // What the prepared files measured on load. Published rather than thrown on, because a
      // number in the run report says which level is off the ground and a stack trace does not.
      let preparedLodBaseSpread = 0;
      let preparedLevelsWithoutSolid = 0;
      let surfacesDispose: (() => void) | undefined;
      ctx.entities.add("props-lifetime", {
        dispose: () => {
          released = true;
          textureUploads.abort(new Error("Strata scene released during texture preparation."));
          admission.cancel();
          loading.finish();
          surfacesDispose?.();
          flat.dispose();
          preparedDispose?.();
          props?.dispose();
          for (const parts of propParts.values()) for (const part of parts) part.geometry.dispose();
        },
      });
      // Ground contact is a ray query against the drawn terrain and the terrain's collider, never
      // the bilinear sampler: a spruce floating a centimetre above the visible surface reads as a
      // mistake at exactly the distance a player spends most of their time at.
      mesh.updateMatrixWorld(true);
      mesh.geometry.computeBoundingBox();
      const top = mesh.geometry.boundingBox?.max.y ?? 0;
      const groundAt: PropGroundQuery = (placement, at) => {
        const [x, , z] = at;
        const visual = ctx.raycast({
          direction: new Vector3(0, -1, 0),
          origin: new Vector3(x, top + 2, z),
          targets: [mesh],
        });
        const physical = ctx.physics.directSpaceState.intersectRay({
          collisionMask: 4,
          from: { x, y: top + 2, z },
          to: { x, y: -100, z },
        });
        let height = visual?.point.y ?? physical?.position.y ?? null;
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
              const foot = ctx.raycast({
                direction: new Vector3(0, -1, 0),
                origin: new Vector3(x + (dx ?? 0), top + 2, z + (dz ?? 0)),
                targets: [mesh],
              });
              if (foot) height = Math.min(height, foot.point.y);
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
      const buildProps = async (): Promise<void> => {
        propsStage = "assets";
        const [prepared, pack, skyLight] = await Promise.all([
          loadPreparedProps(ctx.assets),
          loadPack(ctx.assets, world, data, ctx.state.getState().canopyComparison),
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
        );
        if (released) return;
        propsStage = "streaming";
        props = await createStreamedProps({
          placements: scatter.placements,
          groundAt,
          parts: propParts,
          materials: surfaces.materials,
          assets: ctx.assets,
          follow: ctx.camera,
          size: data.size,
          horizonDistance:
            ctx.camera instanceof PerspectiveCamera || ctx.camera instanceof OrthographicCamera
              ? ctx.camera.far
              : 5000,
          whileCurrent: () => !released,
          onProgress: (progress) => {
            const previous =
              preparation?.phase === progress.phase && preparation.bucket === progress.bucket
                ? preparation.added
                : 0;
            completedPropsWork += Math.max(0, progress.added - previous);
            preparation = progress;
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
        // Prewarm borrows actual world draws only after registration. Grounding and package
        // preparation have no attached stream to prewarm and keep the opaque curtain's draw gate.
        ctx.canvasLayer.keepWorldRendering = true;
        propsStage = "attached";

        const alpineCrags =
          world === "alpine"
            ? [...props.byId.values()].filter((instance) => instance.placement.asset === "mountain")
            : [];
        ctx.entities.add("props", {
          object: props.worlds[0],
          debug: () => ({
            streaming: props?.stats(),
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
                      ? Math.max(...alpineCrags.map((instance) => instance.cragBaseClearance ?? 1))
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

      let frames = 0;
      let propCounts = { draws: 0, instances: 0, triangles: 0 };
      let travel = 0;
      currentView = `${world}:player`;
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
        travel += Math.hypot(actor.position.x - previous.x, actor.position.z - previous.z);
        previous.copy(actor.position);
        // Query actual triangles, not bilinear interpolation, after the shared solver step.
        if (frames === 0) {
          probeMesh.updateMatrixWorld(true);
          mesh.updateMatrixWorld(true);
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
        // An oblique traversal crosses cells; exact vertical edge/corner probes remain above.
        const visual = ctx.raycast({
          origin: new Vector3(actor.position.x, 300, actor.position.z),
          direction: new Vector3(1, -400, 1).normalize(),
          targets: mesh,
        });
        const physical = ctx.physics.directSpaceState.intersectRay({
          from: { x: actor.position.x, y: 300, z: actor.position.z },
          to: { x: actor.position.x + 1, y: -100, z: actor.position.z + 1 },
          collisionMask: 4,
        });
        if (!visual || !physical)
          throw new Error(
            `Missing playable terrain contact: world=${world}, frame=${frames}, player=${actor.position.toArray()}, visual=${!!visual}, physical=${!!physical}, terrain=${mesh.position.toArray()}`,
          );
        maxContactError = Math.max(maxContactError, Math.abs(visual.point.y - physical.position.y));
        contactSamples++;
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
        if (props === undefined && !building) {
          building = true;
          const work = buildProps();
          if (ctx.startup.phase !== "ready") ctx.startup.hold("strata-props", work);
          void work.then(
            () => {
              propsSettled = true;
            },
            (error) => {
              propsSettled = true;
              if (!released) failSpawn(error);
            },
          );
        }
        frames++;
        // `props.meshes` walks every streamed world; three walks per fixed step were 8.3 s of a
        // 15.6 s main-thread stall in a profiled session (PRD-541). Half a second is fresh enough.
        if (frames % 30 === 1) {
          const meshes = props?.meshes ?? [];
          propCounts = {
            draws: meshes.length,
            instances: meshes.reduce((sum, draw) => sum + draw.count, 0),
            triangles: meshes.reduce(
              (sum, draw) => sum + (draw.count * (draw.geometry.index?.count ?? 0)) / 3,
              0,
            ),
          };
        }
        const streaming = props?.stats();
        const region = props?.readinessAt(spawn);
        admission.observe(region?.ready === true, region?.failures ?? 0);
        const worldReady = admission.ready;
        if (region)
          ctx.state.set({ spawnCellsRequired: region.required, spawnCellsLoaded: region.loaded });
        if (admission.error) ctx.state.set({ loadingError: admission.error });
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
          maxViewGpuMs: viewGpu.length ? Math.max(...viewGpu.map((group) => group.gpuMs)) : -1,
          measuredGpuViewCount: viewGpu.length,
          tasksAvailable: budget.tasksAvailable,
          longestLoadTaskMs: budget.longestTaskMs,
          afterFirstFrameTaskMs: budget.afterFirstFrameTaskMs,
          viewFrameP50s,
          maxViewFrameP50: Math.max(0, ...viewFrameP50s.map((group) => group.p50)),
          maxViewPresentedP95: Math.max(0, ...viewFrameP50s.map((group) => group.presentedP95)),
          measuredViewCount: viewFrameP50s.filter((group) => group.windows > 0).length,
          world,
          groundBiome: (mesh.material as MeshStandardMaterial).userData.biome ?? "baked",
          worldReady,
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
            (mesh.material as MeshStandardMaterial).userData.erosion === true &&
            erosionFlowSamples > 1000 &&
            erosionDepositSamples > 100,
          erosionFlowSamples,
          erosionDepositSamples,
          sunX: sky.sunX,
          frames,
          travel,
          grounded: player.grounded,
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
        actor.material.visible = view === "player" && !ctx.state.getState().showcase;
        if (view === "player") {
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
          else if (world === "desert")
            ctx.camera.lookAt(
              actor.position.x - 180,
              actor.position.y + 30,
              actor.position.z - 160,
            );
          else ctx.camera.lookAt(actor.position.x, actor.position.y + 2, actor.position.z - 12);
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
        ctx.state.set({ view: next });
      }
      this.#ocean?.advance(this.#elapsed);
      this.#river?.advance(this.#elapsed);
      this.#lake?.advance(this.#elapsed);
      if (playable && ctx.input.justPressed("light"))
        this.#sky?.setSunX(this.#sky.sunX < 0 ? 180 : -180);
      const player = this.#player;
      if (!player) return;
      const move = playable ? ctx.input.vector("move") : { x: 0, y: 0 };
      player.velocity.x = move.x * 9;
      player.velocity.z = move.y * 9;
      if (playable && ctx.input.justPressed("jump") && player.grounded) player.velocity.y = 5;
      player.moveAndSlide(dt);
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
    view: { keys: ["KeyV"] },
    coast: { keys: ["KeyC"] },
    light: { keys: ["KeyL"] },
    forest: { keys: ["Digit1"] },
    coastal: { keys: ["Digit2"] },
    alpine: { keys: ["Digit3"] },
    desert: { keys: ["Digit4"] },
    tundra: { keys: ["Digit5"] },
  },
  // A short window so a playtest run actually closes one: the default 300 frames is longer than
  // this scenario runs. The window is read into state, which is what puts the measured draw count
  // and frame cost into the run report instead of only on a console line nobody reads.
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
      const sameView = reportedView === currentView;
      reportedView = currentView;
      if (group && sameView) {
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
    // Small because this counts PRESENTED frames, not simulated ones. The native host presents at
    // roughly fifteen a second under Xvfb, so a 1459-frame run presents only a couple of hundred
    // times: the default 300-present window never closes at all, and every framing would report zero
    // samples. Ten presents is a second of steady state here, enough that each benchmark view that
    // the scenario holds on screen accumulates several windows to take a median over.
    reportEvery: 10,
  },
  plugins: [rapier({ deterministicRestart: true }), playtest()],
  // HiDPI displays ask for 2-3x the pixels; the engine scaler trims to what the GPU affords.
  render: { preferWebGPU: true, resolutionScale: "auto" },
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
