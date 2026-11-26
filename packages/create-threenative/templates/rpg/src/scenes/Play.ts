import {
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  buildStaticColliders,
} from "@threenative/physics";
import { type PerspectiveCamera, Vector3 } from "three";
import { STATS } from "../content.js";
import { ACTOR_LAYER, Actor, WORLD_LAYER } from "../entities/Actor.js";
import type { GameCtx, IMannequin } from "../entities/Fighter.js";
import { ACTORS, FIELD, POST } from "../level.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { STATIONS } from "../playtest-stations.js";
import { createCamp } from "../render/camp.js";
import { createPartyCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { createRing, createTalkMarker } from "../render/props.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import { Dice } from "../rules/dice.js";
import { INTERACTION_DISTANCE } from "../rules/queue.js";
import type { GameState } from "../state.js";
import { collectRunning, directFollowers, directRaiders, stepAction } from "../systems/orders.js";
import { publish } from "../systems/publish.js";
import { Post, TALK_RANGE, World } from "../systems/world.js";

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;
const STATION_NAMES = Object.keys(STATIONS);
const CHOICE_KEYS = ["choice1", "choice2", "choice3", "choice4"] as const;

function statsFor(id: string, team: string) {
  return STATS[id] ?? STATS[id.split(".")[0] ?? ""] ?? STATS[team] ?? STATS.villager;
}

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    attackBonus: 0,
    coins: 0,
    dialogue: undefined,
    inCombat: 0,
    journalOpen: 0,
    kills: 0,
    lastAutomatic: "",
    lastCheck: "",
    lastCheckPassed: 0,
    lastDamage: 0,
    lastOutcome: "",
    lastRoll: 0,
    leader: "hero",
    log: [],
    medpacks: 3,
    message: "",
    missionTime: 0,
    party: [],
    paused: false,
    phase: "playing",
    playerX: 0,
    playerZ: 0,
    prompt: "",
    quests: [],
    roundTime: 0,
    runSpeed: 0,
    shot: "overhead",
    skills: [],
    target: "",
    targetDefense: 0,
    targetHp: 0,
    targetName: "",
    uiReady: false,
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for everyone: the party, the villagers and the raiders are the combat mannequin
    // (Quaternius' Universal Animation Library, CC0), dressed apart by a material swap.
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
    const cameraRig = createPartyCamera(camera);
    ctx.viewport.resize();
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    // The camp and the ruin: walls and crates collide, the floor does not.
    const camp = createCamp();
    ctx.add(camp.dressing);
    ctx.add(camp.solid);
    const colliders = { collisionLayer: WORLD_LAYER, collisionMask: ACTOR_LAYER };
    buildStaticColliders(ctx, camp.solid, colliders);
    new RigidBody3D({
      ...colliders,
      physics: ctx.physics,
      position: { x: 0, y: -0.5, z: 0 },
      shape: CollisionShape3D.box(FIELD.halfWidth * 2, 1, FIELD.halfDepth * 2),
      type: "fixed",
    });

    const actors = ACTORS.map((spec) => {
      const actor = new Actor(ctx, mannequin, spec, statsFor(spec.id, spec.team));
      ctx.entities.add(spec.id, actor);
      return actor;
    });
    const world = new World(actors, new Post(POST.x, POST.z), new Dice(ctx.random));
    const leaderRing = createRing(0x2a6cf0, 0.55, 0.7);
    const targetRing = createRing(0xd0532a, 0.6, 0.78);
    targetRing.visible = false;
    ctx.add(leaderRing);
    ctx.add(targetRing);
    const markers = new Map<string, ReturnType<typeof createTalkMarker>>();
    for (const actor of actors) {
      if (actor.treeId === "") continue;
      const marker = createTalkMarker();
      actor.mesh.add(marker);
      markers.set(actor.id, marker);
    }
    cameraRig.snap(world.leader.position);
    afterPhysics(ctx, (dt) => {
      if (world.conversation.open) {
        const npc = world.actors.get(world.npc);
        if (npc !== undefined) cameraRig.converse(world.leader.position, npc.position, dt);
      } else cameraRig.follow(world.leader.position, dt);
    });

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

    let missionTime = 0;
    let touchAttack = false;
    let touchHeal = false;
    const publisher = publish(world);
    const move = new Vector3();
    return (frameCtx, dt) => {
      loading.update();
      const input = frameCtx.input;
      if (input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      for (const name of UNDER_PLAYTEST ? STATION_NAMES : []) {
        if (!input.justPressed(name)) continue;
        STATIONS[name]?.(world);
        emitPlaytestEvent({ entity: world.leader.id, name });
      }
      const playing = world.phase === "playing";
      const touch = touchControls?.update(input.raw.pointers, frameCtx.viewport.size);
      const leader = world.leader;
      for (const actor of actors) actor.settle();
      world.retarget();

      if (playing && frameCtx.startup.compileSettled) {
        missionTime += dt;
        if (world.conversation.open) {
          for (let index = 0; index < CHOICE_KEYS.length; index += 1)
            if (input.justPressed(CHOICE_KEYS[index] ?? "choice1")) world.choose(index);
          if (input.justPressed("leave")) {
            world.conversation.close();
            world.npc = "";
          }
        } else {
          // Commands that queue work on the leader. They queue; the queue runs below.
          const attackKey = input.justPressed("attack") || (touch?.attackPressed === true && !touchAttack);
          const healKey = input.justPressed("heal") || (touch?.abilityPressed === true && !touchHeal);
          touchAttack = touch?.attackPressed === true;
          touchHeal = touch?.abilityPressed === true;
          if (attackKey && world.targetId !== "")
            leader.queue.push({ kind: "attack", started: false, target: world.targetId });
          if (healKey) {
            const weakest = world.members
              .filter((member) => member.alive && member.hp < member.maxHp)
              .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
            if (weakest !== undefined) leader.queue.push({ kind: "heal", target: weakest.id });
          }
          if (input.justPressed("talk")) {
            let best: Actor | undefined;
            let bestDistance = TALK_RANGE;
            for (const actor of actors) {
              if (actor.treeId === "" || actor.team !== "villager") continue;
              const distance = actor.position.distanceTo(leader.position);
              if (distance < bestDistance) {
                best = actor;
                bestDistance = distance;
              }
            }
            if (best !== undefined) leader.queue.push({ kind: "talk", npc: best.id });
          }
          if (input.justPressed("target")) world.cycleTarget();
          if (input.justPressed("rotate")) world.rotateLeader();
          if (input.justPressed("journal")) publisher.toggleJournal();

          // The leader: held keys beat the queue and clear it, as in the reference.
          const stick = input.vector("move");
          move.set(stick.x + (touch?.move.x ?? 0), 0, -(stick.y + (touch?.move.y ?? 0)));
          if (move.lengthSq() > 0.01) {
            leader.queue.clear();
            move.normalize().multiplyScalar(10).add(leader.position);
            leader.stepToward(move.x, move.z, !input.pressed("walk"), dt);
          } else leader.queue.update((action) => stepAction(world, leader, action, dt));

          directFollowers(world);
          directRaiders(world);
          for (const actor of actors) {
            if (actor === leader || !actor.alive || actor.team === "villager") continue;
            if (actor.team === "raider" && !world.alerted) continue;
            actor.queue.update((action) => stepAction(world, actor, action, dt));
          }
        }
        world.update(dt);
        collectRunning(world);
      }
      const inCombat = world.inCombat;
      for (const actor of actors) {
        actor.setStance(inCombat);
        if (!actor.acted) actor.rest(dt);
        actor.acted = false;
      }

      leaderRing.position.set(leader.position.x, 0.04, leader.position.z);
      const target = world.targetId === "" ? undefined : world.combatant(world.targetId);
      targetRing.visible = target !== undefined && playing;
      if (target !== undefined) targetRing.position.set(target.position.x, 0.05, target.position.z);
      for (const [id, marker] of markers) {
        const actor = world.actors.get(id);
        marker.visible = actor?.team === "villager";
        marker.position.y = 2.25 + Math.sin(missionTime * 3) * 0.06;
      }
      publisher.frame(frameCtx.state, {
        near: [...actors].some(
          (actor) =>
            actor.team === "villager" &&
            actor.treeId !== "" &&
            actor.position.distanceTo(leader.position) <= INTERACTION_DISTANCE + 4,
        ),
        missionTime,
      });
    };
  }

  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
  }
}
