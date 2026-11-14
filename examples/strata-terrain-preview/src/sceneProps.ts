import {
  type Heightfield,
  type HeightfieldCollar,
  type IShadowRegion,
  type WorldCells,
  surfaceSampler,
} from "@threenative/core/world";
import { ScatterColliders } from "@threenative/physics";
import {
  Float32BufferAttribute,
  Mesh,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from "three";
import type { IRevealProbe } from "./diagnostics.js";
import { posesFor } from "./render/benchmark.js";
import type { IBiome, IWorldBiome, WorldName } from "./render/biomes.js";
import { HORIZON_WALK_BAND } from "./render/ground/horizon.js";
import { meadowCover } from "./render/ground/scatter.js";
import { type IBakedWorld, OPEN_MEADOW } from "./render/ground/terrain.js";
import {
  FAR_FOREST,
  FAR_FOREST_WORLDS,
  collarSampler,
  farForestPlacements,
} from "./render/props/farForest.js";
import { loadPack, loadSkyLight } from "./render/props/pack.js";
import { loadPreparedProps } from "./render/props/prepared.js";
import { createPropSurfaces } from "./render/props/propMaterials.js";
import type { IPropPreparationProgress } from "./render/props/propProgress.js";
import type { IScatter } from "./render/props/propWorld.js";
import { invalidatePropShadows, streamProps } from "./render/props/propWorld.js";
import {
  type PropGroundQuery,
  buildPropVariants,
  flatPropMaterials,
  variantFor,
} from "./render/props/props.js";
import { SHADOW_REACH } from "./render/sky/sky.js";
import { preparePropTextures } from "./render/texturePreparation.js";
import type { TerrainCtx } from "./sceneState.js";
import type { ISpawnGate, ISpawnWitness } from "./spawnGate.js";
import type { ForestStageWorld } from "./world/forestStage.js";

/** The whole set of placements one world scatters, with the canopy weight painted from them. */
export type Scatter = IScatter;
/** The built prop variants, keyed by `asset:variant`. */
export type Variants = ReturnType<typeof buildPropVariants>;
/** The streamed worlds the meadow builds, once they have landed. */
type StreamedProps = Awaited<ReturnType<typeof streamProps>>;
/** One streamed world's spawn join: data and draws, reported separately. */
export type IPropJoins = Map<WorldCells, { data: string; prewarm: string }>;

export interface IMeadowOptions {
  readonly ctx: TerrainCtx;
  readonly world: WorldName;
  readonly data: IBakedWorld;
  /** The biome row's look values: what the props are, and how they sit on the ground. */
  readonly look: IBiome;
  /** The measured elevations of the world this meadow draws. */
  readonly biome: IWorldBiome;
  readonly field: Heightfield;
  /** The drawn terrain mesh: absent when the run streams a staged forest kit instead. */
  readonly mesh: Mesh | undefined;
  readonly collar: HeightfieldCollar | undefined;
  /** The staged forest kit world, when `?stage=before|after` replaced this world's own ground. */
  readonly stage: ForestStageWorld | undefined;
  readonly scatter: Scatter | undefined;
  readonly fallbackParts: Variants | undefined;
  /** Where the player starts in this world: the point every stream measures its spawn cells around. */
  readonly spawn: Vector3;
  /** PRD-790: the streamed ground's first tiles, drawn behind the curtain; absent without `?stream=1`. */
  readonly groundReady?: Promise<void> | undefined;
  readonly gate: ISpawnGate;
  readonly reveal: IRevealProbe;
  readonly loading: { readonly finish: () => void };
  /** True once the scene tore this world down. */
  readonly released: () => boolean;
  /** Marks the scene released: nothing in this meadow may revive it after that. */
  readonly release: () => void;
  readonly invalidateShadows: (region?: IShadowRegion) => void;
}

export interface IMeadow {
  /** Starts the build on the first physics step, once; undefined when there is nothing to build. */
  readonly start: () => Promise<void> | undefined;
  /** The streamed world, once it landed. */
  readonly props: StreamedProps | undefined;
  readonly colliders: ScatterColliders | undefined;
  /** One entry per streamed world's spawn join, for the frame report. */
  readonly joins: IPropJoins;
  readonly farForest: number;
  readonly preparedLodBaseSpread: number;
  readonly compressedTexturesPrepared: number;
  readonly preparedLevelsWithoutSolid: number;
  /** Where preparation stands, for the spawn failure report. */
  readonly witness: ISpawnWitness;
  /** Completed preparation work, so the loading screen cannot claim progress a stall did not make. */
  readonly progress: () => number;
  /** Advances the prop surface shaders by the scene's own clock. */
  readonly advance: (elapsed: number) => void;
}

/**
 * The meadow: every prop, rock and tree a world draws, and the water the bake carved into it.
 *
 * The build waits for the first physics step rather than `enter`, because both ways of asking the
 * world where the ground is need a world that has been stepped: the ray query walks the heightfield's
 * own triangles and the collider is not in the space until the solver runs. Asking in `enter`
 * returns "no ground here" for every prop on a perfectly solid hillside.
 */
export function createMeadow(options: IMeadowOptions): IMeadow {
  const {
    biome,
    collar,
    ctx,
    data,
    fallbackParts,
    field,
    gate,
    groundReady,
    invalidateShadows,
    loading,
    look,
    mesh,
    release,
    released,
    reveal,
    scatter,
    spawn,
    stage,
    world,
  } = options;
  // The gate's deadline, joins and its two settlements, under the names this build has always used.
  const { deadlineAt, fail: failSpawn, land, settle } = gate;
  const textureUploads = new AbortController();
  let propsStage = "waiting-for-physics";
  let preparation: IPropPreparationProgress | undefined;
  let buildStartedAt: number | undefined;
  let phaseStartedAt: number | undefined;
  let lastProgressAt: number | undefined;
  let completedPropsWork = 0;
  let props: StreamedProps | undefined;
  let propColliders: ScatterColliders | undefined;
  let building = false;
  let preparedDispose: (() => void) | undefined;
  let surfacesDispose: (() => void) | undefined;
  let surfaces: { advance: (elapsed: number) => void } | undefined;
  let buildProps: (() => Promise<void>) | undefined;
  // What the prepared files measured on load. Published rather than thrown on, because a number in
  // the run report says which level is off the ground and a stack trace does not.
  let preparedLodBaseSpread = 0;
  let compressedTexturesPrepared = 0;
  let preparedLevelsWithoutSolid = 0;
  let farForestCount = 0;
  /** One status record per streamed world's spawn join, for the frame report. */
  const spawnJoins: IPropJoins = new Map();

  if (stage) {
    ctx.entities.add("forest-stage", {
      object: stage.world,
      dispose: () => {
        release();
        settle(new Error("Strata spawn cancelled"));
        loading.finish();
      },
    });
    ctx.canvasLayer.keepWorldRendering = true;
    propsStage = "attached";
    gate.watch((remaining) =>
      Promise.all([stage.world.whenSpawnReady(spawn, 60, remaining), stage.world.prewarmed]).then(
        ([region]) => region,
      ),
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
        release();
        textureUploads.abort(new Error("Strata scene released during texture preparation."));
        settle(new Error("Strata spawn cancelled"));
        loading.finish();
        surfacesDispose?.();
        flat.dispose();
        preparedDispose?.();
        props?.dispose();
        propColliders?.dispose();
        for (const parts of propParts.values()) for (const part of parts) part.geometry.dispose();
      },
    });
    // Ground contact is a ray query against the drawn terrain and the terrain's collider, never the
    // bilinear sampler: a spruce floating a centimetre above the visible surface reads as a mistake
    // at exactly the distance a player spends most of their time at.
    mesh.updateMatrixWorld(true);
    mesh.geometry.computeBoundingBox();
    const top = mesh.geometry.boundingBox?.max.y ?? 0;
    // The surroundings rise above the square's top, so their collider ray starts above both.
    const ridges = mesh.getObjectByName("temperate-distant-ridges");
    if (ridges instanceof Mesh) ridges.geometry.computeBoundingBox();
    const rayTop =
      Math.max(top, ridges instanceof Mesh ? (ridges.geometry.boundingBox?.max.y ?? top) : top) + 2;
    const groundSample = surfaceSampler(field, mesh.matrixWorld);
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
    // The prepared art is asked for here rather than in `enter`, and the variants it fills are not
    // built again: a game with the licensed Landscape Pro models has the pack's own pines, shrubs and
    // photoscanned stone, a game without them has the procedural spruce, the procedural boulder and
    // the starter's own clumps, and neither waits on the other. Both loaders run together and fail
    // soft per file, so one missing species costs that species and nothing else. One load, because
    // `afterPhysics` runs every frame.
    buildProps = async (): Promise<void> => {
      // The capsule mesh named "player" (the body has no transform), looked up once, else the eye.
      let actor: Object3D | undefined;
      const followed = (): Vector3 => {
        actor ??= ctx.scene.getObjectByName("player");
        return actor?.position ?? ctx.camera.position;
      };
      buildStartedAt = performance.now();
      propsStage = "assets";
      const [prepared, pack, skyLight] = await Promise.all([
        loadPreparedProps(ctx.assets),
        loadPack(
          ctx.assets,
          world,
          data,
          ctx.state.getState().canopyComparison,
          biome,
          scatter.canopy,
        ),
        ctx.assets ? loadSkyLight(ctx.assets) : Promise.resolve(undefined),
      ]);
      preparedDispose = () => {
        prepared.dispose();
        pack.dispose();
      };
      if (released()) {
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
      const built = await createPropSurfaces(ctx.assets, data, biome, skyLight);
      surfaces = built;
      surfacesDispose = built.dispose;
      if (released()) {
        built.dispose();
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
          ...Object.values(built.materials),
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
      if (released()) return;
      propsStage = "streaming";
      // A fixed view standing on the surroundings gets the meadow the bake cannot place there.
      const vista = OPEN_MEADOW ? posesFor(world, data.size).vista : undefined;
      // Spruce across the valley past the square; `?farForest=on` plants them.
      const vistaEye = posesFor(world, data.size).vista?.at;
      const far =
        FAR_FOREST_WORLDS.includes(world) && FAR_FOREST && ridges instanceof Mesh
          ? farForestPlacements({
              size: data.size,
              resolution: data.resolution,
              collar,
              world,
              treeline: biome.heightBands.treeline,
              rivers: data.rivers,
              lakes: data.lakes,
              clear: vistaEye ? [[vistaEye[0], vistaEye[1], 55]] : [],
              seaLevel: data.waterLevel,
            })
          : [];
      farForestCount = far.length;
      props = await streamProps({
        // The bake's containers, and only the view cover the game plants at load: the meadow the
        // camera stands in and the collar past the square, both compiled through the package.
        package: scatter.package,
        placements: [
          ...(vista
            ? meadowCover(
                { x: vista.at[0], z: vista.at[1] },
                { x: vista.look[0], z: vista.look[1] },
                data.size / 2,
                HORIZON_WALK_BAND - 12,
              ).filter(({ position: [x, , z] }) => {
                // A cooked coast's sea covers the ground past the square: no meadow under it.
                if (data.waterLevel === null) return true;
                const ground = groundSample(x, z) ?? collarGround.at(x, z);
                return ground === null || ground > data.waterLevel + 0.35;
              })
            : []),
          ...far,
        ],
        groundAt,
        parts: propParts,
        materials: built.materials,
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
        standShade: look.standShade,
        shadowReach: SHADOW_REACH,
        horizonDistance:
          ctx.camera instanceof PerspectiveCamera || ctx.camera instanceof OrthographicCamera
            ? ctx.camera.far
            : 5000,
        whileCurrent: () => !released(),
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
        invalidateShadows: (region) => invalidateShadows(region),
      });
      if (!props) return;
      const streamed = props;
      if (released()) {
        streamed.dispose();
        return;
      }
      // ctx.add registers render-cadence processing. Never manually update these worlds.
      for (const stream of streamed.worlds) ctx.add(stream);
      // Rocks and trunks are solid: the stone or bark part each placement is grounded by, with a body
      // near the player. Leaves, needles, grass and flowers have no such part and stay open.
      // Layer 16 holds prop bodies alone, for the overlap measure. `?propCollision=off` is the named
      // override: the bodies leave the player's layer 4 (the before arm of collide.playtest.json).
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
        instances: [...streamed.byId.values()].flatMap(({ placement, pose }) => {
          const solid = propParts
            .get(`${placement.asset}:${variantFor(placement, placement.asset)}`)
            ?.find((part) => part.role === "bark" || part.role === "stone");
          return solid ? [{ geometry: solid.geometry, matrix: pose }] : [];
        }),
      });
      // Prewarm borrows actual world draws only after registration. Grounding and package preparation
      // have no attached stream to prewarm and keep the opaque curtain's draw gate.
      ctx.canvasLayer.keepWorldRendering = true;
      propsStage = "attached";
      // Armed once, after the streams attach: the fixed spawn data join plus each draw join, bounded
      // by the deadline taken at scene entry. `WorldCells.whenSpawnReady` owns the data authority and
      // each streamed world's `prewarmed` owns the draw.
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) {
        failSpawn("Strata spawn admission exceeded 120000 ms");
      } else {
        const joins = streamed.worlds.map((stream) => {
          const status = { data: "pending", prewarm: "pending" };
          spawnJoins.set(stream, status);
          const ready = stream.whenSpawnReady(spawn, 60, remaining);
          // Observe settlement without replacing the promises the spawn join awaits.
          void ready.then(
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
          return { ready, stream };
        });
        // Every streamed world joins its draw gate: the engine settles it for a world that holds no
        // cell here and so has nothing to prewarm, which is the meadow a fixed view plants streams
        // in when the view reaches it.
        void Promise.all([
          Promise.all(joins.map((join) => join.ready)),
          ...joins.map((join) => join.stream.prewarmed),
          groundReady,
        ]).then(
          ([regions]) => {
            land({
              loadedCells: regions.reduce((sum, region) => sum + region.loadedCells, 0),
              requiredCells: regions.reduce((sum, region) => sum + region.requiredCells, 0),
            });
          },
          (reason) => failSpawn(reason),
        );
      }

      // A pinned-crag look's mountains are the crags: their base ring is what it measures.
      const alpineCrags = look.pinnedCrags
        ? [...streamed.byId.values()].filter((instance) => instance.placement.asset === "mountain")
        : [];
      ctx.entities.add("props", {
        object: streamed.worlds[0],
        debug: () => ({
          reveal: reveal.readout(),
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
  }

  return {
    /** The build starts once, from the first physics step, and returns its own work. */
    start: (): Promise<void> | undefined => {
      if (buildProps === undefined || props !== undefined || building) return undefined;
      building = true;
      return buildProps();
    },
    advance: (elapsed: number): void => {
      surfaces?.advance(elapsed);
    },
    progress: () =>
      completedPropsWork +
      (preparation?.prewarmedWorlds ?? 0) +
      (props?.worlds.reduce((sum, stream) => {
        const stats = stream.stats();
        return sum + stats.admissionCompletedUnits + stats.prewarmMinted;
      }, 0) ?? 0),
    get colliders(): ScatterColliders | undefined {
      return propColliders;
    },
    get compressedTexturesPrepared(): number {
      return compressedTexturesPrepared;
    },
    get farForest(): number {
      return farForestCount;
    },
    joins: spawnJoins,
    get preparedLevelsWithoutSolid(): number {
      return preparedLevelsWithoutSolid;
    },
    get preparedLodBaseSpread(): number {
      return preparedLodBaseSpread;
    },
    get props(): StreamedProps | undefined {
      return props;
    },
    get witness(): ISpawnWitness {
      return {
        added: preparation?.added ?? null,
        bucket: preparation?.bucket ?? null,
        buildStartedAt,
        lastProgressAt,
        phase: preparation?.phase,
        phaseStartedAt,
        stage: propsStage,
        total: preparation?.total ?? null,
      };
    },
  };
}
