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
import type { IBiomeSpec } from "@threenative/terrain";
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
import {
  beginScene,
  createMeasure,
  createRevealProbe,
  enterView,
  initialDiagnosticsState,
  launchedAt,
  leaveScene,
  observeFrame,
  observeWindow,
  publish,
} from "./diagnostics.js";
import { BENCHMARK, type ViewName } from "./render/benchmark.js";
import { biomeSpec } from "./render/biomeData.js";
import { BIOMES, type IWorldBiome, type WorldName, measureBiome } from "./render/biomes.js";
import {
  FAR_FOREST,
  FAR_FOREST_WORLDS,
  collarSampler,
  farForestPlacements,
} from "./render/farForest.js";
import { createGroundSampler } from "./render/groundSampler.js";
import {
  HORIZON_WALK_BAND,
  type HorizonSurroundings,
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
import { meadowCover } from "./render/scatter.js";
import { type IOutdoorSky, createOutdoorSky, installOutdoorOcclusion } from "./render/sky.js";
import { type IBakedWorld, OPEN_MEADOW, createTerrain } from "./render/terrain.js";
import { preparePropTextures } from "./render/texturePreparation.js";
import { sampleActiveWaterProof, waterProofEnabled } from "./render/waterProof.js";
import {
  type ForestStageWorld,
  addForestStage,
  forestStageArm,
  forestStageTerrainTargets,
} from "./world/forestStage.js";
import { waterCurrentAt, waterSurfaceAt } from "./world/water.js";
import { START_WORLD, WORLD_ORDER, WORLD_SELECT, loadBakedWorld } from "./worlds.js";

let horizonLoad: Promise<void> | undefined;

/**
 * What the scene keeps in state that is not a measurement: the look readout a run compares, and
 * whether the showcase hides the figure. Every counter beside it comes from `./diagnostics.js`.
 */
const initialState = {
  ...initialDiagnosticsState,
  canopyComparison: { normals: "authored", specular: "disabled" } as ICanopyComparison,
  showcase: false,
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
  // What the game resolves this world from: its validated rules, and the look it is graded under.
  const spec = biomeSpec(world);
  const look = BIOMES[world];
  return class TerrainScene extends Scene<TerrainState, IPhysicsContext> {
    static override readonly initialState = initialState;
    #data: IBakedWorld | undefined;
    #biome: IWorldBiome | undefined;
    /** The other world drawn from this biome's baked bundle, if the bundle holds one. */
    #bundleTwin: WorldName | undefined;
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
      const [baked, mannequin, swim] = await Promise.all([
        loadBakedWorld(ctx.assets, spec),
        ctx.assets.model<IMannequin>("mannequin.glb"),
        ctx.assets.model<IMannequin>(SWIM_CLIPS),
      ]);
      this.#data = baked.data;
      this.#mannequin = mannequin;
      this.#swimClips = swim.animations;
      this.#bundleTwin = (Object.keys(BIOMES) as WorldName[]).find(
        (name) => name !== world && baked.siblings.includes(name),
      );
      this.#biome = measureBiome(look, this.#data.heights);
      // `?stage=before|after` replaces this world's terrain, water, colliders and props with one
      // baked forest kit copy, streamed by the kit's own `addForest`; the sky, camera and views stay.
      const arm = look.stageArm ? forestStageArm(globalThis.location?.search ?? "") : undefined;
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
      if (spec.water.some((body) => body.kind === "ocean")) {
        this.#ocean = createOcean();
        this.#water = createWaterMesh(this.#ocean, this.#data);
      }
      this.#lake = createLakes(this.#data.lakes ?? [], this.#terrain.field);
      this.#erosionSamples = {
        flow: this.#data.erosion?.flow.filter((value) => value > 0).length ?? 0,
        deposition: this.#data.erosion?.deposition.filter((value) => value > 0).length ?? 0,
      };
      this.#fallbackParts = buildPropVariants(undefined, look.saplingHeight ?? undefined);
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
      leaveScene();
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
      const reveal = createRevealProbe({
        camera: () => ctx.camera as PerspectiveCamera,
        pipelineCensus: () => ctx.renderer.pipelineCensus?.(),
        engineCompiles: () => {
          const engine = (ctx.renderer.raw as { info?: { engine?: { compiles?: unknown } } }).info
            ?.engine;
          return typeof engine?.compiles === "number" ? engine.compiles : undefined;
        },
        covered: () => ctx.canvasLayer.opaque,
        phase: () => ctx.startup.phase,
        shadowNode: () => this.#sky?.sun.shadow.shadowNode,
        pendingImpostors: () =>
          props?.worlds.reduce((sum, stream) => sum + stream.stats().impostor.pending, 0) ?? 0,
        released: () => released,
        afterPhysics: (callback) => ctx.afterPhysics(callback),
        revealed: () => ctx.state.set({ revealComplete: true }),
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
        onReveal: reveal.initialize,
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
      const collar = terrain?.collar;
      if (mesh) {
        // Every scene that draws a terrain mesh has a collar: `createTerrain` builds both.
        if (!collar) throw new Error(`World ${world} has no horizon collar`);
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
        const band = collar.walk;
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
      const [startX, startZ] = spec.spawn.at;
      actor.position.set(startX, field.heightAt(startX, startZ) + 2, startZ);
      actor.name = "player";
      // Freeze the launch region before gameplay or a review view can move its follow camera.
      const spawn = actor.position.clone().add(new Vector3(...spec.spawn.cameraOffset));
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
      const vista = look.vistaAim !== null;
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
        // Every pond a bundled water body draws has a baked footprint of its own; a lake drawn alone
        // draws one group, and the loop leaves the error at nought.
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
            look.riverMirrorsPonds ? lake?.reflectionAt : undefined,
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
        player.water = waterSurfaceAt(rivers, lakes, field);
        if (params.get("current") !== "off")
          player.waterCurrent = waterCurrentAt(rivers, lakes, field);
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
        if (!mesh || !collar || !scatter || scatter.canopy.length !== data.resolution ** 2)
          throw new Error(`World ${world} placements do not match the terrain`);
        if (!fallbackParts) throw new Error(`World ${world} prop variants were not loaded`);
        mesh.geometry.setAttribute("canopy", new Float32BufferAttribute(scatter.canopy, 1));
        const fallbackSaplingHeight = look.saplingHeight ?? undefined;
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
        // The surroundings rise above the square's top, so their collider ray starts above both.
        const ridges = mesh.getObjectByName("temperate-distant-ridges");
        if (ridges instanceof Mesh) ridges.geometry.computeBoundingBox();
        const rayTop =
          Math.max(
            top,
            ridges instanceof Mesh ? (ridges.geometry.boundingBox?.max.y ?? top) : top,
          ) + 2;
        const groundSample = createGroundSampler(field, mesh.geometry, mesh.matrixWorld);
        // Past the walk band's collider the drawn collar is the ground (`farForest.ts`).
        const collarGround = collarSampler(collar);
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
            from: { x, y: rayTop, z },
            to: { x, y: -100, z },
          });
          let height = visual ?? physical?.position.y ?? collarGround.at(x, z) ?? null;
          if (
            height !== null &&
            look.stoneSinkShare !== null &&
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
              height -= (box.max.y - box.min.y) * placement.scale * look.stoneSinkShare;
            }
          }
          const [originX, originY, originZ] = placement.position;
          // Past the square there is no Heightfield: an authored y there is its own offset.
          const resident = Math.abs(originX) <= data.size / 2 && Math.abs(originZ) <= data.size / 2;
          return {
            height,
            offset: resident ? originY - field.heightAt(originX, originZ) : originY,
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
          // A look whose stones use both scans fills the otherwise primitive slot with the second.
          const dryStone = prepared.parts.get("boulder:1");
          if (look.stoneScans > 1 && dryStone && !pack.parts.has("boulder:0"))
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
          // A fixed view standing on the surroundings gets the meadow the bake cannot place there.
          const vista = OPEN_MEADOW ? BENCHMARK[world].poses.vista : undefined;
          // Spruce across the valley past the square; `?farForest=off` plants none.
          const vistaEye = BENCHMARK[world].poses.vista?.at;
          const far =
            FAR_FOREST_WORLDS.includes(world) && FAR_FOREST && ridges instanceof Mesh
              ? farForestPlacements({
                  size: data.size,
                  resolution: data.resolution,
                  collar,
                  treeline: biome.heightBands.treeline,
                  rivers: data.rivers,
                  lakes: data.lakes,
                  clear: vistaEye ? [[vistaEye[0], vistaEye[1], 55]] : [],
                })
              : [];
          farForestCount = far.length;
          props = await createStreamedProps({
            placements: [
              ...scatter.placements,
              ...(vista
                ? meadowCover(
                    { x: vista.at[0], z: vista.at[1] },
                    { x: vista.look[0], z: vista.look[1] },
                    data.size / 2,
                    HORIZON_WALK_BAND - 12,
                  )
                : []),
              ...far,
            ],
            groundAt,
            parts: propParts,
            materials: surfaces.materials,
            assets: ctx.assets,
            // The player, not the orbiting eye: turning the camera in place must not swap tree LODs.
            // A fixed view streams around its own eye, as UE grass follows the rendered view
            // (UE 5.8.3: Engine/Source/Runtime/Landscape/Private/LandscapeSubsystem.cpp:641);
            // `?meadow=off` keeps the player.
            follow: {
              get position() {
                return OPEN_MEADOW && ctx.state.getState().view !== "player"
                  ? ctx.camera.position
                  : followed();
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
            onPublication: (bounds) => reveal.publishedBatch(bounds),
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

          // A pinned-crag look's mountains are the crags: their base ring is what it measures.
          const alpineCrags = look.pinnedCrags
            ? [...props.byId.values()].filter((instance) => instance.placement.asset === "mountain")
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
                ...(look.pinnedCrags
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
      let farForestCount = 0;
      beginScene(world);
      const measure = createMeasure({
        world,
        physics: ctx.physics,
        raycast: (options) => ctx.raycast(options),
        actor,
        player,
        size: data.size,
        mesh,
        stage,
        fixture,
        probeMesh,
        swimmingClip: () => {
          const clip = this.#figure?.current;
          return clip === CLIPS.swim || clip === CLIPS.tread;
        },
        hasPropColliders: () => propColliders !== undefined,
        eye: () => ctx.camera.position,
        camera: () => ctx.camera as PerspectiveCamera,
        ocean,
        spawnReady: () => spawnReady,
        terrainTargets: () => (stage ? forestStageTerrainTargets(stage.world) : mesh),
        view: () => ctx.state.getState().view,
      });
      ctx.afterPhysics(() => {
        measure.step();
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
          measure.countProps(
            meshes,
            props?.worlds.find((stream) => stream.name === "strata-props:far:false"),
          );
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
        publish(ctx, {
          world,
          groundBiome: mesh
            ? ((mesh.material as MeshStandardMaterial).userData.biome ?? "baked")
            : `stage:${forestStageArm(globalThis.location?.search ?? "")}`,
          elevation: biome.elevationRange,
          snowBand: biome.snowBand,
          worldReady,
          spawnReadiness,
          spawnCells,
          streaming,
          terrainTransportBound:
            (mesh?.material as MeshStandardMaterial | undefined)?.userData.erosion === true &&
            erosionFlowSamples > 1000 &&
            erosionDepositSamples > 100,
          erosion: { flow: erosionFlowSamples, deposition: erosionDepositSamples },
          sunX: sky.sunX,
          frames,
          propColliders: propColliders?.stats().resident ?? 0,
          ...measure.facts(),
          farForest: farForestCount,
          preparedLodBaseSpread,
          compressedTexturesPrepared,
          preparedLevelsWithoutSolid,
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
        observeFrame(world, ctx);
        const view = ctx.state.getState().view;
        figure.root.visible = view === "player" && !ctx.state.getState().showcase;
        if (view === "player") {
          // Forest and tundra: the orbit camera framed the player after physics.
          const aim = look.vistaAim;
          if (!aim) return;
          ctx.camera.position.copy(actor.position).add(new Vector3(...spec.spawn.cameraOffset));
          const [aimX, aimZ] = aim.at;
          // A look's aim stands on the player's own ground, or level with the water it looks over.
          const aimY = aim.rise === null ? (data.waterLevel ?? 0) : actor.position.y + aim.rise;
          ctx.camera.lookAt(actor.position.x + aimX, aimY, actor.position.z + aimZ);
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
        const entered = enterView(world, next);
        ctx.state.set({ view: next, currentViewWindows: entered.windows });
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
      for (const name of Object.keys(WORLD_SELECT) as WorldName[])
        if (name !== world && ctx.input.justPressed(name)) {
          void ctx.goto(name);
          return;
        }
      // The coast key compares the two worlds drawn from one bake; a world baked alone has none.
      if (this.#bundleTwin !== undefined && ctx.input.justPressed("coast"))
        void ctx.goto(this.#bundleTwin);
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
    ...WORLD_SELECT,
  },
  frameBudget: {
    // A short window so a playtest run actually closes one; the default 300 frames is longer than
    // this scenario runs. The scene reads the result into state, which is what puts the measured
    // draw count and frame cost into the run report rather than only on a console line.
    onWindow: (window) => observeWindow(window),
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
  scenes: Object.fromEntries(WORLD_ORDER.map((name) => [name, terrainScene(name)])),
  start: START_WORLD,
});

export default game;
