import {
  CameraShake,
  type ICtx,
  Scene,
  type SceneFrame,
  getPlatform,
  isMobile,
} from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import { type Group, type Mesh, type PerspectiveCamera, type Texture, Vector3 } from "three";
import {
  ENEMIES,
  type EnemyKind,
  type ISpawn,
  STRIKE_COOLDOWN,
  STRIKE_RADIUS,
  TARGET_MODES,
  TOWERS,
  TOWER_KINDS,
  type TargetMode,
  type TowerKind,
  sellValue,
  strikeDamage,
  towerStats,
  upgradeCost,
  waveBonus,
} from "../balance.js";
import { Board } from "../board/Board.js";
import { SAFE_PADS, STARTING_PAD } from "../board/Route.js";
import { CameraRig } from "../camera-rig.js";
import { Economy } from "../economy.js";
import { Effects } from "../effects/Effects.js";
import { Enemy } from "../enemies/Enemy.js";
import { drainIntents } from "../intents.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { setupCamera } from "../render/camera.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { palette } from "../render/palette.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { ghostTower, rangeGeometry, rangeRing } from "../render/shapes.js";
import { setupSky } from "../render/sky.js";
import { type GameState, INITIAL_STATE } from "../state.js";
import { Tower } from "../towers/Tower.js";
import { WaveDirector } from "../waves.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;
type FrameCtx = Parameters<SceneFrame<GameState, IPhysicsContext>>[0];

/** Keys that are nothing but an intent of the same name. */
const KEY_INTENTS = [
  "launch",
  "strike",
  "upgrade",
  "recycle",
  "cancel",
  "help",
  "speed",
  "autosend",
] as const;

const SPEEDS = [1, 2, 3] as const;
/** The strike may land anywhere on the slab, and nowhere off it. */
const STRIKE_BOUNDS = { x: 19, z: 12 } as const;
const LEFT_SHIFT = "ShiftLeft";
const RIGHT_SHIFT = "ShiftRight";

function sameState(a: GameState, b: GameState): boolean {
  for (const key of Object.keys(a) as (keyof GameState)[]) if (a[key] !== b[key]) return false;
  return true;
}

export class Battle extends Scene<GameState, IPhysicsContext> {
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #materialEnvironment(ctx: GameCtx) {
    return {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
  }
  static override readonly initialState = INITIAL_STATE;

  #sky: Texture | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    this.#sky = await ctx.assets.texture("sky.jpg");
    setupSky(ctx.scene, this.#sky);
    this.#environmentSample = await sampleEnvironment(
      ctx.renderer.raw,
      ctx.scene,
      this.#materialEnvironment(ctx),
    );
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#sky === undefined) throw new Error("Battle.enter ran before load() loaded sky.jpg.");
    setupSky(ctx.scene, this.#sky);
    const { key } = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    // isMobile() arrives as an argument because src/render/ imports no framework package: the
    // platform decision is made here, in portable game code.
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: key,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(
          materialLightingEnabled(tier, this.#materialEnvironment(ctx)),
        ),
    });
    const camera = ctx.camera as PerspectiveCamera;
    setupCamera(camera);
    ctx.add(camera);
    const loading = createLoadingScreen(ctx);

    const board = new Board({ add: (object) => ctx.add(object) });
    const effects = new Effects({ add: (object) => ctx.add(object) }, () => ctx.random());
    const rig = new CameraRig();
    const shake = new CameraShake({
      amplitude: new Vector3(0.5, 0.35, 0.5),
      curve: (radians) => Math.sin(radians) * Math.sin(radians * 0.37),
      decay: 5,
      frequency: 19,
      rotationAmplitude: new Vector3(0, 0, 0),
    });
    const economy = new Economy();

