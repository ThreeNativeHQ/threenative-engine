import {
  type ICtx,
  type ITracerSpawnOptions,
  Scene,
  type SceneFrame,
  TracerPool3D,
  getPlatform,
  isMobile,
} from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import type { AnimationClip, Group, Object3D, PerspectiveCamera, Quaternion, Texture } from "three";
import {
  AdditiveBlending,
  CylinderGeometry,
  MathUtils,
  MeshBasicMaterial,
  Mesh as MeshClass,
  PlaneGeometry,
  PointLight as PointLightClass,
  Vector3,
} from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { BreakableField } from "../entities/Breakables.js";
import { Enemy } from "../entities/Enemy.js";
import { FpsPlayer } from "../entities/FpsPlayer.js";
import { MAGAZINE, RESERVE, Rifle } from "../entities/Rifle.js";
import { Target } from "../entities/Target.js";
import { TouchControls } from "../entities/TouchControls.js";
import { onAfterPhysics } from "../postPhysics.js";
import { DecalField, bulletHoleTexture } from "../render/decals.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { ImpactBursts, MuzzleFlash, MuzzleFlashPool, softCircleTexture } from "../render/gunfx.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { BoxOccluders } from "../render/occlusion.js";
import { PooledBillboards } from "../render/pooled-billboards.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { scale } from "../render/scale.js";
import { setupSky } from "../render/sky.js";
import { TOWN_HALF, type Town, buildTown } from "../render/town.js";
import { createTownMaterials } from "../render/townMaterials.js";
import { type GameState, TARGET_GOAL } from "../state.js";
import { resolveSurface } from "../surfaces.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/** The reference HUD reads 1:45 on the round clock. */
const RUN_SECONDS = 105;
const RANGE_METRES = 70;
const ROUND_DAMAGE = 10;

/**
 * Where the breakable vessels stand. Placed against walls and in doorways rather than out in the
 * open: a pot in the middle of a lane is an obstacle, and a pot beside a doorway is a place
 * someone lives. Every one of these is on the ground deck, clear of the patrol routes.
 */
const BREAKABLE_SPOTS: readonly {
  kind: "pot" | "jar" | "bottle";
  x: number;
  z: number;
  yaw: number;
}[] = [
  { kind: "pot", x: -8.4, z: 18.6, yaw: 0.3 },
  { kind: "jar", x: -7.2, z: 18.2, yaw: 1.1 },
  { kind: "pot", x: 11.5, z: 12.4, yaw: -0.6 },
  { kind: "bottle", x: 12.3, z: 12.1, yaw: 0 },
  { kind: "jar", x: 4.2, z: -6.5, yaw: 2.2 },
  { kind: "pot", x: -14.8, z: -3.2, yaw: 0.9 },
  { kind: "bottle", x: -15.6, z: -3.6, yaw: 0 },
  { kind: "jar", x: 17.4, z: -14.2, yaw: -1.4 },
  { kind: "pot", x: -3.6, z: 27.4, yaw: 1.8 },
  { kind: "bottle", x: 8.1, z: 24.6, yaw: 0 },
];

