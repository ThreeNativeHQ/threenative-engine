import {
  Scene,
  VirtualShadowNode,
  addInSlices,
  type defineGame,
  markStatic,
} from "@threenative/core";
import { Heightfield, warmUnculled } from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  type AnimationClip,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  type PerspectiveCamera,
  Vector2,
  Vector3,
} from "three";
import { uniform } from "three/tsl";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import {
  beginScene,
  createMeasure,
  createRevealProbe,
  enterView,
  launchedAt,
  leaveScene,
  observeFrame,
  observeWindow,
  publish,
} from "./diagnostics.js";
import { type IMannequin, type IPlayerRig, createPlayerRig } from "./playerRig.js";
import { BENCHMARK, type ViewName, posesFor } from "./render/benchmark.js";
import { biomeSpec } from "./render/biomeData.js";
import { BIOMES, type IWorldBiome, measureBiome } from "./render/biomes.js";
import {
  HORIZON_REACH,
  HORIZON_WALK_BAND,
  loadHorizonSurroundings,
} from "./render/ground/horizon.js";
import { type IBakedWorld, type ITerrainStream, createTerrain } from "./render/ground/terrain.js";
import { forestAssets } from "./render/kitAssets.js";
import { createLoadingScreen } from "./render/loading.js";
import { loadCanopy, loadPropPackage, loadSky, propCounts } from "./render/props/propWorld.js";
import { invalidatePropShadows } from "./render/props/propWorld.js";
import { buildPropVariants } from "./render/props/props.js";
import { type IOutdoorSky, createOutdoorSky, installOutdoorOcclusion } from "./render/sky/sky.js";
import { type IRiverWater, WATER_LAYER, createLakes, createRivers } from "./render/water/river.js";
import { type IMeadow, type Scatter, type Variants, createMeadow } from "./sceneProps.js";
import { type TerrainCtx, type TerrainState, initialState } from "./sceneState.js";
import { createSpawnGate } from "./spawnGate.js";
import { addStreamedGround } from "./world/streamedGround.js";
import { walkBandSlices } from "./world/walkBand.js";
import { waterCurrentAt, waterSurfaceAt } from "./world/water.js";
import { loadBakedWorld } from "./worlds.js";

/**
 * The mannequin's two swim clips (Universal Animation Library 1, CC0), copied by the bake. They are
 * authored with the root on the waterline, so a swimming figure's root rides the water surface.
 */
const SWIM_CLIPS = "mannequin-swim.glb";
/** The player's model, from the game's own asset root (the scaffold ships it). */
const MANNEQUIN = "mannequin.glb";

const world = "forest";
// What the game resolves this world from: its rules, and the look it is graded under.
const spec = biomeSpec(world);
const look = BIOMES[world];

/**
 * The forest: terrain, streamed ground, sky, water, props, the player and its follow camera, and the
 * fixed benchmark views (`V`). Register it as a scene and spread {@link FOREST_GAME} into `defineGame`.
 */
