import {
  GPUParticles3D,
  type ICtx,
  Scene,
  type SceneFrame,
  VirtualShadowNode,
  isMobile,
  isTouchscreenAvailable,
  qualityTiers,
} from "@threenative/core";
import { type DataTexture, Euler, type PerspectiveCamera, Vector3 } from "three";
import { Driver } from "../entities/Driver.js";
import { CourseItem, ITEM_FEEL, ItemSlot, drawItem } from "../entities/Items.js";
import { type IKartInput, Kart, idleInput } from "../entities/Kart.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createChaseCamera } from "../render/camera.js";
import { buildCourseView, makeRng } from "../render/course.js";
import { BURSTS, EFFECTS } from "../render/effects.js";
import { ItemBoxes, bananaMesh, shellMesh } from "../render/items.js";
import { KartModel, LIVERIES } from "../render/kart.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { postTier, setupPost } from "../render/postprocessing.js";
import { SkidMarks } from "../render/skids.js";
import { setupSky, skyTexture } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState, IMapDot, IResult } from "../state.js";
import { type ICourse, buildCourse } from "../track/Course.js";
import { RACE, Racer, rank } from "../track/Race.js";

export type GameCtx = ICtx<GameState>;

/** Seconds from the scene's start to GO: "READY", then the three lamps. */
const GO_AT = RACE.ready + RACE.light * RACE.lights;
/** Karts closer than this bump apart, metres between centres. */
const BUMP = 1.6;
/** Effects are drawn for karts within this many metres of the camera. */
const EFFECT_RANGE = 90;
const POOL = { bananas: ITEM_FEEL.maxBananas, shells: 6 } as const;

/** A kart in the field: the model, its place in the race, its hand on the wheel and its item. */
interface IEntrant {
  readonly name: string;
  readonly kart: Kart;
  readonly model: KartModel;
  readonly racer: Racer;
  readonly driver: Driver;
  readonly slot: ItemSlot;
  readonly player: boolean;
  /** CPU: seconds until it uses the item in hand. */
  useIn: number;
  onPad: boolean;
  padHits: number;
  boxes: number;
  /** Seconds the kart has been slower than 1.5 m/s while racing, the worst stretch kept. */
  stuck: number;
  stuckWorst: number;
  sparkClock: number;
  wallClock: number;
  /** Every item this kart used, in order, for the scenarios. */
  used: string[];
}

