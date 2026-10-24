// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Pip, the hero: a stout, moustached sprout-keeper in a teal cap and mustard overalls, modelled from
// primitives — no mesh file and no skin. The silhouette is the classic 3D-platformer one (big head,
// short brim, round nose, round torso, stubby limbs, big shoes); the palette and the leaf emblem are
// this game's own. Arms and legs are groups pivoting at the shoulder and the hip. The idle, walk and
// run are `AnimationClip`s built here from a few rotations; `Hero.ts` plays them through
// `AnimationPlayer`, which times the walk and run to the ground the body covers. Jumps, flips and
// the hang are posed procedurally on top. Local space is feet at y = 0, facing -Z (Three.js
// forward); `createHero` returns the group, its clips and the function that poses the rest.
import {
  AnimationClip,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  type MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  VectorKeyframeTrack,
} from "three";
import { flat, lit, paintedTexture } from "./materials.js";
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
  /** "idle", "walk", "run" and "air" (the neutral pose the procedural jumps bend). */
  readonly clips: readonly AnimationClip[];
  /** The two soles, for measuring whether a planted foot slides. */
  readonly soles: readonly Mesh[];
  update(pose: IHeroPose): void;
}

/** One key of a cycle: each limb's swing about its joint (+ is forward), each foot's lift, the body. */
interface ICycleKey {
  readonly legs: readonly [number, number];
  readonly lift: readonly [number, number];
  readonly arms: readonly [number, number];
  readonly bob: number;
}

const SWINGS = ["legSwingL", "legSwingR", "armSwingL", "armSwingR"] as const;
const X_AXIS = new Vector3(1, 0, 0);

/** A looping clip sampled from `key(p)` at 33 keys over one cycle, p from 0 to 1. */
function cycleClip(name: string, period: number, key: (p: number) => ICycleKey): AnimationClip {
  const keys = Array.from({ length: 33 }, (_, i) => key((i / 32) % 1));
  const times = keys.map((_, i) => (i / 32) * period);
  const q = new Quaternion();
  const turn = (axis: Vector3, angle: (k: ICycleKey) => number) =>
    keys.flatMap((k) => q.setFromAxisAngle(axis, angle(k)).toArray());
  const angles = [
    (k: ICycleKey) => k.legs[0],
    (k: ICycleKey) => k.legs[1],
    (k: ICycleKey) => k.arms[0],
    (k: ICycleKey) => k.arms[1],
  ];
  return new AnimationClip(name, period, [
    ...SWINGS.map(
      (swing, i) =>
        new QuaternionKeyframeTrack(
          `${swing}.quaternion`,
          times,
          turn(X_AXIS, angles[i] as (k: ICycleKey) => number),
        ),
    ),
    ...[0, 1].map(
      (side) =>
        new VectorKeyframeTrack(
          `${SWINGS[side]}.position`,
          times,
          keys.flatMap((k) => [0, k.lift[side] ?? 0, 0]),
        ),
    ),
    new VectorKeyframeTrack(
      "bounce.position",
      times,
      keys.flatMap((k) => [0, k.bob, 0]),
    ),
  ]);
}

/**
 * A stride: each foot is planted for `stance` of the cycle, sweeping back from `reach` ahead of the
 * hip to `reach` behind it, then swings forward lifted by `lift`. The body is lowest at each
 * mid-stance and rises `bob` between them. The arms swing against the legs.
 *
 * The planted foot slides back at one steady speed (the angle is the arcsine of a linear sweep):
 * a leg turning at a steady rate moves its foot fastest under the hip, so the foot would skate
 * whatever rate the clip played at. The hips do not twist: a turn of the body about the vertical
 * swings a planted foot sideways, which `playtests/stride.playtest.json` reads as a slide.
 */
function gait(stance: number, reach: number, lift: number, arms: number, bob: number) {
  const leg = (p: number) => {
    if (p < stance) return [Math.asin(Math.sin(reach) * (1 - (2 * p) / stance)), 0] as const;
    const s = (p - stance) / (1 - stance);
    return [-reach + reach * (1 - Math.cos(Math.PI * s)), lift * Math.sin(Math.PI * s)] as const;
  };
  return (p: number): ICycleKey => {
    const [l, liftL] = leg(p);
    const [r, liftR] = leg((p + 0.5) % 1);
    const swing = Math.cos(Math.PI * 2 * p);
    return {
      arms: [-arms * swing, arms * swing],
      bob: (bob * (1 - Math.cos(Math.PI * 4 * (p - stance / 2)))) / 2,
      legs: [l, r],
      lift: [liftL, liftR],
    };
  };
}

