// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Pip, the hero: a stout, moustached sprout-keeper in a teal cap and mustard overalls, modelled from
// primitives — no mesh file, no skin, no animation clip. The silhouette is the classic 3D-platformer
// one (big head, short brim, round nose, round torso, stubby limbs, big shoes); the palette and
// the leaf emblem are this game's own. Arms and legs are groups pivoting at the shoulder and the
// hip, so the run cycle is a few rotations. Local space is feet at y = 0, facing -Z (Three.js
// forward); `createHero` returns the group and the one function that poses it.
import {
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  type MeshBasicMaterial,
  SphereGeometry,
} from "three";
import { flat, lit } from "./materials.js";
import { C } from "./palette.js";

export interface IHeroPose {
  /** The action `Hero.ts` is in: "idle", "run", "triple", "backflip", "dive", "ledgeHang"… */
  readonly action: string;
  readonly dt: number;
  /** Seconds since the action started, which is what a flip's spin is timed on. */
  readonly actionTime: number;
  /** Metres between the feet and the ground under them, for the contact shadow. */
  readonly drop: number;
  readonly speed: number;
  readonly vy: number;
}

export interface IHero {
  readonly group: Group;
  update(pose: IHeroPose): void;
}

/** The pivot every flip and squash turns about: the middle of the torso, above the feet. */
const BODY_Y = 0.8;
/** Shoulder joint, from the pivot. */
const SHOULDER = { x: 0.32, y: 0.14 };
/** Shoulder to glove centre at rest. */
const ARM = 0.3;
/**
 * The hang, from the feet: `Hero.ts` holds the capsule (radius 0.35) 0.37 m off the wall, with the
 * lip 1.3 m above the feet. The body lifts and leans back off the wall, and each arm reaches its
 * glove onto the lip, stretching like a cartoon arm does.
 */
const HANG = (() => {
  const lift = 0.15;
  const back = 0.12;
  const glove = { y: 1.3 + 0.12, z: -0.36 };
  const dy = glove.y - (BODY_Y + lift + SHOULDER.y);
  const dz = glove.z - back;
  return { angle: Math.atan2(-dz, -dy), back, lift, stretch: Math.hypot(dy, dz) / ARM };
})();

