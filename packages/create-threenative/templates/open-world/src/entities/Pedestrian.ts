import type { IRandom } from "@threenative/core";
import { BoxGeometry, type Material, Mesh, Vector3 } from "three";
import { BLOCKS, type IBlock, sidewalkLoop } from "../city/layout.js";
import { copMaterial, pistolMaterial } from "../render/materials.js";
import { Humanoid, type IMannequin } from "./Humanoid.js";
import { CAR_LAYER, type GameCtx, PED_LAYER, PLAYER_LAYER, WORLD_LAYER } from "./layers.js";

/**
 * Pedestrian behaviour, borrowed from GTA III's ped AI (MCP cards grand-theft-auto-iii-re3/
 * ped-state-timer and ped-wait-timer: a state is held 600 ms before the next decision, and an idle
 * ped waits two seconds before walking on) and San Andreas' stat defaults (…/ped-stat-defaults:
 * a frightened ped tries to get 20 units away).
 */
export const PED = {
  walk: 1.4,
  flee: 5.4,
  dwell: 0.6,
  wait: 2,
  fleeDistance: 20,
  /** Chance at a corner to cross the road to the next block instead of walking on. */
  crossChance: 0.3,
  /** Seconds on the ground before a knocked-down ped gets up (if still alive). */
  downTime: 3.5,
  health: 30,
} as const;

/** Officers on foot. Arrest needs a second adjacent; shots only from two stars up (re3 behaviour). */
export const COP = {
  chase: 5.2,
  arrestReach: 1.4,
  arrestTime: 1,
  shootRange: 18,
  shootInterval: 0.8,
  damage: 8,
  health: 50,
} as const;

export type PedState = "wander" | "wait" | "flee" | "down" | "dead" | "chase" | "shoot";

const _to = new Vector3();

/**
 * A person on the street: a civilian who wanders the sidewalk loops and flees from trouble, or an
 * officer who chases, shoots and arrests. One class because the only difference is the decision
 * each tick; the body, the clips and the fall are the same.
 */
export class Pedestrian extends Humanoid {
  readonly cop: boolean;
  readonly tags: string[];
  state: PedState = "wander";
  /** Seconds since the last decision, against `PED.dwell`. */
  #dwell = 0;
  #timer = 0;
  #loop: Vector3[];
  #corner = 0;
  #step = 1;
  #random: IRandom;
  #threat = new Vector3();
  #crossing: Vector3 | undefined;
  #shootTimer = 0;
  /** Seconds this officer has been within reach of an on-foot player. */
  arrest = 0;
  /** Set when the officer pulled the trigger this tick; `Play` resolves the hit. */
  fired = false;
  /** Seconds since death, for despawning. */
  deadFor = 0;

  constructor(
    ctx: GameCtx,
    model: IMannequin,
    options: {
      readonly at: Vector3;
      readonly block: IBlock;
      readonly material: Material;
      readonly random: IRandom;
      readonly cop?: boolean;
    },
  ) {
    const cop = options.cop === true;
    const pistol = cop ? new Mesh(new BoxGeometry(0.05, 0.12, 0.22), pistolMaterial) : undefined;
    pistol?.position.set(0, 0.02, 0.06);
    super(ctx, model, {
      collisionLayer: PED_LAYER,
      collisionMask: WORLD_LAYER | CAR_LAYER | PLAYER_LAYER | PED_LAYER,
      health: cop ? COP.health : PED.health,
      material: cop ? copMaterial : options.material,
      position: options.at,
      ...(pistol === undefined ? {} : { weapon: pistol }),
    });
    this.cop = cop;
    this.tags = cop ? ["cop", "pedestrian"] : ["pedestrian"];
    this.#random = options.random;
    this.#loop = sidewalkLoop(options.block);
    this.#corner = this.#nearestCorner(options.at);
    this.#step = this.#random() < 0.5 ? 1 : -1;
    if (cop) this.state = "chase";
  }

