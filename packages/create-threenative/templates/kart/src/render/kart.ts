// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// A kart and its driver from primitives: the chassis, side pods, seat, engine and twin exhausts,
// a rear wing, and a driver in a round helmet, merged into one vertex-coloured mesh; the wheels
// are three more (the rear axle turns as one, each front wheel steers). Eight original liveries.
// `KartModel.update` follows a `Kart` from `entities/Kart.ts`: it pitches with the road, leans
// out of a drift, spins on a banana and flips on a shell. Forward is −z, the origin is the ground.
import {
  AdditiveBlending,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  TorusGeometry,
} from "three";
import type { Kart } from "../entities/Kart.js";
import { at, lit, merge, paint } from "./materials.js";
import { C } from "./palette.js";

export interface ILivery {
  readonly name: string;
  readonly body: number;
  readonly trim: number;
  readonly helmet: number;
  readonly suit: number;
}

/** The field's eight liveries; the player drives the first. All original, none borrowed. */
export const LIVERIES: readonly ILivery[] = [
  { body: 0xe8452c, helmet: 0xffffff, name: "Ember", suit: 0xe8452c, trim: 0xffd23a },
  { body: 0x2f6fe0, helmet: 0xf2c232, name: "Tide", suit: 0x1d3f8a, trim: 0xffffff },
  { body: 0x3fae46, helmet: 0xffffff, name: "Fern", suit: 0x2a6e2e, trim: 0xf2c232 },
  { body: 0xf2c232, helmet: 0x2f6fe0, name: "Sunny", suit: 0xe8862c, trim: 0x1a1410 },
  { body: 0x8a4fd0, helmet: 0xf06fa8, name: "Plum", suit: 0x4e2a80, trim: 0xffffff },
  { body: 0xf06fa8, helmet: 0xffffff, name: "Rose", suit: 0xb83a72, trim: 0x8a4fd0 },
  { body: 0x22b6b0, helmet: 0xe8452c, name: "Reef", suit: 0x13706c, trim: 0xffffff },
  { body: 0xe9edf2, helmet: 0x1a1410, name: "Frost", suit: 0x5a6878, trim: 0x2f6fe0 },
];

/**
 * The drift-charge glow per stage: blue, yellow, orange. Above 1 so it glows on a metered sunny
 * course, with one channel kept low so the filmic curve keeps the hue instead of turning it white.
 */
const SPARK_GLOW = [
  [0.6, 1.1, 2.6],
  [2.4, 1.7, 0.1],
  [2.6, 0.32, 0.02],
] as const;
const WHEEL = { front: 0.27, rear: 0.31, track: 0.62, frontZ: -0.62, rearZ: 0.58 } as const;

function wheel(radius: number, width: number) {
  const turn = (x: number) => at(x, 0, 0, 0, 0, Math.PI / 2);
  return [
    paint(new CylinderGeometry(radius, radius, width, 14), C.tyre, turn(0)),
    paint(new CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.02, 10), C.hub, turn(0)),
  ];
}

// Built once and shared by every kart, so the eight karts upload one copy of each part.
const REAR_AXLE = merge([
  ...wheel(WHEEL.rear, 0.32).map((g) => g.translate(-WHEEL.track - 0.04, 0, 0)),
  ...wheel(WHEEL.rear, 0.32).map((g) => g.translate(WHEEL.track + 0.04, 0, 0)),
  paint(new CylinderGeometry(0.04, 0.04, 1.3, 6), C.metal, at(0, 0, 0, 0, 0, Math.PI / 2)),
]);
const FRONT_WHEEL = merge(wheel(WHEEL.front, 0.26));
const cone = (x: number) =>
  new ConeGeometry(0.11, 0.6, 8).rotateX(Math.PI / 2).translate(x, 0, 0.3);
const FLAME = merge([cone(-0.17), cone(0.17)]);
const FLAME_MATERIAL = new MeshBasicMaterial({
  blending: AdditiveBlending,
  color: new Color(7, 3.2, 0.7),
  depthWrite: false,
  transparent: true,
});
const STAR = merge([
  new SphereGeometry(0.09, 8, 6),
  ...[0, 1, 2, 3].map((r) => new BoxGeometry(0.62, 0.05, 0.05).rotateZ((r * Math.PI) / 4)),
]);
/** One glow material per drift stage, swapped onto the stars instead of recoloured per kart. */
const GLOW_MATERIALS = SPARK_GLOW.map(
  ([r, g, b]) => new MeshBasicMaterial({ color: new Color(r, g, b) }),
);

