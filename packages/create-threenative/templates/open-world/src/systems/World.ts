// Everything alive in the city and every rule between them: cars, people, the police, the wanted
// level, the job, pickups and the respray. `scenes/Play.ts` builds the world and calls `update`.
import { type IRandom, createRandom } from "@threenative/core";
import { BoxGeometry, Mesh, type PerspectiveCamera, Vector3 } from "three";
import {
  BLOCKS,
  DOWNTOWN,
  type IBlock,
  type ILane,
  KERB,
  LANES,
  PLACES,
  ROADS,
  ROAD_WIDTH,
  nearestLane,
  onSidewalk,
  roadLine,
  sidewalkLoop,
} from "../city/layout.js";
import { Car } from "../entities/Car.js";
import type { IMannequin } from "../entities/Humanoid.js";
import { COP, Pedestrian } from "../entities/Pedestrian.js";
import { COMBAT, type IPlayerInput, Player } from "../entities/Player.js";
import { type GameCtx, WORLD_LAYER } from "../entities/layers.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { PAINTS, POLICE_PAINT } from "../render/car.js";
import { civilianMaterials, moneyMaterial, pistolMaterial } from "../render/materials.js";
import type { Blip, GameState } from "../state.js";
import { type IObstacle, Intersections, LaneDriver, PursuitDriver } from "./drivers.js";
import { JOB, JOB_CAR_SPOT, JOB_CAR_YAW, Job } from "./job.js";
import { type Crime, POLICE_CARS, STAR_CHAOS, Wanted } from "./wanted.js";

export const POPULATION = { traffic: 8, parked: 4, civilians: 12, maxCopsOnFoot: 8 } as const;
/**
 * The population streams with the player: civilians and traffic appear within `spawn` metres and
 * are cleared past `despawn`, so the city looks full wherever the player is without simulating
 * all of it. Both stay inside `STREAMING.load` (`systems/streaming.ts`): nobody walks on an
 * unbuilt block.
 */
export const POPULATION_RANGE = { spawn: 90, despawn: 120 } as const;
/** Seconds a WASTED or BUSTED banner holds before the respawn. */
const DOWN_TIME = 3;
/** Respawn fee at the hospital or the police station. */
const FEE = 100;
/** The respray's price (re3 @ b050e1cc `src/control/Garages.cpp:37`, `RESPRAY_PRICE`). */
export const RESPRAY_PRICE = 1000;
/** Seconds from answering an enter press to sitting in the car, and from exit to standing. */
const ENTER_TIME = 0.7;
const EXIT_TIME = 0.4;
const ENTER_REACH = 3.4;
/** The velocity change (m/s in one tick) a car must take from the player's car to count as rammed. */
const RAM_SHOVE = 1.5;
/** A car faster than this knocks a person down; damage grows with speed. */
const KNOCK_SPEED = 4;
const SHOT_FEAR = 25;
const POLICE_SIGHT = 60;
/** Police spawn this far from the player, on a lane the camera is not looking down. */
const SPAWN_NEAR = 45;
const SPAWN_FAR = 95;
const MONEY_RESPAWN = 60;

interface IPickup {
  readonly mesh: Mesh;
  readonly kind: "money" | "pistol";
  readonly amount: number;
  readonly fixed: boolean;
  respawn: number;
}

interface IPoliceCar {
  readonly driver: PursuitDriver;
  crew: number;
  /** The officers who got out of it. */
  readonly officers: Pedestrian[];
}

const _to = new Vector3();
const _local = new Vector3();
const _forward = new Vector3();
const _right = new Vector3();
const _eye = new Vector3();
const _chest = new Vector3();
const _door = new Vector3();
const pickupGeometry = new BoxGeometry(0.5, 0.3, 0.25);

/**
 * Playtest stations, in key order (Digit1 to Digit9, Digit0, Minus, Equal, BracketRight). Each one sets up one
 * mechanic in a single tick, so a scenario proves that mechanic in a few seconds.
 */
export const STATIONS = [
  "punch",
  "pistol",
  "parked",
  "lane",
  "runover",
  "respray",
  "fire",
  "arrest",
  "phone",
  "dropoff",
  "money",
  "hide",
  "far",
] as const;
export type Station = (typeof STATIONS)[number];

export class World {
  readonly player: Player;
  readonly cars: Car[] = [];
  readonly traffic: LaneDriver[] = [];
  readonly police: IPoliceCar[] = [];
  readonly people: Pedestrian[] = [];
  readonly pickups: IPickup[] = [];
  readonly wanted = new Wanted();
  readonly job = new Job();
  readonly intersections = new Intersections();
  jobCar: Car | undefined;
  money = 1200;
  phase: GameState["phase"] = "playing";
  banner = "";
  bannerTime = 0;
  prompt = "";
  /** False only under the `hide` playtest station: no police are sent. */
  dispatch = true;
  counts = { busted: 0, carjacks: 0, evasions: 0, pedsDown: 0, pickups: 0, resprays: 0, wasted: 0 };
  #random: IRandom;
  #ids = 0;
  #downTimer = 0;
  #policeTimer = 0;
  #carArrest = 0;
  /** Seconds before a car can hurt the player on foot again: one hit per bump, not one per tick. */
  #carHit = 0;
  #onPad = false;
  #obstacles: IObstacle[] = [];
  #seen = false;
  readonly #byBody = new Map<number, Pedestrian>();
  readonly #carByBody = new Map<number, Car>();