    // ── enemies: one pool per kind, built on demand and reused ─────────────────────────────────
    const enemies = new Map<string, Enemy>();
    const pools = new Map<EnemyKind, Enemy[]>();
    let kills = 0;
    let leaks = 0;
    let status: GameState["status"] = "PLAYING";
    let toastText = "";
    let toastSeq = 0;
    const toast = (text: string): void => {
      toastText = text;
      toastSeq += 1;
    };
    const onDefeated = (enemy: Enemy): void => {
      kills += 1;
      economy.reward(ENEMIES[enemy.kind].reward);
      effects.burst(
        enemy.deathPoint,
        palette.enemies[enemy.kind],
        enemy.kind === "titan" ? 28 : 10,
        4.5,
      );
    };
    const onLeak = (enemy: Enemy): void => {
      const lost = ENEMIES[enemy.kind].leak;
      leaks += lost;
      economy.leak(lost);
      waves.markLeak();
      shake.trigger();
      toast(`Reactor hit  -${lost}`);
      if (economy.lives <= 0) status = "LOST";
    };
    const spawnEnemy = (spawn: ISpawn, wave: number): void => {
      let pool = pools.get(spawn.kind);
      if (pool === undefined) {
        pool = [];
        pools.set(spawn.kind, pool);
      }
      let enemy = pool.find((candidate) => !candidate.active);
      if (enemy === undefined) {
        const entityId = `enemy.${spawn.kind}.${pool.length}`;
        enemy = new Enemy({
          id: entityId,
          kind: spawn.kind,
          onDefeated,
          onLeak,
          physics: ctx.physics,
          points: board.points,
        });
        pool.push(enemy);
        enemies.set(entityId, enemy);
        ctx.add(enemy.mesh);
        this.#materialLighting?.enroll(enemy.mesh);
        ctx.entities.add(entityId, enemy);
      }
      enemy.reset(`${enemy.entityId}.w${wave}`, spawn.hp);
    };
    const waves = new WaveDirector({
      onCleared: (wave, leaked) => {
        const bonus = waveBonus(wave, leaked);
        economy.bonus(bonus);
        toast(wave >= 12 ? "The line held" : `Wave ${wave} cleared  +${bonus}`);
        if (waves.won) status = "WON";
      },
      onSpawn: spawnEnemy,
    });

    // ── towers ─────────────────────────────────────────────────────────────────────────────────
    const towers = new Map<string, Tower>();
    const towerAt = new Map<number, Tower>();
    let towerSerial = 0;
    let shots = 0;
    let placementRejects = 0;
    let fundsRejects = 0;
    const world = {
      effects,
      enemies,
      onShot: () => {
        shots += 1;
      },
      query: ctx.physics.directSpaceState,
      random: ctx.random,
    };
    const raise = (kind: TowerKind, pad: number, invested: number): Tower => {
      const id = String(towerSerial);
      towerSerial += 1;
      const tower = new Tower({ id, kind, padIndex: pad, position: board.position(pad), world });
      tower.invested = invested;
      towers.set(id, tower);
      towerAt.set(pad, tower);
      board.occupy(pad);
      ctx.add(tower.group);
      this.#materialLighting?.enroll(tower.group);
      ctx.entities.add(`tower.${id}`, tower);
      return tower;
    };
    raise("sentry", STARTING_PAD, TOWERS.sentry.cost);

    // ── selection, arming and the preview under the pointer ────────────────────────────────────
    let armed: TowerKind | "" = "";
    let strikeArmed = false;
    let strikeTimer = 0;
    let selected: Tower | undefined;
    let hoverPad: number | undefined;
    let helpOpen = false;
    let paused = false;
    let autoSend = false;
    let speedIndex = 0;

    const ghosts = new Map<TowerKind, Group>();
    for (const kind of TOWER_KINDS) {
      const ghost = ghostTower(kind);
      ghost.visible = false;
      ctx.add(ghost);
      ghosts.set(kind, ghost);
    }
    const hoverRing: Mesh = rangeRing(1);
    const selectRing: Mesh = rangeRing(1);
    hoverRing.visible = selectRing.visible = false;
    ctx.add(hoverRing);
    ctx.add(selectRing);
    let hoverRadius = 0;
    let selectRadius = 0;
    const setRing = (ring: Mesh, radius: number): void => {
      ring.geometry.dispose();
      ring.geometry = rangeGeometry(radius);
    };

