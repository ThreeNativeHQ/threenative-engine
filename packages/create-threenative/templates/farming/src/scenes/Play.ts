import {
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { type PerspectiveCamera, Vector2, Vector3 } from "three";
import { type GameCtx, type IMannequin } from "../entities/Fighter.js";
import { Farmer } from "../entities/Farmer.js";
import { Farm, type DayCause, type IZones } from "../farm/Farm.js";
import { CROP_IDS } from "../farm/crops.js";
import { type ITile } from "../farm/field.js";
import { clockLabel, dateLabel } from "../farm/time.js";
import { TIER_SPEED } from "../farm/tools.js";
import {
  BED_ZONE,
  BIN_ZONE,
  FIELD,
  OBSTACLES,
  PLAYER_LAYER,
  POND_ZONE,
  SHOP_ZONE,
  SPAWN,
  WORLD_LAYER,
  inZone,
  tileAt,
  tileCenter,
} from "../level.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createFarmCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { applyDaylight, createSkyBlend, prewarmDay } from "../render/daylight.js";
import { createFarmScenery } from "../render/farm.js";
import { FieldView } from "../render/fieldView.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { createHighlight } from "../render/props.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { SKY_OPTIONS, setupSky } from "../render/sky.js";
import { sunElevation } from "../render/sunPath.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState, TargetKind } from "../state.js";
import { CHEATS, CHEAT_NAMES, STATIONS, STATION_NAMES, UNDER_PLAYTEST } from "./stations.js";

/** How long a HUD message stays up, seconds. */
const MESSAGE_TIME = 2.5;
/** How long the farmer lies on the ground before the night screen opens, seconds. */
const FAINT_TIME = 1.8;
const SLOT_KEYS = ["slot1", "slot2", "slot3", "slot4", "slot5", "slot6", "slot7"] as const;
const FAINT_MESSAGE: Readonly<Record<DayCause, string>> = {
  exhausted: "You collapsed from exhaustion.",
  late: "You stayed up too late and fainted.",
  sleep: "",
};

const round = (value: number, scale = 100): number => Math.round(value * scale) / scale;

/** The day's work phase: working, lying where the farmer fell, or reading the night screen. */
type Phase = GameState["phase"];

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    binCount: 0,
    binValue: 0,
    carrying: "",
    clock: "06:00",
    day: 1,
    dayIndex: 0,
    dead: 0,
    faints: 0,
    message: "",
    minute: 360,
    money: 200,
    paused: false,
    phase: "playing",
    planted: 0,
    playTime: 0,
    playerX: SPAWN.x,
    playerZ: SPAWN.z,
    prompt: "",
    ripe: 0,
    rocks: 0,
    season: "spring",
    seeds: { pumpkin: 0, tomato: 0, turnip: 6 },
    slot: 0,
    slotLabel: "Hoe",
    sleeps: 0,
    speed: 0,
    stageSum: 0,
    stamina: 250,
    summary: null,
    sunElevation: 0,
    targetCol: -1,
    targetKind: "none",
    targetRow: -1,
    tier: 0,
    tilled: 0,
    uiReady: false,
    water: 10,
    watered: 0,
    weeds: 0,
    weekday: "Mon",
    year: 1,
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for the farmer: the combat mannequin (Quaternius' Universal Animation Library, CC0).
    this.#mannequin = await ctx.assets.model<IMannequin>("mannequin-combat.glb");
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    // The dozen sky keyframes the day clock mixes: baked here, while the loading screen shows.
    await prewarmDay(SKY_OPTIONS.clouds, SKY_OPTIONS.ground);
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined, true, SKY_OPTIONS.clouds, createSkyBlend({ minute: 360 }));
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
    const farm = new Farm();
    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined, true, SKY_OPTIONS.clouds, createSkyBlend(farm));
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
    const cameraRig = createFarmCamera(camera);
    ctx.viewport.resize();
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    // The farm: the house, bin, stall, pond and fence block the farmer's feet; rocks do too until broken.
    const scenery = createFarmScenery();
    ctx.add(scenery.dressing);
    const solid = { collisionLayer: WORLD_LAYER, collisionMask: PLAYER_LAYER };
    for (const { x, z, width, depth, height } of scenery.colliders)
      new RigidBody3D({
        ...solid,
        physics: ctx.physics,
        position: { x, y: height / 2, z },
        shape: CollisionShape3D.box(width, height, depth),
        type: "fixed",
      });
    new RigidBody3D({
      ...solid,
      physics: ctx.physics,
      position: { x: 0, y: -0.5, z: -4 },
      shape: CollisionShape3D.box(140, 1, 110),
      type: "fixed",
    });
    const rockBodies = new Map<number, RigidBody3D>();
    for (const { col, row, kind } of OBSTACLES) {
      if (kind !== "rock") continue;
      const { x, z } = tileCenter(col, row);
      rockBodies.set(
        row * FIELD.cols + col,
        new RigidBody3D({
          ...solid,
          physics: ctx.physics,
          position: { x, y: 0.5, z },
          shape: CollisionShape3D.box(1.3, 1, 1.3),
          type: "fixed",
        }),
      );
    }

    const view = new FieldView(farm.field);
    ctx.add(view.root);
    const highlight = createHighlight(FIELD.tile);
    ctx.add(highlight.mesh);
    const farmer = new Farmer(ctx, mannequin, new Vector3(SPAWN.x, 0.9, SPAWN.z));
    ctx.entities.add("player", farmer);
    const spawn = new Vector3(SPAWN.x, 0.9, SPAWN.z);
    cameraRig.snap(farmer.mesh.position);
    afterPhysics(ctx, (dt) => cameraRig.follow(farmer.mesh.position, dt));

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

    let phase: Phase = "playing";
    let message = "";
    let messageTimer = 0;
    let faintTimer = 0;
    let faintCause: DayCause = "late";
    let playTime = 0;
    let seedsKey = "";
    const say = (text: string): void => {
      message = text;
      messageTimer = MESSAGE_TIME;
    };
    const event = (name: string): void => {
      if (name !== "") emitPlaytestEvent({ entity: "player", name });
    };
    /** Rocks that were broken lose their collider. */
    const syncField = (): void => {
      view.sync();
      for (const [index, body] of rockBodies)
        if ((farm.field.tiles[index] as ITile).obstacle !== "rock") {
          body.dispose();
          rockBodies.delete(index);
        }
    };
    const frame: Partial<GameState> = {};
    const aim = { x: 0, z: 0 };
    const stick = new Vector2();
    const centre = new Vector3(0, 0, -4);
    let summary: GameState["summary"] = null;

    const beginFaint = (cause: DayCause): void => {
      phase = "fainting";
      faintCause = cause;
      faintTimer = FAINT_TIME;
      farmer.faint();
      say(FAINT_MESSAGE[cause]);
      event("collapsed");
    };
    const openSummary = (cause: DayCause): void => {
      summary = farm.endDay(cause);
      farmer.carriedCrop.show(undefined);
      syncField();
      phase = "summary";
      event(cause === "sleep" ? "slept" : "fainted");
      event(`summary-${cause}`);
    };
    const morning = (): void => {
      farm.wake();
      farmer.wake(spawn);
      cameraRig.snap(farmer.mesh.position);
      summary = null;
      phase = "playing";
      say(dateLabel(farm.date));
      event("new-day");
    };

    return (frameCtx, dt) => {
      loading.update();
      const input = frameCtx.input;
      if (phase === "summary") {
        if (input.justPressed("interact") || input.justPressed("use")) morning();
        else farmer.freeze(dt);
      } else if (phase === "fainting") {
        farmer.freeze(dt);
        faintTimer -= dt;
        if (faintTimer <= 0) openSummary(faintCause);
      } else {
        playTime += dt;
        // Playtest keys: stations and clock cheats.
        for (const name of UNDER_PLAYTEST ? STATION_NAMES : []) {
          if (!input.justPressed(name)) continue;
          const spot = STATIONS[name];
          if (spot === undefined) continue;
          farmer.mesh.position.set(spot.x, farmer.mesh.position.y, spot.z);
          farmer.body.teleport(farmer.mesh.position);
          farmer.facing.x = spot.facing.x;
          farmer.facing.z = spot.facing.z;
          farmer.face();
          event(name);
        }
        for (const name of UNDER_PLAYTEST ? CHEAT_NAMES : [])
          if (input.justPressed(name)) event(CHEATS[name]?.(farm) ?? "");

        SLOT_KEYS.forEach((key, index) => {
          if (input.justPressed(key)) farm.select(index);
        });
        if (input.justPressed("nextTool")) farm.select(farm.slot + 1);
        if (input.justPressed("prevTool")) farm.select(farm.slot - 1);
        const slot = farm.hotbar;
        farmer.rack.show(slot.kind === "tool" ? slot.tool : undefined);

        // The tile ahead of the farmer, and the zones it stands in.
        const point = farmer.target(aim);
        const found = tileAt(point.x, point.z);
        const tile = found === undefined ? undefined : farm.field.at(found.col, found.row);
        const { x, z } = farmer.mesh.position;
        const zones: IZones = {
          bed: inZone(BED_ZONE, x, z),
          bin: inZone(BIN_ZONE, x, z),
          pond: inZone(POND_ZONE, x, z),
          shop: inZone(SHOP_ZONE, x, z),
        };

        const touch = touchControls?.update(input.raw.pointers, frameCtx.viewport.size);
        stick.copy(input.vector("move"));
        if (touch !== undefined) stick.add(touch.move).clampLength(0, 1);
        farmer.update(dt, stick, TIER_SPEED[farm.tier] ?? 3.6);

        const interaction = farm.interaction(tile, zones);
        const plan = farm.plan(tile, zones.pond);
        if (!farmer.busy) {
          if (input.justPressed("use") || touch?.attackPressed === true) {
            if (!plan.valid) say(plan.message);
            else if (plan.cost > farm.stamina) beginFaint("exhausted");
            else
              farmer.work(
                slot.kind === "tool" ? ({ can: "interact", hammer: "chop", hoe: "chop", sickle: "jab" } as const)[slot.tool] : "pick",
                () => {
                  const result = plan.apply();
                  syncField();
                  say(result.message);
                  event(result.event);
                  if (farm.stamina <= 0) beginFaint("exhausted");
                },
              );
          } else if (input.justPressed("interact") || touch?.abilityPressed === true) {
            if (interaction.kind === "harvest" && tile !== undefined)
              farmer.work("pick", () => {
                const result = farm.harvest(tile);
                farmer.carriedCrop.show(farm.carrying);
                syncField();
                say(result.message);
                event(result.event);
              });
            else if (interaction.kind === "ship")
              farmer.work("interact", () => {
                const result = farm.ship();
                farmer.carriedCrop.show(farm.carrying);
                say(result.message);
                event(result.event);
              });
            else if (interaction.kind === "sleep") openSummary("sleep");
            else if (interaction.kind === "buy") {
              const result = farm.buy();
              say(result.message);
              event(result.event);
            }
          }
        }
        if (phase === "playing" && farm.tick(dt)) beginFaint("late");

        highlight.mesh.visible = found !== undefined && farm.carrying === undefined;
        if (found !== undefined) {
          const at = tileCenter(found.col, found.row);
          highlight.mesh.position.set(at.x, highlight.mesh.position.y, at.z);
          highlight.set(plan.valid || interaction.kind === "harvest");
        }
        frame.prompt = interaction.prompt;
        frame.targetCol = found?.col ?? -1;
        frame.targetRow = found?.row ?? -1;
        frame.targetKind = (tile === undefined ? "none" : farm.field.kind(tile)) as TargetKind;
      }
      if (phase !== "playing") {
        highlight.mesh.visible = false;
        frame.prompt = phase === "summary" ? "E  CONTINUE" : "";
      }

      applyDaylight(farm.minute, lighting.key, centre);
      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      const stats = farm.field.stats();
      const date = farm.date;
      const nextSeeds = CROP_IDS.map((id) => farm.seeds[id]).join(",");
      if (nextSeeds !== seedsKey) {
        seedsKey = nextSeeds;
        frame.seeds = { ...farm.seeds };
      }
      frame.phase = phase;
      frame.dayIndex = date.dayIndex;
      frame.day = date.day;
      frame.season = date.season;
      frame.weekday = date.weekday;
      frame.year = date.year;
      frame.minute = round(farm.minute, 10);
      frame.clock = clockLabel(farm.minute);
      frame.sunElevation = round((sunElevation(farm.minute) * 180) / Math.PI, 10);
      frame.money = farm.money;
      frame.stamina = farm.stamina;
      frame.tier = farm.tier;
      frame.speed = round(farmer.speed);
      frame.water = farm.water;
      frame.slot = farm.slot;
      frame.slotLabel = farm.hotbar.label;
      frame.carrying = farm.carrying ?? "";
      frame.binCount = farm.binCount;
      frame.binValue = farm.binValue;
      frame.tilled = stats.tilled;
      frame.watered = stats.watered;
      frame.planted = stats.planted;
      frame.ripe = stats.ripe;
      frame.dead = stats.dead;
      frame.weeds = stats.weeds;
      frame.rocks = stats.rocks;
      frame.stageSum = stats.stageSum;
      frame.message = message;
      frame.sleeps = farm.sleeps;
      frame.faints = farm.faints;
      frame.summary = summary;
      frame.playerX = round(farmer.mesh.position.x);
      frame.playerZ = round(farmer.mesh.position.z);
      frame.playTime = round(playTime, 10);
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
