import { type Group, Vector3 } from "three";
import { coinModel, gemModel, seedModel } from "../render/props.js";

export type PickupKind = "coin" | "gem" | "seed";

/** How close the hero's waist has to come, in metres, for each kind to count as taken. */
const REACH: Record<PickupKind, number> = { coin: 1.1, gem: 1.2, seed: 1.5 };

/**
 * One collectible: it spins, bobs around its home, and is taken when the hero comes within reach.
 * `mesh` is the registry object, so a scenario can place a pickup with `setup.place`; the home is
 * re-read from it in `settle()`, after placement and before the first frame.
 */
export class Pickup {
  readonly mesh: Group;
  readonly kind: PickupKind;
  /** For a Sunseed, which of the three it is. */
  readonly seed: string | undefined;
  readonly tags: readonly string[];
  taken = false;
  readonly #home = new Vector3();
  #gone = 0;

  constructor(kind: PickupKind, at: readonly [number, number, number], seed?: string) {
    this.kind = kind;
    this.seed = seed;
    this.tags = [kind];
    this.mesh = kind === "coin" ? coinModel() : kind === "gem" ? gemModel() : seedModel();
    this.mesh.position.set(at[0], at[1], at[2]);
    this.settle();
  }

  get reach(): number {
    return REACH[this.kind];
  }

  /** Takes the current position as home: call once after a scenario may have placed it. */
  settle(): void {
    this.#home.copy(this.mesh.position);
  }

  update(dt: number, time: number): void {
    if (this.taken) {
      // A taken pickup spins up, rises a metre and shrinks away over 0.4 s, then leaves the scene.
      this.#gone += dt / 0.4;
      this.mesh.rotation.y += dt * 12;
      this.mesh.position.y += dt * 2.5;
      this.mesh.scale.setScalar(Math.max(0, 1 - this.#gone));
      if (this.#gone >= 1) this.mesh.removeFromParent();
      return;
    }
    this.mesh.rotation.y += dt * (this.kind === "coin" ? 3.2 : 1.6);
    this.mesh.position.y = this.#home.y + Math.sin(time * 2.4 + this.#home.x) * 0.12;
  }

  take(): void {
    this.taken = true;
  }

  debug(): Record<string, unknown> {
    return { kind: this.kind, position: this.mesh.position.toArray(), taken: this.taken };
  }
}