  /** Something frightening happened at `from`: run the other way (cops are not frightened). */
  scare(from: Vector3): void {
    if (this.cop || !this.alive || this.state === "down") return;
    this.#threat.copy(from);
    this.#crossing = undefined;
    if (this.state !== "flee") {
      this.state = "flee";
      this.#timer = 0;
    }
  }

  /** Knocked down by a car or a fist. Returns true if it killed. */
  knockDown(damage: number, from: Vector3): boolean {
    if (this.state === "dead") return false;
    this.#threat.copy(from);
    this.health = Math.max(0, this.health - damage);
    this.state = this.health > 0 ? "down" : "dead";
    this.#timer = 0;
    this.play("death", { fade: 0.06, hold: Number.POSITIVE_INFINITY });
    this.leaveWorld(false);
    return this.state === "dead";
  }

  /** A shot or a punch that does not floor them: a flinch, then flight. Returns true if it killed. */
  takeHit(damage: number, from: Vector3): boolean {
    if (!this.alive) return false;
    if (this.health - damage <= 0) return this.knockDown(damage, from);
    this.health -= damage;
    // Long enough to root them through the follow-up punch of a combo.
    this.play("hit", { fade: 0.04, hold: 0.65 });
    this.scare(from);
    return false;
  }

  /**
   * One tick. `player` is where the player is; `wanted` the star count; `playerOnFoot` whether an
   * arrest is possible; `seesPlayer` an already-run line-of-sight answer for officers.
   */
  update(
    dt: number,
    player: Vector3,
    stars: number,
    playerOnFoot: boolean,
    seesPlayer: boolean,
  ): void {
    this.fired = false;
    this.#dwell += dt;
    this.#timer += dt;
    switch (this.state) {
      case "dead":
        this.deadFor += dt;
        this.animateStill(dt);
        return;
      case "down":
        this.animateStill(dt);
        if (this.#timer >= PED.downTime) {
          this.enterWorld(this.visual.position.clone().setY(0.15));
          this.release();
          this.state = this.cop ? "chase" : "flee";
          this.#timer = 0;
        }
        return;
    }
    if (this.cop) this.#police(dt, player, stars, playerOnFoot, seesPlayer);
    else this.#civilian(dt);
  }

