import type { InputMap } from "@threenative/core";
import { Group, MathUtils, Matrix4, Vector3 } from "three";
import { type IRailFrame, type Rail, createFrame } from "../rail.js";
import { createShipModel } from "../render/hulls.js";
import type { FlightMode } from "../state.js";
import { AIM, ROLL, SHIELD, SHIP } from "../tuning.js";

const _basis = new Matrix4();
const _frame = createFrame();

/**
 * The player's ship: where it sits on the rail and in the corridor around it, the boost and brake
 * gauge, the barrel roll and the shield. It owns the flight model and nothing about shooting.
 *
 * Reference: Star Fox 64 `arwing-boost`, `arwing-brake`, `banking`, `barrel-roll`, `shield-damage`
 * and `rails-path-progress`; each constant in `tuning.ts` names its card.
 */
export class Ship {
  /** Placed on the rail frame every tick; `model` inside it carries the bank, the roll and the lean. */
  readonly group = new Group();
  readonly model = createShipModel();
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly nose = new Vector3();
  readonly reticle = new Vector3();
  frame: IRailFrame = createFrame();

  /** Metres flown along the rail. */
  s = 0;
  offsetX = 0;
  offsetY = 0;
  aimX = 0;
  aimY = 0;
  /** Speed above (+) or below (-) cruise, m/s. */
  speedOffset = 0;
  speed: number = SHIP.cruise;
  mode: FlightMode = "cruise";
  gauge = 0;
  gaugeLocked = false;
  bank = 0;
  rolling = false;
  rolls = 0;
  shield: number = SHIELD.max;
  /** Playtest-only: a hit that cannot hurt, so a long scenario outlives the enemy fire. */
  invulnerable = false;
  #pending = 0;
  #healing = 0;
  #mercy = 0;
  #vx = 0;
  #vy = 0;
  #throttle = 1;
  #tap = { left: 0, right: 0 };
  #roll = { angle: 0, dir: 1, spin: 0, rate: 0 };

  constructor(
    private readonly rail: Rail,
    private readonly arenaStop: number,
  ) {
    this.group.name = "ship";
    this.group.add(this.model);
    this.model.rotation.order = "YXZ";
  }

  get dead(): boolean {
    return this.shield <= 0;
  }

  /** Takes a hit: damage drains the shield over the next moments, behind a short window of mercy. */
  hit(damage: number): boolean {
    if (this.invulnerable || this.dead || this.#mercy > 0) return false;
    this.#pending += damage;
    this.#mercy = SHIELD.mercy;
    return true;
  }

  heal(amount: number): void {
    this.#healing += amount;
  }

  debug(): Record<string, unknown> {
    return {
      bank: this.bank,
      gauge: this.gauge,
      mode: this.mode,
      position: this.position.toArray(),
      rolling: this.rolling,
      s: this.s,
      shield: this.shield,
      speed: this.speed,
    };
  }

  /** The hull's own motion: stick, gauge, roll and rail progress. `held` is false after the run ends. */
  update(input: InputMap, dt: number, held: boolean): void {
    this.#mercy = Math.max(0, this.#mercy - dt);
    this.#drainShield(dt);
    if (held) {
      this.#gauge(input, dt);
      this.#roll_(input, dt);
      this.#steer(input, dt);
    } else {
      this.#vx = MathUtils.damp(this.#vx, 0, 3, dt);
      this.#vy = MathUtils.damp(this.#vy, 0, 3, dt);
    }
    this.#throttle = MathUtils.damp(this.#throttle, held ? 1 : 0, 2.5, dt);
    // rails-path-progress: the course scrolls by the ship's speed; at the arena it comes to rest.
    const toStop = Math.max(0, this.arenaStop - this.s);
    this.speed =
      Math.max(0, SHIP.cruise + this.speedOffset) * Math.min(1, toStop / 60) * this.#throttle;
    this.s = Math.min(this.arenaStop, this.s + this.speed * dt);
    this.#bank(input, dt, held);
    this.#place(held);
  }

  /** arwing-boost and arwing-brake: one gauge pays for both. */
  #gauge(input: InputMap, dt: number): void {
    const boost = input.pressed("boost");
    const brake = input.pressed("brake");
    const asked: FlightMode = boost === brake ? "cruise" : boost ? "boost" : "brake";
    this.mode = this.gaugeLocked ? "cruise" : asked;
    if (this.mode === "cruise") {
      this.gauge = Math.max(0, this.gauge - SHIP.gaugeRecover * dt);
      if (this.gaugeLocked && this.gauge === 0) this.gaugeLocked = false;
      this.speedOffset = approach(this.speedOffset, 0, SHIP.speedRecover * dt);
      return;
    }
    this.gauge = Math.min(SHIP.gaugeMax, this.gauge + SHIP.gaugeFill * dt);
    if (this.gauge >= SHIP.gaugeMax) this.gaugeLocked = true;
    this.speedOffset =
      this.mode === "boost"
        ? Math.min(SHIP.boostMax, this.speedOffset + SHIP.boostAccel * dt)
        : Math.max(SHIP.brakeMin, this.speedOffset - SHIP.brakeDecel * dt);
  }