export class ForestScene extends Scene<TerrainState, IPhysicsContext> {
  static override readonly initialState = initialState;
  #data: IBakedWorld | undefined;
  #biome: IWorldBiome | undefined;
  #erosionSamples = { flow: 0, deposition: 0 };
  #scatter: Scatter | undefined;
  #terrain: ReturnType<typeof createTerrain> | undefined;
  #fallbackParts: Variants | undefined;
  /** Bumped when a scene is left, so a band build still slicing stops instead of joining the next scene. */
  #bandLoad = 0;
  /** PRD-790: the streamed ground past the square. */
  #stream: { split: ITerrainStream; material: Promise<MeshStandardNodeMaterial> } | undefined;
  #mannequin: IMannequin | undefined;
  #swimClips: readonly AnimationClip[] = [];
  #rig: IPlayerRig | undefined;
  #meadow: IMeadow | undefined;
  #assets: ReturnType<typeof forestAssets> | undefined;
  override async load(ctx: TerrainCtx): Promise<void> {
    const assets = forestAssets(ctx.assets);
    this.#assets = assets;
    const [baked, mannequin, swim] = await Promise.all([
      loadBakedWorld(assets),
      ctx.assets.model<IMannequin>(MANNEQUIN),
      assets.model<IMannequin>(SWIM_CLIPS),
    ]);
    this.#data = baked;
    this.#mannequin = mannequin;
    this.#swimClips = swim.animations;
    this.#biome = measureBiome(look, this.#data.heights);
    const horizon = loadHorizonSurroundings(assets);
    const [packageData, canopy, sky] = await Promise.all([
      loadPropPackage(assets, world),
      loadCanopy(assets, world),
      loadSky(assets, world),
    ]);
    this.#scatter = { package: packageData, canopy, counts: propCounts(packageData) };
    await horizon;
    // Prepare scenery while the scene loads; enter only attaches it.
    // PRD-790: the ground streams past the playable square.
    let tileSurface: (material: MeshStandardNodeMaterial) => void = () => undefined;
    const material = new Promise<MeshStandardNodeMaterial>((resolve) => {
      tileSurface = resolve;
    });
    const split: ITerrainStream = {
      centre: uniform(new Vector2()),
      half: uniform(0),
      tiles: (surface) => tileSurface(surface),
    };
    this.#stream = { split, material };
    this.#terrain = createTerrain(this.#data, assets, this.#biome, sky, split);
    this.#sky = createOutdoorSky(ctx.camera, this.#biome, ctx.renderer);
    // The sky's LUT dispatch builds its compute nodes: 13-16 ms, paid here behind the curtain so
    // `enter`'s own `ctx.add` finds the renderer already attached (PRD-585, `enterMs` <= 50).
    this.#sky.atmosphere.attachRenderer(ctx.renderer);
    this.#lake = createLakes(this.#data.lakes ?? [], this.#terrain.field);
    // A braided river network is 15-18 ms of geometry: built with the lake, attached in `enter`.
    this.#river = createRivers(
      this.#data.rivers ?? [],
      this.#terrain.field,
      look.riverMirrorsPonds ? this.#lake?.reflectionAt : undefined,
    );
    this.#erosionSamples = {
      flow: this.#data.erosion?.flow.filter((value) => value > 0).length ?? 0,
      deposition: this.#data.erosion?.deposition.filter((value) => value > 0).length ?? 0,
    };
    this.#fallbackParts = buildPropVariants(undefined, look.saplingHeight ?? undefined);
  }
  #elapsed = 0;
  #sky: IOutdoorSky | undefined;
  #river: IRiverWater | undefined;
  #lake: IRiverWater | undefined;

  override exit(ctx: TerrainCtx): void {
    leaveScene();
    ctx.state.set({ currentViewWindows: 0 });
    this.#bandLoad++;
  }

  override enter(ctx: TerrainCtx): void {
    const enterStart = performance.now();
    const assets = this.#assets;
    if (!assets) throw new Error(`World ${world} was not loaded`);
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
    let meadow: IMeadow | undefined;
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
        meadow?.props?.worlds.reduce((sum, stream) => sum + stream.stats().impostor.pending, 0) ??
        0,
      released: () => released,
      afterPhysics: (callback) => ctx.afterPhysics(callback),
      revealed: () => ctx.state.set({ revealComplete: true }),
    });
    // One scene-local spawn gate: a single deadline, settled once by the world readiness join, a
    // failure or teardown. `src/spawnGate.ts` owns it and reports the one line a failed spawn leaves.
    const gate = createSpawnGate(ctx, {
      world,
      progress: () => (meadow?.progress() ?? 0) + ctx.state.getState().spawnCellsLoaded,
      witness: () => meadow?.witness,
      released: () => released,
    });
    gate.hold();
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
        whenReady: () => Promise.all([ctx.startup.whenReady(), gate.promise]).then(() => undefined),
      },
    });
    ctx.afterPhysics(() => loading.update());
    const biome = this.#biome;
    if (!biome) throw new Error(`World ${world} elevations were not measured`);
    const terrain = this.#terrain;
    const field = terrain?.field;
    if (!field) throw new Error(`World ${world} terrain was not loaded`);
    const mesh = terrain?.mesh;
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
        shape: CollisionShape3D.heightfield(field.rows, field.columns, field.toColliderHeights(), {
          x: data.size,
          y: 1,
          z: data.size,
        }),
      });
      // The surveyed hills past the square are ground too, out to the walk band: their collider is
      // the drawn triangles, so feet meet what the eye sees. Four fixed walls 2 m inside the band's
      // outer edge are the level's blocking volumes; past them is only scenery.
      const band = collar.walk;
      const bandBodies: RigidBody3D[] = [];
      // That band is 188 416 triangles, and the player spawns at least 256 m inside it, so no foot
      // touches it in the frames it is missing: it is not built in `enter`. One fixed body per ring
      // slice is built on this scene's own first frames instead, with the loading curtain held up
      // until the last one exists. From a frame and not from `load()`: `deterministicRestart`
      // replaces the simulation at the outgoing scene's exit, so a body built before that would be
      // a body in a world that no longer exists.
      const bandLoad = this.#bandLoad;
      let bandStarted = false;
      ctx.afterPhysics(() => {
        if (bandStarted) return;
        bandStarted = true;
        const work = addInSlices(
          walkBandSlices(band, collar.perimeter),
          (slice) =>
            bandBodies.push(
              new RigidBody3D({
                physics: ctx.physics,
                type: "fixed",
                entity: "terrain",
                collisionLayer: 4 | 8,
                position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
                shape: CollisionShape3D.trimesh(slice.vertices, slice.indices),
              }),
            ),
          // One slice a frame, and not one slice more once this scene is left: a body must never
          // land in the simulation that replaced this one.
          { sliceSize: 1, while: () => bandLoad === this.#bandLoad },
        );
        if (ctx.startup.phase !== "ready") ctx.startup.hold("strata-collar", work);
        void work.catch((error) => {
          if (!released) gate.fail(error);
        });
      });
      // Streamed ground reaches the collar's rim; without it the walk band is the level.
      const edge = data.size / 2 + (this.#stream ? HORIZON_REACH - 40 : band.extent);
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
          for (const body of bandBodies.splice(0)) body.dispose();
          ground.dispose();
          mesh.geometry.dispose();
          (mesh.material as MeshStandardMaterial).dispose();
        },
      });
    }
    // One rig owns the whole of the sky, the sun, the shadows that follow the eye, the haze the
    // far ridges fade into and the tone curve. It used to be a flat `Color` background, a
    // hand-set `FogExp2`, a sun with a five metre shadow box that missed everything, and no tone
    // mapping at all; the numbers behind all of that now live in `src/render/sky/sky.ts`.
    ctx.add(sky.daylight);
    ctx.add(sky.atmosphere);
    ctx.add(sky.sun);
    this.#sky = sky;
    ctx.entities.add("sun", {
      object: sky.sun,
      debug: () => ({ x: sky.sunX }),
      dispose: installOutdoorOcclusion(ctx, biome),
    });

    const mannequin = this.#mannequin;
    if (!mannequin) throw new Error(`World ${world} mannequin was not loaded`);
    // The capsule, the mannequin that rides it and the follow camera live in `src/playerRig.ts`:
    // this scene wires them and hands the model and the swim clips over.
    const rig = createPlayerRig(ctx, {
      at: spec.spawn.at,
      cameraOffset: spec.spawn.cameraOffset,
      field,
      focusShadows: (at) => this.#sky?.focusShadows(at),
      horizon: () =>
        mesh
          ? {
              seamGap: mesh.userData.horizonSeamGap,
              samples: mesh.userData.horizonSeamSamples,
            }
          : { observed: false },
      mannequin,
      staged: false,
      swimClips: this.#swimClips,
      vista: look.vistaAim !== null,
      world,
    });
    this.#rig = rig;
    const player = rig.body;
    const actor = rig.actor;
    const stream = this.#stream;
    // ponytail: a ground material that never loads leaves this pending, and the spawn deadline
    // then fails the scene by name.
    let groundReady: Promise<void> | undefined;
    if (stream && mesh && collar) {
      const streamLoad = this.#bandLoad;
      groundReady = stream.material.then((surface) => {
        if (streamLoad !== this.#bandLoad) return surface.dispose();
        const ground = addStreamedGround(
          ctx,
          data,
          world,
          surface,
          collar,
          stream.split,
          actor,
          (facts) => ctx.state.set(facts),
        );
        ctx.entities.add("streamed-ground", { tiles: ground.tiles, dispose: ground.dispose });
        return ground.ready;
      });
    }

    const fixture = new Heightfield({
      rows: 17,
      columns: 17,
      width: 16,
      depth: 16,
      origin: { x: 0, z: 0 },
      heights: Float32Array.from(
        { length: 17 * 17 },
        (_, i) => ((i % 17) * 13 + Math.floor(i / 17) * 7 + (i % 17) * Math.floor(i / 17) * 3) % 11,
      ),
    });
    const probeMesh = new Mesh(fixture.toGeometry(), new MeshStandardMaterial({ color: 0xd3a168 }));
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

    // The water in the channels the bake carved. A world with no river gets nothing. Water draws on
    // its own layer so the lake's mirror can leave it out; the eye sees both.
    ctx.camera.layers.enable(WATER_LAYER);
    const lake = this.#lake;
    if (lake) {
      // The lake's mirror renders only when the lake draws, and each surface it reflects builds
      // its pipeline on that first mirror draw. So the lake draws unculled for two world draws
      // behind the curtain and the spawn join waits for them (PRD-790). Re-culled before the
      // holds release: the held startup compile copies the screen in the canvas format, which the
      // lake's refraction refuses.
      const warmed = warmUnculled(ctx, lake.mesh);
      groundReady =
        groundReady === undefined
          ? warmed
          : Promise.all([groundReady, warmed]).then(() => undefined);
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
    // The props build on the first physics step, not here: both ways of asking the world where the
    // ground is need a stepped world. `src/sceneProps.ts` owns that build, the staged kit's arm and
    // the spawn joins it reports.
    const erosionFlowSamples = this.#erosionSamples.flow;
    const erosionDepositSamples = this.#erosionSamples.deposition;
    // Every fixed camera stands in a clearing: a trunk a metre from the lens is a green wall, not a
    // framing, and the seed decides where trees land, so the eyes are kept open by rule.
    const river = this.#river;
    if (river) {
      ctx.state.set({
        riverSurfaceCount: river.mesh.geometry.groups.filter((group) => group.count > 0).length,
      });
      ctx.add(river.mesh);
      ctx.entities.add("river", { mesh: river.mesh, dispose: () => river.dispose() });
    }
    // The player swims in the river and lake drawn above: the same splines, levels and reach.
    {
      const rivers = data.rivers ?? [];
      const lakes = data.lakes ?? [];
      player.water = waterSurfaceAt(rivers, lakes, field, undefined);
      player.waterCurrent = waterCurrentAt(rivers, lakes, field, undefined);
    }
    this.#meadow = meadow = createMeadow({
      assets,
      biome,
      collar,
      ctx,
      data,
      fallbackParts: this.#fallbackParts,
      field,
      gate,
      invalidateShadows: (region) => {
        const shadows = sky.sun.shadow.shadowNode;
        if (shadows instanceof VirtualShadowNode) invalidatePropShadows(shadows, region);
      },
      loading,
      look,
      mesh,
      release: () => {
        released = true;
      },
      released: () => released,
      reveal,
      scatter: this.#scatter,
      spawn: rig.spawn,
      groundReady,
      world,
    });

    let frames = 0;
    let readyTimePending = false;
    beginScene(world);
    const measure = createMeasure({
      world,
      physics: ctx.physics,
      raycast: (options) => ctx.raycast(options),
      actor,
      player,
      size: data.size,
      mesh,
      stage: undefined,
      fixture,
      probeMesh,
      swimmingClip: () => rig.playsSwimClip(),
      hasPropColliders: () => meadow?.colliders !== undefined,
      eye: () => ctx.camera.position,
      camera: () => ctx.camera as PerspectiveCamera,
      ocean: undefined,
      spawnReady: () => gate.ready,
      terrainTargets: () => mesh,
      view: () => ctx.state.getState().view,
    });
    ctx.afterPhysics(() => {
      measure.step();
      // The props are placed here rather than in `enter`: their ground query asks the stepped
      // world where the surface is, and neither the ray tree nor the collider answers before the
      // solver has run once.
      meadow?.colliders?.update();
      const work = meadow?.start();
      if (work !== undefined) {
        if (ctx.startup.phase !== "ready") ctx.startup.hold("strata-props", work);
        void work.catch((error) => {
          if (!released) gate.fail(error);
        });
      }
      frames++;
      // `props.meshes` walks every streamed world; three walks per fixed step were 8.3 s of a
      // 15.6 s main-thread stall in a profiled session (PRD-541). Half a second is fresh enough.
      if (frames % 30 === 1) {
        const meshes = meadow?.props?.meshes ?? [];
        measure.countProps(
          meshes,
          meadow?.props?.worlds.find((stream) => stream.name === "strata-props:far:false"),
        );
      }
      const streaming = meadow?.props?.stats();
      const spawnReadiness = [...(meadow?.joins ?? [])].map(([stream, status], index) => {
        if (gate.ready)
          return { name: stream.name, ...ctx.state.getState().spawnReadiness[index], ...status };
        const stats = stream.stats();
        return {
          name: stream.name,
          observedFrame: frames,
          ...status,
          ...stream.readinessAt(rig.spawn, 60),
          admissionBacklog: stats.admission.backlog,
          impostorPending: stats.impostor.pending,
        };
      });
      const worldReady = gate.ready;
      if (gate.error) ctx.state.set({ loadingError: gate.error });
      if (worldReady && !released && !readyTimePending && ctx.state.getState().timeToReadyMs < 0) {
        readyTimePending = true;
        void ctx.startup.whenReady().then(() => {
          if (!released) ctx.state.set({ timeToReadyMs: Date.now() - launchedAt });
        });
      }
      publish(ctx, {
        world,
        groundBiome: mesh
          ? ((mesh.material as MeshStandardMaterial).userData.biome ?? "baked")
          : "baked",
        elevation: biome.elevationRange,
        snowBand: biome.snowBand,
        worldReady,
        spawnReadiness,
        spawnCells: gate.cells,
        streaming,
        terrainTransportBound:
          (mesh?.material as MeshStandardMaterial | undefined)?.userData.erosion === true &&
          erosionFlowSamples > 1000 &&
          erosionDepositSamples > 100,
        erosion: { flow: erosionFlowSamples, deposition: erosionDepositSamples },
        sunX: sky.sunX,
        frames,
        propColliders: meadow?.colliders?.stats().resident ?? 0,
        ...measure.facts(),
        farForest: meadow?.farForest ?? 0,
        preparedLodBaseSpread: meadow?.preparedLodBaseSpread ?? 0,
        compressedTexturesPrepared: meadow?.compressedTexturesPrepared ?? 0,
        preparedLevelsWithoutSolid: meadow?.preparedLevelsWithoutSolid ?? 0,
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
    const { views } = BENCHMARK[world];
    const poses = posesFor(world, data.size);
    const at = (x: number, z: number, up: number): Vector3 =>
      new Vector3(x, field.heightAt(x, z) + up, z);
    ctx.beforeRender(() => {
      observeFrame(world, ctx);
      const view = ctx.state.getState().view;
      rig.figure.root.visible = view === "player" && !ctx.state.getState().showcase;
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
          : // Never under the drawn ground: a cooked world (`STRATA_WORLD`) has other hills there.
            new Vector3(
              pose.at[0],
              Math.max(
                pose.eyeY,
                (collar?.heightAt(pose.at[0], pose.at[1]) ??
                  field.heightAt(pose.at[0], pose.at[1])) + 1.7,
              ),
              pose.at[1],
            ),
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

  override update(ctx: TerrainCtx, dt: number): void {
    this.#elapsed += dt;
    this.#meadow?.advance(this.#elapsed);
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
    this.#river?.advance(this.#elapsed);
    this.#lake?.advance(this.#elapsed);
    if (playable && ctx.input.justPressed("light"))
      this.#sky?.setSunX(this.#sky.sunX < 0 ? 180 : -180);
    const player = this.#rig?.body;
    if (!player) return;
    const move = playable ? ctx.input.vector("move") : { x: 0, y: 0 };
    // Camera-relative: up on the stick runs along the ground where the camera looks.
    const yaw = this.#rig?.yaw() ?? 0;
    const [forwardX, forwardZ] = [-Math.sin(yaw), -Math.cos(yaw)];
    const pace = this.#rig?.pace(playable && ctx.input.pressed("sprint")) ?? 0;
    player.velocity.x = (forwardX * move.y - forwardZ * move.x) * pace;
    player.velocity.z = (forwardZ * move.y + forwardX * move.x) * pace;
    if (playable && ctx.input.justPressed("jump") && player.grounded) player.velocity.y = 5;
    player.moveAndSlide(dt);
    this.#rig?.animate(dt);
  }
}

/**
 * The game options the forest needs: its input map, a camera that reaches the 5 km sky, and the
 * frame-budget window its diagnostics read. Spread them into `defineGame` with the game's own
 * plugins (`rapier()` at least), then register {@link ForestScene}.
 */
export const FOREST_GAME = {
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
    light: { keys: ["KeyL"] },
  },
  // Windows close every ten presents; the scene reads each into state, which puts the measured
  // draw count and frame cost into a run report.
  frameBudget: { onWindow: observeWindow, reportEvery: 10 },
  renderer: { preferWebGPU: true, resolutionScale: "auto" },
} satisfies Partial<Parameters<typeof defineGame<TerrainState, IPhysicsContext>>[0]>;
