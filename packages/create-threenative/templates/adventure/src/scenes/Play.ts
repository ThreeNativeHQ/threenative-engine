import {
  GPUParticles3D,
  Scene,
  type SceneFrame,
  afterPhysics,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { type IPhysicsContext, buildStaticColliders } from "@threenative/physics";
import {
  Box3,
  Euler,
  type Group,
  type InstancedMesh,
  MathUtils,
  type PerspectiveCamera,
  Vector3,
} from "three";
import { Block } from "../entities/Block.js";
import { Chest } from "../entities/Chest.js";
import { Door } from "../entities/Door.js";
import { Dummy } from "../entities/Dummy.js";
import { Flicker } from "../entities/Flicker.js";
import {
  ADVENTURE_FEEL,
  FOOT_OFFSET,
  type GameCtx,
  Hero,
  LAYER,
  readHeroInput,
} from "../entities/Hero.js";
import { type ITarget, LockOn } from "../entities/LockOn.js";
import { Mossling } from "../entities/Mossling.js";
import { Switch } from "../entities/Switch.js";
import { Thornback } from "../entities/Thornback.js";
import { Warden } from "../entities/Warden.js";
import { Interactions } from "../interact.js";
import { type IHollow, buildHollow } from "../level/Hollow.js";
import {
  type IVale,
  buildVale,
  isSolid,
  makeRng,
  measureRelief,
  valeHeight,
} from "../level/Vale.js";
import { setupCamera } from "../render/camera.js";
import { BURSTS, EFFECTS } from "../render/effects.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { setupPost } from "../render/postprocessing.js";
import { createCompanion, createHeartVessel } from "../render/props.js";
import { type ISky, createSky, setupSky } from "../render/sky.js";
import { loadSurfaces } from "../render/surface.js";
import { TouchControls } from "../render/touch-controls.js";
import type { Checkpoint, GameState } from "../state.js";

export type { GameCtx };

const DEG = 180 / Math.PI;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    assetLoads: 0,
    blockSteps: 0,
    cameraInGround: 0,
    capacity: ADVENTURE_FEEL.startHalves / 2,
    cleared: false,
    companionFarthest: 0,
    companionNearest: 0,
    heightFog: false,
    hutLanterns: 0,
    motesSpawned: 0,
    pathCover: 0,
    pathStones: 0,
    reliefLevelShare: 0,
    reliefRange: 0,
    reliefSteepShare: 0,
    sunShafts: 0,
    defeated: 0,
    doorOpen: false,
    grateOpen: false,
    cameraBlocked: 0,
    fightFramedShare: 0,
    fightOccluded: 0,
    fightOutRun: 0,
    hearts: ADVENTURE_FEEL.startHalves / 2,
    hintOverlap: 0,
    toastOverlap: 0,
    openingFramedShare: 0,
    cameraTurnWorst: 0,
    torsoCovered: 0,
    torsoContactWorst: 0,
    ringFacingLeast: 0,
    heroViewNearest: 0,
    hitsTaken: 0,
    keys: 0,
    lastRespawn: "",
    lockFacingError: 0,
    lockMarkerLowest: 0,
    lockMarkerShown: false,
    lockStrafeDrift: 0,
    nearWallWorst: 0,
    lockStrafeSeconds: 0,
    lockTarget: "",
    paused: false,
    prompt: "",
    respawns: 0,
    shieldBlocks: 0,
    slashHits: 0,
    slashes: 0,
    stopSeconds: 0,
    sword: false,
    toast: "",
    topSpeed: 0,
    turnSeconds: 0,
    uiReady: false,
    wardenHealth: 3,
    wardenStuns: 0,
    wardenState: "dormant",
    zone: "vale",
  };

  #sky: ISky | undefined;
  #vale: IVale | undefined;
  #hollow: IHollow | undefined;
  #hero: Hero | undefined;
  #dummies: Dummy[] = [];
  #mosslings: Mossling[] = [];
  #flickers: Flicker[] = [];
  #thornbacks: Thornback[] = [];
  #warden: Warden | undefined;
  #block: Block | undefined;
  #chests: Chest[] = [];
  #post: ReturnType<typeof setupPost> | undefined;

  /**
   * Both places are built here, and everything a scenario can place is registered here:
   * `setup.place` and `setup.spawn` run after `load()` and before `enter()`, so an entity that first
   * appears in `enter()` cannot be placed. `enter()` builds every body where its mesh now stands.
   */
  override async load(ctx: GameCtx): Promise<void> {
    await loadSurfaces(ctx.assets);
    this.#sky = createSky();
    setupSky(ctx.scene, this.#sky);
    const vale = buildVale(makeRng(1986));
    const hollow = buildHollow(makeRng(1998));
    this.#vale = vale;
    this.#hollow = hollow;
    ctx.add(vale.group);
    ctx.add(hollow.group);

    const hero = new Hero();
    hero.mesh.position.set(vale.spawn.x, vale.spawn.y + FOOT_OFFSET, vale.spawn.z);
    hero.mesh.rotation.y = vale.spawnYaw;
    this.#hero = ctx.entities.add("player", hero);
    vale.dummies.forEach((at, i) => {
      this.#dummies.push(ctx.entities.add(`dummy.${i}`, new Dummy(`dummy.${i}`, at)));
    });
    [...vale.mosslings, ...hollow.guards].forEach((at, i) => {
      this.#mosslings.push(ctx.entities.add(`mossling.${i}`, new Mossling(`mossling.${i}`, at)));
    });
    [...vale.flickers, ...hollow.flickers].forEach((at, i) => {
      this.#flickers.push(ctx.entities.add(`flicker.${i}`, new Flicker(`flicker.${i}`, at)));
    });
    [...vale.thornbacks, ...hollow.thornbacks].forEach(({ at, yaw }, i) => {
      const id = `thornback.${i}`;
      this.#thornbacks.push(ctx.entities.add(id, new Thornback(id, at, yaw)));
    });
    this.#warden = ctx.entities.add("warden", new Warden("warden", hollow.warden));
    this.#block = ctx.entities.add("block", new Block("block", hollow.block, makeRng(7)));
    this.#chests = [
      new Chest("chest.sword", "sword", vale.swordChest.at, vale.swordChest.yaw),
      new Chest("chest.key", "key", hollow.keyChest.at, hollow.keyChest.yaw),
    ];
    for (const chest of this.#chests) ctx.entities.add(chest.id, chest);
    for (const thing of [
      ...this.#dummies,
      ...this.#mosslings,
      ...this.#flickers,
      ...this.#thornbacks,
      ...this.#chests,
      this.#warden,
      this.#block,
    ])
      ctx.add(thing.mesh);
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const { vale, hollow, hero, warden, block } = {
      block: this.#block,
      hero: this.#hero,
      hollow: this.#hollow,
      vale: this.#vale,
      warden: this.#warden,
    };
    const [swordChest, keyChest] = this.#chests;
    if (
      vale === undefined ||
      hollow === undefined ||
      hero === undefined ||
      warden === undefined ||
      block === undefined ||
      swordChest === undefined ||
      keyChest === undefined ||
      this.#sky === undefined
    )
      throw new Error("Play.enter ran before load() built the world.");
    // `userData.solid` marks exactly the meshes that block (`level/Vale.ts`, `level/Hollow.ts`).
    // The Hollow's roof starts at 5 m, so the default 4.5 m reachable ceiling is raised to keep it.
    for (const root of [vale.group, hollow.group])
      buildStaticColliders(ctx, root, {
        collisionLayer: LAYER.world,
        predicate: isSolid,
        reachableCeiling: 6,
      });
    setupSky(ctx.scene, this.#sky);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: lighting.key,
      gpuClass: ctx.renderer.gpuClass?.class,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
    const camera = ctx.camera as PerspectiveCamera;
    ctx.add(camera);
    const loading = createLoadingScreen(ctx);
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    // ------------------------------------------------------------------ actors
    // A scenario may have moved or turned Wren: read both back, then build her body there.
    hero.yaw = new Euler().setFromQuaternion(hero.mesh.quaternion, "YXZ").y;
    hero.mesh.rotation.set(0, 0, 0);
    hero.spawn(ctx);
    const dummies = this.#dummies;
    const mosslings = this.#mosslings;
    const foes = [...this.#flickers, ...this.#thornbacks];
    for (const thing of [...dummies, ...mosslings, ...foes, warden, block]) thing.spawn(ctx);
    const targets: ITarget[] = [...dummies, ...mosslings, ...foes, warden];
    const lock = new LockOn();
    ctx.add(lock.reticle);

    // Effects: four pooled emitters, every look parameter in `render/effects.ts`. A cut that lands
    // throws embers, a cut that clanks and a hit the shield turns throw cold sparks; fireflies
    // drift round Wren in the vale, and her companion orb sheds a trail.
    const emitters = {
      ember: ctx.add(new GPUParticles3D(EFFECTS.ember())),
      mote: ctx.add(new GPUParticles3D(EFFECTS.mote())),
      spark: ctx.add(new GPUParticles3D(EFFECTS.spark())),
      wisp: ctx.add(new GPUParticles3D(EFFECTS.wisp())),
    };
    const burst = (kind: keyof typeof BURSTS, at: Vector3): void => {
      const { count, emitter, shape } = BURSTS[kind];
      emitters[emitter].emitParticle({
        count,
        direction: { x: shape[0], y: shape[1], z: shape[2] },
        origin: { x: at.x, y: at.y, z: at.z },
      });
    };
    ctx.entities.add("effects", {
      debug: () => ({
        ember: emitters.ember.stats.spawned,
        mote: emitters.mote.stats.spawned,
        spark: emitters.spark.stats.spawned,
        wisp: emitters.wisp.stats.spawned,
      }),
    });
    // Wren's companion orb rides off her left shoulder, a little behind, and lags so it reads as
    // alive; in a fight it climbs higher, out of the line between the lens and what she fights.
    const companion = createCompanion();
    companion.group.position.copy(hero.mesh.position).setY(hero.mesh.position.y + 0.8);
    ctx.add(companion.group);
    const orbGoal = new Vector3();
    const orb = { clock: 0, farthest: 0, nearest: Number.POSITIVE_INFINITY };
    let moteClock = 0;
    // The landform and the path are fixed: measure them once.
    const relief = measureRelief();
    ctx.state.set({
      hutLanterns: vale.hut.lanterns,
      pathCover: Math.round(vale.path.cover * 1000) / 1000,
      pathStones: vale.path.stones,
      reliefLevelShare: Math.round(relief.levelShare * 1000) / 1000,
      reliefRange: Math.round(relief.range * 100) / 100,
      reliefSteepShare: Math.round(relief.steepShare * 1000) / 1000,
      heightFog: ctx.scene.fogNode !== null,
      sunShafts: (ctx.scene.getObjectByName("sun-shafts") as InstancedMesh | undefined)?.count ?? 0,
    });
    const thornbacks = this.#thornbacks;
    const seen = { blocks: 0, clanks: 0, hits: 0 };
    const impact = new Vector3();

    const grate = new Door(
      "door.grate",
      "grate",
      hollow.grate.at,
      hollow.grate.yaw,
      hollow.grate.width,
      3,
    );
    const door = new Door(
      "door.locked",
      "locked",
      hollow.lockedDoor.at,
      0,
      hollow.lockedDoor.width,
      3,
    );
    for (const thing of [swordChest, keyChest]) thing.spawn(ctx);
    for (const thing of [grate, door]) {
      thing.spawn(ctx);
      ctx.entities.add(thing.id, thing);
    }

    // --------------------------------------------------------------- the loop's state
    let keys = 0;
    let elapsed = 0;
    let toastUntil = 0;
    let respawns = 0;
    let defeated = 0;
    const counted = new Set<ITarget>();
    let cleared = false;
    let indoors = hollow.contains(hero.mesh.position);
    lighting.setIndoors(indoors);
    let lockAge = 0;
    let strafeDrift = 0;
    let strafeSeconds = 0;
    let lockFacing = 0;
    let markerLow = 0;
    // Respawn point: the start, then the last doorway Wren came through.
    const checkpoint: { at: Vector3; name: Checkpoint; yaw: number } = {
      at: (indoors ? hollow.entry : vale.spawn).clone(),
      name: indoors ? "hollow-entry" : "clearing",
      yaw: Math.PI,
    };
    const toast = (text: string, seconds = 2): void => {
      ctx.state.set({ toast: text });
      toastUntil = elapsed + seconds;
    };
    // The slash hint goes at her first slash or lock, and any toast when the Warden wakes: a fight opens
    // on a clear screen. -1 while no hint is up, else her slash count when it went up.
    let slashHint = -1;
    let wardenSlept = true;
    const standAt = (feet: Vector3): Vector3 =>
      new Vector3(feet.x, feet.y + FOOT_OFFSET + 0.05, feet.z);

    const interactions = new Interactions(ctx, () => hero.body);
    interactions.add({
      at: swordChest.mesh.position,
      label: () => (swordChest.opened ? undefined : "Open chest"),
      use: () => {
        if (swordChest.open() === undefined) return;
        hero.giveSword();
        toast("THE EMBER BLADE! Click or press J to slash.", 3);
        slashHint = hero.slashes;
      },
    });
    interactions.add({
      at: keyChest.mesh.position,
      label: () => (keyChest.opened ? undefined : "Open chest"),
      use: () => {
        if (keyChest.open() === undefined) return;
        keys += 1;
        toast("A SMALL KEY!");
      },
    });
    interactions.add({
      at: vale.sign.at,
      label: () => "Read sign",
      use: () => toast(vale.sign.text, 4),
    });
    interactions.add(
      {
        at: new Vector3(door.mesh.position.x, 0, door.mesh.position.z + 0.6),
        label: () => (door.open ? undefined : keys > 0 ? "Unlock door" : "Locked"),
        use: () => {
          if (door.unlock(keys)) {
            keys -= 1;
            toast("THE DOOR OPENS");
          } else toast("It is locked. Somewhere in here is a key.");
        },
      },
      1.6,
    );
    const plate = new Switch(hollow.switchAt, block, (pressed) => {
      grate.setOpen(pressed);
      if (pressed) toast("THE GRATE OPENS");
    });
    plate.spawn(ctx);

    // The heart vessel appears where the Warden falls; taking it clears the dungeon.
    const vessel: Group = createHeartVessel();
    vessel.visible = false;
    ctx.add(vessel);

    // The camera arm and the sun read the solved body, so they run after physics has moved it.
    const rig = setupCamera(
      camera,
      (from, to) =>
        from.distanceToSquared(to) < 1e-8
          ? undefined
          : ctx.physics.directSpaceState.intersectRay({ collisionMask: LAYER.world, from, to }),
      // Outdoors the lens stays over the vale's ground; the Hollow's rooms are flat and roofed.
      (x, z) => (indoors ? Number.NEGATIVE_INFINITY : valeHeight(x, z)),
    );
    rig.snap(hero.mesh.position, hero.yaw + Math.PI);
    // The closest the camera came to Wren's head (her head's centre is 1.33 m over her soles).
    const HEAD_HEIGHT = 1.33;
    const NEAR_VIEW = 1.8;
    const head = new Vector3();
    let viewNearest = Number.POSITIVE_INFINITY;
    // Readability, sampled every tick through the camera's own projection. A fight is on while a
    // target is locked, the Warden is awake (its opening, before any lock) or a live hostile
    // stands within FIGHT_RANGE of Wren; then Wren and that target must both sit inside the frame
    // with a 5% margin (6% at the top, so a head never touches the edge), and Wren's screen centre
    // must not sit behind the target; once a lock has glided in (GLIDE ticks), she must not hide
    // over half of it either. Every tick: nothing solid between her head and the lens, walls in
    // the front half of the way from the lens to her cover little of the frame (a grid of rays,
    // every 6th tick), Wren stays clear of the controls card (top right, Menu.tsx), and a toast
    // (Hud.tsx) covers neither Wren nor the fight's target. The worst per-tick view turn and the
    // most of the locked Warden's chest rune ring Wren's box covers at close range are kept too.
    const FIGHT_RANGE = 8;
    const GLIDE = 15;
    // ponytail: the card's and the toast's boxes in view space at 1280 by 720, kept in step with
    // Menu.tsx and Hud.tsx by hand.
    const HINT = { x0: 0.55, y0: 0.6 };
    const TOAST = { x0: -0.97, x1: -0.36, y0: 0.54, y1: 0.78 };
    const fight = {
      inGround: 0,
      blocked: 0,
      frames: 0,
      framed: 0,
      hint: 0,
      nearWall: 0,
      occluded: 0,
      openingFrames: 0,
      openingFramed: 0,
      toast: 0,
      turn: 0,
      torso: 0,
      contact: 0,
      ring: Number.POSITIVE_INFINITY,
      run: 0,
      worstRun: 0,
      ticks: 0,
      lockTicks: 0,
      lockedOn: undefined as ITarget | undefined,
    };
    const underToast = (rect: typeof HINT & { x1: number; y1: number }): boolean =>
      toastUntil !== 0 &&
      rect.x1 > TOAST.x0 &&
      rect.x0 < TOAST.x1 &&
      rect.y1 > TOAST.y0 &&
      rect.y0 < TOAST.y1;
    const fightBox = new Box3();
    const viewNow = new Vector3();
    const viewBefore = new Vector3();
    const heroCentre = new Vector3();
    const ray = new Vector3();
    // Wren's silhouette: her body's width across the view, from her feet to the top of her head.
    const heroBox = new Box3();
    const across = new Vector3();
    const heroRect = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const targetRect = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const corner = new Vector3();
    // The Warden's chest rune ring (render/creatures.ts): a disc on its chest face, centred at
    // `at` on the rig, `radius` out to the tips of its strokes; the fight is close inside `within`.
    // Closer than `clear` (ring centre to Wren's) no lens short of side-on clears it, as her
    // half-width alone is 0.32 m: that is shield contact, kept apart.
    const CHEST = { at: new Vector3(0, 1.3, 0.72), radius: 0.48, within: 5, clear: 0.4 };
    const chestRect = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const ringAt = new Vector3();
    const toWren = new Vector3();
    // The ring's screen box: its four rim points (left, right, top, bottom) projected.
    const projectRing = (): void => {
      Object.assign(chestRect, {
        x0: Number.POSITIVE_INFINITY,
        x1: Number.NEGATIVE_INFINITY,
        y0: Number.POSITIVE_INFINITY,
        y1: Number.NEGATIVE_INFINITY,
      });
      for (let i = 0; i < 4; i += 1) {
        const a = (i * Math.PI) / 2;
        corner.copy(CHEST.at);
        corner.x += Math.cos(a) * CHEST.radius;
        corner.y += Math.sin(a) * CHEST.radius;
        warden.rig.group.localToWorld(corner).project(camera);
        chestRect.x0 = Math.min(chestRect.x0, corner.x);
        chestRect.x1 = Math.max(chestRect.x1, corner.x);
        chestRect.y0 = Math.min(chestRect.y0, corner.y);
        chestRect.y1 = Math.max(chestRect.y1, corner.y);
      }
    };
    // The screen area two boxes share.
    const overlap = (a: typeof heroRect, b: typeof heroRect): number =>
      Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
      Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const solidBetween = (from: Vector3, to: Vector3): boolean =>
      from.distanceToSquared(to) > 1e-8 &&
      ctx.physics.directSpaceState.intersectRay({ collisionMask: LAYER.world, from, to }) !==
        undefined;
    const fightTarget = (): ITarget | undefined => {
      if (lock.target !== undefined) return lock.target;
      if (warden.alive && warden.state !== "dormant") return warden;
      let best: ITarget | undefined;
      let bestDistance = FIGHT_RANGE;
      for (const target of targets) {
        if (!target.alive) continue;
        const distance = target.mesh.position.distanceTo(hero.mesh.position);
        if (distance < bestDistance) {
          best = target;
          bestDistance = distance;
        }
      }
      return best;
    };
    const project = (box: Box3, rect: typeof heroRect): boolean => {
      Object.assign(rect, {
        x0: Number.POSITIVE_INFINITY,
        x1: Number.NEGATIVE_INFINITY,
        y0: Number.POSITIVE_INFINITY,
        y1: Number.NEGATIVE_INFINITY,
      });
      let ahead = true;
      for (let i = 0; i < 8; i += 1) {
        corner.set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        );
        corner.project(camera);
        ahead &&= corner.z < 1;
        rect.x0 = Math.min(rect.x0, corner.x);
        rect.x1 = Math.max(rect.x1, corner.x);
        rect.y0 = Math.min(rect.y0, corner.y);
        rect.y1 = Math.max(rect.y1, corner.y);
      }
      return ahead && rect.x0 >= -0.9 && rect.y0 >= -0.9 && rect.x1 <= 0.9 && rect.y1 <= 0.88;
    };
    afterPhysics(ctx, (dt) => {
      // An awake Warden stays in the picture from its first stir, before any lock.
      const awake = warden.alive && warden.state !== "dormant";
      rig.update(
        hero.mesh.position,
        lock.target === undefined ? undefined : lock,
        dt,
        awake ? fightBox.setFromObject(warden.mesh) : undefined,
      );
      head.copy(hero.mesh.position).setY(hero.mesh.position.y - FOOT_OFFSET + HEAD_HEIGHT);
      const near = camera.position.distanceTo(head);
      // A wall-pulled camera in a tight room climbs to the ceiling right over her, where her cap
      // fills the lens: closer than NEAR_VIEW she hides, as Ocarina's hero does.
      hero.rig.group.visible = !hero.blinking && near > NEAR_VIEW;
      if (hero.rig.group.visible) viewNearest = Math.min(viewNearest, near);
      lighting.follow(hero.mesh.position);
      camera.updateMatrixWorld();
      // A camera under the vale's ground is inside a bank or an outcrop: the arm must never go there.
      if (!indoors && camera.position.y < valeHeight(camera.position.x, camera.position.z) + 0.2)
        fight.inGround += 1;
      // The orb: off her left shoulder, a little behind, on a slow small circle; higher in a fight.
      orb.clock += dt;
      const f = hero.forward;
      const fighting = lock.target !== undefined || awake;
      orbGoal.set(
        hero.mesh.position.x + f.z * 0.7 - f.x * 0.4 + Math.cos(orb.clock * 1.3) * 0.15,
        head.y + (fighting ? 0.8 : 0.35) + Math.sin(orb.clock * 2.3) * 0.08,
        hero.mesh.position.z - f.x * 0.7 - f.z * 0.4 + Math.sin(orb.clock * 1.3) * 0.15,
      );
      if (companion.group.position.distanceTo(orbGoal) > 6) companion.group.position.copy(orbGoal);
      else companion.group.position.lerp(orbGoal, 1 - Math.exp(-dt * 4));
      const orbGap = companion.group.position.distanceTo(head);
      orb.nearest = Math.min(orb.nearest, orbGap);
      orb.farthest = Math.max(orb.farthest, orbGap);
      burst("wisp", companion.group.position);
      // How far the view turned this tick, in degrees: the fastest swing a player sees.
      camera.getWorldDirection(viewNow);
      if (fight.ticks > 0) fight.turn = Math.max(fight.turn, viewNow.angleTo(viewBefore) * DEG);
      viewBefore.copy(viewNow);
      fight.ticks += 1;
      fight.lockTicks =
        lock.target !== undefined && lock.target === fight.lockedOn ? fight.lockTicks + 1 : 0;
      fight.lockedOn = lock.target;
      if (solidBetween(head, camera.position)) fight.blocked += 1;
      if (fight.ticks % 6 === 0) {
        // A wall or ceiling (any hit not facing up) in the front half of the way from the lens to
        // Wren is foreground clutter: a doorway jamb the camera films her through.
        const reach = near / 2;
        let walls = 0;
        for (let u = -0.75; u <= 0.76; u += 0.3)
          for (let v = -0.75; v <= 0.76; v += 0.5) {
            ray.set(u, v, 0.5).unproject(camera).sub(camera.position).setLength(reach);
            const hit = ctx.physics.directSpaceState.intersectRay({
              collisionMask: LAYER.world,
              from: camera.position,
              to: ray.add(camera.position),
            });
            if (hit !== undefined && hit.normal.y < 0.7) walls += 1;
          }
        fight.nearWall = Math.max(fight.nearWall, walls / 24);
      }
      across.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize().multiplyScalar(0.32);
      const feet = hero.mesh.position.y - FOOT_OFFSET;
      heroBox.min.set(hero.mesh.position.x, feet, hero.mesh.position.z).sub(across);
      heroBox.max.set(hero.mesh.position.x, feet + 1.8, hero.mesh.position.z).add(across);
      const heroIn = project(heroBox, heroRect);
      if (hero.rig.group.visible && heroRect.x1 > HINT.x0 && heroRect.y1 > HINT.y0) fight.hint += 1;
      const target = fightTarget();
      if (target === undefined) {
        fight.run = 0;
        return;
      }
      const box = target === lock.target ? lock.bounds : fightBox.setFromObject(target.mesh);
      const targetIn = project(box, targetRect);
      heroCentre.set(hero.mesh.position.x, feet + 0.9, hero.mesh.position.z);
      const heroDistance = heroCentre.distanceTo(camera.position);
      heroCentre.project(camera);
      const targetNearer = box.getCenter(corner).distanceTo(camera.position) < heroDistance;
      corner.project(camera);
      const covers = (point: Vector3, rect: typeof heroRect): boolean =>
        point.x > rect.x0 && point.x < rect.x1 && point.y > rect.y0 && point.y < rect.y1;
      // Wren hiding the locked target: she covers its centre and over half of its box.
      const hidden = overlap(heroRect, targetRect);
      const area = (targetRect.x1 - targetRect.x0) * (targetRect.y1 - targetRect.y0);
      const behind = targetNearer
        ? covers(heroCentre, targetRect)
        : target === lock.target &&
          fight.lockTicks > GLIDE &&
          covers(corner, heroRect) &&
          hidden > area / 2;
      fight.frames += 1;
      if (behind) fight.occluded += 1;
      // Locked on the Warden within CHEST.within, once the lock has glided in (its stuns, cuts and
      // shield blocks): the most of the box round its chest rune ring that Wren's box covers.
      if (
        target === warden &&
        lock.target === warden &&
        fight.lockTicks > GLIDE &&
        warden.mesh.position.distanceTo(hero.mesh.position) < CHEST.within
      ) {
        warden.rig.group.updateWorldMatrix(true, false);
        warden.rig.group.localToWorld(ringAt.copy(CHEST.at));
        // How square the ring faces the lens: its on-screen width over its face-on width.
        const facing =
          warden.rig.group.getWorldDirection(ray).dot(corner.subVectors(camera.position, ringAt)) /
          corner.length();
        // A shield stun leaves the ring facing Wren; a wall stun turns it to the wall, unseen anyway.
        const stunnedAtWren =
          warden.state === "stunned" && ray.dot(toWren.subVectors(hero.mesh.position, ringAt)) > 0;
        if (stunnedAtWren) fight.ring = Math.min(fight.ring, Math.max(0, facing));
        // A ring facing away from the lens is behind the Warden's own body: nothing to cover.
        if (facing > 0) {
          projectRing();
          const share =
            overlap(heroRect, chestRect) /
            ((chestRect.x1 - chestRect.x0) * (chestRect.y1 - chestRect.y0));
          const ahead = Math.hypot(
            ringAt.x - hero.mesh.position.x,
            ringAt.z - hero.mesh.position.z,
          );
          if (ahead < CHEST.clear) fight.contact = Math.max(fight.contact, share);
          else fight.torso = Math.max(fight.torso, share);
        }
      }
      if (underToast(heroRect) || underToast(targetRect)) fight.toast += 1;
      if (target === warden && lock.target === undefined) {
        fight.openingFrames += 1;
        if (heroIn && targetIn) fight.openingFramed += 1;
      }
      if (heroIn && targetIn) {
        fight.framed += 1;
        fight.run = 0;
      } else {
        fight.run += 1;
        fight.worstRun = Math.max(fight.worstRun, fight.run);
      }
    });

    const toTarget = new Vector3();
    const statePatch: Partial<GameState> = {};

    return (frameCtx, dt) => {
      loading.update();
      elapsed += dt;
      const input = readHeroInput(
        frameCtx,
        touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size),
      );

      // Lock first: the hero reads this step's target for strafing and facing.
      lock.update(dt, input.target, input.targetPressed, hero.mesh.position, camera, targets);
      if (input.targetPressed && lock.target === undefined) rig.recenter(hero.yaw + Math.PI);
      hero.update(frameCtx, dt, input, lock, rig.yaw, indoors, targets);
      hero.setPushing(block.update(frameCtx, dt, hero, hero.wish));

      for (const mossling of mosslings) mossling.update(frameCtx, dt, hero);
      for (const foe of foes) foe.update(dt, hero);
      // Effects fire on the counters' edges: a cut's where the blade met the target, a block's off
      // the shield in front of Wren.
      const clanks = thornbacks.reduce((sum, foe) => sum + foe.clanks, warden.clanks);
      impact.copy(hero.forward).multiplyScalar(0.9).add(hero.mesh.position);
      impact.y += 0.35;
      if (hero.slashHits > seen.hits) burst("hit", hero.strikeAt);
      if (clanks > seen.clanks) burst("clank", hero.strikeAt);
      if (hero.shieldBlocks > seen.blocks) burst("block", impact.setY(hero.mesh.position.y + 0.15));
      Object.assign(seen, { blocks: hero.shieldBlocks, clanks, hits: hero.slashHits });
      warden.update(dt, hero);
      for (const dummy of dummies) dummy.update(dt);
      // A target falls inside Wren's slash, so count the fallen after everything has moved.
      for (const fallen of targets) {
        if (fallen.alive || counted.has(fallen)) continue;
        counted.add(fallen);
        defeated += 1;
        if (fallen === warden) {
          vessel.position.set(warden.mesh.position.x, 1.2, warden.mesh.position.z);
          vessel.visible = true;
          door.setOpen(true);
          toast("THE STONE WARDEN FALLS", 3);
        }
      }
      swordChest.update(dt);
      keyChest.update(dt);
      grate.update(dt);
      door.update(dt);
      plate.update();
      const prompt = interactions.update(hero.mesh.position, input.interact && hero.alive);
      // Fireflies round Wren in the vale, a few every quarter second, from just under her waist.
      moteClock += dt;
      if (!indoors && moteClock >= 0.25) {
        moteClock = 0;
        burst("motes", impact.copy(hero.mesh.position).setY(hero.mesh.position.y - 0.6));
      }

      if (vessel.visible) {
        vessel.rotation.y += dt * 2;
        vessel.position.y = 1.2 + Math.sin(elapsed * 3) * 0.1;
        if (vessel.position.distanceTo(hero.mesh.position) < 1.2) {
          vessel.visible = false;
          hero.capacity += 2;
          hero.heal(hero.capacity);
          cleared = true;
          toast("HEART VESSEL! The Moss Hollow is cleared.", 5);
        }
      }

      // The cave mouth carries Wren between the clearing and the Hollow, and moves her checkpoint.
      const at = hero.mesh.position;
      const enter = (name: Checkpoint, feet: Vector3, yaw: number, camYaw: number): void => {
        hero.teleport(standAt(feet));
        hero.yaw = yaw;
        checkpoint.name = name;
        checkpoint.at.copy(feet);
        checkpoint.yaw = yaw;
        rig.snap(hero.mesh.position, camYaw);
      };
      if (Math.hypot(at.x - vale.caveMouth.x, at.z - vale.caveMouth.z) < 1.4)
        enter("hollow-entry", hollow.entry, Math.PI, 0);
      else if (Math.hypot(at.x - hollow.exit.x, at.z - hollow.exit.z) < 0.9)
        enter("cave-exit", vale.caveExit, 0, Math.PI);
      if (
        hollow.contains(at) &&
        at.z < hollow.bossCheckpoint.z &&
        checkpoint.name !== "warden-door"
      ) {
        checkpoint.name = "warden-door";
        checkpoint.at.copy(hollow.bossCheckpoint);
        checkpoint.yaw = Math.PI;
      }
      // The door shuts behind her in the Warden's room and opens again when it falls.
      if (
        door.open &&
        warden.alive &&
        hollow.contains(at) &&
        at.z < hollow.bossCheckpoint.z + 0.5
      ) {
        door.setOpen(false);
        toast("The door grinds shut behind you.");
      }
      const nowIndoors = hollow.contains(at);
      if (nowIndoors !== indoors) {
        indoors = nowIndoors;
        lighting.setIndoors(indoors);
      }

      // Out of hearts, or off the world: back at the last checkpoint with full hearts.
      if (hero.readyToRespawn || at.y < ADVENTURE_FEEL.killPlane) {
        hero.respawn(standAt(checkpoint.at), checkpoint.yaw);
        rig.snap(hero.mesh.position, checkpoint.yaw + Math.PI);
        respawns += 1;
        frameCtx.state.set({ lastRespawn: checkpoint.name });
        toast("Wren picks herself up.");
      }

      // Lock-on measurements, over the whole run: the worst drift from the held distance while
      // strafing, the seconds spent strafing, and the worst facing error once 0.3 s has let her
      // turn in.
      const target = lock.target;
      if (target !== undefined) {
        toTarget.subVectors(target.mesh.position, at).setY(0);
        const distance = toTarget.length();
        if (lock.justAcquired) lockAge = 0;
        lockAge += dt;
        if (Math.abs(input.move.y) < 0.2 && input.move.length() > 0.1 && hero.state === "run") {
          strafeDrift = Math.max(strafeDrift, Math.abs(distance - hero.lockDistance));
          strafeSeconds += dt;
        }
        if (lockAge > 0.3) {
          const gap = Math.acos(MathUtils.clamp(hero.forward.dot(toTarget.normalize()), -1, 1));
          lockFacing = Math.max(lockFacing, gap * DEG);
        }
      }

      const woke = wardenSlept && warden.state !== "dormant";
      wardenSlept = warden.state === "dormant";
      if (woke || (slashHint >= 0 && (hero.slashes > slashHint || lock.target !== undefined))) {
        slashHint = -1;
        toastUntil = elapsed;
      }
      if (toastUntil !== 0 && elapsed >= toastUntil) {
        toastUntil = 0;
        frameCtx.state.set({ toast: "" });
      }
      statePatch.blockSteps = block.steps;
      statePatch.capacity = hero.capacity / 2;
      statePatch.cleared = cleared;
      statePatch.defeated = defeated;
      statePatch.doorOpen = door.open;
      statePatch.grateOpen = grate.open;
      statePatch.hearts = hero.health / 2;
      statePatch.hitsTaken = hero.hitsTaken;
      statePatch.keys = keys;
      statePatch.lockFacingError = Math.round(lockFacing * 10) / 10;
      statePatch.lockStrafeDrift = Math.round(strafeDrift * 1000) / 1000;
      statePatch.lockStrafeSeconds = Math.round(strafeSeconds * 100) / 100;
      statePatch.lockTarget = target?.id ?? "";
      statePatch.lockMarkerShown = lock.reticle.visible;
      if (lock.reticle.visible)
        markerLow = markerLow === 0 ? lock.markerLift : Math.min(markerLow, lock.markerLift);
      statePatch.lockMarkerLowest = Math.round(markerLow * 1000) / 1000;
      statePatch.fightFramedShare =
        fight.frames === 0 ? 0 : Math.round((fight.framed / fight.frames) * 1000) / 1000;
      statePatch.fightOutRun = fight.worstRun;
      statePatch.fightOccluded = fight.occluded;

      statePatch.cameraBlocked = fight.blocked;
      statePatch.cameraInGround = fight.inGround;
      statePatch.motesSpawned = emitters.mote.stats.spawned;
      statePatch.companionNearest =
        orb.nearest === Number.POSITIVE_INFINITY ? 0 : Math.round(orb.nearest * 100) / 100;
      statePatch.companionFarthest = Math.round(orb.farthest * 100) / 100;
      statePatch.assetLoads = frameCtx.assets.progress.requested;
      statePatch.nearWallWorst = Math.round(fight.nearWall * 1000) / 1000;
      statePatch.hintOverlap = fight.hint;
      statePatch.toastOverlap = fight.toast;
      statePatch.cameraTurnWorst = Math.round(fight.turn * 100) / 100;
      statePatch.torsoCovered = Math.round(fight.torso * 1000) / 1000;
      statePatch.torsoContactWorst = Math.round(fight.contact * 1000) / 1000;
      statePatch.ringFacingLeast =
        fight.ring === Number.POSITIVE_INFINITY ? 0 : Math.round(fight.ring * 1000) / 1000;
      statePatch.openingFramedShare =
        fight.openingFrames === 0
          ? 0
          : Math.round((fight.openingFramed / fight.openingFrames) * 1000) / 1000;
      statePatch.heroViewNearest =
        viewNearest === Number.POSITIVE_INFINITY ? 0 : Math.round(viewNearest * 100) / 100;
      statePatch.prompt = prompt;
      statePatch.respawns = respawns;
      statePatch.shieldBlocks = hero.shieldBlocks;
      statePatch.slashHits = hero.slashHits;
      statePatch.slashes = hero.slashes;
      statePatch.stopSeconds = Math.round(hero.stopSeconds * 1000) / 1000;
      statePatch.sword = hero.hasSword;
      statePatch.topSpeed = Math.round(hero.topSpeed * 1000) / 1000;
      statePatch.turnSeconds = Math.round(hero.turnSeconds * 1000) / 1000;
      statePatch.wardenHealth = warden.health;
      statePatch.wardenStuns = warden.stuns;
      statePatch.wardenState = warden.state;
      statePatch.zone = indoors ? "hollow" : "vale";
      frameCtx.state.set(statePatch);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#post?.dispose();
    this.#post = undefined;
    this.#dummies = [];
    this.#mosslings = [];
    this.#flickers = [];
    this.#thornbacks = [];
    this.#chests = [];
    super.exit(ctx);
  }
}