    const select = (tower: Tower | undefined): void => {
      selected = tower;
      if (tower === undefined) {
        selectRing.visible = false;
        return;
      }
      selectRing.position.set(tower.position.x, 0.09, tower.position.z);
      if (selectRadius !== tower.stats.range) {
        selectRadius = tower.stats.range;
        setRing(selectRing, selectRadius);
      }
      selectRing.visible = true;
    };

    const build = (kind: TowerKind, pad: number, keepArmed: boolean): boolean => {
      if (board.occupied(pad)) {
        placementRejects += 1;
        return false;
      }
      if (!economy.spend(TOWERS[kind].cost)) {
        fundsRejects += 1;
        toast("Not enough credits");
        return false;
      }
      select(raise(kind, pad, TOWERS[kind].cost));
      if (!keepArmed) armed = "";
      emitPlaytestEvent({ entity: `pad.${pad}`, name: "built", kind });
      return true;
    };

    const strike = (at: Vector3): void => {
      if (Math.abs(at.x) > STRIKE_BOUNDS.x || Math.abs(at.z) > STRIKE_BOUNDS.z) {
        toast("Target the board");
        return;
      }
      strikeArmed = false;
      strikeTimer = STRIKE_COOLDOWN;
      const damage = strikeDamage(Math.max(1, waves.wave));
      const centre = new Vector3(at.x, 0, at.z);
      effects.column(centre, palette.effects.strike);
      effects.ring(centre, STRIKE_RADIUS, palette.effects.strike, 0.6);
      effects.burst(centre, palette.effects.strike, 36, 7);
      shake.trigger();
      for (const enemy of enemies.values())
        if (
          enemy.active &&
          Math.hypot(enemy.position.x - at.x, enemy.position.z - at.z) <= STRIKE_RADIUS
        )
          enemy.takeDamage(damage);
      emitPlaytestEvent({ entity: "strike", name: "struck", damage });
    };

    const tapPad = (pad: number | undefined, point: Vector3): void => {
      if (status !== "PLAYING" || paused) return;
      if (strikeArmed) {
        strike(point);
        return;
      }
      if (pad === undefined) {
        select(undefined);
        return;
      }
      const there = towerAt.get(pad);
      if (there !== undefined) {
        select(selected === there ? undefined : there);
        return;
      }
      if (armed === "") {
        toast("Choose a tower from the armory");
        return;
      }
      const shift = ctx.input.raw.keys.has(LEFT_SHIFT) || ctx.input.raw.keys.has(RIGHT_SHIFT);
      build(armed, pad, shift);
    };
    ctx.pointer?.on(board.hits, "pointerEntered", (event) => {
      hoverPad = board.padOf(event.object);
    });
    ctx.pointer?.on(board.hits, "pointerExited", () => {
      hoverPad = undefined;
    });
    ctx.pointer?.on(board.hits, "tapped", (event) =>
      tapPad(board.padOf(event.object), event.point),
    );
    ctx.pointer?.on(board.ground, "tapped", (event) => tapPad(undefined, event.point));