/** The sample nearest a world point, height included, so the bridge and the road under it differ. */
function locate(course: ICourse, x: number, y: number, z: number): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < course.count; i += 1) {
    const d =
      (x - (course.x[i] ?? 0)) ** 2 +
      (z - (course.z[i] ?? 0)) ** 2 +
      (3 * (y - (course.y[i] ?? 0))) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export class Race extends Scene<GameState> {
  static override readonly initialState: GameState = {
    autopilot: false,
    countdown: 4,
    driftStage: 0,
    finishedCount: 0,
    item: "",
    lap: 1,
    lapTimes: [],
    laps: RACE.laps,
    mapDots: [],
    mapPath: "",
    paused: false,
    phase: "countdown",
    place: 8,
    racers: 8,
    results: [],
    speed: 0,
    time: 0,
    toast: "",
    uiReady: false,
    wrongWay: false,
  };

  #sky: DataTexture | undefined;
  #fill: DataTexture | undefined;
  #course: ICourse | undefined;
  #view: ReturnType<typeof buildCourseView> | undefined;
  #field: IEntrant[] = [];
  #items: CourseItem[] = [];
  #boxes: ItemBoxes | undefined;
  #post: ReturnType<typeof setupPost> | undefined;

  /**
   * Everything a scenario can place is built and registered here: `setup.place` is applied after
   * `load()` and before `enter()`, so a kart or an item placed by a scenario is read back there.
   */
  override load(ctx: GameCtx): void {
    this.#sky = skyTexture();
    this.#fill = skyTexture(0.3, 128);
    setupSky(ctx.scene, this.#sky, this.#fill);
    const course = buildCourse();
    const view = buildCourseView(course);
    this.#course = course;
    this.#view = view;
    ctx.add(view.group);
    ctx.entities.add("course", {
      debug: () => ({ ...view.audit, count: course.count, length: course.length }),
    });
    this.#boxes = new ItemBoxes(course, view.group);

    // The grid: two abreast, staggered, behind the line. The player starts last, as in a cup's
    // first race; the CPUs fill the slots ahead.
    const field: IEntrant[] = [];
    LIVERIES.forEach((livery, i) => {
      const player = i === 0;
      const slot = player ? 7 : i - 1;
      const kart = new Kart(course);
      kart.place(
        course.count - 5 - Math.floor(slot / 2) * 6 - (slot % 2) * 3,
        slot % 2 === 0 ? -3 : 3,
      );
      const model = new KartModel(livery);
      model.update(kart, 0, 0);
      ctx.add(model.root);
      const entrant: IEntrant = {
        boxes: 0,
        driver: new Driver(kart, slot % 2 === 0 ? -3 : 3, 0.5 + (i % 4) * 0.04),
        kart,
        model,
        name: player ? "player" : `cpu.${i}`,
        onPad: false,
        padHits: 0,
        player,
        racer: new Racer(livery.name, kart, course.checkpoints),
        slot: new ItemSlot(),
        sparkClock: 0,
        stuck: 0,
        stuckWorst: 0,
        useIn: 0,
        used: [],
        wallClock: 0,
      };
      field.push(entrant);
      ctx.entities.add(entrant.name, {
        debug: () => ({
          ...kart.counts,
          airborne: kart.airborne,
          backCrossings: entrant.racer.backCrossings,
          boostLift: kart.boostPeak / kart.topSpeed,
          boostSeconds: kart.boostSeconds,
          boostTicks: kart.boostTicks,
          boxes: entrant.boxes,
          drag: kart.drag,
          driftSide: kart.driftSide,
          driftStage: kart.driftStage,
          driftEntrySpeed: kart.driftEntrySpeed,
          stageLog: kart.driftStages.join(","),
          drifting: kart.drifting,
          finished: entrant.racer.finished,
          groundGap: kart.y - course.heightAt(kart.index, kart.x, kart.z),
          finishTime: entrant.racer.finishTime,
          hit: kart.hit,
          hitSeconds: kart.hitSeconds,
          index: kart.index,
          item: entrant.slot.held ?? (entrant.slot.rolling ? "rolling" : ""),
          itemDraws: entrant.slot.draws,
          lap: entrant.racer.lap,
          lateral: kart.lateral,
          longestAir: kart.longestAir,
          maxLateral: kart.maxLateral,
          maxJump: entrant.racer.maxJump,
          miniTurboTicks: kart.miniTurboTicks,
          name: entrant.racer.name,
          next: entrant.racer.next,
          padHits: entrant.padHits,
          passed: entrant.racer.passed,
          progress: entrant.racer.progress,
          rank: entrant.racer.rank,
          settledGrass: kart.settled.grass,
          settledRoad: kart.settled.road,
          speed: kart.speed,
          stuckWorst: entrant.stuckWorst,
          surface: kart.surface,
          throttle: kart.throttle,
          topSpeed: kart.topSpeed,
          turboPeak: kart.turboPeak,
          wallAfter: kart.wallAfter,
          wallHits: kart.wallHits,
          wallInto: kart.wallInto,
          wallThrottleDrop: kart.wallThrottleDrop,
          wrongWay: entrant.racer.wrongWay,
          used: entrant.used.join(","),
          y: kart.y,
        }),
        object: model.root,
      });
    });
    this.#field = field;

    // Every banana and shell is built now and parked under the course, so a scenario can place one.
    const items: CourseItem[] = [];
    const pool = (kind: "banana" | "shell", count: number): void => {
      for (let i = 0; i < count; i += 1) {
        const item = new CourseItem(kind, kind === "banana" ? bananaMesh() : shellMesh());
        ctx.add(item.mesh);
        ctx.entities.add(`${kind}.${i}`, {
          debug: () => ({
            active: item.active,
            bounces: item.bounces,
            hits: item.hits,
            index: item.index,
          }),
          mesh: item.mesh,
        });
        items.push(item);
      }
    };
    pool("banana", POOL.bananas);
    pool("shell", POOL.shells);
    this.#items = items;
  }

  override enter(ctx: GameCtx): SceneFrame<GameState> {
    const course = this.#course;
    const view = this.#view;
    const boxes = this.#boxes;
    if (
      course === undefined ||
      view === undefined ||
      boxes === undefined ||
      this.#sky === undefined
    )
      throw new Error("Race.enter ran before load() built the course.");
    const field = this.#field;
    const items = this.#items;
    const player = field.find((entrant) => entrant.player);
    if (player === undefined) throw new Error("Race.enter: the field has no player.");
    setupSky(ctx.scene, this.#sky, this.#fill);
    const environment = {
      gpuClass: ctx.renderer.gpuClass?.class,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    const tier = postTier(environment);
    const shadows = qualityTiers.shadow(tier).castShadows;
    const lighting = setupLighting(ctx.scene, shadows);
    // Clip levels round the camera: crisp under the karts, coarse out to the hills.
    if (shadows)
      lighting.key.shadow.shadowNode = new VirtualShadowNode(lighting.key, {
        clipExtents: tier === "high" ? [14, 48, 160] : [16, 70],
      });
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      ...environment,
      godraysLight: lighting.key,
    });
    const camera = ctx.camera as PerspectiveCamera;
    ctx.add(camera);
    const loading = createLoadingScreen(ctx);
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    // A scenario may have moved a kart or an item: read each back and put it on the course there.
    const euler = new Euler();
    for (const { kart, model, racer } of field) {
      const root = model.root;
      if (
        Math.hypot(root.position.x - kart.x, root.position.z - kart.z) > 0.01 ||
        Math.abs(euler.setFromQuaternion(root.quaternion, "YXZ").y - kart.yaw) > 1e-3
      ) {
        const yaw = euler.setFromQuaternion(root.quaternion, "YXZ").y;
        const index = locate(course, root.position.x, root.position.y, root.position.z);
        const lateral = course.track(index, root.position.x, root.position.z).lateral;
        kart.place(index, lateral);
        kart.x = root.position.x;
        kart.z = root.position.z;
        kart.yaw = yaw;
        kart.velocityYaw = yaw;
        racer.resync();
      }
      model.update(kart, 0, 0);
    }
    for (const item of items) {
      if (!item.placed) continue;
      const p = item.mesh.position;
      const index = locate(course, p.x, p.y, p.z);
      p.y = course.y[index] ?? 0;
      item.activate(
        course,
        index,
        euler.setFromQuaternion(item.mesh.quaternion, "YXZ").y,
        undefined,
      );
    }

    const rig = createChaseCamera(camera);
    rig.snap(player.kart);
    ctx.entities.add("camera-rig", { debug: () => rig.debug() });

    // Effects: six pooled emitters, every look parameter in `render/effects.ts`.
    const make = (name: keyof typeof EFFECTS): GPUParticles3D => {
      const emitter = ctx.add(new GPUParticles3D(EFFECTS[name]()));
      emitter.name = `effects-${name}`;
      return emitter;
    };
    const emitters = {
      dust: make("dust"),
      flame: make("flame"),
      sparkOrange: make("sparkOrange"),
      sparkWhite: make("sparkWhite"),
      sparkYellow: make("sparkYellow"),
      sparkle: make("sparkle"),
    };
    const fired: Record<string, number> = Object.fromEntries(
      Object.keys(BURSTS).map((kind) => [kind, 0]),
    );
    const burst = (kind: keyof typeof BURSTS, at: { x: number; y: number; z: number }): void => {
      const { count, emitter, shape } = BURSTS[kind];
      emitters[emitter].emitParticle({
        count,
        direction: { x: shape[0], y: shape[1], z: shape[2] },
        origin: { x: at.x, y: at.y, z: at.z },
      });
      fired[kind] = (fired[kind] ?? 0) + 1;
    };
    const skids = new SkidMarks(view.group);
    ctx.entities.add("effects", {
      debug: () => ({
        ...fired,
        skids: skids.laid,
        spawned: Object.fromEntries(Object.entries(emitters).map(([k, e]) => [k, e.stats.spawned])),
      }),
    });

    // The minimap: the course in a 100 × 100 box, north up.
    let minX = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < course.count; i += 1) {
      minX = Math.min(minX, course.x[i] ?? 0);
      maxX = Math.max(maxX, course.x[i] ?? 0);
      minZ = Math.min(minZ, course.z[i] ?? 0);
      maxZ = Math.max(maxZ, course.z[i] ?? 0);
    }
    const mapScale = 92 / Math.max(maxX - minX, maxZ - minZ);
    const mapX = (x: number) => 4 + (x - minX) * mapScale + (92 - (maxX - minX) * mapScale) / 2;
    const mapY = (z: number) => 4 + (z - minZ) * mapScale + (92 - (maxZ - minZ) * mapScale) / 2;
    let mapPath = "";
    for (let i = 0; i <= course.count; i += 6) {
      const k = course.wrap(i);
      mapPath += `${i === 0 ? "M" : "L"}${mapX(course.x[k] ?? 0).toFixed(1)} ${mapY(course.z[k] ?? 0).toFixed(1)} `;
    }
    mapPath += "Z";

    const random = makeRng(91);
    let elapsed = 0;
    let goTime = -1;
    let throttlePressedAt = Number.NEGATIVE_INFINITY;
    let throttleWasHeld = false;
    let autopilot = false;
    let toastUntil = 0;
    let lastLap = player.racer.lap;
    let lapStart = 0;
    const lapTimes: number[] = [];
    const boxReady = new Array<number>(boxes.spots.length).fill(0);
    const race = {
      finishedCount: 0,
      finishRankMismatches: 0,
      phase: "countdown" as GameState["phase"],
      rocket: false,
      thrown: { banana: 0, mushroom: 0, shell: 0 },
    };
    ctx.entities.add("race", {
      debug: () => ({
        ...race,
        elapsed,
        itemsUsed: race.thrown.banana + race.thrown.mushroom + race.thrown.shell,
        order: rank(field.map((e) => e.racer)).map((r) => r.name),
        raceTime: goTime < 0 ? 0 : elapsed - goTime,
        stuckWorst: Math.max(...field.filter((e) => !e.player).map((e) => e.stuckWorst)),
      }),
    });
    const toast = (text: string, seconds = 1.6): void => {
      ctx.state.set({ toast: text });
      toastUntil = elapsed + seconds;
    };
    const statePatch: Partial<GameState> = {};
    const at = { x: 0, y: 0, z: 0 };
    const at2 = { x: 0, y: 0, z: 0 };
    const playerInput: IKartInput = idleInput();
    const frozen = idleInput();
    const lamps = view.lamps;

    const useItem = (entrant: IEntrant): void => {
      const kind = entrant.slot.held;
      if (kind === undefined) return;
      entrant.slot.held = undefined;
      entrant.used.push(kind);
      race.thrown[kind] += 1;
      const kart = entrant.kart;
      if (kind === "mushroom") {
        kart.startBoost();
        return;
      }
      const pool = items.filter((item) => item.kind === kind);
      const free = pool.find((item) => !item.active) ?? pool[0];
      if (free === undefined) return;
      const fx = -Math.sin(kart.yaw);
      const fz = -Math.cos(kart.yaw);
      const reach = kind === "banana" ? -ITEM_FEEL.bananaBehind : 1.8;
      free.mesh.position.set(kart.x + fx * reach, kart.y, kart.z + fz * reach);
      free.activate(course, kart.index, kart.yaw, kart);
      emitPlaytestEvent({ entity: entrant.name, item: kind, name: "item-used" });
    };

    const hitKart = (entrant: IEntrant, kind: "banana" | "shell"): void => {
      if (entrant.kart.hit) return;
      if (kind === "banana") entrant.kart.spinOut();
      else entrant.kart.tumble();
      burst("hit", { x: entrant.kart.x, y: entrant.kart.y + 0.8, z: entrant.kart.z });
      emitPlaytestEvent({ entity: entrant.name, item: kind, name: "hit" });
      if (entrant.player) toast(kind === "banana" ? "SPUN OUT!" : "SHELL HIT!", 1.2);
    };

    return (frameCtx, rawDt) => {
      loading.update();
      const dt = Math.min(rawDt, 1 / 30);
      elapsed += dt;
      const input = frameCtx.input;
      const touch = touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size);

      // ---- The countdown ------------------------------------------------------------------
      const racing = elapsed >= GO_AT;
      const lit = Math.max(
        0,
        Math.min(RACE.lights, Math.floor((elapsed - RACE.ready) / RACE.light) + 1),
      );
      lamps.forEach((lamp, i) => {
        lamp.emissive.setHex(racing ? 0x2aff4a : 0xff2a1a);
        lamp.emissiveIntensity = racing
          ? elapsed < GO_AT + 2
            ? 3
            : 0
          : i < lit && elapsed >= RACE.ready
            ? 3
            : 0;
      });
      const throttleHeld = input.pressed("accel") || touch?.accelHeld === true;
      if (!racing && throttleHeld && !throttleWasHeld) throttlePressedAt = elapsed;
      throttleWasHeld = throttleHeld;
      if (racing && goTime < 0) {
        goTime = elapsed;
        race.phase = "race";
        // A rocket start: the pedal pressed in the last 8 ticks before GO, and still held.
        if (throttleHeld && GO_AT - throttlePressedAt <= RACE.rocketWindow) {
          player.kart.startBoost();
          race.rocket = true;
          toast("ROCKET START!", 1.2);
        }
      }
      const remaining = GO_AT - elapsed;
      const countdown =
        remaining > RACE.lights
          ? 4
          : remaining > 0
            ? Math.ceil(remaining)
            : elapsed < GO_AT + 1
              ? 0
              : -1;

      // ---- The player's hands -------------------------------------------------------------
      if (input.justPressed("autopilot")) autopilot = !autopilot;
      const steer = input.vector("move").x + (touch?.move.x ?? 0);
      playerInput.throttle = throttleHeld;
      playerInput.brake = input.pressed("brake") || (touch !== undefined && touch.move.y < -0.5);
      playerInput.steer = Math.max(-1, Math.min(1, steer));
      playerInput.drift = input.pressed("drift") || touch?.driftHeld === true;
      playerInput.item = input.justPressed("item") || touch?.itemPressed === true;

      // ---- Drive every kart --------------------------------------------------------------
      const leader = player.racer.progress;
      for (const entrant of field) {
        const { kart, racer, driver, slot } = entrant;
        slot.update(dt);
        const ai = !entrant.player || autopilot || racer.finished;
        let control: IKartInput;
        if (!racing) control = frozen;
        else if (ai) {
          if (!entrant.player) {
            // The rubber band, against the player's progress, not the leader's.
            kart.catchingUp = racer.progress < leader - RACE.behind && !player.racer.finished;
            driver.coasting =
              !player.racer.finished &&
              racer.progress > leader + RACE.ahead + RACE.aheadPerPlace * racer.rank;
          }
          control = driver.update(dt, random);
          if (slot.held !== undefined) {
            entrant.useIn -= dt;
            if (entrant.useIn <= 0) control.item = true;
          }
        } else control = playerInput;
        if (racing) {
          kart.step(control, dt);
          if (control.item) useItem(entrant);
        }
        if (!racing) continue;
        // Stuck: a CPU slower than 1.5 m/s while racing and not hit.
        entrant.stuck = !racer.finished && kart.speed < 1.5 && !kart.hit ? entrant.stuck + dt : 0;
        entrant.stuckWorst = Math.max(entrant.stuckWorst, entrant.stuck);
      }

      // ---- Karts bump each other ----------------------------------------------------------
      for (let a = 0; a < field.length; a += 1) {
        for (let b = a + 1; b < field.length; b += 1) {
          const ka = field[a]?.kart;
          const kb = field[b]?.kart;
          if (ka === undefined || kb === undefined) continue;
          const dx = kb.x - ka.x;
          const dz = kb.z - ka.z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= BUMP * BUMP || d2 < 1e-6 || Math.abs(ka.y - kb.y) > 1.5) continue;
          const d = Math.sqrt(d2);
          const push = (BUMP - d) / 2;
          ka.x -= (dx / d) * push;
          ka.z -= (dz / d) * push;
          kb.x += (dx / d) * push;
          kb.z += (dz / d) * push;
          // The kart behind gives a little speed to the one ahead.
          const share = (ka.speed - kb.speed) * 0.15;
          ka.speed -= share;
          kb.speed += share;
        }
      }

      // ---- Pads, boxes and items ------------------------------------------------------------
      for (const entrant of field) {
        const kart = entrant.kart;
        const onPad =
          kart.grounded &&
          course.pads.some(
            (pad) =>
              Math.abs(kart.index - pad.index) <= 2 && Math.abs(kart.lateral - pad.lateral) <= 1.7,
          );
        if (onPad && !entrant.onPad) {
          kart.startBoost();
          entrant.padHits += 1;
          if (entrant.player) emitPlaytestEvent({ entity: "player", name: "boost-pad" });
        }
        entrant.onPad = onPad;
        boxes.spots.forEach((spot, i) => {
          if ((boxReady[i] ?? 0) > elapsed) return;
          if ((spot.x - kart.x) ** 2 + (spot.z - kart.z) ** 2 > ITEM_FEEL.boxReach ** 2) return;
          if (Math.abs(spot.y - 1.1 - kart.y) > 2) return;
          boxReady[i] = elapsed + ITEM_FEEL.boxRespawn;
          burst("box", spot);
          entrant.boxes += 1;
          if (entrant.slot.busy) return;
          entrant.slot.roll(drawItem(entrant.racer.rank, random()));
          entrant.useIn = 1 + ITEM_FEEL.roulette + random() * 3;
          if (entrant.player) emitPlaytestEvent({ entity: "player", name: "item-box" });
        });
      }
      // Thrown and placed items wait for GO like the karts do.
      for (const item of items) {
        if (racing) item.update(course, dt);
        if (!item.active) continue;
        for (const entrant of field) {
          if (!item.touches(entrant.kart)) continue;
          item.hits += 1;
          hitKart(entrant, item.kind);
          item.park();
          break;
        }
      }
      for (const shell of items) {
        if (shell.kind !== "shell" || !shell.active) continue;
        for (const banana of items) {
          if (banana.kind !== "banana" || !banana.active) continue;
          if (shell.mesh.position.distanceToSquared(banana.mesh.position) < 1.2) {
            shell.park();
            banana.park();
            break;
          }
        }
      }

      // ---- Race order --------------------------------------------------------------------
      const raceTime = goTime < 0 ? 0 : elapsed - goTime;
      const crossing: [Racer, number][] = [];
      for (const { racer } of field) {
        const was = racer.finished;
        racer.update(course, raceTime);
        if (!was && racer.finished) crossing.push([racer, racer.rank]);
      }
      rank(field.map((e) => e.racer));
      // The HUD's place was honest: each kart finishes in the place the progress ranking gave it.
      for (const [racer, place] of crossing)
        if (racer.rank !== place) race.finishRankMismatches += 1;
      race.finishedCount = field.filter((e) => e.racer.finished).length;
      if (player.racer.lap !== lastLap) {
        if (player.racer.lap > lastLap && player.racer.lap >= 1) {
          lapTimes.push(raceTime - lapStart);
          lapStart = raceTime;
          if (player.racer.lap === RACE.laps - 1) toast("FINAL LAP!", 2);
          else if (player.racer.lap < RACE.laps) toast(`LAP ${player.racer.lap + 1}`, 1.4);
        }
        lastLap = player.racer.lap;
      }
      if (player.racer.finished && race.phase !== "finished") {
        race.phase = "finished";
        toast("FINISH!", 3);
        emitPlaytestEvent({ entity: "player", name: "finished" });
      }

      // ---- What the race looks like --------------------------------------------------------
      for (const entrant of field) {
        const { kart, model } = entrant;
        const steering =
          entrant.player && !autopilot ? playerInput.steer : entrant.driver.input.steer;
        model.update(kart, steering, dt);
        if (!racing) continue;
        if (
          (kart.x - camera.position.x) ** 2 + (kart.z - camera.position.z) ** 2 >
          EFFECT_RANGE ** 2
        )
          continue;
        entrant.sparkClock += dt;
        const tick = entrant.sparkClock >= 1 / 30;
        if (tick) entrant.sparkClock = 0;
        if (tick && kart.grounded && kart.drifting) {
          for (const side of [-1, 1] as const) {
            model.rearWheel(side, at);
            if (kart.driftStage > 0)
              burst(
                kart.driftStage === 1 ? "spark1" : kart.driftStage === 2 ? "spark2" : "spark3",
                at,
              );
            else burst("drift", at);
            skids.lay(at.x, at.y, at.z, kart.yaw);
          }
        }
        if (tick && (kart.boostTicks > 0 || kart.miniTurboTicks > 0)) {
          model.exhaust(at2);
          burst("flame", at2);
        }
        if (tick && kart.grounded && kart.surface !== "road" && Math.abs(kart.speed) > 3) {
          model.rearWheel(kart.index % 2 === 0 ? -1 : 1, at);
          burst(kart.surface === "water" ? "splash" : "grass", at);
        }
        entrant.wallClock -= dt;
        if (kart.onWall && Math.abs(kart.speed) > 4 && entrant.wallClock <= 0) {
          entrant.wallClock = 0.15;
          burst("wall", { x: kart.x, y: kart.y + 0.5, z: kart.z });
        }
      }
      boxes.update(elapsed, (i) => (boxReady[i] ?? 0) <= elapsed, dt);
      rig.update(player.kart, dt);
      lighting.follow(new Vector3(player.kart.x, player.kart.y, player.kart.z));

      // ---- What the HUD reads ----------------------------------------------------------------
      if (toastUntil !== 0 && elapsed > toastUntil) {
        toastUntil = 0;
        frameCtx.state.set({ toast: "" });
      }
      const order = rank(field.map((e) => e.racer));
      const results: IResult[] =
        race.phase === "finished"
          ? order.map((racer) => ({
              name: racer.name,
              place: racer.rank,
              player: racer === player.racer,
              time: racer.finished ? racer.finishTime : 0,
            }))
          : [];
      const dots: IMapDot[] = field.map((e) => ({
        colour: `#${e.model.livery.body.toString(16).padStart(6, "0")}`,
        player: e.player,
        x: mapX(e.kart.x),
        y: mapY(e.kart.z),
      }));
      statePatch.autopilot = autopilot || player.racer.finished;
      statePatch.countdown = countdown;
      statePatch.driftStage = player.kart.driftStage;
      statePatch.finishedCount = race.finishedCount;
      statePatch.item = player.slot.held ?? (player.slot.rolling ? "rolling" : "");
      statePatch.lap = player.racer.displayLap;
      statePatch.lapTimes = [...lapTimes];
      statePatch.mapDots = dots;
      statePatch.mapPath = mapPath;
      statePatch.phase = race.phase;
      statePatch.place = player.racer.rank;
      statePatch.results = results;
      statePatch.speed = Math.round(Math.abs(player.kart.speed) * 3.6);
      statePatch.time = raceTime;
      statePatch.wrongWay = player.racer.wrongWay;
      frameCtx.state.set(statePatch);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#post?.dispose();
    this.#post = undefined;
    this.#field = [];
    this.#items = [];
    super.exit(ctx);
  }
}