function bodyGeometry(livery: ILivery) {
  const { body, trim, helmet, suit } = livery;
  return merge([
    // Chassis: a low floor pan, the nose and its bumper, two side pods.
    paint(new BoxGeometry(1.0, 0.12, 1.55), body, at(0, 0.22, 0.02), 0.3),
    paint(new BoxGeometry(0.82, 0.24, 0.55), body, at(0, 0.32, -0.66, -0.25), 0.25),
    paint(new BoxGeometry(1.28, 0.12, 0.16), trim, at(0, 0.24, -1.0)),
    paint(new BoxGeometry(0.42, 0.06, 0.03), C.white, at(0, 0.36, -1.09)),
    paint(new BoxGeometry(0.26, 0.26, 0.95), body, at(-0.56, 0.3, 0.05), 0.3),
    paint(new BoxGeometry(0.26, 0.26, 0.95), body, at(0.56, 0.3, 0.05), 0.3),
    paint(new BoxGeometry(0.27, 0.06, 0.96), trim, at(-0.56, 0.45, 0.05)),
    paint(new BoxGeometry(0.27, 0.06, 0.96), trim, at(0.56, 0.45, 0.05)),
    // Seat, engine, twin exhausts and a rear wing on two struts.
    paint(new BoxGeometry(0.56, 0.12, 0.42), C.seat, at(0, 0.36, 0.22)),
    paint(new BoxGeometry(0.56, 0.5, 0.12), C.seat, at(0, 0.6, 0.42, 0.2)),
    paint(new BoxGeometry(0.6, 0.34, 0.36), C.metal, at(0, 0.45, 0.68), 0.35),
    paint(
      new CylinderGeometry(0.07, 0.08, 0.34, 8),
      C.exhaust,
      at(-0.17, 0.56, 0.92, Math.PI / 2 - 0.3),
    ),
    paint(
      new CylinderGeometry(0.07, 0.08, 0.34, 8),
      C.exhaust,
      at(0.17, 0.56, 0.92, Math.PI / 2 - 0.3),
    ),
    paint(new BoxGeometry(0.05, 0.36, 0.08), C.metal, at(-0.3, 0.7, 0.86)),
    paint(new BoxGeometry(0.05, 0.36, 0.08), C.metal, at(0.3, 0.7, 0.86)),
    paint(new BoxGeometry(1.12, 0.06, 0.3), body, at(0, 0.9, 0.9, 0.12)),
    paint(new BoxGeometry(0.06, 0.2, 0.32), trim, at(-0.56, 0.85, 0.9)),
    paint(new BoxGeometry(0.06, 0.2, 0.32), trim, at(0.56, 0.85, 0.9)),
    // Steering column and wheel.
    paint(new CylinderGeometry(0.03, 0.03, 0.42, 6), C.ink, at(0, 0.56, -0.32, -0.9)),
    paint(new TorusGeometry(0.16, 0.035, 6, 16), C.ink, at(0, 0.72, -0.18, -0.5)),
    // The driver: torso, arms to the wheel, gloves, helmet and visor.
    paint(new CapsuleGeometry(0.2, 0.26, 4, 10), suit, at(0, 0.78, 0.18), 0.3),
    paint(new CapsuleGeometry(0.065, 0.32, 3, 8), suit, at(-0.22, 0.78, -0.02, -1.05, 0, 0.25)),
    paint(new CapsuleGeometry(0.065, 0.32, 3, 8), suit, at(0.22, 0.78, -0.02, -1.05, 0, -0.25)),
    paint(new SphereGeometry(0.075, 8, 6), C.glove, at(-0.15, 0.73, -0.2)),
    paint(new SphereGeometry(0.075, 8, 6), C.glove, at(0.15, 0.73, -0.2)),
    paint(new SphereGeometry(0.25, 16, 12), helmet, at(0, 1.2, 0.16), 0.35),
    paint(new BoxGeometry(0.06, 0.06, 0.5), trim, at(0, 1.44, 0.16, 0, 0, 0)),
    paint(new SphereGeometry(0.17, 12, 8), C.visor, at(0, 1.19, -0.02, 0, 0, 0, 1.1, 0.62, 0.62)),
  ]);
}

export class KartModel {
  readonly root = new Group();
  readonly #rear: Mesh;
  readonly #fronts: readonly Group[];
  readonly #frontWheels: readonly Mesh[];
  readonly #flame: Mesh;
  readonly #glows: readonly Mesh[];
  #roll = 0;
  #spin = 0;