export function createHero(): IHero {
  const root = new Group();
  const pivot = new Group();
  pivot.position.y = BODY_Y;
  root.add(pivot);
  /** A primitive on `parent`; small details skip the shadow map. */
  const part = (
    geometry: SphereGeometry | CylinderGeometry | ConeGeometry,
    color: number,
    parent: Group,
    at: readonly [number, number, number],
    scale: readonly [number, number, number] = [1, 1, 1],
    shadow = true,
  ): Mesh => {
    const mesh = new Mesh(geometry, lit(color));
    mesh.position.set(...at);
    mesh.scale.set(...scale);
    mesh.castShadow = shadow;
    parent.add(mesh);
    return mesh;
  };
  const ball = (radius: number) => new SphereGeometry(radius, 20, 14);

  // Torso: a round shirt under round overalls, with a bib, two straps and two buttons. It sits
  // low, so the legs stay stubby and the head is a third of the hero.
  part(ball(0.31), C.shirt, pivot, [0, 0.08, 0]);
  part(ball(0.35), C.overalls, pivot, [0, -0.08, 0], [1, 0.9, 0.9]);
  const bib = part(
    new CylinderGeometry(0.16, 0.18, 0.22, 14, 1),
    C.overalls,
    pivot,
    [0, 0.12, -0.23],
  );
  bib.scale.set(1, 1, 0.45);
  for (const side of [-1, 1]) {
    const strap = part(
      new CylinderGeometry(0.035, 0.035, 0.28, 6),
      C.overalls,
      pivot,
      [0.12 * side, 0.24, -0.12],
      [1, 1, 1],
      false,
    );
    strap.rotation.x = 0.9;
    part(ball(0.04), C.button, pivot, [0.11 * side, 0.2, -0.31], [1, 1, 0.6], false);
  }

  // Head: big and round, ears, a round nose, a bushy moustache, eyes under the brim.
  const R = 0.37;
  const HEAD_Y = 0.6;
  const FACE = -0.02 - R;
  part(ball(R), C.skin, pivot, [0, HEAD_Y, -0.02]);
  for (const side of [-1, 1]) {
    part(ball(0.075), C.skin, pivot, [(R - 0.01) * side, HEAD_Y - 0.03, 0], [0.6, 1, 1], false);
    part(
      ball(0.08),
      C.white,
      pivot,
      [0.11 * side, HEAD_Y + 0.02, FACE + 0.05],
      [0.8, 1.25, 0.5],
      false,
    );
    part(
      ball(0.038),
      C.ink,
      pivot,
      [0.11 * side, HEAD_Y + 0.01, FACE + 0.01],
      [1, 1.3, 0.6],
      false,
    );
    const tash = part(
      ball(0.1),
      C.hair,
      pivot,
      [0.09 * side, HEAD_Y - 0.15, FACE + 0.06],
      [1.35, 0.55, 0.6],
      false,
    );
    tash.rotation.z = -0.3 * side;
  }
  part(ball(0.11), C.nose, pivot, [0, HEAD_Y - 0.06, FACE - 0.02], [1, 0.9, 1], false);
  // Hair along the back of the cap's rim: wide and tucked under it, so from behind it reads as
  // hair and never as a second face.
  part(ball(0.15), C.hair, pivot, [0, HEAD_Y + 0.04, 0.24], [2, 0.6, 0.8], false);
  // The cap, a short forward brim, the leaf emblem and the sprout on top.
  part(
    new SphereGeometry(R + 0.02, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    C.cap,
    pivot,
    [0, HEAD_Y + 0.08, -0.02],
    [1.03, 0.85, 1.05],
  );
  const brim = part(new CylinderGeometry(0.27, 0.28, 0.04, 20), C.cap, pivot, [
    0,
    HEAD_Y + 0.09,
    FACE + 0.06,
  ]);
  brim.scale.set(1, 1, 0.7);
  brim.rotation.x = 0.12;
  const badge = part(
    new CylinderGeometry(0.09, 0.09, 0.02, 16),
    C.button,
    pivot,
    [0, HEAD_Y + 0.26, FACE + 0.07],
    [1, 1, 1],
    false,
  );
  badge.rotation.x = Math.PI / 2 - 0.55;
  const leaf = part(
    ball(0.065),
    C.leaf,
    pivot,
    [0, HEAD_Y + 0.26, FACE + 0.055],
    [0.6, 1, 0.3],
    false,
  );
  leaf.rotation.set(-0.55, 0, 0.5);
  const sprout = part(new ConeGeometry(0.06, 0.26, 8), C.leaf, pivot, [0.04, HEAD_Y + 0.44, 0.02]);
  sprout.rotation.z = -0.4;

  // Arms: a sleeve and a glove on a shoulder joint. Legs: an overall leg and a big shoe on a hip.
  const arms: Group[] = [];
  const legs: Group[] = [];
  for (const side of [-1, 1]) {
    const arm = new Group();
    arm.position.set(SHOULDER.x * side, SHOULDER.y, 0);
    arm.rotation.z = 0.35 * side;
    pivot.add(arm);
    part(new CylinderGeometry(0.075, 0.07, 0.22, 10), C.shirt, arm, [0, -0.11, 0]);
    part(ball(0.12), C.gloves, arm, [0, -ARM, 0]);
    arms.push(arm);

    // Hip 0.42 m above the feet; the shoe's sole is on the floor.
    const leg = new Group();
    leg.position.set(0.15 * side, -0.38, 0);
    pivot.add(leg);
    part(new CylinderGeometry(0.1, 0.1, 0.18, 10), C.overalls, leg, [0, -0.09, 0]);
    part(ball(0.17), C.boots, leg, [0, -0.3, -0.06], [1, 0.7, 1.45]);
    legs.push(leg);
  }

  // The contact shadow: a blob that shrinks with the drop, so a jump reads against the grass even
  // where the shadow map's own shadow is a few texels across.
  const blob = new Mesh(
    new CircleGeometry(0.55, 20),
    flat(C.ink, { depthWrite: false, opacity: 0.32 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 2;
  root.add(blob);

  let time = 0;
  const [armL, armR] = arms as [Group, Group];
  const [legL, legR] = legs as [Group, Group];
  const ease = (from: number, to: number, k: number) => MathUtils.lerp(from, to, k);
  return {
    group: root,
    update(pose: IHeroPose): void {
      time += pose.dt;
      const run = Math.min(1, pose.speed / 9.6);
      const cycle = time * (5 + run * 10);
      const k = 1 - Math.exp(-pose.dt * 18);
      let pitch = 0;
      let roll = 0;
      let squash = 1;
      let bob = 0;
      /** Arm swing about the shoulder: 0 hangs down, π/2 points forward, π points up. */
      let reachAngle: number | undefined;
      let spread = 0.35;
      let stretch = 1;
      const hang = pose.action === "ledgeHang" || pose.action === "ledgeClimb";
      const t = pose.actionTime;
      switch (pose.action) {
        case "triple":
        case "backflip":
          // A full forward (triple) or backward (backflip) somersault over the first 0.6 s.
          pitch = (pose.action === "triple" ? -1 : 1) * Math.min(1, t / 0.6) * Math.PI * 2;
          spread = 1.1;
          break;
        case "sideflip":
          roll = Math.min(1, t / 0.6) * Math.PI * 2;
          spread = 1.1;
          break;
        case "dive":
        case "diveSlide":
          pitch = -1.25;
          reachAngle = Math.PI;
          spread = 0.15;
          break;
        case "longJump":
          pitch = -0.55;
          reachAngle = 2.4;
          spread = 0.2;
          break;
        case "groundPound":
          pitch = t < 0.25 ? -(t / 0.25) * Math.PI * 2 : 0;
          squash = t < 0.25 ? 0.85 : 0.9;
          spread = 1.2;
          break;
        case "crouch":
        case "crouchSlide":
          squash = 0.72;
          break;
        default:
          if (hang) {
            reachAngle = HANG.angle;
            spread = 0.12;
            stretch = HANG.stretch;
          }
          break;
      }
      const grounded = pose.action === "idle" || pose.action === "run" || pose.action === "skid";
      if (grounded) {
        const swing = Math.sin(cycle) * (0.15 + run * 0.75);
        legL.rotation.x = swing;
        legR.rotation.x = -swing;
        // Arms swing against the legs.
        armL.rotation.x = -swing * 0.9;
        armR.rotation.x = swing * 0.9;
        bob = Math.abs(Math.sin(cycle)) * 0.07 * run + Math.sin(time * 2.4) * 0.012;
        pitch = pose.action === "skid" ? 0.35 : -run * 0.2;
      } else {
        const rise = MathUtils.clamp(pose.vy / 12, -1, 1);
        legL.rotation.x = ease(legL.rotation.x, hang ? 0.15 : 0.7 - rise * 0.3, k);
        legR.rotation.x = ease(legR.rotation.x, hang ? -0.1 : -0.3 + rise * 0.2, k);
        // A rising jump throws one fist up; falling, both arms float out.
        const up = reachAngle ?? (rise > 0.2 ? 2.6 : 0.4);
        armL.rotation.x = ease(armL.rotation.x, reachAngle ?? 0.4, k);
        armR.rotation.x = ease(armR.rotation.x, up, k);
      }
      armL.rotation.z = ease(armL.rotation.z, -spread, k);
      armR.rotation.z = ease(armR.rotation.z, spread, k);
      for (const arm of arms) arm.scale.y = ease(arm.scale.y, stretch, k);
      pivot.position.z = ease(pivot.position.z, hang ? HANG.back : 0, k);
      pivot.position.y = BODY_Y * squash + bob + (hang ? HANG.lift : 0);
      pivot.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
      pivot.rotation.x = pitch;
      pivot.rotation.z = roll;
      blob.position.y = -pose.drop + 0.02;
      blob.visible = pose.drop < 9;
      const shade = MathUtils.clamp(1 - pose.drop / 9, 0.25, 1);
      blob.scale.setScalar(shade);
      (blob.material as MeshBasicMaterial).opacity = 0.32 * shade;
    },
  };
}
