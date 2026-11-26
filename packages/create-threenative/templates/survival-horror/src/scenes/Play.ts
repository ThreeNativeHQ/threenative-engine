import {
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  buildStaticColliders,
} from "@threenative/physics";
import { type PerspectiveCamera, Vector3 } from "three";
import {
  type GameCtx,
  HOSTILE_LAYER,
  type IMannequin,
  PLAYER_LAYER,
  WORLD_LAYER,
} from "../entities/Actor.js";
import { type AimPitch, type ITarget, MAGAZINE, Survivor } from "../entities/Survivor.js";
import { Zombie } from "../entities/Zombie.js";
import { CASE_SLOTS, ITEMS, type IStack, Inventory } from "../items.js";
import {
  DOORS,
  FURNITURE,
  type IDoor,
  type IFurniture,
  type IPickup,
  PICKUPS,
  SPAWN,
  ZOMBIES,
  doorById,
  roomAt,
  zoneAt,
} from "../level.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createFixedCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createHandgun, createMansion } from "../render/mansion.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { zombieMaterial } from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState, Menu, SlotView } from "../state.js";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

/** Reach for items and furniture, and for door handles, in metres from the survivor's centre. */
const REACH = 1.5;
const DOOR_REACH = 1.5;
/** Things to use must be in front: half-angle of the cone, radians. */
const USE_HALF_ANGLE = Math.PI / 3;
/** The door beat: the screen goes black, the room changes at the midpoint, then it fades up. */
const DOOR_TIME = 1.4;
/** Auto-aim (silent-hill `aim-assist`): a 50-degree cone around the facing, out to 10 m. */
const AIM_HALF_ANGLE = (50 * Math.PI) / 180;
const AIM_REACH = 10;
/** A missed shot flies this far before the wall takes it. */
const SHOT_RANGE = 15;
/** Handgun damage: base times a roll of 0.75 to 1.125, the reference spread (`weapon-damage`). */
const HANDGUN_DAMAGE = 16;
/** Aimed high at a standing zombie this close, a round can take the head: chance per shot. */
const CRITICAL_RANGE = 2.5;
const CRITICAL_CHANCE = 0.3;
/** A green herb restores a quarter of the survivor. */
const HERB_HEAL = 25;
/** Two green herbs mixed in the case: one slot, and more than twice the healing. */
const MIXED_HEAL = 60;
const MESSAGE_TIME = 3;
const START_MAGAZINE = 10;

/** The last typewriter save of this page: a death continues from it, a new game clears it. */
interface ISave {
  readonly health: number;
  readonly magazine: number;
  readonly slots: readonly IStack[];
  readonly box: readonly IStack[];
  readonly taken: readonly string[];
  readonly unlocked: readonly string[];
  readonly dead: readonly string[];
  readonly position: readonly [number, number];
  readonly heading: number;
  readonly saveCount: number;
}
// ponytail: one save per page, in memory. `../action-rpg`'s `progress.ts` shows the backend-held
// version when a save must survive a reload.
let lastSave: ISave | undefined;

/** Forget the save, so the next `goto("play")` is a new game rather than a continue. */
export function forgetSave(): void {
  lastSave = undefined;
}

function quantize(value: number): number {
  return Math.round(value * 1000) / 1000;
}