const CLIPS = [
  cycleClip("idle", 2.4, (p) => {
    const breath = Math.sin(Math.PI * 2 * p);
    return {
      arms: [0.04 * breath, -0.04 * breath],
      bob: 0.012 * breath,
      legs: [0, 0],
      lift: [0, 0],
    };
  }),
  // The walk lifts its swing foot 16 cm: at 6 cm it stayed inside the band a run plants in.
  cycleClip("walk", 0.5, gait(0.5, 0.6, 0.16, 0.45, 0.03)),
  cycleClip("run", 0.45, gait(0.15, 0.85, 0.14, 1.1, 0.1)),
  cycleClip("air", 1, () => ({ arms: [0, 0], bob: 0, legs: [0, 0], lift: [0, 0] })),
];

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

/**
 * Woven cloth: a fine diagonal twill, and with `seams` a stitched seam down each side and the front
 * and back (a sphere's u = 0, 1/4, 1/2, 3/4), a darker fold with a dashed paler thread beside it.
 */
function fabric(color: number, seams: boolean): MeshStandardMaterial {
  const size = 128;
  const map = paintedTexture(
    size,
    size,
    (x, y) => {
      const twill = 0.94 + 0.06 * Math.sin(((x + y) / size) * Math.PI * 2 * 48);
      const u = (x % (size / 4)) / (size / 4);
      const fold = seams ? Math.min(u, 1 - u) * (size / 4) : 99;
      const stitch = fold > 1.5 && fold < 2.6 && y % 6 < 3 ? 1.12 : 1;
      const v = twill * (fold < 1.2 ? 0.72 : 1) * stitch;
      return [v, v, v];
    },
    true,
  );
  return new MeshStandardMaterial({ color, map, roughness: 0.95 });
}