    const upgrade = (): void => {
      const tower = selected;
      if (tower === undefined) return;
      const cost = upgradeCost(tower.kind, tower.level);
      if (cost === undefined) {
        toast("Already at MK.III");
        return;
      }
      if (!economy.spend(cost)) {
        fundsRejects += 1;
        toast("Not enough credits");
        return;
      }
      tower.invested += cost;
      const oldGroup = tower.group;
      this.#materialLighting?.release(oldGroup);
      tower.upgrade();
      this.#materialLighting?.enroll(tower.group);
      select(tower);
      setRing(selectRing, tower.stats.range);
      selectRadius = tower.stats.range;
      emitPlaytestEvent({ entity: `tower.${tower.id}`, name: "upgraded", level: tower.level });
    };
    const recycle = (): void => {
      const tower = selected;
      if (tower === undefined) return;
      const refund = sellValue(tower.invested);
      economy.refund(Math.max(1, refund));
      board.free(tower.padIndex);
      towerAt.delete(tower.padIndex);
      towers.delete(tower.id);
      select(undefined);
      this.#materialLighting?.release(tower.group);
      ctx.entities.remove(`tower.${tower.id}`);
      toast(`Recycled  +${refund}`);
    };
    const safeBuild = (): void => {
      const pad = SAFE_PADS.find((candidate) => !board.occupied(candidate));
      if (pad === undefined) {
        placementRejects += 1;
        toast("No free pads");
        return;
      }
      build(armed === "" ? "sentry" : armed, pad, false);
    };

    const arm = (kind: TowerKind | ""): void => {
      armed = armed === kind ? "" : kind;
      strikeArmed = false;
    };
    const handleIntent = (intent: string, payload: unknown): void => {
      if (status !== "PLAYING" && intent !== "restart" && intent !== "help") return;
      switch (intent) {
        case "arm":
          if (payload === "" || TOWER_KINDS.includes(payload as TowerKind))
            arm(payload as TowerKind | "");
          break;
        case "launch":
          if (!paused && waves.launch()) toast(`Wave ${waves.wave} incoming`);
          break;
        case "upgrade":
          upgrade();
          break;
        case "recycle":
          recycle();
          break;
        case "target":
          if (selected !== undefined && TARGET_MODES.includes(payload as TargetMode))
            selected.mode = payload as TargetMode;
          break;
        case "speed":
          speedIndex = (speedIndex + 1) % SPEEDS.length;
          break;
        case "autosend":
          autoSend = !autoSend;
          waves.autoSend = autoSend;
          break;
        case "pause":
          paused = true;
          break;
        case "resume":
          paused = false;
          break;
        case "strike":
          if (waves.phase === "combat" && strikeTimer <= 0) {
            strikeArmed = !strikeArmed;
            armed = "";
          } else toast(strikeTimer > 0 ? "Strike recharging" : "Strike needs a wave");
          break;
        case "cancel":
          armed = "";
          strikeArmed = false;
          select(undefined);
          helpOpen = false;
          break;
        case "help":
          helpOpen = !helpOpen;
          break;
        default:
          break;
      }
    };

    ctx.entities.add("battle", {
      debug: () => ({
        armed,
        hostiles: waves.queued + [...enemies.values()].filter((enemy) => enemy.active).length,
        hoverPad: hoverPad ?? -1,
        phase: waves.phase,
        selected: selected?.id ?? "",
        wave: waves.wave,
      }),
    });

    // ── one frame, in four steps ───────────────────────────────────────────────────────────────
    // Keys and UI intents meet in `handleIntent`: a key is only an intent that arrived from the
    // keyboard, so a button and its hotkey can never disagree.
    const readKeys = (input: FrameCtx["input"]): void => {
      for (const name of KEY_INTENTS) if (input.justPressed(name)) handleIntent(name, undefined);
      if (input.justPressed("pause")) handleIntent(paused ? "resume" : "pause", undefined);
      if (input.justPressed("safeBuild")) safeBuild();
      for (const [index, kind] of TOWER_KINDS.entries())
        if (input.justPressed(`tower${index + 1}`)) handleIntent("arm", kind);
      for (const { intent, payload } of drainIntents()) handleIntent(intent, payload);
    };

    const stepSimulation = (step: number): void => {
      strikeTimer = Math.max(0, strikeTimer - step);
      for (const enemy of enemies.values()) enemy.update(step);
      for (const tower of towers.values()) tower.update(step);
      effects.update(step);
      board.update(step);
      let alive = 0;
      for (const enemy of enemies.values()) if (enemy.active) alive += 1;
      waves.update(step, alive, effects.inFlight);
    };

