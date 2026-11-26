// Lasers, the charged homing shot and enemy fire: three instanced meshes and one pool of bolts.
//
// Reference: Star Fox 64 `laser-fire` (a press fires at once, a hold repeats every 4 updates),
// `charge-lock-on` (a charge past 20 updates searches for a mark, a release past 10 fires the
// homing shot) and `lock-on-tracking` (the mark lasts 20 updates, the turn rate ramps).
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { CHARGE, ENEMY, LASER, ROLL, SHIP } from "../tuning.js";
import type { ITarget } from "./Target.js";

type Owner = "player" | "enemy";
type Kind = "laser" | "homing" | "enemy";

interface IBolt {
  active: boolean;
  kind: Kind;
  owner: Owner;
  damage: number;
  life: number;
  turn: number;
  target: ITarget | undefined;
  readonly position: Vector3;
  readonly previous: Vector3;
  readonly velocity: Vector3;
}

const POOL = { laser: 48, homing: 6, enemy: 72 } as const;

const _quaternion = new Quaternion();
const _matrix = new Matrix4();
const _scale = new Vector3(1, 1, 1);
const _forward = new Vector3(0, 0, -1);
const _to = new Vector3();
const _axis = new Vector3();
const _heading = new Vector3();
const _aimLine = new Vector3();
const _segment = new Vector3();
const _closest = new Vector3();
const _hidden = new Matrix4().makeScale(0, 0, 0);

/** Distance from `point` to the segment `from`-`to`. */
function segmentDistance(from: Vector3, to: Vector3, point: Vector3): number {
  _segment.subVectors(to, from);
  const length = _segment.lengthSq();
  const along =
    length === 0 ? 0 : Math.min(1, Math.max(0, _to.subVectors(point, from).dot(_segment) / length));
  return _closest.copy(from).addScaledVector(_segment, along).distanceTo(point);
}

export interface IWeaponEvents {
  /** A player shot landed on `target`. */
  readonly onHit: (target: ITarget, kind: Kind) => void;
  /** An enemy shot was turned back by a barrel roll. */
  readonly onDeflect: () => void;
  /** An enemy shot reached the hull. */
  readonly onStruck: (damage: number) => void;
}

export class Weapons {
  readonly group = new Group();
  /** Lasers fired and homing shots released this run. */
  shots = 0;
  homingShots = 0;
  /** Charge, 0 to 1. */
  charge = 0;
  mark: ITarget | undefined;
  enemyShots = 0;
  readonly #bolts: IBolt[] = [];
  readonly #meshes: Record<Kind, InstancedMesh>;
  readonly #pools: Record<Kind, IBolt[]> = { laser: [], homing: [], enemy: [] };
  #cooldown = 0;
  #held = 0;
  #search = 0;
  #markLife = 0;