  constructor(
    readonly ctx: GameCtx,
    readonly model: IMannequin,
    readonly camera: PerspectiveCamera,
  ) {
    this.#random = createRandom(30_301);
    this.player = new Player(ctx, model, PLACES.playerSpawn);
    ctx.entities.add("player", this.player);
    // Traffic on random lanes near the spawn, spread out so no two start nose to tail.
    const lanes = LANES.filter(
      (lane) => lane.start.distanceTo(PLACES.playerSpawn) < POPULATION_RANGE.spawn,
    ).sort(() => this.#random() - 0.5);
    for (let index = 0; index < POPULATION.traffic; index += 1)
      this.#spawnTraffic(lanes[index] as ILane, 0.4);
    // A few parked cars along the kerb, one of them right by the spawn so the first drive is a walk away.
    const parked: [number, number, number][] = [
      // Kerbside on the spawn street, clear of the lane.
      [PLACES.playerSpawn.x + 7, roadLine(DOWNTOWN + 2) - ROAD_WIDTH / 2 + 1.0, Math.PI / 2],
      [-24 + 5, -48, 0],
      [24 - 5, 48, Math.PI],
      [-72 - 5, 0, Math.PI],
    ];
    for (const [x, z, yaw] of parked) this.addCar(new Vector3(x, 0, z), yaw, "parked", false);
    // A cruiser parked outside the station: the city has police before anyone calls them, and its
    // light bar is drawn (and compiled) at load rather than at the first dispatch.
    this.addCar(
      new Vector3(PLACES.police.x + 6, 0, roadLine(DOWNTOWN + 2) + ROAD_WIDTH / 2 - 1.0),
      Math.PI / 2,
      "parked",
      false,
      POLICE_PAINT,
      true,
    );
    for (let index = 0; index < POPULATION.civilians; index += 1) this.#spawnCivilian(true);
    // Money on the street and a pistol by the police station: the first things worth walking to.
    const nearSpawn = BLOCKS.filter((candidate) => candidate.kind === "buildings").sort(
      (a, b) => a.center.distanceTo(PLACES.playerSpawn) - b.center.distanceTo(PLACES.playerSpawn),
    );
    for (const target of nearSpawn.slice(0, 4)) {
      const corner = sidewalkLoop(target)[1] as Vector3;
      this.#addPickup("money", corner, 100, true);
    }
    this.#addPickup("pistol", PLACES.police.clone().add(new Vector3(4, 0, 0)), 24, true);
    ctx.entities.add("world", { debug: () => this.debug() });
  }

  addCar(
    at: Vector3,
    yaw: number,
    role: Car["role"],
    occupied: boolean,
    colour?: number,
    police = role === "police",
  ): Car {
    const id = this.#ids++;
    const car = new Car(this.ctx, {
      colour: colour ?? (role === "police" ? POLICE_PAINT : (PAINTS[id % PAINTS.length] as number)),
      id,
      occupied,
      police,
      position: at,
      role,
      yaw,
    });
    this.cars.push(car);
    this.#carByBody.set(car.body.body.id, car);
    this.ctx.entities.add(`car.${id}`, car);
    return car;
  }

  #spawnTraffic(lane: ILane, along: number): LaneDriver {
    const at = lane.start.clone().lerp(lane.end, along);
    const car = this.addCar(at, Math.atan2(-lane.direction.x, -lane.direction.z), "traffic", true);
    const driver = new LaneDriver(car, lane, this.#random);
    this.traffic.push(driver);
    return driver;
  }

  #spawnCivilian(anywhere: boolean): Pedestrian {
    const where = this.player.where;
    const candidates = BLOCKS.filter(
      (target) =>
        target.kind !== "respray" && target.center.distanceTo(where) < POPULATION_RANGE.spawn,
    );
    let target = this.#random.pick(candidates) as IBlock;
    let corner = this.#random.pick(sidewalkLoop(target)) as Vector3;
    // A replacement appears out of the player's way, never in front of them.
    for (let tries = 0; tries < 8 && !anywhere && corner.distanceTo(where) < 35; tries += 1) {
      target = this.#random.pick(candidates) as IBlock;
      corner = this.#random.pick(sidewalkLoop(target)) as Vector3;
    }
    const ped = new Pedestrian(this.ctx, this.model, {
      at: corner.clone().setY(KERB),
      block: target,
      material: this.#random.pick(civilianMaterials),
      random: this.#random,
    });
    this.#addPerson(ped);
    return ped;
  }