type LoadedModel = { scene: Group; animations: AnimationClip[] };

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    aiming: false,
    ammo: MAGAZINE,
    blips: [],
    distanceMoved: 0,
    health: 100,
    hitFlash: 0,
    hurtFlash: 0,
    phase: "playing",
    playerX: 0,
    playerYaw: 0,
    playerZ: 32,
    reloads: 0,
    reserve: RESERVE,
    score: 0,
    shots: 0,
    targetsHit: 0,
    timeRemaining: RUN_SECONDS,
  };

  #assets:
    | {
        enemy: LoadedModel;
        viewmodel: LoadedModel;
        sky: Texture;
      }
    | undefined;

  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // Three files, and one of them is the whole town: the geometry is procedural
    // (`render/town.ts`), so the only downloads are two rigs and one photograph.
    //
    //  - `mannequin-combat.glb` is Quaternius' UAL mannequin (CC0), the soldiers.
    //  - `player-viewmodel.glb` is "Animated FPS hands (rifle animation pack)" by
    //    Cransh, CC-BY-4.0 — https://sketchfab.com/3d-models/animated-fps-hands-rifle-animation-pack-5f2d0ed780a94724b36ab505f7564057
    //  - `sky.jpg` is Poly Haven's "Kloofendal 48d Partly Cloudy (Pure Sky)" by
    //    Greg Zaal and Jarod Guest, CC0 (https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky),
    //    and is background, environment light and fog colour at once (`render/sky.ts`).
    // No per-asset progress is published to the HUD: `src/render/loading.ts` is the one boot
    // surface, it rides `ctx.startup`, and a second bar drawn over it was the two-bar screen.
    const [enemy, viewmodel, sky] = await Promise.all([
      ctx.assets.model<LoadedModel>("mannequin-combat.glb"),
      ctx.assets.model<LoadedModel>("player-viewmodel.glb"),
      ctx.assets.texture("sky.jpg"),
    ]);
    this.#assets = { enemy, viewmodel, sky };
    setupSky(ctx.scene, this.#assets.sky);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;

    // The hook closes over this scene's player. Leaving it registered means a restart keeps
    // syncing the camera to the torn-down body until `enter` happens to overwrite it.
    onAfterPhysics(undefined);
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const assets = this.#assets;
    if (assets === undefined) throw new Error("Town assets did not load.");

    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, assets.sky);
    // The shadow map is fitted to the town, not to the arena this template's lighting was
    // written for, and both this call and the post chain below are told whether this is a phone
    // — a 2048² map and the `low` tier instead of a 4096² map plus full-resolution GTAO over 832
    // renderables, which is not a phone's frame. `isMobile` is passed in rather than imported
    // because `src/render/` reads no framework package.
    const mobile = isMobile();
    const { key } = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      TOWN_HALF,
      mobile,
    );
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    let materialTier: QualityTier = "low";
    this.#post = setupPost(ctx.renderer, ctx.scene, camera, {
      onTierChanged: (tier) => {
        materialTier = tier;
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment));
      },
      godraysLight: key,
      mobile,
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    ctx.add(camera);

    // The in-canvas launch screen. It rides `startup.whenReady()` and prewarms the pipelines
    // without waiting for them: holding the screen for a town-wide compile would run a whole
    // playtest behind a progress bar.
    const loading = createLoadingScreen(ctx);
    const materials = createTownMaterials();
    const town: Town = buildTown(materials);
    ctx.add(town.group);
    // Plates are raycast targets like any solid: without them in the list a round flies
    // straight through and scores whatever soldier happens to stand behind the plate.
    const plateMeshes: Object3D[] = [];
    town.targets.forEach((spec, index) => {
      const entity = `target-${index}`;
      ctx.entities.remove(entity);
      // The spec list is data; the plates themselves are entities so playtests can read them.
      const plate = new Target(
        {
          face: materials.plateFace,
          hit: materials.plateHit,
          frame: materials.plateFrame,
          steel: materials.steel,
        },
        spec,
      );
      // Plates live inside the town group like every other prop, so scene-wide
      // audits that traverse the town find them where they belong.
      town.group.add(plate.group);
      ctx.entities.add(entity, plate);
      plateMeshes.push(plate.plate);
    });

    // One fixed body per solid so the player slides along walls properly. These
    // colliders have no visual, so they take a bare `position` and never allocate a
    // carrier Object3D to hold a transform nothing reads.
    const staticBody = (
      centreX: number,
      centreY: number,
      centreZ: number,
      sx: number,
      sy: number,
      sz: number,
    ): void => {
      new RigidBody3D({
        physics: ctx.physics,
        position: { x: centreX, y: centreY, z: centreZ },
        shape: CollisionShape3D.box(sx, sy, sz),
        type: "fixed",
      });
    };
    for (const box of town.colliders) {
      staticBody(
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2,
        box.max[0] - box.min[0],
        box.max[1] - box.min[1],
        box.max[2] - box.min[2],
      );
    }
    staticBody(0, -0.5, 0, TOWN_HALF * 2 + 4, 1, TOWN_HALF * 2 + 4);

    const playerSetup = ctx.entities.get<{
      readonly isObject3D?: boolean;
      readonly position: Vector3;
      readonly quaternion?: Quaternion;
    }>("player");
    ctx.entities.remove("player");
    const player = new FpsPlayer(ctx, camera);
    if (playerSetup?.isObject3D === true && playerSetup.position.lengthSq() > 1e-6) {
      player.mesh.position.copy(playerSetup.position);
      player.body.teleport(player.mesh.position);
      // A scenario can aim the spawn through the placeholder's rotation. Only the
      // look angles are taken (the body stays upright): forward's height is the
      // pitch, its heading the yaw — identity falls out as the constructor defaults.
      if (playerSetup.quaternion !== undefined) {
        const forward = new Vector3(0, 0, -1).applyQuaternion(playerSetup.quaternion);
        player.look.pitch = Math.asin(MathUtils.clamp(forward.y, -1, 1));
        player.look.yaw = Math.atan2(-forward.x, -forward.z);
      }
      player.syncCamera();
    }
    ctx.entities.add("player", player);
    // The camera is placed here, after rapier has written the solved transform, rather than at the
    // end of `player.update` where `mesh.position` is still last step's. See `onAfterPhysics`.
    // Split the physics step out of `outsideGame`.
    //
    onAfterPhysics(() => {
      player.syncCamera();
    });
    // Thumb controls. Registered so a scenario can assert a finger actually drove the player,
    // and read every tick below before the player consumes its input.
    // Two seconds in, every pooled pipeline has been through a real draw, so the unused slots can
    // stop being submitted. Worth ~a third of the draw calls on a phone.
    ctx.after(2, () => {
      decals.settle();
      smoke.settle();
      impacts.settle();
      rifle.settlePools();
      breakables.settle();
      enemyFlashes.settle();
      playerTracers.settle();
      enemyTracers.settle();
    });

    const touch = new TouchControls();
    ctx.entities.remove("touch");
    ctx.entities.add("touch", touch);
    const rifle = new Rifle(
      camera,
      assets.viewmodel.scene as Object3D,
      assets.viewmodel.animations,
      ctx.scene,
    );
    ctx.entities.add("rifle", rifle);

    // Five soldiers patrol the ground lanes, one per route — a full T side holding
    // the town. The model asset is shared; each Enemy normalises its own copy out of
    // the cached scene only once, so later soldiers clone the prepared rig.
    const enemySetup = ctx.entities.get<{
      readonly isObject3D?: boolean;
      readonly position: Vector3;
    }>("enemy");
    ctx.entities.remove("enemy");
    // A scenario that shoots a soldier needs one who does not patrol. Placing the
    // optional "enemy-frozen" placeholder turns soldier 0 into a sentry standing at
    // that spot for the whole round: presence is the flag, position is the spawn
    // (facing +z, toward a player placed north of him). It takes precedence over the
    // plain "enemy" placement when both are present. The placeholder parks off-map
    // until placed (see game.ts), so an origin spawn is still a real placement.
    const frozenSetup = ctx.entities.get<{
      readonly isObject3D?: boolean;
      readonly position: Vector3;
    }>("enemy-frozen");
    ctx.entities.remove("enemy-frozen");
    const frozenSpawn =
      frozenSetup?.isObject3D === true && frozenSetup.position.y > -100
        ? frozenSetup.position.clone()
        : undefined;
    const navBounds = { min: -TOWN_HALF - 1, max: TOWN_HALF + 1 };
    const enemies: Enemy[] = [];
    for (let index = 0; index < town.enemyRoutes.length; index += 1) {
      // Every soldier needs its own rig: the class mutates scale and pose, and the rifle is
      // welded to its right hand, so a shared skeleton would be scaled twice.
      const soldier = new Enemy(
        ctx,
        cloneSkeleton(assets.enemy.scene),
        assets.enemy.animations,
        town.colliders,
        index === 0 && frozenSpawn !== undefined
          ? {
              route: [frozenSpawn],
              navBounds,
              decks: town.decks,
              frozen: true,
            }
          : {
              route: town.enemyRoutes[index],
              navBounds,
              decks: town.decks,
            },
      );
      if (index === 0 && frozenSpawn !== undefined) {
        soldier.group.position.copy(frozenSpawn);
        soldier.group.updateWorldMatrix(true, true);
      } else if (
        index === 0 &&
        enemySetup?.isObject3D === true &&
        enemySetup.position.lengthSq() > 1e-6
      ) {
        soldier.group.position.copy(enemySetup.position);
        soldier.group.updateWorldMatrix(true, true);
      }
      ctx.add(soldier.group);
      ctx.entities.add(index === 0 ? "enemy" : `enemy-${index}`, soldier);
      enemies.push(soldier);
    }

    // Vessels standing about the town that come apart when they are shot. They are the one thing
    // in the world that answers a round with more than a mark, which is what stops the town
    // reading as a shooting gallery with scenery painted on it.
    const breakables = new BreakableField(ctx.scene, ctx.physics, () => ctx.random());
    for (const spot of BREAKABLE_SPOTS) {
      breakables.add(spot.kind, { x: spot.x, y: 0, z: spot.z }, spot.yaw);
    }
    ctx.entities.remove("breakables");
    ctx.entities.add("breakables", breakables);

    // Hitscan picks against an explicit list: the town solids, the plates and the
    // soldier proxies. Raycasting the whole scene would also hit the viewmodel welded
    // to the camera and score every shot as a miss at 0.4 m.
    const hittable: Object3D[] = [
      ...town.hittable,
      ...plateMeshes,
      ...breakables.hittable(),
      ...enemies.map((e) => e.hitbox),
    ];
    // Sight lines treat a standing plate like the old range did: thin dressing the
    // LOS check skips by its userData, but a solid that can still stop a round.
    // Sight lines are answered in two stages, cheap first.
    //
    // The raycast on its own cost 15.4 ms of a 16.3 ms frame across five soldiers — the whole
    // mid-round hitch, in one call. Replacing it outright with a box test against the town's
    // colliders was fast but wrong: a collider is a solid slab where the building has a doorway,
    // so soldiers went blind through openings they should see through, and
    // `enemy-reaches-walkway` started failing about half the time.
    //
    // So the box test is a pre-filter, not a replacement. Colliders are conservative — they cover
    // at least as much as the walls they stand for — which means "no box in the way" is a
    // trustworthy *clear*, and that is the common case while a firefight is in the open. Only a
    // box-blocked line needs the exact answer, and that is where the doorways are.
    const boxes = new BoxOccluders(town.colliders);
    ctx.entities.remove("occluders");
    ctx.entities.add("occluders", boxes);
    const occluders: Object3D[] = [...town.hittable, ...plateMeshes];

    const lineOfSight = (from: Vector3, to: Vector3): boolean => {
      if (boxes.clear(from, to)) return true;
      const direction = new Vector3().subVectors(to, from);
      const distance = direction.length();
      if (distance < 0.001) return true;
      for (const hit of ctx.raycastAll({
        direction: direction.multiplyScalar(1 / distance),
        far: distance - 0.2,
        origin: from,
        targets: occluders,
      })) {
        // Plates and paint are thin dressing; only solids block sight.
        if (hit.object.userData.target !== undefined) continue;
        return false;
      }
      return true;
    };

    // Impact bursts: flash, sparks, chips and dust in one pooled system keyed by
    // surface — steel sprays fast bright sparks, stone/plaster throw pale chips
    // under a dust cloud, wood spits brown splinters. One expanding circle read
    // as a decal; a burst is what makes a hit look like material answering.
    const impacts = new ImpactBursts(ctx.scene, () => ctx.random());
    // Bullet holes. They stay put: a mark that fades tells the player their rounds went nowhere.
    // What colour the crushed rim comes out is per material — steel burns bare and cold, plaster
    // and stone go pale, wood darkens. See `decals.ts` for why the pool is shaped this way.
    const decalTexture = bulletHoleTexture();
    const decals = new DecalField(ctx.scene, {
      countPerVariant: 56,
      map: decalTexture,
      size: 0.13,
      tints: {
        plaster: 0xf3ead8,
        stone: 0xd2cbbb,
        steel: 0xb6bcc4,
        wood: 0x8a6a44,
      },
    });
    ctx.entities.remove("decals");
    ctx.entities.remove("decal-texture");
    ctx.entities.add("decals", decals);
    // The field borrows its map. Register the scene-owned texture after its borrowers so
    // registry teardown releases their materials first, then the texture, exactly once.
    ctx.entities.add("decal-texture", decalTexture);
    // `hit.face.normal` is object-local; transform it into world space before any
    // spawn math, or rotated meshes send their bursts into the wall.
    const impactNormal = new Vector3();
    const impactUp = new Vector3(0, 1, 0);
    // Player rounds trail warm white; the enemy's are red so you can tell incoming from
    // outgoing at a glance, which is the whole point of seeing a trajectory at all.
    // Unit-length tapered cylinder along +Y, base at the origin: scaling y stretches it end to
    // end. Tapered — the far end is the glowing slug's head, the near end its thinning tail;
    // a uniform tube read as a chalk line.
    const tracerGeometry = new CylinderGeometry(0.009, 0.002, 1, 6, 1, true);
    tracerGeometry.translate(0, 0.5, 0);
    const tracerMaterial = (colour: number): MeshBasicMaterial =>
      new MeshBasicMaterial({
        blending: AdditiveBlending,
        color: colour,
        depthWrite: false,
        // A tracer is a hot gas trail, not a painted line. At 0.9 the old 1.7 cm cylinder read
        // as chalk drawn across the frame; thin and half-transparent over the additive blend is
        // what makes it a thing that glowed rather than a thing that was drawn.
        opacity: 0.55,
        transparent: true,
      });
    const playerTracers = new TracerPool3D(ctx.scene, {
      count: 12,
      geometry: tracerGeometry,
      material: tracerMaterial(0xffe6b0),
    });
    const enemyTracers = new TracerPool3D(ctx.scene, {
      count: 16,
      geometry: tracerGeometry,
      material: tracerMaterial(0xff6a4d),
    });
    // Per-shot variation, computed here so replays stay seeded: two rounds must never read
    // as one drawn line, and a point-blank round dies faster than a far one. The pool only
    // applies these; the numbers are this game's.
    const tracerShot = (distance: number): ITracerSpawnOptions => ({
      // Long enough to see the round travel, short enough that it is gone before the next one.
      lifetime: MathUtils.clamp(distance / 400, 0.025, 0.13),
      segmentLength: 1.5 + ctx.random() * 0.8,
      widthScale: 0.7 + ctx.random() * 0.5,
    });
    /**
     * Not every round is a tracer. A real belt carries one in four or five, and that is not a
     * detail — it is the whole reason tracers read as individual rounds instead of a continuous
     * beam. Drawing one per shot at 600 rounds a minute paints a solid stripe down the lane.
     *
     * The enemy's are more frequent because they are the player's only warning of where incoming
     * fire is coming from; the player's own are sparse because they already know.
     */
    let playerTracerCursor = 0;
    let enemyTracerCursor = 0;
    const playerTracerDue = (): boolean => playerTracerCursor++ % 4 === 0;
    const enemyTracerDue = (): boolean => enemyTracerCursor++ % 2 === 0;
    // One hoisted rng closure shared by every per-shot spawn: a closure literal at a
    // call site is a fresh allocation on every trigger pull.
    const shotRng = (): number => ctx.random();

    let elapsed = 0;
    let hitFlash = 0;
    // How red the screen is *right now*, because a round is landing. A separate scalar from
    // `hitFlash` (which is the crosshair's scoring marker) and from `health`, because the
    // vignette answers "am I being shot" and not "am I nearly dead": reading it off `health`
    // gave a soldier at 40 with nobody shooting him a permanent red screen, and no feedback at
    // all for the 70 rounds it takes to get there.
    let hurtFlash = 0;
    const eye = new Vector3();

    const fire = (frameCtx: GameCtx, aimRay: { origin: Vector3; direction: Vector3 }): void => {
      if (!rifle.fire()) return;
      eye.copy(aimRay.origin);
      const direction = aimRay.direction.clone().normalize();
      player.recordFiringDirection(direction);
      const hit = frameCtx.raycast({
        direction,
        far: RANGE_METRES,
        origin: eye,
        targets: hittable,
      });
      // Every soldier within earshot reacts, not just the closest one.
      for (const soldier of enemies) soldier.hearShot(eye.clone());
      // The trail is drawn whether or not the round connects — a miss you cannot see is a
      // miss you cannot correct.
      const barrel = rifle.barrelRay();
      const distance = hit === undefined ? RANGE_METRES : hit.point.distanceTo(eye);
      if (playerTracerDue()) {
        playerTracers.spawn(barrel.origin, barrel.direction, distance, tracerShot(distance));
      }
      playerFlash.spawn(barrel.origin, barrel.direction, shotRng);
      if (hit === undefined) return;

      const target = hit.object.userData.target as Target | undefined;
      if (target !== undefined) {
        if (!target.scorable) return;
        const value = target.strike(frameCtx);
        if (value > 0) {
          frameCtx.state.set((state) => ({
            score: state.score + value,
            targetsHit: state.targetsHit + 1,
          }));
          hitFlash = 0.12;
        }
        return;
      }
      const struck = hit.object.userData.enemy as Enemy | undefined;
      if (struck !== undefined) {
        const multiplier =
          hit.point.y >= struck.headZoneMinY ? 4 : hit.point.y < struck.legZoneMaxY ? 0.7 : 1;
        struck.recordHit(multiplier, direction);
        const earned = struck.hurt(frameCtx, ROUND_DAMAGE * multiplier);
        if (earned > 0) {
          frameCtx.state.set((state) => ({
            score: state.score + earned,
            targetsHit: state.targetsHit + 1,
          }));
          hitFlash = 0.12;
        }
        return;
      }
      impactNormal.copy(hit.face?.normal ?? impactUp).transformDirection(hit.object.matrixWorld);
      // A vessel answers a round by coming apart, not by taking a mark. Ask first: the breakable
      // branch consumes the hit, so nothing below stamps a bullet hole into geometry that is no
      // longer there.
      if (breakables.shatter(hit.object, hit.point, direction) !== undefined) {
        impacts.spawn(hit.point, impactNormal, "stone");
        return;
      }
      // One tag, resolved once: the builder stamped `userData.surface` on every
      // solid at construction, so VFX and decals read the same answer here
      // instead of each walking its own name rules.
      const surface = resolveSurface(hit.object);
      impacts.spawn(hit.point, impactNormal, surface);
      // The mark outlives the burst. `impactNormal` is already in world space above; handing a
      // raycast's object-local `face.normal` straight to a decal buries it in the wall.
      decals.place(hit.point, impactNormal, surface, 0.82 + ctx.random() * 0.45);
    };

    // A muzzle flash is three things at once: a bright star-silhouette card, a light
    // that touches the world, and smoke that outlives both. One round glow alone
    // reads as a lamp switching on; the uneven rays are what say "gunshot".
    //
    // One flash per shooter, never one shared between them. The squad used to share a single
    // quad and a single lifetime, so any soldier firing reset it for all of them — under
    // sustained fire from five men the lifetime never reached zero and the flash sat lit at the
    // last muzzle that fired, which is the "flash that never gets destroyed". See
    // `MuzzleFlashPool` for the whole story.
    const smokeSprite = softCircleTexture(64, 0.05);
    const enemyFlashes = new MuzzleFlashPool(ctx.scene, 6, {
      colour: 0xffd79a,
      forwardOffset: 0.22,
      life: 0.05,
      lightColour: 0xffb347,
      lightDistance: 11,
      // Brighter than before but over a shorter life. Peak brightness is what says "explosion at
      // the muzzle"; duration is what makes the same light read as a lamp someone switched on.
      lightIntensity: 44,
      size: scale.muzzleFlash * 1.25,
    });
    // Registered so a scenario can prove a squad's flashes retire. Sustained fire from five
    // soldiers is exactly the case that used to hold the old single shared flash open forever.
    ctx.entities.remove("enemy-flashes");
    ctx.entities.add("enemy-flashes", {
      debug: (): { peakOpacity: number } => ({ peakOpacity: enemyFlashes.peakOpacity() }),
    });

    // The player's own flash is drawn in world space at the measured muzzle tip:
    // the star card reads on camera and the light kicks the wall ahead of the
    // barrel for a frame. Rifle's suppressed cone stays as the tight forward core.
    const playerFlash = new MuzzleFlash(ctx.scene, {
      colour: 0xffd9a0,
      forwardOffset: 0.06,
      life: 0.06,
      lightColour: 0xffb347,
      lightDistance: 14,
      lightIntensity: 40,
      size: 0.34,
    });

    const smokeMaterial = new MeshBasicMaterial({
      color: 0xb9bec6,
      depthWrite: false,
      map: smokeSprite,
      opacity: 0.5,
      transparent: true,
    });
    // Enemy muzzle smoke rides the same pooled-billboard mechanism as the player's.
    // Scratch vectors keep the fire path allocation-free; the three random draws per
    // puff keep their original order so seeded replays stay identical.
    const smoke = new PooledBillboards(ctx.scene, {
      count: 10,
      geometry: new PlaneGeometry(0.4, 0.4),
      materialPrototype: smokeMaterial,
    });
    const smokeAt = new Vector3();
    const smokeDrift = new Vector3();
    const spawnSmoke = (at: Vector3, forward: Vector3, ctxFrame: GameCtx): void => {
      for (let index = 0; index < 2; index += 1) {
        const driftX = (ctxFrame.random() - 0.5) * 0.5;
        const driftY = 0.55 + ctxFrame.random() * 0.35;
        const driftZ = (ctxFrame.random() - 0.5) * 0.5;
        smoke.spawn({
          at: smokeAt.copy(at).addScaledVector(forward, 0.3 + index * 0.16),
          drift: smokeDrift.set(driftX, driftY, driftZ),
          life: 0.75,
          opacity: 0.5,
          scaleFrom: 0.35,
          scaleTo: 1.475,
        });
      }
    };

    const hooks = {
      lineOfSight,
      damagePlayer: (amount: number): void => {
        player.hurt(amount);
        hurtFlash = 1;
      },
      onMuzzleFlash: (at: Vector3, direction: Vector3, distance: number): void => {
        enemyFlashes.spawn(at, direction, shotRng);
        if (enemyTracerDue()) enemyTracers.spawn(at, direction, distance, tracerShot(distance));
        spawnSmoke(at, direction, ctx);
      },
    };

    // What the renderer actually drew last frame, so a scenario can fail on an empty picture.
    //
    // Every gate in this project is blind to how the game looks, and that is not a slogan: a
    // `prewarm(ctx.scene)` call once put every material in the town at zero opacity, and the whole
    // suite stayed green. Decals still "placed", soldiers still pathfound, diagnostics were clean,
    // and the frame budget *improved*, because a level nobody draws is cheap. `survives` checks for
    // a nonblank frame and passed too — the sky and the clouds are not blank.
    //
    // Triangles are the assertion that would have caught it. A game drawing its level submits
    // hundreds of thousands of them; a game drawing only its sky submits a handful.
    const renderInfo = (): {
      drawCalls: number;
      triangles: number;
      invisibleMeshes: number;
    } => {
      // drawCalls/triangles are the totals captured inside the frame callback
      // (top of the returned frame callback below), because `renderer.info`
      // resets at the start of each render — a between-frames read sees zeros.
      // The capture lags one frame, which a settled assertion does not care about.
      const invisibleMeshes = countInvisibleMeshes();
      return {
        drawCalls: lastWorldDraws,
        triangles: lastWorldTriangles,
        invisibleMeshes,
      };
    };
    let lastWorldDraws = 0;
    let lastWorldTriangles = 0;
    const countInvisibleMeshes = (): number => {
      // Meshes the renderer is still drawing that cannot possibly show up: fully transparent.
      //
      // Counting pixels does not catch this. A scene whose materials are all at zero opacity
      // submits *more* triangles than a healthy one, because transparency pushes every mesh off
      // the projection's batched lane, and the resulting sky-only picture is neither blank nor
      // notably brighter than the real one — both a nonblank-ratio and a dark-pixel-ratio
      // assertion passed on it. The invariant that actually holds is simpler: nothing in this
      // game's level is supposed to be invisible, so any solid mesh at zero opacity is a defect.
      let invisibleMeshes = 0;
      ctx.scene.traverse((object) => {
        const mesh = object as { isMesh?: boolean; material?: unknown };
        if (mesh.isMesh !== true || mesh.material === undefined) return;
        const surfaces = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const surface of surfaces) {
          const material = surface as { opacity?: number; visible?: boolean };
          if (material.visible === false) continue;
          if ((material.opacity ?? 1) <= 0) invisibleMeshes += 1;
        }
      });
      return invisibleMeshes;
    };
    ctx.entities.remove("render");
    ctx.entities.add("render", { debug: renderInfo });
    // Collect only after the loaded character and scene receivers are attached.
    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, key, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(materialTier, materialEnvironment),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const sample = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        sample.measurement,
        sample.source,
        sample.intensity,
        sample,
      );
    }

    return (frameCtx, dt) => {
      loading.update();
      // The totals of the frame that just finished, read before this frame's
      // render resets `renderer.info` — the `render` entity serves these to the
      // draw-budget scenario. A between-frames read would see zeros.
      const lastInfo = ctx.renderer.info as
        | { render?: { drawCalls?: number; triangles?: number } }
        | undefined;
      lastWorldDraws = lastInfo?.render?.drawCalls ?? 0;
      lastWorldTriangles = lastInfo?.render?.triangles ?? 0;
      if (frameCtx.input.justPressed("restart")) {
        frameCtx.state.set(Play.initialState);
        frameCtx.state.flush();
        void frameCtx.goto("play");
        return;
      }

      // Every shot effect decays outside the phase gate. An early return with a quad still lit
      // leaves it frozen in the world behind the end screen, which is indistinguishable from an
      // effect that failed to clean itself up.
      enemyFlashes.update(dt, eye);
      impacts.update(dt, eye);
      playerFlash.update(dt, eye);
      breakables.update(dt);
      smoke.update(dt, eye);
      rifle.updateSmoke(dt, eye);
      playerTracers.update(dt);
      enemyTracers.update(dt);

      const state = frameCtx.state.getState();
      if (state.phase !== "playing") {
        // The run is over: hold the frame, keep looking around, wait for Enter.
        //
        // The viewmodel's muzzle cone and its point light still have to retire. `rifle.update` is
        // the pose-and-animation half and belongs to gameplay, but a round fired on the very frame
        // the clock expired would otherwise leave the cone and the light burning on screen for as
        // long as the end card is up.
        rifle.decay(dt);
        player.update(frameCtx, dt, false);
        return;
      }

      elapsed += dt;
      hitFlash = Math.max(0, hitFlash - dt * 2.4);
      // About a third of a second: long enough to be a hit, short enough not to be a state.
      hurtFlash = Math.max(0, hurtFlash - dt * 3);
      const timeRemaining = Math.max(0, RUN_SECONDS - elapsed);

      // Any press on the surface buys the pointer, which is what makes the mouse steer.
      // This is deliberately not folded into the `fire` branch: gating it on the fire action
      // means the view stays stuck until you take a shot, and aiming or simply clicking to
      // start would leave the camera dead. Keyboard shots never reach here, so the playtests
      // never ask for a lock they did not earn.
      const pointer = frameCtx.input.raw.pointer;
      // Never on a touch screen: there is no pointer to lock, the request is refused or prompts,
      // and every thumb press would ask again. Thumb input needs no capture to steer.
      if (pointer.down && !pointer.captured && !touch.engaged) {
        frameCtx.input.captureMouse();
      }

      player.touch = touch.update(frameCtx);
      player.update(frameCtx, dt, !rifle.reloading);
      const moveVector = frameCtx.input.vector("move");
      const aimRay = player.aimRay();
      rifle.converge(aimRay.origin, aimRay.direction);
      rifle.update(dt, player.aiming, Math.min(1, Math.hypot(moveVector.x, moveVector.y)));
      // Held, not tapped. The trigger is polled every frame and `Rifle` decides which of those
      // frames sends a round, so a held button fires at the weapon's cyclic rate instead of asking
      // the player to produce ten clicks a second by hand.
      if (frameCtx.input.pressed("fire") || player.touch?.fire === true) fire(frameCtx, aimRay);
      if (frameCtx.input.justPressed("reload") || player.touch?.reload === true) {
        rifle.reload(frameCtx);
      }

      eye.set(player.eye.x, player.eye.y, player.eye.z);
      for (const soldier of enemies) {
        soldier.update(frameCtx, dt, eye, 0, hooks);
      }

      const hitCount = frameCtx.state.getState().targetsHit;
      let phase: GameState["phase"] = "playing";
      if (hitCount >= TARGET_GOAL) phase = "complete";
      else if (player.health <= 0 || timeRemaining <= 0) phase = "failed";

      frameCtx.state.set({
        aiming: player.aiming,
        ammo: rifle.ammo,
        blips: enemies.map((soldier, index) => ({
          id: index,
          alive: soldier.alive,
          x: soldier.group.position.x,
          z: soldier.group.position.z,
        })),
        distanceMoved: player.distanceMoved,
        health: player.health,
        hitFlash,
        hurtFlash,
        phase,
        playerX: player.mesh.position.x,
        playerYaw: player.look.yaw,
        playerZ: player.mesh.position.z,
        reloads: rifle.reloads,
        reserve: rifle.reserve,
        score: frameCtx.state.getState().score,
        shots: rifle.shots,
        timeRemaining,
      });
      if (phase !== "playing") frameCtx.state.flush();
    };
  }
}
