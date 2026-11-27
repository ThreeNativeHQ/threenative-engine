// Everything alive in the arena and every rule between the cars: the player, the rival drivers,
// the pads, the crashes and who they count against. `scenes/Play.ts` builds the world and calls
// `update` before each physics step and `afterStep` after it.
import { type IRandom, createRandom } from "@threenative/core";
import type { Vector3 } from "three";
import { type IRivalControl, type Objective, RivalDriver } from "../ai/rival.js";
import { PADS, pathAt, yawOf } from "../arena/layout.js";
import { Car, type IControl } from "../entities/Car.js";
import type { GameCtx } from "../entities/layers.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { PAINTS } from "../render/car.js";
import { Race } from "./Race.js";

/** A rival's nastiness: how readily it picks a fight (opponent.c:1680). */
const NASTINESS = [0.9, 0.5, 0.2] as const;
/** Metres within which a crash is blamed on another car. */
const BLAME_RANGE = 6.5;
/** Slower than this, a car on a pad is repaired. */
const PAD_SPEED = 6;

export class World {
  readonly player: Car;
  readonly rivals: RivalDriver[] = [];
  readonly race = new Race();
  rammed = 0;
  backups = 0;
  /** A station parks the player: the brake holds it still until the next restart. */
  holdPlayer = false;
  repairing = false;
  bonusFlash = 0;
  /** Set by the clock: a freeze for tests that need the rivals still. */
  readonly #random: IRandom;

  constructor(readonly ctx: GameCtx) {
    this.#random = createRandom(30_303);
    const start = pathAt(6);
    this.player = new Car(ctx, {
      colour: PAINTS[0],
      name: "player",
      player: true,
      x: start.x,
      yaw: yawOf(start),
      z: start.z,
    });
    ctx.entities.add("player", this.player);
    const grid = [
      { lane: -4, s: -4 },
      { lane: 4, s: -12 },
      { lane: -4, s: -20 },
    ];
    grid.forEach((slot, index) => {
      const point = pathAt(slot.s);
      const x = point.x - point.fz * slot.lane;
      const z = point.z + point.fx * slot.lane;
      const car = new Car(ctx, {
        colour: PAINTS[index + 1] as number,
        name: `rival.${index}`,
        player: false,
        x,
        yaw: yawOf(point),
        z,
      });
      ctx.entities.add(`rival.${index}`, {
        debug: () => ({
          ...car.debug(),
          grudge: Math.round(driver.grudge),
          nastiness: driver.nastiness,
          objective: driver.objective,
        }),
        // The playtest bridge reads an entity's position off its `mesh`.
        mesh: car.mesh,
      });
      const driver = new RivalDriver(car, NASTINESS[index] as number, slot.s, () => this.#random());
      this.rivals.push(driver);
    });
    ctx.entities.add("race", this.race);
    ctx.entities.add("world", { debug: () => this.debug() });
  }

  get cars(): readonly Car[] {
    return [this.player, ...this.rivals.map((driver) => driver.car)];
  }

  get rivalsWrecked(): number {
    return this.rivals.filter((driver) => driver.car.wrecked).length;
  }

  /** The player's controls, then every rival's, then the pads and the race. */
  update(dt: number, input: IControl): void {
    this.bonusFlash = Math.max(0, this.bonusFlash - dt);
    const playing = this.race.phase === "playing";
    if (playing && !this.holdPlayer) this.player.control(input, dt);
    else this.player.hold();
    const target = {
      speed: Math.abs(this.player.speed),
      vx: this.player.body.linearVelocity.x,
      vz: this.player.body.linearVelocity.z,
      x: this.player.position.x,
      z: this.player.position.z,
    };
    for (const driver of this.rivals) {
      const before = driver.objective;
      const control: IRivalControl = playing
        ? driver.update(dt, target, this.rivals)
        : { back: 0, fwd: 0, handbrake: false, steer: 0 };
      if (before !== "backup" && driver.objective === "backup") {
        this.backups += 1;
        emitPlaytestEvent({ entity: driver.car.name, name: "rival-backs-off" });
      }
      if (driver.car.wrecked) driver.car.drive(control, dt);
      else if (driver.objective === "wait" || !playing) driver.car.hold();
      else driver.car.drive(control, dt);
    }
    this.#pads(dt);
    if (playing) {
      const gate = this.race.update(dt, this.player.position.x, this.player.position.z);
      if (gate >= 0) {
        this.bonusFlash = 2;
        emitPlaytestEvent({
          entity: "player",
          gate,
          name: "gate",
          timeLeft: Math.ceil(this.race.timeLeft),
        });
      }
    }
  }

  #pads(dt: number): void {
    const car = this.player;
    const onPad = PADS.some(
      (pad) => Math.hypot(car.position.x - pad.x, car.position.z - pad.z) < pad.radius,
    );
    this.repairing =
      onPad && !car.wrecked && Math.abs(car.speed) < PAD_SPEED && this.race.phase === "playing";
    if (!this.repairing) return;
    if (car.damage.repaired) {
      this.repairing = false;
      return;
    }
    car.damage.repair(dt);
  }

