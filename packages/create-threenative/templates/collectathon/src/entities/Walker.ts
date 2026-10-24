import { type Group, MathUtils, Vector3 } from "three";
import { walkerModel } from "../render/props.js";

/**
 * The key `@threenative/playtest` sets on an entity a scenario placed with `frozen: true`. Written
 * here rather than imported: the marker belongs to the test harness, and game code importing a
 * devDependency stops building for a native target. Honouring it keeps a stomp reproducible.
 */
const PLAYTEST_FROZEN = "__threenativeFrozen";

const WALKER = {
  /** Wander speed around home, and chase speed toward a hero inside `sight`. */
  wanderSpeed: 1.2,
  chaseSpeed: 2.6,
  sight: 6,
  /** How far from home it will chase before it gives up and goes back. */
  leash: 7,
  /** Its body, for touches: a cylinder this wide and tall from its feet. */
  radius: 0.65,
  height: 1.2,
} as const;

/**
 * A stompable walker: it wanders a circle round its home and chases the hero inside its sight.
 * Kinematic scenery that can be hit, not a physics body: a touch costs one distance test.
 */
export class Walker {
  readonly mesh: Group;
  readonly tags = ["walker"];
  alive = true;
  readonly #home = new Vector3();
  #squash = 0;
  #phase: number;

  constructor(at: readonly [number, number, number], phase: number) {
    this.mesh = walkerModel();
    this.mesh.position.set(at[0], at[1], at[2]);
    this.#phase = phase;
    this.settle();
  }

  static readonly radius = WALKER.radius;
  static readonly height = WALKER.height;

  /** Takes the current position as home: call once after a scenario may have placed it. */
  settle(): void {
    this.#home.copy(this.mesh.position);
  }

  update(dt: number, time: number, hero: Vector3): void {
    if (!this.alive) {
      // Flattened, then gone: the squash is the stomp's feedback before the count moves.
      this.#squash += dt;
      this.mesh.scale.set(
        1 + this.#squash * 1.5,
        Math.max(0.05, 1 - this.#squash * 3),
        1 + this.#squash * 1.5,
      );
      if (this.#squash > 0.4) this.mesh.removeFromParent();
      return;
    }
    if (this.mesh.userData[PLAYTEST_FROZEN] === true) return;
    const p = this.mesh.position;
    const toHero = Math.hypot(hero.x - p.x, hero.z - p.z);
    const fromHome = Math.hypot(p.x - this.#home.x, p.z - this.#home.z);
    let tx: number;
    let tz: number;
    let speed: number = WALKER.wanderSpeed;
    if (toHero < WALKER.sight && fromHome < WALKER.leash && Math.abs(hero.y - p.y) < 2.5) {
      tx = hero.x;
      tz = hero.z;
      speed = WALKER.chaseSpeed;
    } else {
      this.#phase += dt * 0.35;
      tx = this.#home.x + Math.cos(this.#phase) * 2.5;
      tz = this.#home.z + Math.sin(this.#phase) * 2.5;
    }
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.05) {
      const step = Math.min(d, speed * dt);
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
      const yaw = Math.atan2(-dx, -dz);
      this.mesh.rotation.y +=
        (MathUtils.euclideanModulo(yaw - this.mesh.rotation.y + Math.PI, Math.PI * 2) - Math.PI) *
        Math.min(1, dt * 8);
    }
    const waddle = Math.sin(time * 9 + this.#phase);
    this.mesh.rotation.z = waddle * 0.08;
    p.y = this.#home.y + Math.abs(waddle) * 0.05;
  }

  kill(): void {
    this.alive = false;
    this.#squash = 0;
  }

  debug(): Record<string, unknown> {
    return { alive: this.alive, position: this.mesh.position.toArray() };
  }
}
