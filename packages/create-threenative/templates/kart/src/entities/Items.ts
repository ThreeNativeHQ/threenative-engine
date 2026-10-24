import type { Object3D } from "three";
import type { ICourse } from "../track/Course.js";
import { KART_FEEL, type Kart } from "./Kart.js";

export type ItemKind = "banana" | "shell" | "mushroom";

/**
 * The item roulette: per place, how many of 100 draws give each item. MK64 draws
 * `curve[rank·100 + rand%100]` (`mk64: src/update_objects.c:3665`); its curves are ROM data that
 * is not in the decompiled source, so these are the kit's: the leaders get defence, the back of
 * the field gets speed, and last place always gets a mushroom.
 */
export const ITEM_CURVE: readonly Readonly<Record<ItemKind, number>>[] = [
  { banana: 60, mushroom: 5, shell: 35 },
  { banana: 45, mushroom: 15, shell: 40 },
  { banana: 35, mushroom: 25, shell: 40 },
  { banana: 25, mushroom: 35, shell: 40 },
  { banana: 20, mushroom: 50, shell: 30 },
  { banana: 15, mushroom: 60, shell: 25 },
  { banana: 5, mushroom: 80, shell: 15 },
  { banana: 0, mushroom: 100, shell: 0 },
];

export const ITEM_FEEL = {
  /** Seconds the roulette spins before the item is in hand. */
  roulette: 1,
  /** Seconds a taken box stays empty. */
  boxRespawn: 2,
  /** Reach of a box, banana and shell, in metres between centres on the ground plane. */
  boxReach: 1.7,
  bananaReach: 1.2,
  shellReach: 1.3,
  /** A banana lands this far behind the kart. */
  bananaBehind: 1.9,
  /** Green shell speed: MK64 launches at 8 units a tick against a 5.89 top, 1.36 × top speed
   * (`mk64: src/actors/green_shell/update.inc.c:100`). */
  shellSpeed: KART_FEEL.topSpeed["150cc"] * 1.36,
  /** Seconds a shell lives. MK64's shell lives until it hits something (kit guard). */
  shellLife: 10,
  /** Seconds the thrower is immune to its own item. */
  ownerGrace: 0.6,
  /** Bananas on the course at once; the oldest goes first. */
  maxBananas: 10,
} as const;

/** Draws an item for `place` (1-based) from one uniform `roll` in [0, 1). */
export function drawItem(place: number, roll: number): ItemKind {
  const curve = ITEM_CURVE[Math.min(ITEM_CURVE.length, Math.max(1, place)) - 1] ?? ITEM_CURVE[0]!;
  let ticket = Math.floor(roll * 100);
  for (const kind of ["banana", "shell", "mushroom"] as const) {
    ticket -= curve[kind];
    if (ticket < 0) return kind;
  }
  return "mushroom";
}

/** A kart's item slot: empty, spinning, or holding. */
export class ItemSlot {
  held: ItemKind | undefined;
  #rolling = 0;
  #pending: ItemKind | undefined;
  draws = 0;

  get rolling(): boolean {
    return this.#rolling > 0;
  }

  get busy(): boolean {
    return this.held !== undefined || this.#rolling > 0;
  }

  /** Spends the box: the item is decided now and shown after the roulette spins. */
  roll(kind: ItemKind): void {
    this.#pending = kind;
    this.#rolling = ITEM_FEEL.roulette;
    this.draws += 1;
  }

  update(dt: number): void {
    if (this.#rolling <= 0) return;
    this.#rolling -= dt;
    if (this.#rolling <= 0) {
      this.held = this.#pending;
      this.#pending = undefined;
    }
  }
}

/**
 * A thrown or dropped item on the course. Pooled: `scenes/Race.ts` builds every banana and shell
 * at load and registers each as an entity, so a scenario can place one with `setup.place`.
 * Parked items sit far below the course and are inactive.
 */
export class CourseItem {
  active = false;
  owner: Kart | undefined;
  /** Seconds left of the owner's immunity, and of a shell's life. */
  grace = 0;
  life = 0;
  index = 0;
  lateral = 0;
  /** A shell's heading on the ground plane, three's yaw convention. */
  heading = 0;
  bounces = 0;
  hits = 0;
  static readonly parkedY = -50;

  constructor(
    readonly kind: "banana" | "shell",
    readonly mesh: Object3D,
  ) {
    mesh.position.set(0, CourseItem.parkedY, 0);
    mesh.visible = false;
  }

  /** True when a scenario moved the parked item onto the course. */
  get placed(): boolean {
    return !this.active && this.mesh.position.y > CourseItem.parkedY + 1;
  }

  activate(course: ICourse, from: number, heading: number, owner: Kart | undefined): void {
    this.active = true;
    this.owner = owner;
    this.grace = owner === undefined ? 0 : ITEM_FEEL.ownerGrace;
    this.life = ITEM_FEEL.shellLife;
    this.heading = heading;
    this.bounces = 0;
    const point = course.track(from, this.mesh.position.x, this.mesh.position.z);
    this.index = point.index;
    this.lateral = point.lateral;
    this.mesh.visible = true;
  }

  park(): void {
    this.active = false;
    this.owner = undefined;
    this.mesh.visible = false;
    this.mesh.position.set(0, CourseItem.parkedY, 0);
  }

  /** A shell runs straight along its heading, bounces off the walls and follows the ground. */
  update(course: ICourse, dt: number): void {
    if (!this.active) return;
    this.grace = Math.max(0, this.grace - dt);
    const at = this.mesh.position;
    if (this.kind === "banana") {
      at.y = course.y[this.index]! + 0.25;
      return;
    }
    this.life -= dt;
    if (this.life <= 0) {
      this.park();
      return;
    }
    at.x += -Math.sin(this.heading) * ITEM_FEEL.shellSpeed * dt;
    at.z += -Math.cos(this.heading) * ITEM_FEEL.shellSpeed * dt;
    const point = course.track(this.index, at.x, at.z);
    this.index = point.index;
    this.lateral = point.lateral;
    const limit = course.wall[this.index]! - 0.4;
    if (Math.abs(this.lateral) > limit) {
      // Reflect the heading about the wall: the wall's normal is the line's right, (−tz, tx).
      const side = Math.sign(this.lateral);
      const nx = -course.tz[this.index]! * side;
      const nz = course.tx[this.index]! * side;
      const vx = -Math.sin(this.heading);
      const vz = -Math.cos(this.heading);
      const into = vx * nx + vz * nz;
      if (into > 0) this.heading = Math.atan2(-(vx - 2 * into * nx), -(vz - 2 * into * nz));
      at.x -= nx * (Math.abs(this.lateral) - limit);
      at.z -= nz * (Math.abs(this.lateral) - limit);
      this.bounces += 1;
    }
    at.y = course.y[this.index]! + 0.35;
    this.mesh.rotation.y += dt * 14;
  }

  /** Whether `kart` runs into this item now. */
  touches(kart: Kart): boolean {
    if (!this.active || (kart === this.owner && this.grace > 0)) return false;
    const at = this.mesh.position;
    const reach = this.kind === "banana" ? ITEM_FEEL.bananaReach : ITEM_FEEL.shellReach;
    return (at.x - kart.x) ** 2 + (at.z - kart.z) ** 2 < reach * reach && Math.abs(at.y - kart.y) < 2;
  }
}