    // The preview follows the pointer: a see-through tower where one would stand, and the ring of
    // what it would cover — or, over a tower already built, the ring of the tower itself.
    const syncPreview = (): void => {
      for (const ghost of ghosts.values()) ghost.visible = false;
      hoverRing.visible = false;
      if (hoverPad === undefined || status !== "PLAYING") return;
      const there = towerAt.get(hoverPad);
      const at = board.position(hoverPad);
      const range =
        there !== undefined ? there.stats.range : armed === "" ? 0 : towerStats(armed, 1).range;
      if (range > 0) {
        if (range !== hoverRadius) {
          hoverRadius = range;
          setRing(hoverRing, range);
        }
        hoverRing.position.set(at.x, 0.09, at.z);
        hoverRing.visible = true;
      }
      const ghost = there === undefined && armed !== "" ? ghosts.get(armed) : undefined;
      if (ghost === undefined) return;
      ghost.position.copy(at);
      ghost.visible = true;
    };

    // Publish only what changed: the HUD is another process on native, and a frame that changed
    // nothing should cost it nothing.
    const next: GameState = { ...INITIAL_STATE };
    const publish = (frameCtx: FrameCtx, speed: number): void => {
      const previous = frameCtx.state.getState();
      let hostiles = waves.queued;
      for (const enemy of enemies.values()) if (enemy.active) hostiles += 1;
      const sel = selected;
      const cost = sel === undefined ? undefined : upgradeCost(sel.kind, sel.level);
      next.armed = armed;
      next.autoSend = autoSend;
      // The credits shown are whole: a fraction never appears on screen, so it must not republish.
      next.credits = Math.floor(economy.credits);
      next.fundsRejects = fundsRejects;
      next.helpOpen = helpOpen;
      next.hostiles = hostiles;
      next.kills = kills;
      next.leaks = leaks;
      next.lives = economy.lives;
      next.paused = paused || helpOpen;
      next.phase = waves.phase;
      next.placementRejects = placementRejects;
      next.score = economy.score;
      next.selDamage = sel?.stats.damage ?? 0;
      next.selKind = sel?.kind ?? "";
      next.selLevel = sel?.level ?? 0;
      next.selMode = sel?.mode ?? "first";
      next.selRange = sel === undefined ? 0 : Math.round(sel.stats.range * 10) / 10;
      next.selSell = sel === undefined ? 0 : sellValue(sel.invested);
      next.selUpgrade = cost ?? 0;
      next.selected = sel !== undefined;
      next.shots = shots;
      next.speed = speed;
      next.spent = economy.spent;
      next.status = status;
      next.strikeArmed = strikeArmed;
      next.strikeCooldown = Math.ceil(strikeTimer);
      next.toast = toastText;
      next.toastSeq = toastSeq;
      next.towers = towers.size;
      next.uiReady = previous.uiReady;
      next.wave = waves.wave;
      if (!sameState(next, previous)) frameCtx.state.set(next);
    };

    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, key, {
        ...this.#materialEnvironment(ctx),
        enabled: materialLightingEnabled(this.#post.tier, this.#materialEnvironment(ctx)),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const { measurement, source, intensity } = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        measurement,
        source,
        intensity,
        this.#environmentSample,
      );
    }

    return (frameCtx, rawDt) => {
      loading.update();
      const input = frameCtx.input;
      if (input.justPressed("restart")) {
        frameCtx.state.set(INITIAL_STATE);
        frameCtx.state.flush();
        void frameCtx.goto("battle");
        return;
      }
      readKeys(input);
      const speed = SPEEDS[speedIndex] ?? 1;
      const delta = Math.min(rawDt, 0.1);
      if (status === "PLAYING" && !paused && !helpOpen) stepSimulation(delta * speed);
      const offset = shake.update(delta);
      rig.update(camera, input, input.raw.pointer.position.x, delta, offset.position);
      for (const enemy of enemies.values()) if (enemy.active) enemy.faceCamera(camera.quaternion);
      syncPreview();
      publish(frameCtx, speed);
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
