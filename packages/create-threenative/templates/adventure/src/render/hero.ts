// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Wren, a lamp-bearing wanderer, modelled from primitives: no mesh file, no skin, no clip. Every
// joint is a group the pose below rotates. Local space is feet at y = 0, facing +Z. The right
// hand is a real `Bone` named `RightHand`, so the blade is attached with the engine's
// `attachToBone` (a weapon stays in the hand that holds it) instead of being parented by hand.
import {
  Bone,
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  MathUtils,
  Mesh,
  SphereGeometry,
} from "three";
import { flat, glow, lit } from "./materials.js";
import { C } from "./palette.js";

export type HeroPoseName = "idle" | "run" | "roll" | "hop" | "slash" | "block" | "hurt" | "dead";

export interface IHeroPose {
  readonly dt: number;
  readonly state: HeroPoseName;
  /** Ground speed, m/s. */
  readonly speed: number;
  /** 0..1 through the current action (slash, roll, hurt). */
  readonly progress: number;
}

export interface IHeroRig {
  readonly group: Group;
  update(pose: IHeroPose): void;
}

function part(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** The Ember Blade: a short sword with a glowing fuller, gripped at its own origin. */
export function createBlade(): Group {
  const blade = new Group();
  blade.add(part(new CylinderGeometry(0.025, 0.03, 0.16, 8), lit(C.leather), 0, 0, 0));
  const guard = part(new BoxGeometry(0.2, 0.035, 0.05), lit(C.brass, { metalness: 0.8 }), 0, 0.09);
  blade.add(guard);
  const steel = part(
    new BoxGeometry(0.055, 0.68, 0.015),
    lit(C.blade, { metalness: 0.9, roughness: 0.25 }),
    0,
    0.45,
  );
  blade.add(steel);
  blade.add(part(new BoxGeometry(0.014, 0.55, 0.018), glow(C.ember, 3), 0, 0.42));
  blade.add(
    part(
      new ConeGeometry(0.028, 0.09, 4),
      lit(C.blade, { metalness: 0.9, roughness: 0.25 }),
      0,
      0.83,
    ),
  );
  return blade;
}

export function createHero(): IHeroRig {
  const root = new Group();
  const body = new Group();
  body.position.y = 0.92;
  root.add(body);
  const cloak = lit(C.cloak);
  const tunic = lit(C.tunic);
  const leather = lit(C.leather);
  const skin = lit(C.skin);

  // Torso: tunic, belt, then the cloak hanging off the shoulders behind.
  body.add(part(new CapsuleGeometry(0.19, 0.3, 4, 12), tunic, 0, 0.2, 0));
  body.add(part(new CylinderGeometry(0.21, 0.21, 0.07, 14), leather, 0, 0.02, 0));
  const cape = part(new ConeGeometry(0.34, 0.85, 14, 1, true), cloak, 0, 0.12, -0.06);
  cape.scale.set(1, 1, 0.7);
  body.add(cape);
  body.add(part(new CylinderGeometry(0.2, 0.25, 0.14, 14), lit(C.cloakDark), 0, 0.52, -0.01));

  // The lantern on her left hip: the one warm light she carries.
  const lamp = new Group();
  lamp.position.set(0.24, -0.02, 0.06);
  body.add(lamp);
  lamp.add(part(new CylinderGeometry(0.05, 0.05, 0.11, 8), lit(C.iron, { metalness: 0.7 })));
  lamp.add(part(new SphereGeometry(0.04, 8, 6), glow(C.lamp, 8)));

  const head = new Group();
  head.position.set(0, 0.68, 0);
  body.add(head);
  head.add(part(new SphereGeometry(0.15, 14, 12), skin));
  const hair = part(
    new SphereGeometry(0.165, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    lit(C.hair),
  );
  hair.rotation.x = -0.25;
  head.add(hair);
  const tail = part(new ConeGeometry(0.07, 0.28, 8), lit(C.hair), 0, -0.05, -0.16);
  tail.rotation.x = 2.6;
  head.add(tail);
  for (const side of [-1, 1])
    head.add(part(new SphereGeometry(0.022, 8, 6), lit(C.eye), 0.055 * side, 0.02, 0.135));
  // Hood resting on the shoulders.
  const hood = part(
    new SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
    cloak,
    0,
    -0.08,
    -0.04,
  );
  head.add(hood);

  const arms = { left: new Group(), right: new Group() };
  const legs = { left: new Group(), right: new Group() };
  for (const [name, side] of [
    ["left", 1],
    ["right", -1],
  ] as const) {
    const arm = arms[name];
    arm.position.set(0.25 * side, 0.46, 0);
    body.add(arm);
    arm.add(part(new CapsuleGeometry(0.055, 0.26, 4, 8), tunic, 0, -0.17, 0));
    arm.add(part(new SphereGeometry(0.06, 8, 6), skin, 0, -0.36, 0));
    const leg = legs[name];
    leg.position.set(0.1 * side, 0, 0);
    body.add(leg);
    // The leg runs from the hip (y -0.03) down into the boot top (y -0.83): no gap above the boot.
    leg.add(part(new CapsuleGeometry(0.07, 0.66, 4, 8), lit(C.cloakDark), 0, -0.43, 0));
    leg.add(part(new BoxGeometry(0.12, 0.09, 0.22), leather, 0, -0.87, 0.04));
  }

  // The right hand is a bone: `Hero.ts` attaches the blade to it once Wren has one.
  const hand = new Bone();
  hand.name = "RightHand";
  hand.position.set(0, -0.36, 0.02);
  hand.rotation.x = Math.PI / 2;
  arms.right.add(hand);

  // The shield rides the left forearm, face out.
  const shield = new Group();
  shield.position.set(0.06, -0.26, 0.06);
  shield.rotation.y = -Math.PI / 2 + 0.25;
  arms.left.add(shield);
  const board = part(new CylinderGeometry(0.24, 0.24, 0.04, 18), lit(C.shield), 0, 0, 0);
  board.rotation.x = Math.PI / 2;
  shield.add(board);
  const boss = part(
    new SphereGeometry(0.07, 10, 8),
    lit(C.brass, { metalness: 0.8, roughness: 0.35 }),
    0,
    0,
    0.03,
  );
  shield.add(boss);

  // A blob under the feet keeps her planted on bright grass where the shadow map's own is faint.
  const blob = new Mesh(new CircleGeometry(0.36, 18), flat(0x0b1408, 0.32));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.015;
  blob.renderOrder = 2;
  root.add(blob);

  let time = 0;
  return {
    group: root,
    update({ dt, progress, speed, state }: IHeroPose): void {
      time += dt;
      const run = Math.min(1, speed / 3);
      const cycle = time * (5 + run * 6);
      const swing = Math.sin(cycle) * 0.9 * run;
      legs.left.rotation.x = swing;
      legs.right.rotation.x = -swing;
      arms.left.rotation.set(-swing * 0.6, 0, 0.08);
      arms.right.rotation.set(swing * 0.6, 0, -0.08);
      body.position.y = 0.92 + Math.abs(Math.sin(cycle)) * 0.05 * run + Math.sin(time * 2) * 0.008;
      body.rotation.set(run * 0.12, 0, 0);
      cape.rotation.x = -0.15 - run * 0.35;
      head.rotation.set(0, Math.sin(time * 0.9) * 0.08 * (1 - run), 0);
      if (state === "slash") {
        // Windup cocks the blade over the right shoulder; the cut sweeps across to the left.
        const cut = progress < 0.33 ? progress / 0.33 : 1;
        const recover = progress > 0.58 ? (progress - 0.58) / 0.42 : 0;
        arms.right.rotation.set(
          -2.2 + cut * 1.1 + recover * 1.1,
          0,
          -0.9 + cut * 2.1 - recover * 1.2,
        );
        body.rotation.y = 0.5 - cut * 1.1 + recover * 0.6;
      } else if (state === "block") {
        arms.left.rotation.set(-1.45, 0.25, -0.35);
        body.position.y = 0.85;
        body.rotation.x = 0.18;
      } else if (state === "roll") {
        body.rotation.x = progress * Math.PI * 2;
        body.position.y = 0.55 + Math.sin(progress * Math.PI) * 0.1;
        legs.left.rotation.x = -1.2;
        legs.right.rotation.x = -1.2;
      } else if (state === "hop") {
        legs.left.rotation.x = -0.5;
        legs.right.rotation.x = 0.4;
      } else if (state === "hurt") {
        body.rotation.x = -0.35 * (1 - progress);
      } else if (state === "dead") {
        body.rotation.x = MathUtils.lerp(0, -1.45, Math.min(1, progress * 2));
        body.position.y = MathUtils.lerp(0.92, 0.3, Math.min(1, progress * 2));
      }
    },
  };
}
