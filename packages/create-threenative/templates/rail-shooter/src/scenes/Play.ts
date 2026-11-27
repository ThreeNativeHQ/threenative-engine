import {
  CameraShake,
  type ICtx,
  Scene,
  type SceneFrame,
  getPlatform,
  isMobile,
} from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import { type Mesh, type PerspectiveCamera, Vector3 } from "three";
import { Boss } from "../entities/Boss.js";
import type { Enemy, IShipView } from "../entities/Enemy.js";
import { Ship } from "../entities/Ship.js";
import type { ITarget } from "../entities/Target.js";
import { Weapons } from "../entities/Weapons.js";
import { ARENA_BACK, PICKUPS, RAIL_POINTS, START_S, WAVES } from "../level.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { Rail, createFrame } from "../rail.js";
import { createRailCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { Bursts, Sights } from "../render/effects.js";
import { createShieldRing } from "../render/hulls.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { createScenery } from "../render/scenery.js";
import { SUN_DIRECTION, setupSky } from "../render/sky.js";
import type { GamePhase, GameState } from "../state.js";
import { BOSS, CAMERA, ENEMY, SHIELD } from "../tuning.js";
import { INITIAL_STATE } from "./initialState.js";
import { createStations } from "./stations.js";
import { createWave } from "./waves.js";

type GameCtx = ICtx<GameState>;

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;
const MESSAGE_TIME = 2.2;
/** After the core falls the boss burns this long before the score card. */
const DEATH_TIME = 2.2;

const round = (value: number, scale = 100): number => Math.round(value * scale) / scale;

export class Play extends Scene<GameState> {
  static override readonly initialState: GameState = INITIAL_STATE;

  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
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

  override enter(ctx: GameCtx): SceneFrame<GameState> {
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

    // The world: one rail, the plain and pylons around it, the ship, its fire and the boss.
    const rail = new Rail(RAIL_POINTS);
    const arenaStop = rail.length - ARENA_BACK;
    const scenery = createScenery(rail);
    ctx.add(scenery.group);
    const ship = new Ship(rail, arenaStop);
    ship.s = START_S;
    ctx.add(ship.group);
    ctx.interpolate(ship.group);
    ctx.entities.add("player", ship);
    const weapons = new Weapons();
    ctx.add(weapons.group);
    const bursts = new Bursts();
    ctx.add(bursts.group);
    const sights = new Sights();
    ctx.add(sights.reticle);
    ctx.add(sights.mark);
    const boss = new Boss();
    ctx.add(boss.group);
    ctx.entities.add("boss", boss);
    const cameraRig = createRailCamera(camera);
    const shake = new CameraShake({
      amplitude: new Vector3(0.45, 0.3, 0),
      rotationAmplitude: new Vector3(0, 0, 0),
      frequency: 14,
      decay: 5,
      curve: Math.sin,
    });
    const rings = PICKUPS.map(([s, x, y]) => {
      const ring = createShieldRing() as Mesh;
      ctx.add(ring);
      rail.worldAt(s, x, y, ring.position, createFrame());
      return { ring, s, taken: false };
    });

    // Scratch objects the frame reuses.
    const behind = createFrame();
    const ahead = createFrame();
    const arena = createFrame();
    const scratch = createFrame();
    const shipView: IShipView = {
      position: ship.position,
      velocity: ship.velocity,
      forward: ship.frame.forward,
    };
    const enemies: Enemy[] = [];
    const rig = {
      world: (distance: number, x: number, y: number, out: Vector3): Vector3 =>
        rail.worldAt(ship.s + distance, ship.offsetX + x, ship.offsetY + y, out, scratch),
    };
    const addEnemy = (enemy: Enemy): void => {
      enemies.push(enemy);
      ctx.add(enemy.group);
      ctx.entities.add(`enemy.${enemy.id}`, enemy);
    };

    // The run's counters. The store is rewritten from these every tick, so a restart starts clean.
    let wave = 0;
    let kills = 0;
    let lockedKills = 0;
    let hits = 0;
    let deflected = 0;
    let score = 0;
    let pickups = 0;
    let missionTime = 0;
    let message = "";
    let messageTimer = 0;
    // Local, and published every tick: a restart through `goto` keeps the store, so this is what resets it.
    let phase: GamePhase = "playing";
    let deathBurst = 0;
    let coreAnnounced = false;
    const say = (text: string): void => {
      message = text;
      messageTimer = MESSAGE_TIME;
    };

    const spawnWave = (index: number): void => {
      const spec = WAVES[index];
      if (spec === undefined) return;
      for (const enemy of createWave(spec, index, rail, scratch)) addEnemy(enemy);
      wave = index + 1;
      say(`WAVE ${wave}`);
      emitPlaytestEvent({ entity: "director", name: "wave", wave });
    };

    const stations = createStations({
      ship,
      weapons,
      boss,
      addEnemy,
      arenaStop,
      skipTo: (s) => {
        ship.s = s;
        wave = Math.max(wave, WAVES.filter((spec) => spec.trigger <= s).length);
      },
    });
    const stationNames = Object.keys(stations);

    const events = {
      onHit: (target: ITarget, kind: string): void => {
        hits += 1;
        bursts.spawn(target.position, 0.7);
        if (kind === "homing" && !target.live) lockedKills += 1;
        emitPlaytestEvent({ entity: target.id, name: "hit" });
      },
      onDeflect: (): void => {
        deflected += 1;
        emitPlaytestEvent({ entity: "player", name: "deflect" });
      },
      onStruck: (damage: number): void => {
        // A shot still in the air after the run ends must not change the result.
        if (phase !== "playing" || boss.defeated || !ship.hit(damage)) return;
        shake.trigger();
        say("HIT");
        emitPlaytestEvent({ entity: "player", name: "struck" });
      },
    };

    // Seat the camera behind the ship before the first frame.
    const cameraInput = {
      behind,
      ahead,
      offsetX: 0,
      offsetY: 0,
      push: 0,
      bank: 0,
      shake: new Vector3(),
    };
    const seat = (snap: boolean, dt: number): void => {
      rail.frameAt(ship.s - CAMERA.back, behind);
      rail.frameAt(ship.s + CAMERA.look, ahead);
      cameraInput.offsetX = ship.offsetX;
      cameraInput.offsetY = ship.offsetY;
      cameraInput.push = ship.mode === "boost" ? 1 : ship.mode === "brake" ? -1 : 0;
      cameraInput.bank = ship.bank;
      cameraInput.shake.copy(shake.update(dt).position);
      if (snap) cameraRig.snap(cameraInput);
      else cameraRig.follow(cameraInput, dt);
    };
    ship.update(ctx.input, 0, true);
    seat(true, 0);
    const frame: Partial<GameState> = {};

    return (frameCtx, dt) => {
      loading.update();
      if (frameCtx.input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      const playing = phase === "playing";
      for (const name of UNDER_PLAYTEST ? stationNames : []) {
        if (!frameCtx.input.justPressed(name)) continue;
        stations[name]?.();
        emitPlaytestEvent({ entity: "player", name });
      }

      const flying = playing && frameCtx.startup.compileSettled;
      if (flying) missionTime += dt;
      ship.update(frameCtx.input, dt, flying);

      // Waves appear as the ship reaches their trigger.
      while (wave < WAVES.length && ship.s >= (WAVES[wave]?.trigger ?? Number.POSITIVE_INFINITY))
        spawnWave(wave);

      // The boss hangs ahead of the end of the rail, facing back at the ship.
      rail.frameAt(arenaStop + BOSS.ahead, arena);
      const fallen = boss.update(dt, shipView, arena.position, arena, weapons);
      for (const event of fallen) {
        score += event.score;
        bursts.spawn(event.at, event.core ? 6 : 3.4);
        say(event.core ? "CORE DESTROYED" : "WEAK POINT DOWN");
        emitPlaytestEvent({ entity: "boss", name: event.core ? "core-down" : "pod-down" });
      }
      if (boss.phase === 2 && !coreAnnounced) {
        coreAnnounced = true;
        say("CORE EXPOSED");
      }
      if (boss.dying > 0) {
        deathBurst -= dt;
        if (deathBurst <= 0) {
          deathBurst = 0.18;
          const spin = boss.dying * 9;
          bursts.spawn(
            boss.group.position
              .clone()
              .add(new Vector3(Math.sin(spin) * 5, Math.cos(spin * 1.3) * 2, 0)),
            3 + Math.abs(Math.sin(spin)) * 2,
          );
        }
      }

      // Enemies fly, fire and die; a dead or escaped one leaves the world.
      for (const enemy of [...enemies]) {
        enemy.update(dt, shipView, rig, weapons);
        if (enemy.killed) {
          kills += 1;
          score += ENEMY[enemy.kind].score;
          bursts.spawn(enemy.position, enemy.kind === "gunship" ? 4 : 2.4);
          emitPlaytestEvent({ entity: enemy.id, name: "destroyed" });
        }
        if (enemy.killed || enemy.escaped) {
          enemies.splice(enemies.indexOf(enemy), 1);
          frameCtx.entities.remove(`enemy.${enemy.id}`);
        }
      }

      // Shield rings repair the hull.
      for (const entry of rings) {
        entry.ring.rotation.y += dt * 1.6;
        entry.ring.visible = !entry.taken;
        if (playing && !entry.taken && entry.ring.position.distanceTo(ship.position) < 3.4) {
          entry.taken = true;
          pickups += 1;
          ship.heal(SHIELD.pickup);
          say("SHIELD REPAIRED");
          emitPlaytestEvent({ entity: "player", name: "pickup" });
        }
      }

      // Fire: lasers and the charged lock-on shot go toward the reticle.
      const targets: ITarget[] = [...enemies.filter((enemy) => enemy.live), ...boss.targets];
      const triggerInput = {
        pressed: playing && frameCtx.input.pressed("fire"),
        justPressed: playing && frameCtx.input.justPressed("fire"),
        justReleased: playing && frameCtx.input.justReleased("fire"),
      };
      weapons.trigger(triggerInput, dt, ship.nose, ship.reticle, ship.velocity, targets);
      weapons.update(dt, ship.position, ship.rolling, targets, events);

      // The sights and the world follow the ship.
      sights.reticle.position.copy(ship.reticle);
      sights.mark.visible = weapons.mark !== undefined;
      if (weapons.mark !== undefined) {
        sights.mark.position.copy(weapons.mark.position);
        sights.mark.scale.setScalar(weapons.mark.radius * 1.6);
      }
      sights.face(camera);
      bursts.update(dt);
      scenery.follow(ship.position.x, ship.position.z);
      lighting.key.position.copy(ship.position).addScaledVector(SUN_DIRECTION, 40);
      lighting.target.position.copy(ship.position);
      seat(false, dt);

      // The run ends on a dead hull or a dead boss.
      if (playing) {
        if (ship.dead) {
          phase = "lost";
          weapons.cancel();
          bursts.spawn(ship.position, 5);
          say("SHIP DESTROYED");
          emitPlaytestEvent({ entity: "player", name: "destroyed" });
        } else if (boss.defeated && boss.dying >= DEATH_TIME) {
          phase = "won";
          weapons.cancel();
          score += Math.round(ship.shield) * 4;
          say("MISSION COMPLETE");
          emitPlaytestEvent({ entity: "player", name: "complete" });
        }
      }

      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      Object.assign(frame, {
        phase,
        shield: round(ship.shield, 10),
        gauge: round(ship.gauge, 10),
        gaugeLocked: ship.gaugeLocked ? 1 : 0,
        mode: ship.mode,
        speed: round(ship.speed, 10),
        railS: round(ship.s, 10),
        railLength: round(arenaStop, 10),
        offsetX: round(ship.offsetX),
        offsetY: round(ship.offsetY),
        bank: round((ship.bank * 180) / Math.PI, 10),
        rolling: ship.rolling ? 1 : 0,
        rolls: ship.rolls,
        deflected,
        aimX: round(ship.aimX),
        aimY: round(ship.aimY),
        shots: weapons.shots,
        hits,
        charge: round(weapons.charge),
        locked: weapons.mark?.id ?? "",
        homingShots: weapons.homingShots,
        lockedKills,
        wave,
        enemiesLive: enemies.filter((enemy) => enemy.live).length,
        kills,
        enemyShots: weapons.enemyShots,
        score,
        pickups,
        bossPhase: boss.phase,
        bossPods: boss.podsLeft,
        bossHp: round(Math.max(0, boss.core.hp) / BOSS.core.hp),
        message,
        missionTime: round(missionTime, 10),
      } satisfies Partial<GameState>);
      frameCtx.state.set(frame);
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