  /** After the physics step: crashes are blamed, wrecks are counted, and the race may end. */
  afterStep(dt: number): void {
    for (const car of this.cars) {
      const wasWrecked = car.wrecked;
      car.afterStep(dt);
      const hit = car.hit;
      if (hit !== undefined) {
        car.hit = undefined;
        const other = this.#culprit(car);
        if (other === undefined) {
          emitPlaytestEvent({
            entity: car.name,
            levels: Math.round(hit.levels),
            name: "crash",
            region: hit.region,
          });
        } else {
          this.#blame(car, other, hit.levels, hit.region);
        }
      }
      if (!wasWrecked && car.wrecked) this.#wrecked(car);
    }
    if (this.race.phase === "playing" && this.player.wrecked) this.race.wrecked();
    if (
      this.race.phase === "playing" &&
      this.rivals.length > 0 &&
      this.rivalsWrecked === this.rivals.length
    )
      this.race.rivalsWrecked();
  }

  #culprit(car: Car): Car | undefined {
    let best: Car | undefined;
    let bestGap = BLAME_RANGE;
    for (const other of this.cars) {
      if (other === car) continue;
      const gap = Math.hypot(other.position.x - car.position.x, other.position.z - car.position.z);
      if (gap < bestGap) {
        best = other;
        bestGap = gap;
      }
    }
    return best;
  }

  #blame(victim: Car, culprit: Car, levels: number, region: string): void {
    if (victim.player) {
      this.driverOf(culprit)?.provoke();
      emitPlaytestEvent({
        entity: "player",
        levels: Math.round(levels),
        name: "rammed-by-rival",
        region,
      });
    } else {
      if (culprit.player) {
        this.rammed += 1;
        this.driverOf(victim)?.provoke();
        emitPlaytestEvent({
          entity: "player",
          levels: Math.round(levels),
          name: "rammed-rival",
          region,
          victim: victim.name,
        });
      }
    }
  }

  #wrecked(car: Car): void {
    emitPlaytestEvent({ entity: car.name, name: "wrecked" });
  }

  driverOf(car: Car): RivalDriver | undefined {
    return this.rivals.find((driver) => driver.car === car);
  }

  /** Re-aims the rivals' objectives in one place for the HUD and tests. */
  objectives(): Record<Objective, number> {
    const counts: Record<Objective, number> = { backup: 0, pursue: 0, race: 0, wait: 0 };
    for (const driver of this.rivals) counts[driver.objective] += 1;
    return counts;
  }

  /** Where a player-facing camera should look from: the player's car. */
  get focus(): Vector3 {
    return this.player.position;
  }

  debug(): Record<string, unknown> {
    return {
      backups: this.backups,
      objectives: this.objectives(),
      rammed: this.rammed,
      rivalsWrecked: this.rivalsWrecked,
    };
  }
}