type Use =
  | { readonly kind: "pickup"; readonly pickup: IPickup }
  | { readonly kind: "door"; readonly door: IDoor }
  | { readonly kind: "furniture"; readonly furniture: IFurniture };

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    paused: false,
    uiReady: false,
    phase: "playing",
    menu: "none",
    room: "Save room",
    cameraZone: "save",
    cameraCuts: 0,
    health: 100,
    condition: "fine",
    magazine: START_MAGAZINE,
    reserve: 0,
    aiming: 0,
    grabbed: 0,
    slots: [],
    box: [],
    cursor: 0,
    column: "case",
    prompt: "",
    message: "",
    messageTime: 0,
    pickups: 0,
    refused: 0,
    herbsUsed: 0,
    combined: 0,
    hasSave: false,
    doorsOpened: 0,
    lockedTries: 0,
    saveCount: 0,
    saveRefused: 0,
    shots: 0,
    hits: 0,
    criticals: 0,
    dryFires: 0,
    kills: 0,
    bites: 0,
    escapes: 0,
    time: 0,
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for every figure: Quaternius' Universal Animation Library combat mannequin (CC0).
    // The survivor and the dead are the same asset in two materials.
    this.#mannequin = await ctx.assets.model<IMannequin>("mannequin-combat.glb");
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const mannequin = this.#mannequin;
    if (mannequin === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin-combat.glb.");
    const save = lastSave;
    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
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
      godraysLight: lighting.key,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);
    ctx.viewport.resize();
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    // The wing: walls, doors and furniture are one solid group, so the survivor collides with the
    // triangles the camera shows. The ground is one box under everything.
    const mansion = createMansion();
    ctx.add(mansion.ground);
    ctx.add(mansion.solid);
    ctx.add(mansion.decor);
    buildStaticColliders(ctx, mansion.solid, {
      collisionLayer: WORLD_LAYER,
      collisionMask: PLAYER_LAYER | HOSTILE_LAYER,
    });
    new RigidBody3D({
      collisionLayer: WORLD_LAYER,
      physics: ctx.physics,
      position: { x: 5, y: -0.5, z: 0 },
      shape: CollisionShape3D.box(80, 1, 80),
      type: "fixed",
    });

    // The case and the item box, from the last save or a new game's handgun, a herb and one clip.
    const carried = new Inventory(CASE_SLOTS);
    const itemBox = new Inventory();
    carried.restore(
      save?.slots ?? [
        { item: "handgun", quantity: 1 },
        { item: "herb", quantity: 1 },
        { item: "ammo", quantity: 15 },
      ],
    );
    itemBox.restore(save?.box ?? []);
    const taken = new Set(save?.taken ?? []);
    const unlocked = new Set(save?.unlocked ?? []);
    for (const id of taken) {
      const model = mansion.pickups.get(id);
      if (model !== undefined) model.visible = false;
    }

    const message = (text: string): void => {
      ctx.state.set({ message: text, messageTime: MESSAGE_TIME });
    };
    const stats = { ...Play.initialState, saveCount: save?.saveCount ?? 0 };
    const zombies: Zombie[] = [];
    const byBody = new Map<number, Zombie>();
    const muzzle = new Vector3();
    const aimPoint = new Vector3();
    const facing = new Vector3();
    const toTarget = new Vector3();

    const ids = new Map<Zombie, string>();
    const zombieId = (zombie: Zombie): string => ids.get(zombie) ?? "";
    const survivorRef: { value?: Survivor } = {};
    const sightClear = (from: Vector3, to: Vector3, mask: number): number | undefined => {
      const hit = ctx.physics.directSpaceState.intersectRay({ collisionMask: mask, from, to });
      return hit === undefined ? -1 : hit.body.id;
    };
    /** Where a round aimed at `zombie` with `pitch` goes: the head, the chest, the legs or the floor. */
    const pointOn = (zombie: Zombie, pitch: AimPitch): Vector3 => {
      const lift = !zombie.standing
        ? -0.72
        : pitch === "up"
          ? 0.72
          : pitch === "down"
            ? -0.35
            : 0.4;
      return aimPoint.copy(zombie.mesh.position).setY(zombie.mesh.position.y + lift);
    };
    const muzzleOf = (survivor: Survivor): Vector3 =>
      muzzle.copy(survivor.mesh.position).setY(survivor.mesh.position.y + 0.45);

    const acquire = (pitch: AimPitch): ITarget | undefined => {
      const survivor = survivorRef.value;
      if (survivor === undefined) return undefined;
      const room = roomAt(survivor.mesh.position.x, survivor.mesh.position.z)?.id;
      survivor.facingVector(facing);
      let best: Zombie | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const zombie of zombies) {
        if (!zombie.alive || zombie.room !== room || zombie.state === "rising") continue;
        // Only a gun aimed low finds a body on the floor; aimed level or high it looks past it.
        if (!zombie.standing && pitch !== "down") continue;
        toTarget.copy(zombie.mesh.position).sub(survivor.mesh.position).setY(0);
        const distance = toTarget.length();
        if (distance > AIM_REACH || distance < 1e-3) continue;
        if (toTarget.normalize().dot(facing) < Math.cos(AIM_HALF_ANGLE)) continue;
        const blocker = sightClear(muzzleOf(survivor), pointOn(zombie, pitch), WORLD_LAYER);
        if (blocker !== -1) continue;
        // Nearest wins; aimed low, a body on the floor beats one standing.
        const score = distance - (pitch === "down" && !zombie.standing ? 100 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = zombie;
        }
      }
      return best;
    };

    const shot = (pitch: AimPitch, target: ITarget | undefined): void => {
      const survivor = survivorRef.value;
      if (survivor === undefined) return;
      stats.shots += 1;
      emitPlaytestEvent({ entity: "player", name: "shot" });
      const room = roomAt(survivor.mesh.position.x, survivor.mesh.position.z)?.id;
      // A gunshot wakes every zombie in the room (`ai-awareness`: gunfire raises a burst others hear).
      for (const zombie of zombies) if (zombie.room === room) zombie.hear();
      const from = muzzleOf(survivor);
      let victim: Zombie | undefined;
      // Aimed down with no lock, the gun still finds a body on the floor in front of it: a body has
      // no collider, so no ray could.
      const floor =
        target === undefined && pitch === "down"
          ? (acquire("down") as Zombie | undefined)
          : undefined;
      const aimed = (target ?? (floor?.standing === false ? floor : undefined)) as
        | Zombie
        | undefined;
      // A body on the floor is only hit by a gun aimed down; aimed level, the round goes over it.
      if (aimed?.alive === true && (aimed.standing || pitch === "down")) {
        const to = pointOn(aimed, pitch);
        const hit = ctx.physics.directSpaceState.intersectRay({
          collisionMask: WORLD_LAYER | HOSTILE_LAYER,
          from,
          to,
        });
        // A zombie standing in the line takes the round meant for the one behind it.
        victim = hit === undefined ? aimed : byBody.get(hit.body.id);
      } else {
        survivor.facingVector(facing);
        // Aimed high the round still meets a head within the critical range (capsule top 1.82 m).
        const slope = pitch === "up" ? 0.15 : pitch === "down" ? -0.12 : 0;
        const to = aimPoint
          .copy(from)
          .addScaledVector(facing, SHOT_RANGE)
          .setY(from.y + slope * SHOT_RANGE);
        const hit = ctx.physics.directSpaceState.intersectRay({
          collisionMask: WORLD_LAYER | HOSTILE_LAYER,
          from,
          to,
        });
        if (hit !== undefined) victim = byBody.get(hit.body.id);
      }
      if (victim === undefined) {
        emitPlaytestEvent({ entity: "player", name: "missed" });
        return;
      }
      const distance = victim.mesh.position.distanceTo(survivor.mesh.position);
      const critical =
        pitch === "up" &&
        victim.standing &&
        distance <= CRITICAL_RANGE &&
        ctx.random() < CRITICAL_CHANCE;
      const amount = Math.round(HANDGUN_DAMAGE * (0.75 + ctx.random() * 0.375));
      const wasAlive = victim.alive;
      victim.takeHit(amount, critical, survivor);
      stats.hits += 1;
      if (critical) {
        stats.criticals += 1;
        emitPlaytestEvent({ entity: "player", name: "critical" });
      }
      emitPlaytestEvent({ amount, entity: "player", name: "hit" });
      if (wasAlive && !victim.alive) {
        stats.kills += 1;
        emitPlaytestEvent({ entity: "player", name: "kill" });
      }
    };

    const handgun = createHandgun();
    const survivor = new Survivor(
      ctx,
      mannequin,
      handgun,
      carried,
      {
        acquire,
        keeps: (target, pitch) => {
          const zombie = target as Zombie;
          return (
            zombie.alive &&
            zombie.state !== "rising" &&
            (zombie.standing || pitch === "down") &&
            zombie.mesh.position.distanceTo(survivor.mesh.position) <= AIM_REACH
          );
        },
        died: () => emitPlaytestEvent({ entity: "player", name: "died" }),
        dry: () => {
          stats.dryFires += 1;
          message("Click. Out of ammunition.");
          emitPlaytestEvent({ entity: "player", name: "dry-fire" });
        },
        hurt: (amount) => emitPlaytestEvent({ amount, entity: "player", name: "hurt" }),
        shot,
      },
      {
        heading: save?.heading ?? SPAWN.facing,
        health: save?.health ?? 100,
        magazine: save?.magazine ?? START_MAGAZINE,
        position: new Vector3(
          save?.position[0] ?? SPAWN.at[0],
          0.92,
          save?.position[1] ?? SPAWN.at[1],
        ),
      },
    );
    survivorRef.value = survivor;
    ctx.entities.add("player", survivor);

    const dead = new Set(save?.dead ?? []);
    for (const spawn of ZOMBIES) {
      if (dead.has(spawn.id)) continue;
      const zombie = new Zombie(ctx, mannequin, zombieMaterial, spawn);
      zombies.push(zombie);
      ids.set(zombie, spawn.id);
      byBody.set(zombie.bodyId, zombie);
      ctx.entities.add(spawn.id, zombie);
    }

    const fixedCamera = createFixedCamera(camera);
    const cutToSurvivor = (): void => {
      const position = survivor.mesh.position;
      const zone = zoneAt(position.x, position.z, fixedCamera.zone());
      if (zone !== undefined) fixedCamera.cut(zone, position);
    };
    cutToSurvivor();
    afterPhysics(ctx, (dt) => {
      cutToSurvivor();
      fixedCamera.follow(survivor.mesh.position, dt);
    });

    // --- what is in front of the survivor -------------------------------------------------------
    const nearest = (): Use | undefined => {
      const position = survivor.mesh.position;
      survivor.facingVector(facing);
      let best: Use | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      const consider = (x: number, z: number, reach: number, use: Use): void => {
        toTarget.set(x - position.x, 0, z - position.z);
        const distance = toTarget.length();
        if (distance > reach || distance >= bestDistance) return;
        if (distance > 0.2 && toTarget.normalize().dot(facing) < Math.cos(USE_HALF_ANGLE)) return;
        best = use;
        bestDistance = distance;
      };
      for (const pickup of PICKUPS)
        if (!taken.has(pickup.id))
          consider(pickup.at[0], pickup.at[2], REACH, { kind: "pickup", pickup });
      for (const door of DOORS)
        consider(door.at[0], door.at[1], DOOR_REACH, { door, kind: "door" });
      for (const furniture of FURNITURE) {
        if (furniture.kind !== "box" && furniture.kind !== "typewriter") continue;
        // The nearest point of the piece, so a deep desk is reachable from its front edge.
        const x = Math.min(Math.max(position.x, furniture.min[0]), furniture.max[0]);
        const z = Math.min(Math.max(position.z, furniture.min[1]), furniture.max[1]);
        consider(x, z, REACH * 0.8, { furniture, kind: "furniture" });
      }
      return best;
    };
    const promptOf = (use: Use | undefined): string => {
      if (use === undefined) return "";
      if (use.kind === "pickup") return `Take ${ITEMS[use.pickup.item].label}`;
      if (use.kind === "door")
        return use.door.lock !== undefined && !unlocked.has(use.door.id)
          ? "Try the door"
          : "Open the door";
      return use.furniture.kind === "box" ? "Open the item box" : "Use the typewriter";
    };

    let menu: Menu = "none";
    let cursor = 0;
    let column: "case" | "box" = "case";
    let doorTimer = 0;
    let doorTarget: IDoor | undefined;
    let doorPassed = false;
    let elapsed = 0;

    const openDoor = (door: IDoor): void => {
      if (door.lock !== undefined && !unlocked.has(door.id)) {
        if (carried.count(door.lock) === 0) {
          stats.lockedTries += 1;
          message("It's locked. The handle won't turn.");
          emitPlaytestEvent({ entity: "player", name: "locked" });
          return;
        }
        // A key is spent on the lock it opens, and the case gets its slot back.
        carried.take(door.lock, 1);
        unlocked.add(door.id);
        unlocked.add(door.to);
        message(`You used the ${ITEMS[door.lock].label}.`);
        emitPlaytestEvent({ entity: "player", name: "unlocked" });
      }
      menu = "door";
      doorTimer = DOOR_TIME;
      doorTarget = door;
      doorPassed = false;
      stats.doorsOpened += 1;
      emitPlaytestEvent({ entity: "player", name: "door" });
    };

    const passDoor = (door: IDoor): void => {
      if (door.to === "outside") {
        lastSave = undefined;
        // The run is over: lift the black so the ending is what the player sees.
        menu = "none";
        ctx.state.set({ phase: "won" });
        emitPlaytestEvent({ entity: "player", name: "escaped" });
        return;
      }
      const exit = doorById(door.to);
      survivor.place(
        new Vector3(
          exit.at[0] + exit.inward[0] * 0.95,
          survivor.mesh.position.y,
          exit.at[1] + exit.inward[1] * 0.95,
        ),
        Math.atan2(exit.inward[0], exit.inward[1]),
      );
      cutToSurvivor();
    };

    const take = (pickup: IPickup): void => {
      if (!carried.fits(pickup.item, pickup.quantity)) {
        stats.refused += 1;
        message("You can't carry any more. The item box is in the save room.");
        emitPlaytestEvent({ entity: "player", name: "refused" });
        return;
      }
      carried.add(pickup.item, pickup.quantity);
      taken.add(pickup.id);
      const model = mansion.pickups.get(pickup.id);
      if (model !== undefined) model.visible = false;
      stats.pickups += 1;
      survivor.pickup();
      message(
        pickup.quantity > 1
          ? `Picked up ${ITEMS[pickup.item].label} (${pickup.quantity}).`
          : `Picked up the ${ITEMS[pickup.item].label}.`,
      );
      emitPlaytestEvent({ entity: "player", name: "pickup" });
    };

    const typewriter = (): void => {
      if (carried.take("ribbon", 1) === 0) {
        stats.saveRefused += 1;
        message("You need an Ink Ribbon to save.");
        emitPlaytestEvent({ entity: "player", name: "save-refused" });
        return;
      }
      stats.saveCount += 1;
      lastSave = {
        box: itemBox.snapshot(),
        dead: zombies.filter((zombie) => !zombie.alive).map((zombie) => zombieId(zombie)),
        heading: survivor.heading,
        health: survivor.health,
        magazine: survivor.magazine,
        position: [survivor.mesh.position.x, survivor.mesh.position.z],
        saveCount: stats.saveCount,
        slots: carried.snapshot(),
        taken: [...taken],
        unlocked: [...unlocked],
      };
      message(`Progress saved. Ink Ribbons left: ${carried.count("ribbon")}.`);
      emitPlaytestEvent({ entity: "player", name: "saved" });
    };
    const use = (target: Use): void => {
      if (target.kind === "pickup") take(target.pickup);
      else if (target.kind === "door") openDoor(target.door);
      else if (target.furniture.kind === "typewriter") typewriter();
      else {
        menu = "box";
        cursor = 0;
        column = "case";
      }
    };

    /** The selected case item, used: herbs heal, bullets load the gun. */
    const useItem = (index: number): void => {
      const stack = carried.slots[index];
      if (stack === undefined) return;
      if (stack.item === "herb" || stack.item === "mixed") {
        if (survivor.health >= survivor.maxHealth) {
          message("You don't need that right now.");
          return;
        }
        carried.removeAt(index);
        survivor.heal(stack.item === "mixed" ? MIXED_HEAL : HERB_HEAL);
        stats.herbsUsed += 1;
        message(stack.item === "mixed" ? "You feel much better." : "You feel a little better.");
        emitPlaytestEvent({ entity: "player", name: "healed" });
      } else if (stack.item === "ammo" && carried.count("handgun") === 0) {
        message("There is nothing to load these into.");
      } else if (stack.item === "ammo") {
        const loaded = carried.take("ammo", MAGAZINE - survivor.magazine);
        survivor.magazine += loaded;
        message(loaded > 0 ? "Loaded the handgun." : "The handgun is full.");
      } else if (stack.item === "key") message("A small key. Use it on a door.");
      else if (stack.item === "ribbon") message("Use it at a typewriter to save.");
      else message("The handgun. Hold aim to raise it.");
    };

    /** Combine on a green herb: it takes another from the case, and the two share one slot. */
    const combine = (index: number): void => {
      const stack = carried.slots[index];
      if (stack?.item !== "herb" || carried.count("herb") < 2) {
        message(
          stack?.item === "herb" ? "There is nothing to mix it with." : "It can't be combined.",
        );
        return;
      }
      carried.removeAt(index);
      carried.take("herb", 1);
      carried.add("mixed", 1);
      stats.combined += 1;
      message("Mixed the herbs.");
      emitPlaytestEvent({ entity: "player", name: "combined" });
    };

    const transfer = (): void => {
      if (column === "case") {
        const stack = carried.removeAt(cursor);
        if (stack !== undefined) itemBox.add(stack.item, stack.quantity);
        emitPlaytestEvent({ entity: "player", name: "stored" });
        return;
      }
      const stack = itemBox.slots[cursor];
      if (stack === undefined) return;
      if (!carried.fits(stack.item, stack.quantity)) {
        message("You can't carry any more.");
        return;
      }
      itemBox.removeAt(cursor);
      carried.add(stack.item, stack.quantity);
      emitPlaytestEvent({ entity: "player", name: "retrieved" });
    };

    const view = (inventory: Inventory): SlotView[] =>
      inventory.slots.map((stack) => ({ ...stack, label: ITEMS[stack.item].label }));

    ctx.state.set({ ...stats, phase: "playing", menu: "none", message: "", messageTime: 0 });
    // Collect only after the characters and the wing are attached.
    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, lighting.key, {
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

    let lastStep = 0;
    let lastSlots = "";
    let aimLatched = false;
    const frame: Partial<GameState> = {};
    return (frameCtx, dt) => {
      loading.update();
      const input = frameCtx.input;
      const state = frameCtx.state.getState();
      // N is a new game at any moment. Enter only answers the end screens: after a death it continues
      // from the last typewriter save, after the escape it starts again.
      if (
        input.justPressed("newGame") ||
        (input.justPressed("restart") && state.phase !== "playing")
      ) {
        if (input.justPressed("newGame")) lastSave = undefined;
        void frameCtx.goto("play");
        return;
      }
      if (UNDER_PLAYTEST && input.justPressed("probeHurt")) survivor.takeDamage(20);
      if (UNDER_PLAYTEST && input.justPressed("probeKey") && carried.add("key", 1) === 0)
        message("Probe: the Study Key.");
      const move = input.vector("move");
      const touch = touchControls?.update(input.raw.pointers, frameCtx.viewport.size);
      if (touch !== undefined) {
        move.x += touch.move.x;
        move.y += touch.move.y;
        move.clampLength(0, 1);
      }
      // Menus read the stick one step at a time.
      const step = Math.abs(move.y) > 0.5 ? Math.sign(move.y) : 0;
      const stepPressed = step !== 0 && step !== lastStep ? step : 0;
      lastStep = step;
      const action = input.justPressed("action") || touch?.attackPressed === true;
      if (touch?.abilityPressed === true) aimLatched = !aimLatched;
      const playing = state.phase === "playing" && !survivor.dead;

      if (playing && menu === "door") {
        doorTimer -= dt;
        if (!doorPassed && doorTimer <= DOOR_TIME / 2 && doorTarget !== undefined) {
          doorPassed = true;
          passDoor(doorTarget);
        }
        if (doorTimer <= 0) menu = "none";
      } else if (playing && (menu === "inventory" || menu === "box")) {
        const rows = (menu === "box" && column === "box" ? itemBox : carried).slots.length;
        const closing = input.justPressed("inventory") || input.justPressed("back");
        if (stepPressed !== 0)
          cursor = Math.max(0, Math.min(Math.max(0, rows - 1), cursor - stepPressed));
        if (menu === "box" && Math.abs(move.x) > 0.5) {
          const next = move.x > 0 ? "box" : "case";
          if (next !== column) {
            column = next;
            cursor = 0;
          }
        }
        if (action) {
          if (menu === "inventory") useItem(cursor);
          else transfer();
        }
        if (menu === "inventory" && input.justPressed("combine")) combine(cursor);
        // Closed last: a close and an action on the same frame must not act on a shut menu.
        if (closing) menu = "none";
        const after = (menu === "box" && column === "box" ? itemBox : carried).slots.length;
        cursor = Math.min(cursor, Math.max(0, after - 1));
      } else if (playing) {
        if (input.justPressed("inventory") && survivor.state === "free") {
          menu = "inventory";
          cursor = 0;
        }
        if (survivor.state === "held") {
          if (action || input.justPressed("struggle")) {
            survivor.struggle();
            (survivor.holder as Zombie | undefined)?.struggle();
          }
        } else if (action && survivor.state === "free") {
          const target = nearest();
          if (target !== undefined) use(target);
        }
      }

      const frozen = menu !== "none" || state.phase !== "playing";
      if (!frozen || survivor.dead) {
        const hasGun = carried.count("handgun") > 0;
        handgun.visible = hasGun;
        survivor.update(frameCtx, dt, {
          aim: hasGun && (input.pressed("aim") || aimLatched),
          backPressed: stepPressed < 0,
          fire: action,
          forward: move.y,
          reload: hasGun && input.justPressed("reload"),
          run: input.pressed("run"),
          runPressed: input.justPressed("run"),
          turn: move.x,
        });
        const room = roomAt(survivor.mesh.position.x, survivor.mesh.position.z)?.id;
        // Zombies wait for first-use compilation, so a scenario's timings do not depend on the GPU.
        if (frameCtx.startup.compileSettled)
          for (const zombie of zombies) {
            const wasAlive = zombie.alive;
            const before = zombie.bites + zombie.escapes;
            zombie.update(dt, survivor, room);
            if (zombie.bodyId !== -1) byBody.set(zombie.bodyId, zombie);
            if (zombie.bites + zombie.escapes !== before) {
              stats.bites = zombies.reduce((total, entry) => total + entry.bites, 0);
              stats.escapes = zombies.reduce((total, entry) => total + entry.escapes, 0);
            }
            if (wasAlive && !zombie.alive)
              emitPlaytestEvent({ entity: zombieId(zombie), name: "dead" });
          }
      }
      if (survivor.dead && state.phase === "playing") frameCtx.state.set({ phase: "lost" });
      if (state.phase === "playing") elapsed += dt;

      const zone = fixedCamera.zone();
      frame.menu = menu;
      frame.cursor = cursor;
      frame.column = column;
      frame.room = roomAt(survivor.mesh.position.x, survivor.mesh.position.z)?.label ?? state.room;
      frame.cameraZone = zone?.id ?? "";
      frame.cameraCuts = fixedCamera.cuts();
      frame.health = survivor.health;
      frame.condition = survivor.condition;
      frame.magazine = survivor.magazine;
      frame.reserve = survivor.reserve;
      frame.aiming = survivor.state === "aim" ? 1 : 0;
      frame.grabbed = survivor.state === "held" ? 1 : 0;
      // Arrays cross the bridge only when they change.
      const slotsKey = JSON.stringify(carried.slots) + JSON.stringify(itemBox.slots);
      if (slotsKey !== lastSlots) {
        lastSlots = slotsKey;
        frame.slots = view(carried);
        frame.box = view(itemBox);
      } else {
        delete frame.slots;
        delete frame.box;
      }
      frame.prompt =
        playing && menu === "none" && survivor.state === "free" ? promptOf(nearest()) : "";
      frame.messageTime = Math.max(0, state.messageTime - dt);
      if (frame.messageTime === 0 && state.message !== "") frame.message = "";
      else delete frame.message;
      frame.time = quantize(elapsed);
      Object.assign(frame, {
        bites: stats.bites,
        criticals: stats.criticals,
        doorsOpened: stats.doorsOpened,
        dryFires: stats.dryFires,
        escapes: stats.escapes,
        combined: stats.combined,
        hasSave: lastSave !== undefined,
        herbsUsed: stats.herbsUsed,
        hits: stats.hits,
        kills: stats.kills,
        lockedTries: stats.lockedTries,
        pickups: stats.pickups,
        refused: stats.refused,
        saveCount: stats.saveCount,
        saveRefused: stats.saveRefused,
        shots: stats.shots,
      });
      frameCtx.state.set(frame);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    super.exit(ctx);
  }
}
