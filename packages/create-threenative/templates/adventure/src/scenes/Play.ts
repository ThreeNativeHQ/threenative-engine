import {
  InstancedBatch,
  Scene,
  type SceneFrame,
  afterPhysics,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { type IPhysicsContext, buildStaticColliders } from "@threenative/physics";
import { Euler, type Group, MathUtils, type PerspectiveCamera, Vector3 } from "three";
import { Block } from "../entities/Block.js";
import { Chest } from "../entities/Chest.js";
import { Door } from "../entities/Door.js";
import { Dummy } from "../entities/Dummy.js";
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
import { Warden } from "../entities/Warden.js";
import { Interactions } from "../interact.js";
import { type IHollow, buildHollow } from "../level/Hollow.js";
import { type IVale, buildVale, isSolid, makeRng } from "../level/Vale.js";
import { setupCamera } from "../render/camera.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { lit } from "../render/materials.js";
import { C } from "../render/palette.js";
import { setupPost } from "../render/postprocessing.js";
import { createHeartVessel, grassTuft } from "../render/props.js";
import { type ISky, createSky, setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import type { Checkpoint, GameState } from "../state.js";

export type { GameCtx };

const DEG = 180 / Math.PI;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    blockSteps: 0,
    capacity: ADVENTURE_FEEL.startHalves / 2,
    cleared: false,
    defeated: 0,
    doorOpen: false,
    grateOpen: false,
    hearts: ADVENTURE_FEEL.startHalves / 2,
    hitsTaken: 0,
    keys: 0,
    lastRespawn: "",
    lockFacingError: 0,
    lockMarkerLowest: 0,
    lockMarkerShown: false,
    lockStrafeDrift: 0,
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
    zone: "vale",
  };

  #sky: ISky | undefined;
  #vale: IVale | undefined;
  #hollow: IHollow | undefined;
  #hero: Hero | undefined;
  #dummies: Dummy[] = [];
  #mosslings: Mossling[] = [];
  #warden: Warden | undefined;
  #block: Block | undefined;
  #chests: Chest[] = [];
  #post: ReturnType<typeof setupPost> | undefined;

  /**
   * Both places are built here, and everything a scenario can place is registered here:
   * `setup.place` and `setup.spawn` run after `load()` and before `enter()`, so an entity that first
   * appears in `enter()` cannot be placed. `enter()` builds every body where its mesh now stands.
   */
  override load(ctx: GameCtx): void {
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

    // 900 tufts of meadow grass as one draw.
    const grass = new InstancedBatch({
      geometry: grassTuft(),
      material: lit(C.leafLight, { roughness: 0.9 }),
    });
    for (const tuft of vale.grass) grass.place(tuft);
    grass.build({ name: "grass", parent: vale.group });

    // ------------------------------------------------------------------ actors
    // A scenario may have moved or turned Wren: read both back, then build her body there.
    hero.yaw = new Euler().setFromQuaternion(hero.mesh.quaternion, "YXZ").y;
    hero.mesh.rotation.set(0, 0, 0);
    hero.spawn(ctx);
    for (const thing of [...this.#dummies, ...this.#mosslings, warden, block]) thing.spawn(ctx);
    const dummies = this.#dummies;
    const mosslings = this.#mosslings;
    const targets: ITarget[] = [...dummies, ...mosslings, warden];
    const lock = new LockOn();
    ctx.add(lock.reticle);

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
    const standAt = (feet: Vector3): Vector3 =>
      new Vector3(feet.x, feet.y + FOOT_OFFSET + 0.05, feet.z);

    const interactions = new Interactions(ctx, () => hero.body);
    interactions.add({
      at: swordChest.mesh.position,
      label: () => (swordChest.opened ? undefined : "Open chest"),
      use: () => {
        if (swordChest.open() === undefined) return;
        hero.giveSword();
        toast("THE EMBER BLADE! Press J to slash.", 3);
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
    const rig = setupCamera(camera, (from, to) => {
      if (from.distanceToSquared(to) < 1e-8) return undefined;
      return ctx.physics.directSpaceState.intersectRay({ collisionMask: LAYER.world, from, to })
        ?.distance;
    });
    rig.snap(hero.mesh.position, hero.yaw + Math.PI);
    afterPhysics(ctx, (dt) => {
      rig.update(hero.mesh.position, lock.target?.mesh.position, dt, lock.reticle.position.y);
      lighting.follow(hero.mesh.position);
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
      hero.rig.group.visible = !hero.blinking;

      for (const mossling of mosslings) mossling.update(frameCtx, dt, hero);
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

      if (toastUntil !== 0 && elapsed > toastUntil) {
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
      statePatch.zone = indoors ? "hollow" : "vale";
      frameCtx.state.set(statePatch);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#post?.dispose();
    this.#post = undefined;
    this.#dummies = [];
    this.#mosslings = [];
    this.#chests = [];
    super.exit(ctx);
  }
}