  #addPerson(ped: Pedestrian): void {
    this.people.push(ped);
    this.#byBody.set(ped.body.body.id, ped);
    this.ctx.entities.add(`${ped.cop ? "cop" : "ped"}.${this.#ids++}`, ped);
  }

  #addPickup(kind: IPickup["kind"], at: Vector3, amount: number, fixed: boolean): void {
    const mesh = new Mesh(pickupGeometry, kind === "pistol" ? pistolMaterial : moneyMaterial);
    if (kind === "pistol") mesh.scale.set(0.6, 1.4, 1.8);
    mesh.position.set(at.x, KERB + 0.7, at.z);
    mesh.castShadow = true;
    this.ctx.add(mesh);
    this.pickups.push({ amount, fixed, kind, mesh, respawn: 0 });
  }

  report(crime: Crime): void {
    const before = this.wanted.stars;
    this.wanted.report(crime);
    emitPlaytestEvent({ crime, entity: "player", name: "crime" });
    if (this.wanted.stars > before)
      emitPlaytestEvent({ entity: "player", name: "wanted-up", stars: this.wanted.stars });
  }

  /** Every input the player gave this tick, already read from the input map. */
  update(
    dt: number,
    input: IPlayerInput & { readonly enterPressed: boolean; readonly handbrake: boolean },
    cameraYaw: number,
  ): void {
    const player = this.player;
    this.prompt = "";
    this.bannerTime = Math.max(0, this.bannerTime - dt);
    this.#carHit = Math.max(0, this.#carHit - dt);
    if (this.bannerTime === 0 && this.phase === "playing") this.banner = "";
    this.#obstacles.length = 0;
    for (const car of this.cars) this.#obstacles.push({ halfLength: 2.1, position: car.position });
    for (const ped of this.people)
      if (ped.inWorld) this.#obstacles.push({ halfLength: 0.4, position: ped.position });
    if (player.mode !== "driving")
      this.#obstacles.push({ halfLength: 0.4, position: player.position });

    if (this.phase !== "playing") this.#updateDown(dt);
    else if (player.mode === "foot") this.#onFoot(dt, input, cameraYaw);
    else if (player.mode === "driving") this.#driving(dt, input);
    else this.#transition(dt);

    // Traffic, police drivers, people.
    for (const driver of this.traffic) {
      // Each driver sees every obstacle but its own car.
      driver.update(dt, this.#obstaclesExcept(driver.car), this.intersections);
    }
    for (const car of this.cars)
      if (car.role === "parked" || (car.role === "mission" && car !== player.car)) car.hold();
    const stars = this.wanted.stars;
    this.#seen = false;
    const where = player.where;
    const onFoot = player.mode === "foot" && this.phase === "playing";
    // A unit whose car was stolen is no longer a pursuit; nor is one whose crew got out once no
    // officer of it is up within 60 m: the cruiser is abandoned and the budget sends a fresh one.
    for (let index = this.police.length - 1; index >= 0; index -= 1) {
      const unit = this.police[index] as IPoliceCar;
      const abandoned =
        unit.crew === 0 &&
        !unit.officers.some((cop) => cop.alive && cop.position.distanceTo(where) < 60);
      if (unit.driver.car.role === "police" && !abandoned) continue;
      if (abandoned && unit.driver.car.role === "police") unit.driver.car.role = "parked";
      this.police.splice(index, 1);
    }
    // At the cap of officers on foot, a cruiser keeps driving the pursuit instead of stopping.
    const deploy =
      this.people.filter((ped) => ped.cop && ped.alive).length < POPULATION.maxCopsOnFoot;
    for (const unit of this.police) {
      // A held cruiser gives up its junction locks, or the traffic it stopped in waits for it forever.
      if (unit.crew === 0 || unit.driver.car.wrecked) {
        unit.driver.car.hold();
        this.intersections.freeAll(unit.driver.car);
        continue;
      }
      unit.driver.deploy = deploy;
      const sees = this.#sees(unit.driver.car.position, 1.2, where);
      if (sees) this.#seen = true;
      if (stars === 0) {
        unit.driver.car.hold();
        this.intersections.freeAll(unit.driver.car);
        continue;
      }
      unit.driver.update(
        dt,
        where,
        onFoot || Math.abs(player.car?.speed ?? 0) < 2,
        sees,
        this.#obstaclesExcept(unit.driver.car),
        this.intersections,
      );
      if (unit.driver.arrived && unit.crew > 0) this.#deployCrew(unit);
    }
    for (const ped of this.people) {
      const sees = ped.cop && ped.alive && ped.inWorld && this.#sees(ped.position, 0.7, where);
      if (sees) this.#seen = true;
      ped.update(dt, where, stars, onFoot, sees);
      if (ped.fired) this.#copShot(ped);
      if (ped.cop && ped.arrest >= COP.arrestTime && onFoot) this.#bust();
    }
    this.#carsHitPeople();
    this.#arrestInCar(dt);
    this.#explosions();
    this.wanted.update(dt, this.#seen);
    if (this.wanted.evasions > this.counts.evasions) {
      this.counts.evasions = this.wanted.evasions;
      emitPlaytestEvent({ entity: "player", name: "evaded", stars: this.wanted.stars });
    }
    this.#policeBudget(dt);
    this.#pickups(dt);
    this.#jobTick(dt);
    this.#housekeeping();
    // Impacts are per tick: what each car took since the last update, for the ram test above.
    for (const car of this.cars) car.lastImpact = 0;
  }

  #obstaclesExcept(car: Car): IObstacle[] {
    return this.#obstacles.filter((obstacle) => obstacle.position !== car.position);
  }

  #onFoot(
    dt: number,
    input: IPlayerInput & { readonly enterPressed: boolean },
    cameraYaw: number,
  ): void {
    const player = this.player;
    // Lock-on only picks people the player can see: not through a building.
    const targets = input.aim
      ? this.people.filter(
          (ped) =>
            ped.inWorld &&
            ped.alive &&
            ped.position.distanceTo(player.position) < COMBAT.lockRange &&
            this.#sees(player.position, 0.7, ped.position),
        )
      : this.people;
    const result = player.updateOnFoot(dt, input, cameraYaw, targets);
    if (result.punchLanded) {
      // The swing reached its contact frame, hit or miss; `punch-hit` follows when it connects.
      emitPlaytestEvent({ entity: "player", name: "punch" });
      this.#punch();
    }
    if (result.shot) this.#shoot();
    if (player.aiming)
      for (const ped of this.people)
        if (ped.position.distanceTo(player.position) < 12) ped.scare(player.position);
    const car = this.#nearestCar();
    if (car !== undefined) {
      this.prompt = car.occupied
        ? "F  carjack"
        : car === this.jobCar && this.job.active
          ? "F  get in the job car"
          : "F  get in";
      if (input.enterPressed) this.#beginEnter(car);
    }
    if (this.job.canStart(true, player.position)) {
      this.job.start();
      this.#spawnJobCar();
      this.#flash("JOB: deliver the marked car", 3);
      emitPlaytestEvent({ entity: "player", name: "job-started" });
    } else if (this.job.state === "idle" && player.position.distanceTo(PLACES.phone) < 6)
      this.prompt = "walk into the booth for a job";
  }

  #nearestCar(): Car | undefined {
    let best: Car | undefined;
    let bestDistance = ENTER_REACH;
    for (const car of this.cars) {
      // A car moving faster than a jog is not one you can open the door of.
      if (car.wrecked || Math.abs(car.speed) > 4) continue;
      const distance = car.position.distanceTo(this.player.position);
      if (distance < bestDistance) {
        best = car;
        bestDistance = distance;
      }
    }
    return best;
  }

  #beginEnter(car: Car): void {
    const player = this.player;
    player.car = car;
    player.mode = "entering";
    player.transition = ENTER_TIME;
    _to.copy(car.position).sub(player.position);
    player.face(Math.atan2(_to.x, _to.z));
    player.play("interact", { fit: true, hold: ENTER_TIME });
    if (car.occupied) {
      // A carjack: the driver is pulled out of the driver's door and runs (MCP card
      // grand-theft-auto-iii-re3/ped-state-timer gives the 600 ms commit before they decide).
      car.occupied = false;
      const driver = this.traffic.find((candidate) => candidate.car === car);
      if (driver !== undefined) this.traffic.splice(this.traffic.indexOf(driver), 1);
      this.intersections.freeAll(car);
      const ped = new Pedestrian(this.ctx, this.model, {
        at: this.#doorOf(car, _door),
        block: this.#nearestBlock(car.position),
        cop: car.role === "police",
        material: this.#random.pick(civilianMaterials),
        random: this.#random,
      });
      this.#addPerson(ped);
      ped.scare(player.position);
      this.counts.carjacks += 1;
      this.report("steal-car");
      emitPlaytestEvent({ entity: "player", name: "carjack" });
    } else if (car.police || car.role === "traffic") this.report("steal-car");
    car.role = car === this.jobCar ? "mission" : "player";
  }

  #transition(dt: number): void {
    const player = this.player;
    player.updateIdle(dt);
    player.car?.hold();
    if (player.mode === "entering" && player.car?.wrecked === true) {
      // The car caught fire during the enter beat: stay out.
      player.mode = "foot";
      player.car = undefined;
      player.release();
      return;
    }
    if (player.transition > 0) return;
    if (player.mode === "entering" && player.car !== undefined) {
      player.leaveWorld(true);
      player.mode = "driving";
      // A crash from before the player took the wheel is not theirs to answer for.
      player.car.lastImpact = 0;
      emitPlaytestEvent({ entity: "player", name: "entered-car" });
    } else if (player.mode === "exiting") {
      player.mode = "foot";
      player.release();
      emitPlaytestEvent({ entity: "player", name: "exited-car" });
    }
  }

  #driving(
    dt: number,
    input: IPlayerInput & { readonly enterPressed: boolean; readonly handbrake: boolean },
  ): void {
    const player = this.player;
    const car = player.car;
    if (car === undefined) return;
    player.updateIdle(dt);
    car.drive(input.move.y, input.move.x, input.handbrake, dt);
    if (input.enterPressed && Math.abs(car.speed) < 6) {
      // Out of the driver's door; the car stays where it stopped.
      player.enterWorld(this.#doorOf(car, _door));
      player.mode = "exiting";
      player.transition = EXIT_TIME;
      player.car = undefined;
      if (car.role === "player") car.role = "parked";
      if (car === this.jobCar && this.job.active) car.role = "mission";
      return;
    }
    // Rammed traffic panics and drives off; a rammed police car is a crime. A ram is contact: the
    // other car took a knock this tick too, so a kerb clip beside a car in the next lane is not one.
    if (car.lastImpact > 4) {
      for (const other of this.cars) {
        if (
          other === car ||
          other.lastImpact < RAM_SHOVE ||
          other.position.distanceTo(car.position) > 5.5
        )
          continue;
        if (other.police) this.report("hit-cop");
        const driver = this.traffic.find((candidate) => candidate.car === other);
        if (driver !== undefined && driver.panic === 0) {
          driver.panic = 5;
          emitPlaytestEvent({ entity: "player", name: "rammed" });
        }
      }
    }
    // The respray: drive in slowly with heat or damage, pay, drive out clean.
    const onPad =
      Math.abs(car.position.x - PLACES.respray.x) < 2.6 &&
      Math.abs(car.position.z - PLACES.respray.z) < 3.6;
    if (onPad && !this.#onPad && Math.abs(car.speed) < 3) {
      this.#onPad = true;
      if (this.wanted.stars > 0 || car.health < 1000) {
        if (this.money >= RESPRAY_PRICE) {
          this.money -= RESPRAY_PRICE;
          this.wanted.clear();
          car.repair(this.#random.pick(PAINTS));
          this.counts.resprays += 1;
          this.#flash("RESPRAYED", 2.5);
          emitPlaytestEvent({ entity: "player", name: "respray" });
        } else this.#flash(`RESPRAY $${RESPRAY_PRICE}`, 2.5);
      }
    } else if (!onPad) this.#onPad = false;
    if (car.wrecked) this.prompt = "the car is on fire: F to get out";
  }

  /**
   * Where someone gets out: the door on `side` (1 is the driver's, on the left), the other side
   * against a wall, and behind the car when both doors face walls.
   */
  #doorOf(car: Car, out: Vector3, side = 1): Vector3 {
    car.forward(_forward);
    _right.set(_forward.z, 0, -_forward.x);
    for (const offset of [side * 1.6, -side * 1.6]) {
      out.copy(car.position).addScaledVector(_right, offset);
      const wall = this.ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER,
        from: car.position,
        to: out,
      });
      if (wall === undefined) return out.setY(onSidewalk(out) ? KERB : 0);
    }
    out.copy(car.position).addScaledVector(_forward, -3.2);
    return out.setY(onSidewalk(out) ? KERB : 0);
  }

  #nearestBlock(at: Vector3): IBlock {
    let best = BLOCKS[0] as IBlock;
    for (const target of BLOCKS)
      if (target.center.distanceTo(at) < best.center.distanceTo(at)) best = target;
    return best;
  }

  #punch(): void {
    const player = this.player;
    player.facing(_forward);
    for (const ped of this.people) {
      if (!ped.alive || !ped.inWorld) continue;
      _to.copy(ped.position).sub(player.position).setY(0);
      const distance = _to.length();
      if (distance > COMBAT.punchReach + 0.3 || _to.dot(_forward) < COMBAT.punchCone * distance)
        continue;
      const killed = ped.takeHit(COMBAT.punchDamage, player.position);
      if (killed) {
        this.counts.pedsDown += 1;
        this.#dropMoney(ped);
      }
      this.report(ped.cop ? "hit-cop" : "hit-ped");
      emitPlaytestEvent({ entity: "player", name: "punch-hit", target: ped.cop ? "cop" : "ped" });
      break;
    }
  }

  #shoot(): void {
    const player = this.player;
    const from = player.muzzle(_eye);
    for (const ped of this.people)
      if (ped.position.distanceTo(player.position) < SHOT_FEAR) ped.scare(player.position);
    let victim: Pedestrian | undefined;
    const target = player.target;
    if (target instanceof Pedestrian) {
      // A locked shot lands unless a wall is in the way; past 8 m it can miss (GTA's aim scatter,
      // MCP card grand-theft-auto-iii-re3/weapon-fire-offset: up to 0.2 m at the target plane).
      const distance = target.position.distanceTo(player.position);
      const chance = distance < 8 ? 1 : Math.max(0.45, 1 - (distance - 8) / 30);
      _chest.copy(target.position);
      const wall = this.ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER,
        from,
        to: _chest,
      });
      if (wall === undefined && this.#random() < chance) victim = target;
    } else {
      player.facing(_forward);
      _chest.copy(from).addScaledVector(_forward, COMBAT.pistolRange);
      // Chest height first, then knee height: a car's body sits below a standing shooter's aim.
      // Chest height and knee height, nearest wins: a car's body sits below a standing shooter's
      // aim, and the chest ray would carry on to the building behind it.
      const chest = this.ctx.physics.directSpaceState.intersectRay({ from, to: _chest });
      const knee = this.ctx.physics.directSpaceState.intersectRay({
        from: _local.copy(from).setY(from.y - 0.9),
        to: _to.copy(_chest).setY(_chest.y - 0.9),
      });
      const hit =
        chest === undefined || (knee !== undefined && knee.distance < chest.distance)
          ? knee
          : chest;
      if (hit !== undefined) {
        victim = this.#byBody.get(hit.body.id);
        const car = this.#carByBody.get(hit.body.id);
        if (car !== undefined) {
          car.damage(60);
          if (car.police) this.report("hit-cop");
          const driver = this.traffic.find((candidate) => candidate.car === car);
          if (driver !== undefined) driver.panic = 5;
        }
      }
    }
    emitPlaytestEvent({ entity: "player", name: "shot", hit: victim === undefined ? 0 : 1 });
    if (victim === undefined) return;
    const killed = victim.takeHit(COMBAT.pistolDamage, player.position);
    if (killed) this.#dropMoney(victim);
    this.counts.pedsDown += killed ? 1 : 0;
    this.report(victim.cop ? "shoot-cop" : "shoot-ped");
  }

  #dropMoney(ped: Pedestrian): void {
    if (ped.cop) return;
    this.#addPickup("money", ped.visual.position, 10 + Math.floor(this.#random() * 30), false);
  }

  #copShot(cop: Pedestrian): void {
    const player = this.player;
    const distance = cop.position.distanceTo(player.where);
    const chance = Math.max(0.2, 0.85 - distance / 30);
    // No shots at a player already down or in cuffs.
    if (this.phase !== "playing") return;
    // No shots through a building the officer can no longer see past.
    if (!this.#sees(cop.position, 0.7, player.where)) return;
    emitPlaytestEvent({ entity: "cop", name: "cop-shot" });
    if (this.#random() >= chance) return;
    if (player.mode === "driving") player.car?.damage(COP.damage * 8);
    else if (player.takeDamage(COP.damage)) this.#wasted();
  }

  /** Line of sight from an officer's eyes to the player's chest, through walls only. */
  #sees(from: Vector3, eye: number, target: Vector3): boolean {
    if (from.distanceTo(target) > POLICE_SIGHT) return false;
    _eye.copy(from);
    _eye.y += eye;
    _chest.copy(target);
    _chest.y += 0.5;
    return (
      this.ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER,
        from: _eye,
        to: _chest,
      }) === undefined
    );
  }

  /**
   * A car faster than walking pace knocks a person down; the damage grows with speed, so a crawl
   * bumps them and a straight-line run kills. The player driving it commits the crime.
   */
  #carsHitPeople(): void {
    const player = this.player;
    for (const car of this.cars) {
      const speed = Math.abs(car.speed);
      // A car on the sidewalk at any speed sends people running.
      if (speed > 2 && onSidewalk(car.position))
        for (const ped of this.people)
          if (ped.position.distanceTo(car.position) < 7) ped.scare(car.position);
      if (speed < KNOCK_SPEED) continue;
      car.forward(_forward);
      _right.set(-_forward.z, 0, _forward.x);
      const driven = car === player.car && player.mode === "driving";
      for (const ped of this.people) {
        if (!ped.inWorld || !ped.alive) continue;
        _local.copy(ped.position).sub(car.position);
        if (
          Math.abs(_local.dot(_right)) > 1.25 ||
          Math.abs(_local.dot(_forward)) > 2.5 ||
          Math.abs(_local.y) > 2
        )
          continue;
        const killed = ped.knockDown(speed * 4, car.position);
        this.counts.pedsDown += 1;
        if (killed) this.#dropMoney(ped);
        emitPlaytestEvent({ entity: "player", name: "knocked-down", driven: driven ? 1 : 0 });
        if (driven) this.report(ped.cop ? "run-over-cop" : "run-over-ped");
      }
      if (player.mode === "foot" && player.inWorld && car !== player.car && this.#carHit === 0) {
        _local.copy(player.position).sub(car.position);
        if (Math.abs(_local.dot(_right)) < 1.25 && Math.abs(_local.dot(_forward)) < 2.5) {
          this.#carHit = 1;
          if (player.takeDamage(speed * 3)) this.#wasted();
        }
      }
    }
  }

  /** Stopped in a car with an officer at the door for a second and a half: pulled out, busted. */
  #arrestInCar(dt: number): void {
    const player = this.player;
    const car = player.car;
    if (player.mode !== "driving" || car === undefined || this.wanted.stars === 0) {
      this.#carArrest = 0;
      return;
    }
    const adjacent =
      Math.abs(car.speed) < 1 &&
      this.people.some(
        (ped) => ped.cop && ped.alive && ped.inWorld && ped.position.distanceTo(car.position) < 2.8,
      );
    this.#carArrest = adjacent ? this.#carArrest + dt : 0;
    if (this.#carArrest > 1.5) this.#bust();
  }

  /**
   * A wreck burns, then explodes: 9 m radius, damage falling with distance (MCP card
   * grand-theft-auto-iii-re3/explosion-profile).
   */
  #explosions(): void {
    for (const car of this.cars) {
      if (!car.readyToExplode) continue;
      car.exploded = true;
      emitPlaytestEvent({ entity: "world", name: "explosion" });
      const player = this.player;
      const at = car.position;
      if (player.car === car && player.mode === "driving") {
        if (player.takeDamage(1000)) this.#wasted();
      } else if (player.inWorld) {
        const distance = player.position.distanceTo(at);
        if (distance < 9 && player.takeDamage(120 * (1 - distance / 9))) this.#wasted();
      }
      for (const ped of this.people) {
        const distance = ped.position.distanceTo(at);
        if (distance < 9 && ped.inWorld) ped.knockDown(100 * (1 - distance / 9), at);
      }
      for (const other of this.cars) {
        const distance = other.position.distanceTo(at);
        if (other !== car && distance < 9) other.damage(400 * (1 - distance / 9));
      }
    }
  }

  /** Hold the pursuit at the size the star count asks for, spawned where the player is not looking. */
  #policeBudget(dt: number): void {
    this.#policeTimer -= dt;
    const want = this.dispatch ? (POLICE_CARS[this.wanted.stars] as number) : 0;
    // A cruiser whose crew got out still counts while one of its officers is up nearby (see
    // `update`): no fresh car per deployment, but a new one once the crew is down or left behind.
    const live = this.police.filter((unit) => !unit.driver.car.wrecked).length;
    if (live < want && this.#policeTimer <= 0) {
      this.#policeTimer = 3;
      const lane = this.#hiddenLane();
      if (lane !== undefined) {
        const car = this.addCar(
          lane.start,
          Math.atan2(-lane.direction.x, -lane.direction.z),
          "police",
          true,
        );
        this.police.push({
          crew: 2,
          driver: new PursuitDriver(car, lane, this.#random),
          officers: [],
        });
        emitPlaytestEvent({ entity: "world", name: "police-dispatched" });
      }
    }
  }

  #hiddenLane(): ILane | undefined {
    const where = this.player.where;
    this.camera.getWorldDirection(_forward).setY(0).normalize();
    const options = LANES.filter((lane) => {
      const distance = lane.start.distanceTo(where);
      if (distance < SPAWN_NEAR || distance > SPAWN_FAR) return false;
      if (this.cars.some((car) => car.position.distanceTo(lane.start) < 8)) return false;
      _to.copy(lane.start).sub(this.camera.position).setY(0).normalize();
      // Behind the camera, or with a building between the lens and the spawn point, at any range.
      if (_to.dot(_forward) < 0.3) return true;
      return (
        this.ctx.physics.directSpaceState.intersectRay({
          collisionMask: WORLD_LAYER,
          from: this.camera.position,
          to: _local.copy(lane.start).setY(1),
        }) !== undefined
      );
    });
    // Nowhere hidden right now: try again next tick rather than spawn in plain view.
    return options.length === 0 ? undefined : this.#random.pick(options);
  }

  #deployCrew(unit: IPoliceCar): void {
    // Enough officers on foot already: the crew stays in and the cruiser keeps the pursuit.
    if (this.people.filter((ped) => ped.cop && ped.alive).length >= POPULATION.maxCopsOnFoot)
      return;
    const car = unit.driver.car;
    unit.crew = 0;
    // The empty cruiser stays a police car (counted, carjack-free) but holds no box.
    this.intersections.freeAll(car);
    car.occupied = false;
    for (const side of [1, -1]) {
      // Out of a door that faces open ground (see `#doorOf`), a step apart if both use one side.
      const at = this.#doorOf(car, new Vector3(), side).addScaledVector(_forward, side * 0.6);
      const cop = new Pedestrian(this.ctx, this.model, {
        at,
        block: this.#nearestBlock(at),
        cop: true,
        material: civilianMaterials[0] as (typeof civilianMaterials)[number],
        random: this.#random,
      });
      this.#addPerson(cop);
      unit.officers.push(cop);
    }
    emitPlaytestEvent({ entity: "world", name: "cops-out" });
  }

  #pickups(dt: number): void {
    const player = this.player;
    for (let index = this.pickups.length - 1; index >= 0; index -= 1) {
      const pickup = this.pickups[index] as IPickup;
      pickup.mesh.rotation.y += dt * 2;
      if (pickup.respawn > 0) {
        pickup.respawn -= dt;
        pickup.mesh.visible = pickup.respawn <= 0;
        continue;
      }
      if (player.mode !== "foot" || pickup.mesh.position.distanceTo(player.position) > 1.4)
        continue;
      if (pickup.kind === "money") this.money += pickup.amount;
      else {
        player.ammo += pickup.amount;
        player.clip = Math.min(COMBAT.clip, player.ammo);
        player.weapon = "pistol";
      }
      this.counts.pickups += 1;
      emitPlaytestEvent({ entity: "player", name: "pickup", kind: pickup.kind });
      if (pickup.fixed) {
        pickup.respawn = MONEY_RESPAWN;
        pickup.mesh.visible = false;
      } else {
        pickup.mesh.removeFromParent();
        this.pickups.splice(index, 1);
      }
    }
  }

  #spawnJobCar(): void {
    if (this.jobCar !== undefined && !this.jobCar.wrecked && this.jobCar !== this.player.car) {
      this.jobCar.body.teleport(JOB_CAR_SPOT.clone().setY(0.7), JOB_CAR_YAW);
      this.jobCar.repair(0xffc23a);
      this.jobCar.role = "mission";
      return;
    }
    this.jobCar = this.addCar(JOB_CAR_SPOT, JOB_CAR_YAW, "mission", false, 0xffc23a);
  }

  #jobTick(dt: number): void {
    const car = this.jobCar;
    const inJobCar = car !== undefined && this.player.car === car && this.player.mode === "driving";
    const result = this.job.update(
      dt,
      inJobCar,
      car?.position,
      car?.speed ?? 0,
      car?.wrecked ?? false,
    );
    if (result === "passed") {
      this.money += JOB.reward;
      this.#flash(`JOB DONE  $${JOB.reward}`, 3.5);
      emitPlaytestEvent({ entity: "player", name: "job-passed" });
      if (car !== undefined) car.role = "player";
      this.jobCar = undefined;
    } else if (result === "failed") {
      this.#flash("JOB FAILED", 3);
      emitPlaytestEvent({ entity: "player", name: "job-failed" });
    }
  }

  #flash(text: string, seconds: number): void {
    this.banner = text;
    this.bannerTime = seconds;
  }

  #wasted(): void {
    if (this.phase !== "playing") return;
    this.phase = "wasted";
    this.banner = "WASTED";
    this.#downTimer = DOWN_TIME;
    this.counts.wasted += 1;
    this.#resetChase();
    emitPlaytestEvent({ entity: "player", name: "wasted" });
  }

  #bust(): void {
    if (this.phase !== "playing") return;
    this.phase = "busted";
    this.banner = "BUSTED";
    this.#downTimer = DOWN_TIME;
    this.counts.busted += 1;
    const player = this.player;
    if (player.mode === "driving" && player.car !== undefined)
      player.enterWorld(this.#doorOf(player.car, _door));
    player.mode = "dead";
    player.play("hit", { hold: Number.POSITIVE_INFINITY });
    this.#resetChase();
    emitPlaytestEvent({ entity: "player", name: "busted" });
  }

  #resetChase(): void {
    if (this.job.abandon() !== undefined)
      emitPlaytestEvent({ entity: "player", name: "job-failed" });
  }

  #updateDown(dt: number): void {
    const player = this.player;
    player.updateIdle(dt);
    player.car?.hold();
    this.#downTimer -= dt;
    if (this.#downTimer > 0) return;
    // GTA's respawn: the hospital after WASTED, the police station after BUSTED; a fee, no weapons,
    // and the heat gone.
    const at = this.phase === "wasted" ? PLACES.hospital : PLACES.police;
    if (player.car !== undefined && player.car !== this.jobCar) player.car.role = "parked";
    this.money = Math.max(0, this.money - FEE);
    this.wanted.clear();
    player.respawn(at.clone().setY(KERB), false);
    this.phase = "playing";
    this.banner = "";
    for (const ped of this.people) ped.arrest = 0;
    emitPlaytestEvent({ entity: "player", name: "respawned" });
  }

  /** Keep the population topped up and the dead and the distant cleared away. */
  #housekeeping(): void {
    const where = this.player.where;
    for (let index = this.people.length - 1; index >= 0; index -= 1) {
      const ped = this.people[index] as Pedestrian;
      const gone =
        (ped.state === "dead" && ped.deadFor > 15) ||
        (ped.cop && this.wanted.stars === 0 && ped.position.distanceTo(where) > 40) ||
        (!ped.cop && ped.position.distanceTo(where) > POPULATION_RANGE.despawn);
      if (!gone) continue;
      this.#byBody.delete(ped.body.body.id);
      this.#remove(ped);
      ped.dispose();
      this.people.splice(index, 1);
    }
    const civilians = this.people.filter((ped) => !ped.cop).length;
    if (civilians < POPULATION.civilians) this.#spawnCivilian(false);
    for (let index = this.police.length - 1; index >= 0; index -= 1) {
      const unit = this.police[index] as IPoliceCar;
      const car = unit.driver.car;
      if (this.wanted.stars > 0 || car.position.distanceTo(where) < 50 || car === this.player.car)
        continue;
      this.police.splice(index, 1);
      this.#dropCar(car);
    }
    for (const driver of [...this.traffic])
      if (
        driver.car !== this.player.car &&
        driver.car !== this.jobCar &&
        driver.car.position.distanceTo(where) > POPULATION_RANGE.despawn
      )
        this.#dropCar(driver.car);
    if (this.traffic.length < POPULATION.traffic) {
      const lane = this.#hiddenLane();
      if (lane !== undefined && !this.cars.some((car) => car.position.distanceTo(lane.start) < 8))
        this.#spawnTraffic(lane, 0);
    }
    // Wrecks and abandoned cars far from the player make room for new traffic.
    if (this.cars.length > POPULATION.traffic + POPULATION.parked + 6)
      for (const car of [...this.cars])
        if (
          (car.exploded || car.role === "parked") &&
          car !== this.player.car &&
          car !== this.jobCar &&
          car.position.distanceTo(where) > 70
        ) {
          this.#dropCar(car);
          break;
        }
  }

  #dropCar(car: Car): void {
    this.intersections.freeAll(car);
    const driver = this.traffic.findIndex((candidate) => candidate.car === car);
    if (driver >= 0) this.traffic.splice(driver, 1);
    const unit = this.police.findIndex((candidate) => candidate.driver.car === car);
    if (unit >= 0) this.police.splice(unit, 1);
    if (this.jobCar === car) this.jobCar = undefined;
    this.#carByBody.delete(car.body.body.id);
    const index = this.cars.indexOf(car);
    if (index >= 0) this.cars.splice(index, 1);
    this.ctx.entities.remove(`car.${car.id}`);
    car.dispose();
  }

  #remove(ped: Pedestrian): void {
    const snapshot = this.ctx.entities.snapshot();
    for (const id of Object.keys(snapshot))
      if (this.ctx.entities.get(id) === ped) this.ctx.entities.remove(id);
  }

  /** Radar dots: police, the job car and pad, and the fixed landmarks. */
  blips(): Blip[] {
    const out: Blip[] = [
      { id: "hospital", kind: "hospital", x: PLACES.hospital.x, z: PLACES.hospital.z },
      { id: "police", kind: "police", x: PLACES.police.x, z: PLACES.police.z },
      { id: "respray", kind: "respray", x: PLACES.respray.x, z: PLACES.respray.z },
    ];
    if (this.job.state === "idle")
      out.push({ id: "phone", kind: "phone", x: PLACES.phone.x, z: PLACES.phone.z });
    if (this.job.active && this.jobCar !== undefined && this.player.car !== this.jobCar)
      out.push({
        id: "job-car",
        kind: "mission",
        x: this.jobCar.position.x,
        z: this.jobCar.position.z,
      });
    if (this.job.state === "deliver")
      out.push({ id: "dropoff", kind: "dropoff", x: PLACES.dropoff.x, z: PLACES.dropoff.z });
    for (const unit of this.police)
      if (!unit.driver.car.wrecked)
        out.push({
          id: `pc${unit.driver.car.id}`,
          kind: "cop",
          x: unit.driver.car.position.x,
          z: unit.driver.car.position.z,
        });
    for (const [index, ped] of this.people.entries())
      if (ped.cop && ped.alive)
        out.push({ id: `cop${index}`, kind: "cop", x: ped.position.x, z: ped.position.z });
    for (const [index, pickup] of this.pickups.entries())
      if (pickup.kind === "money" && pickup.mesh.visible)
        out.push({
          id: `m${index}`,
          kind: "money",
          x: pickup.mesh.position.x,
          z: pickup.mesh.position.z,
        });
    return out;
  }

  /**
   * Set up one station (see `STATIONS`). `Play` calls this only under a playtest runner, so a
   * player pressing the keys in a real build gets nothing.
   */
  stage(station: Station): void {
    const player = this.player;
    const civilian = this.people.find((ped) => !ped.cop && ped.alive && ped.inWorld);
    const parked = this.cars.find((car) => car.role === "parked" && !car.wrecked);
    const place = (at: Vector3, toward: Vector3): void => {
      player.enterWorld(_door.copy(at).setY(KERB + 0.05));
      player.face(Math.atan2(toward.x - at.x, toward.z - at.z));
    };
    // Out from a pedestrian's block, toward the road: open ground for a punch or a shot.
    const outFrom = (ped: Pedestrian, metres: number): Vector3 =>
      _to
        .copy(ped.position)
        .sub(this.#nearestBlock(ped.position).center)
        .setY(0)
        .normalize()
        .multiplyScalar(metres)
        .add(ped.position);
    const lane = nearestLane(PLACES.playerSpawn).lane;
    const yaw = Math.atan2(-lane.direction.x, -lane.direction.z);
    switch (station) {
      case "punch":
      case "pistol":
        if (civilian === undefined) return;
        civilian.pause(4);
        place(outFrom(civilian, station === "punch" ? 0.9 : 7), civilian.position);
        break;
      case "parked":
        if (parked !== undefined) place(this.#doorOf(parked, _local), parked.position);
        break;
      case "lane": {
        // Car 0 back to the start of its lane, the player standing in that lane 16 m ahead.
        const driver = this.traffic[0];
        if (driver === undefined) return;
        const own = driver.lane;
        this.intersections.freeAll(driver.car);
        const from = own.start.clone().addScaledVector(own.direction, 2);
        driver.car.body.teleport(
          { x: from.x, y: driver.car.position.y, z: from.z },
          Math.atan2(-own.direction.x, -own.direction.z),
        );
        driver.restartOn(own);
        place(from.clone().addScaledVector(own.direction, 16), from);
        break;
      }
      case "runover":
        // The spawn's parked car on a straight lane, a pedestrian standing in the road ahead.
        if (parked === undefined || civilian === undefined) return;
        parked.body.teleport({ x: lane.start.x, y: parked.position.y, z: lane.start.z }, yaw);
        this.#seat(parked);
        civilian.enterWorld(lane.start.clone().addScaledVector(lane.direction, 9));
        civilian.pause(5);
        break;
      case "hide":
        // One star and no dispatch: isolates the out-of-sight timer, which a pursuit would reset
        // (crime-brings-police proves the dispatch itself).
        this.dispatch = false;
        this.wanted.chaos = (STAR_CHAOS[1] + STAR_CHAOS[2]) / 2;
        break;
      case "respray":
        // One star, in a car on the road in front of the garage, nose in.
        if (parked === undefined) return;
        parked.body.teleport(
          { x: PLACES.respray.x, y: parked.position.y, z: PLACES.respray.z + 9 },
          0,
        );
        this.#seat(parked);
        this.wanted.chaos = (STAR_CHAOS[1] + STAR_CHAOS[2]) / 2;
        break;
      case "fire": {
        // At the wheel of a car that has just caught fire: the job car when there is one.
        const car = this.jobCar ?? parked;
        if (car === undefined) return;
        this.#seat(car);
        car.damage(Number.MAX_SAFE_INTEGER);
        // Wanted as well, so the respawn visibly clears the stars.
        this.wanted.chaos = (STAR_CHAOS[1] + STAR_CHAOS[2]) / 2;
        break;
      }
      case "arrest": {
        this.wanted.chaos = (STAR_CHAOS[1] + STAR_CHAOS[2]) / 2;
        const at = player.position.clone().add(_to.set(1.2, 0, 0));
        this.#addPerson(
          new Pedestrian(this.ctx, this.model, {
            at,
            block: this.#nearestBlock(at),
            cop: true,
            material: civilianMaterials[0] as (typeof civilianMaterials)[number],
            random: this.#random,
          }),
        );
        break;
      }
      case "phone":
        place(_local.copy(PLACES.phone).add(_to.set(0.6, 0, 0)), PLACES.phone);
        break;
      case "dropoff": {
        // At the wheel of the job car on the road 14 m short of the drop-off, nose toward it.
        const car = this.jobCar;
        if (car === undefined) return;
        car.body.teleport(
          { x: PLACES.dropoff.x, y: car.position.y, z: PLACES.dropoff.z - 14 },
          Math.PI,
        );
        this.#seat(car);
        break;
      }
      case "far": {
        // On the south-east corner block's sidewalk, 270 m from the plaza: streaming's test drive.
        const corner = BLOCKS.find((target) => target.i === ROADS - 2 && target.j === ROADS - 2);
        if (corner !== undefined) place(sidewalkLoop(corner)[0] as Vector3, corner.center);
        break;
      }
      case "money": {
        // Three metres short of a money pickup, facing it.
        const pickup = this.pickups.find((candidate) => candidate.kind === "money");
        if (pickup === undefined) return;
        const at = pickup.mesh.position;
        place(_local.copy(at).sub(this.#nearestBlock(at).center).setY(0).setLength(3).add(at), at);
        break;
      }
    }
    emitPlaytestEvent({ entity: "player", name: "station", station });
  }

  /** Straight into the driver's seat, no enter beat: only the stations use it. */
  #seat(car: Car): void {
    const player = this.player;
    player.car = car;
    player.leaveWorld(true);
    player.mode = "driving";
    car.occupied = false;
    car.role = car === this.jobCar ? "mission" : "player";
  }

  debug(): Record<string, unknown> {
    return {
      cars: this.cars.length,
      civilians: this.people.filter((ped) => !ped.cop).length,
      copsOnFoot: this.people.filter((ped) => ped.cop && ped.alive).length,
      fleeing: this.people.filter((ped) => ped.state === "flee").length,
      policeCars: this.police.length,
      seen: this.#seen,
      /** Civilians and traffic past `POPULATION_RANGE.despawn`: housekeeping keeps it at zero. */
      strays:
        this.people.filter(
          (ped) =>
            !ped.cop && ped.position.distanceTo(this.player.where) > POPULATION_RANGE.despawn,
        ).length +
        this.traffic.filter(
          (driver) => driver.car.position.distanceTo(this.player.where) > POPULATION_RANGE.despawn,
        ).length,
      traffic: this.traffic.length,
      trafficBlocked: this.traffic.filter((driver) => driver.blocked).length,
      trafficMoving: this.traffic.filter((driver) => Math.abs(driver.car.speed) > 3).length,
      unseen: this.wanted.unseen,
    };
  }
}