  constructor(readonly livery: ILivery) {
    this.root.name = `kart-${livery.name.toLowerCase()}`;
    this.root.rotation.order = "YXZ";
    const material = lit({ roughness: 0.5 });
    const body = new Mesh(bodyGeometry(livery), material);
    this.#rear = new Mesh(REAR_AXLE, material);
    this.#rear.position.set(0, WHEEL.rear, WHEEL.rearZ);
    const fronts: Group[] = [];
    const frontWheels: Mesh[] = [];
    for (const side of [-1, 1]) {
      const pivot = new Group();
      pivot.position.set(side * WHEEL.track, WHEEL.front, WHEEL.frontZ);
      const spinner = new Mesh(FRONT_WHEEL, material);
      pivot.add(spinner);
      fronts.push(pivot);
      frontWheels.push(spinner);
    }
    this.#fronts = fronts;
    this.#frontWheels = frontWheels;
    this.root.add(body, this.#rear, ...fronts);
    this.root.traverse((object) => {
      object.castShadow = true;
      object.receiveShadow = true;
    });
    // The boost flame rides on the exhausts. Particles alone are left behind at racing speed and
    // the temporal anti-aliasing smears them out, so the flame the player sees is a mesh. Its
    // colour runs above 1 for the same reason the sparks do: auto exposure meters a sunny course.
    this.#flame = new Mesh(FLAME, FLAME_MATERIAL);
    this.#flame.position.set(0, 0.62, 1.02);
    this.#flame.visible = false;
    this.root.add(this.#flame);
    // The spark charge glows on each rear tyre in the stage's colour, for the same reason: the
    // thrown sparks fall behind and smear, so the colour the player reads rides on the kart.
    // Opaque, not additive: added onto a sunlit road every colour sums toward white.
    this.#glows = [-1, 1].map((side) => {
      const glow = new Mesh(STAR, GLOW_MATERIALS[0]);
      glow.position.set(side * (WHEEL.track + 0.1), 0.16, WHEEL.rearZ + 0.34);
      glow.visible = false;
      this.root.add(glow);
      return glow;
    });
  }

  /** Follows the kart: place, heading, the road's pitch, a lean out of a drift, the hits. */
  update(kart: Kart, steer: number, dt: number): void {
    const course = kart.course;
    const root = this.root;
    root.position.set(kart.x, kart.y, kart.z);
    // Pitch: the road's slope along the kart's own heading.
    const trackYaw = Math.atan2(-(course.tx[kart.index] ?? 0), -(course.tz[kart.index] ?? 0));
    const along = Math.cos(kart.yaw - trackYaw);
    const pitch = kart.airborne
      ? root.rotation.x * 0.96
      : Math.atan((course.slope[kart.index] ?? 0) * along);
    // A drift leans the kart out of the turn and swings its nose 17° further in, so the slide reads
    // from the chase camera, which follows the travel and not the nose.
    const lean = kart.drifting ? kart.driftSide * 0.1 : steer * 0.05 * Math.min(1, kart.speed / 10);
    this.#roll += (lean - this.#roll) * Math.min(1, dt * 10);
    const flip =
      kart.tumbleTicks > 0 ? (1 - kart.tumbleTicks / kart.feel.tumbleTicks) * Math.PI * 2 : 0;
    root.rotation.set(pitch + flip, kart.yaw + kart.spinAngle - kart.driftSide * 0.3, this.#roll);
    const boosting = kart.boostTicks > 0 || kart.miniTurboTicks > 0;
    this.#flame.visible = boosting;
    if (boosting) this.#flame.scale.set(1, 1, 0.75 + Math.abs(Math.sin(this.#spin * 7)) * 0.5);
    const charge = kart.drifting && kart.grounded ? kart.driftStage : 0;
    const tint = GLOW_MATERIALS[charge - 1];
    for (const [g, glow] of this.#glows.entries()) {
      glow.visible = tint !== undefined;
      if (tint !== undefined) glow.material = tint;
      glow.rotation.z = this.#spin * (g === 0 ? 0.9 : -0.9);
      glow.scale.setScalar(0.8 + Math.abs(Math.sin(this.#spin * 5 + g)) * 0.4 + charge * 0.1);
    }
    this.#spin += (kart.speed * dt) / WHEEL.rear;
    this.#rear.rotation.x = -this.#spin;
    for (const pivot of this.#fronts) pivot.rotation.y = -steer * 0.45;
    for (const spinner of this.#frontWheels)
      spinner.rotation.x = -this.#spin * (WHEEL.rear / WHEEL.front);
  }

  /** Where the exhausts are, in world space: the boost flame comes out here. */
  exhaust(out: { x: number; y: number; z: number }): void {
    const yaw = this.root.rotation.y;
    out.x = this.root.position.x + Math.sin(yaw) * 1.1;
    out.y = this.root.position.y + 0.58;
    out.z = this.root.position.z + Math.cos(yaw) * 1.1;
  }

  /** The two rear tyres' contact points in world space, for sparks, dust and skid marks. */
  rearWheel(side: -1 | 1, out: { x: number; y: number; z: number }): void {
    const yaw = this.root.rotation.y;
    const lx = side * (WHEEL.track + 0.04);
    const lz = WHEEL.rearZ + 0.1;
    out.x = this.root.position.x + Math.cos(yaw) * lx + Math.sin(yaw) * lz;
    out.y = this.root.position.y + 0.06;
    out.z = this.root.position.z - Math.sin(yaw) * lx + Math.cos(yaw) * lz;
  }
}