  /** barrel-roll: a second press of one shoulder key inside the window starts a roll that turns shots. */
  #roll_(input: InputMap, dt: number): void {
    const roll = this.#roll;
    this.#tap.left = Math.max(0, this.#tap.left - dt);
    this.#tap.right = Math.max(0, this.#tap.right - dt);
    for (const [key, side, dir] of [
      ["rollLeft", "left", 1],
      ["rollRight", "right", -1],
    ] as const) {
      if (!input.justPressed(key)) continue;
      if (this.#tap[side] > 0 && !this.rolling) {
        roll.dir = dir;
        roll.spin = ROLL.spinTime;
        roll.rate = ROLL.spinRate;
        roll.angle = 0;
        this.rolling = true;
        this.rolls += 1;
        this.#tap[side] = 0;
      } else this.#tap[side] = ROLL.tapWindow;
    }
    if (!this.rolling) return;
    if (roll.spin > 0) roll.spin -= dt;
    else roll.rate = Math.max(0, roll.rate - (ROLL.spinRate / ROLL.decayTime) * dt);
    roll.angle += roll.rate * dt;
    if (roll.spin <= 0 && roll.rate === 0) {
      this.rolling = false;
      roll.angle = 0;
    }
  }

  #steer(input: InputMap, dt: number): void {
    const stick = input.vector("move");
    const scale = this.rolling ? ROLL.steerScale : 1;
    this.#vx = MathUtils.damp(this.#vx, stick.x * SHIP.steerSpeed * scale, SHIP.steerRate, dt);
    this.#vy = MathUtils.damp(
      this.#vy,
      stick.y * SHIP.steerSpeed * 0.6 * scale,
      SHIP.steerRate,
      dt,
    );
    this.offsetX = MathUtils.clamp(this.offsetX + this.#vx * dt, -SHIP.boxX, SHIP.boxX);
    this.offsetY = MathUtils.clamp(this.offsetY + this.#vy * dt, -SHIP.boxY, SHIP.boxY);
    if (Math.abs(this.offsetX) >= SHIP.boxX) this.#vx = 0;
    if (Math.abs(this.offsetY) >= SHIP.boxY) this.#vy = 0;
    // The reticle leads the stick, ahead of the nose.
    this.aimX = MathUtils.damp(this.aimX, stick.x * AIM.leadX, AIM.follow, dt);
    this.aimY = MathUtils.damp(this.aimY, stick.y * AIM.leadY, AIM.follow, dt);
  }

  /** banking: a held shoulder key leans the hull to 90 degrees; the stick leans it into the turn. */
  #bank(input: InputMap, dt: number, held: boolean): void {
    const hold = held ? -input.vector("bank").x : 0;
    const target =
      hold !== 0 ? hold * SHIP.bankHold : (-this.#vx / SHIP.steerSpeed) * SHIP.bankLean;
    const step = MathUtils.damp(this.bank, target, SHIP.bankChase, dt) - this.bank;
    const limit = SHIP.bankLimit * dt;
    this.bank += Math.max(-limit, Math.min(limit, step));
  }

  #place(held: boolean): void {
    this.rail.frameAt(this.s, this.frame);
    const { position, right, up, forward } = this.frame;
    this.position
      .copy(position)
      .addScaledVector(right, this.offsetX)
      .addScaledVector(up, this.offsetY);
    this.velocity.copy(forward).multiplyScalar(this.speed);
    this.group.position.copy(this.position);
    this.group.quaternion.setFromRotationMatrix(
      _basis.makeBasis(right, up, _frame.forward.copy(forward).negate()),
    );
    // The model leans into its lateral motion: a little yaw and pitch, the bank, then any roll.
    const turn = held ? this.#vx / SHIP.steerSpeed : 0;
    this.model.rotation.set(
      (this.#vy / SHIP.steerSpeed) * 0.25,
      -turn * 0.3,
      this.bank + this.#roll.dir * this.#roll.angle,
    );
    // The nose and the reticle sit ahead on the rail's direction, with the reticle led by the stick.
    this.nose.copy(this.position).addScaledVector(forward, 2.6);
    this.reticle
      .copy(this.position)
      .addScaledVector(forward, AIM.distance)
      .addScaledVector(right, this.aimX)
      .addScaledVector(up, this.aimY);
  }

  #drainShield(dt: number): void {
    const step = SHIELD.rate * dt;
    const loss = Math.min(this.#pending, step);
    this.#pending -= loss;
    this.shield = Math.max(0, this.shield - loss);
    const gain = Math.min(this.#healing, step, SHIELD.max - this.shield);
    this.#healing -= Math.min(this.#healing, step);
    this.shield += gain;
  }
}

function approach(value: number, target: number, step: number): number {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}