  #civilian(dt: number): void {
    // A flinch roots them for its length, so a punch combo can land before they run.
    if (this.busy && this.action === "hit") {
      this.move(dt, 0, 0);
      this.animateRig(dt, undefined, 0);
      return;
    }
    if (this.state === "flee") {
      _to.copy(this.position).sub(this.#threat).setY(0);
      if (_to.lengthSq() < 1e-4) _to.set(1, 0, 0);
      const far = _to.length() >= PED.fleeDistance;
      if (far && this.#dwell >= PED.dwell && this.#timer > 2) {
        this.state = "wander";
        // Settle on whichever block they ran to, not the one they ran from.
        let best = Number.POSITIVE_INFINITY;
        for (const other of BLOCKS)
          for (const [index, corner] of sidewalkLoop(other).entries()) {
            const distance = corner.distanceTo(this.position);
            if (distance >= best) continue;
            best = distance;
            this.#loop = sidewalkLoop(other);
            this.#corner = index;
          }
        this.#dwell = 0;
      }
      _to.normalize().multiplyScalar(PED.flee);
      this.move(dt, _to.x, _to.z);
      this.animateRig(dt, Math.atan2(_to.x, _to.z), this.groundSpeed());
      return;
    }
    if (this.state === "wait") {
      this.move(dt, 0, 0);
      this.animateRig(dt, undefined, 0);
      if (this.#timer >= PED.wait) {
        this.state = "wander";
        this.#dwell = 0;
      }
      return;
    }
    const goal = this.#crossing ?? (this.#loop[this.#corner] as Vector3);
    _to.copy(goal).sub(this.position).setY(0);
    if (_to.length() < 0.6) {
      if (this.#crossing !== undefined) this.#adoptBlockAt(this.#crossing);
      this.#crossing = undefined;
      this.#arriveAtCorner();
      this.move(dt, 0, 0);
      this.animateRig(dt, undefined, 0);
      return;
    }
    _to.normalize().multiplyScalar(PED.walk);
    this.move(dt, _to.x, _to.z);
    this.animateRig(dt, Math.atan2(_to.x, _to.z), this.groundSpeed(), false, 6);
  }

  #police(
    dt: number,
    player: Vector3,
    stars: number,
    playerOnFoot: boolean,
    seesPlayer: boolean,
  ): void {
    if (this.busy && this.action === "hit") {
      this.move(dt, 0, 0);
      this.animateRig(dt, undefined, 0);
      return;
    }
    _to.copy(player).sub(this.position).setY(0);
    const distance = _to.length();
    const heading = Math.atan2(_to.x, _to.z);
    if (stars === 0) {
      // Nothing to do: stand down where they are; `Play` despawns them out of view.
      this.arrest = 0;
      this.move(dt, 0, 0);
      this.animateRig(dt, undefined, 0);
      return;
    }
    // Two stars and up, an officer with a clear line stops and shoots; one star only arrests.
    const shoot =
      stars >= 2 && seesPlayer && distance <= COP.shootRange && distance > COP.arrestReach * 2;
    if (this.#dwell >= PED.dwell) {
      const next: PedState = shoot ? "shoot" : "chase";
      if (next !== this.state) {
        this.state = next;
        this.#dwell = 0;
      }
    }
    if (this.state === "shoot") {
      this.arrest = 0;
      this.move(dt, 0, 0);
      this.face(heading);
      this.#shootTimer -= dt;
      if (this.#shootTimer <= 0) {
        this.#shootTimer = COP.shootInterval;
        this.play("shoot", { fade: 0.04, hold: 0.25 });
        this.fired = true;
      }
      this.animateRig(dt, undefined, 0, true);
      return;
    }
    if (distance <= COP.arrestReach && playerOnFoot) {
      this.arrest += dt;
      this.move(dt, 0, 0);
      this.face(heading);
      this.animateRig(dt, undefined, 0, true);
      return;
    }
    this.arrest = Math.max(0, this.arrest - dt);
    _to.normalize().multiplyScalar(distance > COP.arrestReach ? COP.chase : 0);
    this.move(dt, _to.x, _to.z);
    this.animateRig(dt, heading, this.groundSpeed());
  }

  #arriveAtCorner(): void {
    // At a corner: sometimes stop for a moment, sometimes cross to the next block, else walk on.
    const roll = this.#random();
    if (roll < 0.2) {
      this.state = "wait";
      this.#timer = 0;
    } else if (roll < 0.2 + PED.crossChance) {
      const here = this.#loop[this.#corner] as Vector3;
      const across = this.#acrossFrom(here);
      if (across !== undefined) {
        this.#crossing = across;
        return;
      }
    }
    this.#corner = (this.#corner + this.#step + 4) % 4;
  }

  /** The nearest corner of another block across one road from `corner`, if any. */
  #acrossFrom(corner: Vector3): Vector3 | undefined {
    const options: Vector3[] = [];
    for (const other of BLOCKS)
      for (const point of sidewalkLoop(other)) {
        const distance = point.distanceTo(corner);
        if (distance > 1 && distance < 16) options.push(point);
      }
    return options.length === 0 ? undefined : this.#random.pick(options);
  }

  #adoptBlockAt(point: Vector3): void {
    for (const other of BLOCKS) {
      const loop = sidewalkLoop(other);
      const index = loop.findIndex((corner) => corner.distanceTo(point) < 0.5);
      if (index >= 0) {
        this.#loop = loop;
        this.#corner = index;
        return;
      }
    }
  }

  #nearestCorner(point: Vector3): number {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, corner] of this.#loop.entries()) {
      const distance = corner.distanceTo(point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  /** Stand still for `seconds`: a playtest station sets up a hit with it. */
  pause(seconds: number): void {
    this.state = "wait";
    this.#timer = PED.wait - seconds;
  }

  debug(): Record<string, unknown> {
    return {
      action: this.action,
      arrest: this.arrest,
      cop: this.cop,
      health: this.health,
      position: this.position.toArray(),
      state: this.state,
    };
  }
}