export function createHero(): IHero {
  const root = new Group();
  // The clips bob `bounce`; the procedural poses own `pivot` inside it.
  const bounce = new Group();
  bounce.name = "bounce";
  root.add(bounce);
  const pivot = new Group();
  pivot.position.y = BODY_Y;
  bounce.add(pivot);
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
  const ball = (radius: number) => new SphereGeometry(radius, 24, 16);
  const overalls = fabric(C.overalls, true);
  const shirt = fabric(C.shirt, false);

  // Torso: a round shirt under round overalls, with a bib, two straps and two buttons. It sits
  // low, so the legs stay stubby and the head is a third of the hero.
  part(ball(0.31), C.shirt, pivot, [0, 0.08, 0]).material = shirt;
  part(ball(0.35), C.overalls, pivot, [0, -0.08, 0], [1, 0.9, 0.9]).material = overalls;
  const bib = part(
    new CylinderGeometry(0.16, 0.18, 0.22, 14, 1),
    C.overalls,
    pivot,
    [0, 0.12, -0.23],
  );
  bib.scale.set(1, 1, 0.45);
  bib.material = overalls;
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
    // The whites glow a little, so the eyes read under the brim's shade at any exposure.
    part(
      ball(0.092),
      C.white,
      pivot,
      [0.115 * side, HEAD_Y + 0.02, FACE + 0.05],
      [0.8, 1.25, 0.5],
      false,
    ).material = lit(C.white, { emissive: 0.45 });
    part(
      ball(0.044),
      C.ink,
      pivot,
      [0.115 * side, HEAD_Y + 0.01, FACE + 0.005],
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
  part(ball(0.127), C.nose, pivot, [0, HEAD_Y - 0.06, FACE - 0.03], [1, 0.9, 1], false);
  // Hair along the back of the cap's rim: wide and tucked under it, so from behind it reads as
  // hair and never as a second face.
  part(ball(0.15), C.hair, pivot, [0, HEAD_Y + 0.04, 0.24], [2, 0.6, 0.8], false);
  // The cap, a short forward brim, the leaf emblem and the sprout on top. Glossy, like a lacquered
  // cap, so it catches a highlight the cloth beside it does not.
  const cap = lit(C.cap, { roughness: 0.32 });
  part(
    new SphereGeometry(R + 0.02, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    C.cap,
    pivot,
    [0, HEAD_Y + 0.08, -0.02],
    [1.03, 0.85, 1.05],
  ).material = cap;
  const brim = part(new CylinderGeometry(0.27, 0.28, 0.04, 20), C.cap, pivot, [
    0,
    HEAD_Y + 0.09,
    FACE + 0.06,
  ]);
  brim.scale.set(1, 1, 0.7);
  brim.material = cap;
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
  const soles: Mesh[] = [];
  // Each limb is a joint the procedural poses turn, holding a swing the clips turn.
  const joint = (parent: Group, name: string): [Group, Group] => {
    const outer = new Group();
    const swing = new Group();
    swing.name = name;
    outer.add(swing);
    parent.add(outer);
    return [outer, swing];
  };
  for (const side of [-1, 1]) {
    const tag = side < 0 ? "L" : "R";
    const [arm, armSwing] = joint(pivot, `armSwing${tag}`);
    arm.position.set(SHOULDER.x * side, SHOULDER.y, 0);
    arm.rotation.z = 0.35 * side;
    part(new CylinderGeometry(0.075, 0.07, 0.22, 16), C.shirt, armSwing, [0, -0.11, 0]).material =
      shirt;
    // A soft leather glove with a rolled cuff at the wrist.
    const glove = lit(C.gloves, { roughness: 0.55 });
    part(ball(0.12), C.gloves, armSwing, [0, -ARM, 0]).material = glove;
    const cuff = new Mesh(new TorusGeometry(0.085, 0.03, 10, 20), glove);
    cuff.position.y = -ARM + 0.1;
    cuff.rotation.x = Math.PI / 2;
    armSwing.add(cuff);
    arms.push(arm);

    // Hip 0.42 m above the feet; the shoe's sole is on the floor.
    const [leg, legSwing] = joint(pivot, `legSwing${tag}`);
    leg.position.set(0.15 * side, -0.38, 0);
    part(new CylinderGeometry(0.1, 0.1, 0.18, 16), C.overalls, legSwing, [0, -0.09, 0]).material =
      overalls;
    // Polished leather on a darker, flat rubber sole. Both meshes have their origin where the sole
    // meets the floor, so `AnimationPlayer` reads the stride at the contact point, not the boot's
    // middle (which sweeps a smaller circle and would make the planted foot skate).
    const contact: [number, number, number] = [0, -0.419, -0.06];
    const boot = ball(0.17).scale(1, 0.66, 1.45).translate(0, 0.129, 0);
    part(boot, C.boots, legSwing, contact).material = lit(C.boots, { roughness: 0.42 });
    const sole = part(
      ball(0.17).scale(1.04, 0.2, 1.5).translate(0, 0.034, 0),
      C.sole,
      legSwing,
      contact,
    );
    // Named for the playtest's `footSlip` assertion, which follows these nodes by name.
    sole.name = `foot${tag}`;
    soles.push(sole);
    sole.material = lit(C.sole, { roughness: 0.85 });
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
    clips: CLIPS,
    group: root,
    soles,
    update(pose: IHeroPose): void {
      time += pose.dt;
      const run = Math.min(1, pose.speed / 9.6);
      const k = 1 - Math.exp(-pose.dt * 18);
      let pitch = 0;
      let roll = 0;
      let squash = 1;
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
        // The idle, walk and run clips swing the limbs; the joints settle back to rest under them.
        for (const limb of [legL, legR, armL, armR]) limb.rotation.x = ease(limb.rotation.x, 0, k);
        pitch = pose.action === "skid" ? 0.35 : -run * 0.2;
      } else {
        const rise = MathUtils.clamp(pose.vy / 12, -1, 1);
        // Hanging, the legs dangle back off the wall and kick slowly, so they show below the body
        // instead of folding into the wall under it.
        const kick = Math.sin(time * 3.2) * 0.22;
        legL.rotation.x = ease(legL.rotation.x, hang ? -0.55 + kick : 0.7 - rise * 0.3, k);
        legR.rotation.x = ease(legR.rotation.x, hang ? -0.35 - kick : -0.3 + rise * 0.2, k);
        // A rising jump throws one fist up; falling, both arms float out.
        const up = reachAngle ?? (rise > 0.2 ? 2.6 : 0.4);
        armL.rotation.x = ease(armL.rotation.x, reachAngle ?? 0.4, k);
        armR.rotation.x = ease(armR.rotation.x, up, k);
      }
      armL.rotation.z = ease(armL.rotation.z, -spread, k);
      armR.rotation.z = ease(armR.rotation.z, spread, k);
      legL.rotation.z = ease(legL.rotation.z, hang ? -0.25 : 0, k);
      legR.rotation.z = ease(legR.rotation.z, hang ? 0.25 : 0, k);
      for (const arm of arms) arm.scale.y = ease(arm.scale.y, stretch, k);
      pivot.position.z = ease(pivot.position.z, hang ? HANG.back : 0, k);
      pivot.position.y = BODY_Y * squash + (hang ? HANG.lift : 0);
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