  constructor() {
    this.group.name = "weapons";
    const make = (
      geometry: BoxGeometry | SphereGeometry,
      color: number,
      count: number,
    ): InstancedMesh => {
      const mesh = new InstancedMesh(geometry, new MeshBasicMaterial({ color }), count);
      mesh.frustumCulled = false;
      for (let index = 0; index < count; index += 1) mesh.setMatrixAt(index, _hidden);
      this.group.add(mesh);
      return mesh;
    };
    this.#meshes = {
      laser: make(new BoxGeometry(0.16, 0.16, 2.6), 0x7fd0ff, POOL.laser),
      homing: make(new SphereGeometry(0.55, 10, 8), 0xffffff, POOL.homing),
      enemy: make(new SphereGeometry(ENEMY.shotRadius, 10, 8), 0xff8a4d, POOL.enemy),
    };
    for (const kind of ["laser", "homing", "enemy"] as const) {
      for (let index = 0; index < POOL[kind]; index += 1) {
        const bolt: IBolt = {
          active: false,
          kind,
          owner: kind === "enemy" ? "enemy" : "player",
          damage: 0,
          life: 0,
          turn: 0,
          target: undefined,
          position: new Vector3(),
          previous: new Vector3(),
          velocity: new Vector3(),
        };
        this.#bolts.push(bolt);
        this.#pools[kind].push(bolt);
      }
    }
  }

  /** Enemy fire. */
  fireEnemy(from: Vector3, direction: Vector3, damage = 0): void {
    const bolt = this.#take("enemy");
    if (bolt === undefined) return;
    bolt.owner = "enemy";
    bolt.damage = damage;
    bolt.life = ENEMY.shotLife;
    bolt.position.copy(from);
    bolt.previous.copy(from);
    bolt.velocity.copy(direction).normalize().multiplyScalar(ENEMY.shotSpeed);
    this.enemyShots += 1;
  }

  /** One laser from the nose toward the reticle. The hull's own velocity is added to the bolt. */
  fireLaser(from: Vector3, toward: Vector3, shipVelocity: Vector3): void {
    const bolt = this.#take("laser");
    if (bolt === undefined) return;
    bolt.owner = "player";
    bolt.damage = LASER.damage;
    bolt.life = LASER.life;
    bolt.position.copy(from);
    bolt.previous.copy(from);
    bolt.velocity
      .subVectors(toward, from)
      .normalize()
      .multiplyScalar(LASER.speed)
      .add(shipVelocity);
    this.shots += 1;
  }

  #homing(
    from: Vector3,
    toward: Vector3,
    shipVelocity: Vector3,
    target: ITarget | undefined,
  ): void {
    const bolt = this.#take("homing");
    if (bolt === undefined) return;
    bolt.owner = "player";
    bolt.damage = CHARGE.damage;
    bolt.life = CHARGE.life;
    bolt.turn = 0;
    bolt.target = target;
    bolt.position.copy(from);
    bolt.previous.copy(from);
    bolt.velocity
      .subVectors(toward, from)
      .normalize()
      .multiplyScalar(CHARGE.speed)
      .add(shipVelocity);
    this.homingShots += 1;
  }

  #take(kind: Kind): IBolt | undefined {
    const bolt = this.#pools[kind].find((candidate) => !candidate.active);
    if (bolt === undefined) return undefined;
    bolt.active = true;
    bolt.target = undefined;
    return bolt;
  }

  /**
   * The player's trigger. A press fires; a hold repeats and charges; past `searchFrom` it marks the
   * target nearest the reticle; a release past `releaseMin` sends the homing shot.
   */
  trigger(
    input: {
      readonly pressed: boolean;
      readonly justPressed: boolean;
      readonly justReleased: boolean;
    },
    dt: number,
    from: Vector3,
    reticle: Vector3,
    shipVelocity: Vector3,
    targets: readonly ITarget[],
  ): void {
    this.#cooldown = Math.max(0, this.#cooldown - dt);
    if (input.justPressed) {
      this.fireLaser(from, reticle, shipVelocity);
      this.#cooldown = LASER.interval;
      this.#held = 0;
    } else if (input.pressed && this.#cooldown <= 0) {
      this.fireLaser(from, reticle, shipVelocity);
      this.#cooldown += LASER.interval;
    }
    if (input.pressed) {
      this.#held = Math.min(CHARGE.full, this.#held + dt);
      this.#search -= dt;
      if (this.#held >= CHARGE.searchFrom && this.#search <= 0) {
        this.#search = CHARGE.searchEvery;
        const found = this.#nearest(from, reticle, targets);
        if (found !== undefined) {
          this.mark = found;
          this.#markLife = CHARGE.markLife;
        }
      }
    }
    this.#markLife -= dt;
    if (this.#markLife <= 0 || this.mark?.live === false) this.mark = undefined;
    if (input.justReleased) {
      // The shot leaves along the reticle line and then turns onto its mark.
      if (this.#held >= CHARGE.releaseMin) this.#homing(from, reticle, shipVelocity, this.mark);
      this.cancel();
    }
    this.charge = this.#held / CHARGE.full;
  }

  /** Drops the charge and the mark, for a release and for the end of a run. */
  cancel(): void {
    this.#held = 0;
    this.#search = 0;
    this.mark = undefined;
    this.charge = 0;
  }

  /**
   * lock-on-tracking: the live target nearest the aim line, inside a cone that widens with range.
   * A target dead-centre on the reticle counts at any range the search reaches.
   */
  #nearest(from: Vector3, reticle: Vector3, targets: readonly ITarget[]): ITarget | undefined {
    _aimLine.subVectors(reticle, from).normalize();
    let best: ITarget | undefined;
    let bestOffset = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      if (!target.live) continue;
      _to.subVectors(target.position, from);
      const along = _to.dot(_aimLine);
      if (along < CHARGE.searchNear || along > CHARGE.searchReach) continue;
      const off = _to.addScaledVector(_aimLine, -along).length() - target.radius;
      if (off > along * CHARGE.searchSlope || off >= bestOffset) continue;
      bestOffset = off;
      best = target;
    }
    return best;
  }

  update(
    dt: number,
    ship: Vector3,
    rolling: boolean,
    targets: readonly ITarget[],
    events: IWeaponEvents,
  ): void {
    for (const bolt of this.#bolts) {
      if (!bolt.active) continue;
      bolt.previous.copy(bolt.position);
      if (bolt.kind === "homing") this.#steer(bolt, dt);
      bolt.position.addScaledVector(bolt.velocity, dt);
      bolt.life -= dt;
      if (bolt.life <= 0) {
        bolt.active = false;
        continue;
      }
      if (bolt.owner === "player") {
        for (const target of targets) {
          if (!target.live) continue;
          if (segmentDistance(bolt.previous, bolt.position, target.position) > target.radius + 0.3)
            continue;
          if (target.hurt(bolt.damage)) events.onHit(target, bolt.kind);
          bolt.active = false;
          break;
        }
        continue;
      }
      const reach = segmentDistance(bolt.previous, bolt.position, ship);
      if (rolling && reach < SHIP.radius + ROLL.deflectRadius) {
        // The roll turns the shot: it flies back, faster, and now hurts enemies.
        bolt.owner = "player";
        bolt.damage = 2;
        bolt.velocity.multiplyScalar(-ROLL.returnSpeed);
        bolt.life = LASER.life;
        events.onDeflect();
      } else if (reach < SHIP.radius + ENEMY.shotRadius) {
        events.onStruck(bolt.damage);
        bolt.active = false;
      }
    }
    this.#draw();
  }

  /** lock-on-tracking: the turn rate ramps each update toward a ceiling and the shot closes on its mark. */
  #steer(bolt: IBolt, dt: number): void {
    const target = bolt.target;
    if (target === undefined || !target.live) return;
    bolt.turn = Math.min(CHARGE.turnMax, bolt.turn + CHARGE.turnRamp * dt);
    _to.subVectors(target.position, bolt.position).normalize();
    const speed = bolt.velocity.length();
    const direction = _heading.copy(bolt.velocity).normalize();
    const angle = direction.angleTo(_to);
    if (angle < 1e-4) return;
    const step = Math.min(angle, bolt.turn * dt);
    _axis.crossVectors(direction, _to);
    if (_axis.lengthSq() < 1e-8) return;
    direction.applyAxisAngle(_axis.normalize(), step);
    bolt.velocity.copy(direction).multiplyScalar(speed);
  }

  #draw(): void {
    const counts: Record<Kind, number> = { laser: 0, homing: 0, enemy: 0 };
    for (const bolt of this.#bolts) {
      if (!bolt.active) continue;
      const mesh = this.#meshes[bolt.kind];
      const at = counts[bolt.kind]++;
      _quaternion.setFromUnitVectors(_forward, _to.copy(bolt.velocity).normalize());
      _matrix.compose(bolt.position, _quaternion, _scale);
      mesh.setMatrixAt(at, _matrix);
    }
    for (const kind of ["laser", "homing", "enemy"] as const) {
      const mesh = this.#meshes[kind];
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
