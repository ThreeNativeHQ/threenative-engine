// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Wren, a lantern-bearing wanderer, modelled from primitives: no mesh file, no skin, no clip. Every
// joint is a group the pose below rotates. Local space is feet at y = 0, facing +Z, so her right
// is -X. The right hand is a real `Bone` named `RightHand`, so the blade is attached with the
// engine's `attachToBone` (a weapon stays in the hand that holds it) instead of being parented by
// hand.
//
// Chibi-heroic proportions: the head is about a third of her 1.75 m. A russet tunic with an ochre
// hem over a cream undershirt, a brass-buckled belt, a long dusk-blue cap whose tip lags behind her
// head, a matching scarf whose tails stream back as she runs, bracers and cuffed boots. Sheathed,
// the scabbard and the round shield ride her back, so she reads from the follow camera behind her.
import {
  AdditiveBlending,
  Bone,
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  type Material,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { flat, glow, lit } from "./materials.js";
import { C } from "./palette.js";

export type HeroPoseName =
  | "idle"
  | "run"
  | "roll"
  | "hop"
  | "slash"
  | "block"
  | "push"
  | "hurt"
  | "dead";

export interface IHeroPose {
  readonly dt: number;
  readonly state: HeroPoseName;
  /** Ground speed, m/s. */
  readonly speed: number;
  /** 0..1 through the current action (slash, roll, hurt). */
  readonly progress: number;
  /** She owns the Ember Blade: the scabbard is on her back. */
  readonly sword: boolean;
  /** The blade is in her hand and the shield on her arm; otherwise both ride her back. */
  readonly drawn: boolean;
  /** 1 the step the shield turns a hit, fading to 0. */
  readonly flash: number;
}

export interface IHeroRig {
  readonly group: Group;
  update(pose: IHeroPose): void;
}

/** Hip height: the body group's origin, and the pivot the run and the roll turn about. */
const HIP = 0.62;

function part(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A group at (x, y, z) inside `parent`: a joint the pose rotates. */
function joint(parent: Group, x = 0, y = 0, z = 0): Group {
  const group = new Group();
  group.position.set(x, y, z);
  parent.add(group);
  return group;
}

/** The Ember Blade: a short sword with a glowing fuller, gripped at its own origin. */
export function createBlade(): Group {
  const steel = lit(C.blade, { metalness: 0.9, roughness: 0.25 });
  const blade = new Group();
  blade.add(part(new CylinderGeometry(0.025, 0.03, 0.16, 8), lit(C.leather), 0, 0, 0));
  blade.add(part(new SphereGeometry(0.035, 8, 6), lit(C.brass, { metalness: 0.8 }), 0, -0.1));
  blade.add(part(new BoxGeometry(0.2, 0.035, 0.05), lit(C.brass, { metalness: 0.8 }), 0, 0.09));
  blade.add(part(new BoxGeometry(0.055, 0.68, 0.015), steel, 0, 0.45));
  blade.add(part(new BoxGeometry(0.014, 0.55, 0.018), glow(C.ember, 3), 0, 0.42));
  blade.add(part(new ConeGeometry(0.028, 0.09, 4), steel, 0, 0.83));
  return blade;
}

/** The round shield, face toward +Z: boards, a brass rim and boss, an ochre lantern sigil. */
function createShield(): Group {
  const shield = new Group();
  const board = part(new CylinderGeometry(0.2, 0.2, 0.035, 20), lit(C.shield));
  board.rotation.x = Math.PI / 2;
  shield.add(board);
  shield.add(
    part(new TorusGeometry(0.2, 0.018, 6, 24), lit(C.brass, { metalness: 0.8, roughness: 0.4 })),
  );
  shield.add(part(new TorusGeometry(0.12, 0.012, 6, 20), lit(C.tunicTrim), 0, 0, 0.02));
  shield.add(
    part(
      new SphereGeometry(0.055, 10, 8),
      lit(C.brass, { metalness: 0.8, roughness: 0.35 }),
      0,
      0,
      0.02,
    ),
  );
  return shield;
}

export function createHero(): IHeroRig {
  const root = new Group();
  const body = joint(root, 0, HIP, 0);
  const tunic = lit(C.tunic);
  const trim = lit(C.tunicTrim);
  const cream = lit(C.undershirt);
  const cap = lit(C.cap);
  const leather = lit(C.leather);
  const skin = lit(C.skin);
  const hairMat = lit(C.hair);
  const brass = lit(C.brass, { metalness: 0.8, roughness: 0.35 });

  // Torso: the chest breathes; the flared hem swings with the stride.
  const chest = joint(body, 0, 0.05, 0);
  const torso = part(new CapsuleGeometry(0.17, 0.2, 4, 14), tunic, 0, 0.2, 0);
  torso.scale.z = 0.85;
  chest.add(torso);
  chest.add(part(new CylinderGeometry(0.1, 0.13, 0.06, 12), cream, 0, 0.44, 0));
  const skirt = joint(body, 0, 0.08, 0);
  skirt.add(part(new CylinderGeometry(0.18, 0.28, 0.3, 18), tunic, 0, -0.15, 0));
  const hem = part(new TorusGeometry(0.275, 0.022, 6, 22), trim, 0, -0.29, 0);
  hem.rotation.x = Math.PI / 2;
  skirt.add(hem);
  body.add(part(new CylinderGeometry(0.188, 0.19, 0.06, 16), leather, 0, 0.08, 0));
  body.add(part(new BoxGeometry(0.08, 0.065, 0.03), brass, 0, 0.08, 0.185));

  // The lantern on her left hip: the one warm light she carries.
  const lamp = joint(body, 0.2, -0.02, 0.1);
  const iron = lit(C.iron, { metalness: 0.7 });
  lamp.add(part(new CylinderGeometry(0.038, 0.038, 0.08, 8), glow(C.lamp, 8)));
  lamp.add(part(new ConeGeometry(0.05, 0.05, 8), iron, 0, 0.065));
  lamp.add(part(new CylinderGeometry(0.048, 0.048, 0.015, 8), iron, 0, -0.045));

  // Head: a third of her height. Hair, a fringe under the cap, big eyes with highlights, brows,
  // pointed ears, and the long cap whose two-joint tip trails behind.
  const head = joint(body, 0, 0.71, 0);
  head.add(part(new SphereGeometry(0.25, 20, 16), skin));
  head.add(part(new SphereGeometry(0.258, 18, 14), hairMat, 0, 0.02, -0.03));
  for (let i = 0; i < 5; i += 1) {
    const a = (i - 2) * 0.32;
    const lock = part(
      new ConeGeometry(0.06, 0.16, 6),
      hairMat,
      Math.sin(a) * 0.22,
      0.1,
      Math.cos(a) * 0.215,
    );
    lock.rotation.set(Math.PI - 0.25, a, 0);
    head.add(lock);
  }
  const eyeMat = lit(C.eye, { roughness: 0.3 });
  const shine = flat(0xffffff);
  for (const side of [-1, 1]) {
    const eye = part(new SphereGeometry(0.045, 10, 8), eyeMat, 0.088 * side, -0.01, 0.222);
    eye.scale.set(0.8, 1.25, 0.5);
    head.add(eye);
    head.add(part(new SphereGeometry(0.013, 6, 4), shine, 0.088 * side + 0.014, 0.02, 0.245));
    const brow = part(new BoxGeometry(0.085, 0.02, 0.02), hairMat, 0.088 * side, 0.075, 0.232);
    brow.rotation.z = 0.2 * side;
    head.add(brow);
    const ear = joint(head, 0.235 * side, 0, -0.02);
    ear.rotation.set(-0.35, 0, -side * (Math.PI / 2 - 0.5));
    const tip = part(new ConeGeometry(0.06, 0.2, 6), skin, 0, 0.09, 0);
    tip.scale.z = 0.5;
    ear.add(tip);
  }
  head.add(part(new SphereGeometry(0.024, 6, 4), skin, 0, -0.045, 0.25));
  head.add(part(new BoxGeometry(0.05, 0.012, 0.01), lit(C.mouth), 0, -0.11, 0.228));
  const crown = part(
    new SphereGeometry(0.275, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
    cap,
    0,
    0.03,
    0,
  );
  crown.rotation.x = -0.5;
  head.add(crown);
  const band = part(new TorusGeometry(0.255, 0.022, 6, 24), lit(C.capDark), 0, 0.03, 0);
  band.rotation.x = Math.PI / 2 - 0.5;
  head.add(band);
  const capBase = joint(head, 0, 0.16, -0.2);
  capBase.add(part(new CylinderGeometry(0.08, 0.17, 0.36, 14), cap, 0, 0.18, 0));
  const capTip = joint(capBase, 0, 0.35, 0);
  capTip.add(part(new ConeGeometry(0.08, 0.32, 12), cap, 0, 0.16, 0));
  capTip.add(part(new SphereGeometry(0.035, 8, 6), brass, 0, 0.33, 0));

  // The scarf: a roll round the neck, knotted at the left shoulder, two tails that stream back.
  const scarfMat = lit(C.cap);
  const roll = part(new TorusGeometry(0.15, 0.055, 8, 18), scarfMat, 0, 0.5, 0);
  roll.rotation.x = Math.PI / 2;
  body.add(roll);
  body.add(part(new SphereGeometry(0.06, 10, 8), scarfMat, 0.14, 0.5, -0.16));
  const tails = [0.11, 0.18].map((x) => {
    const tail = joint(body, x, 0.49, -0.2);
    tail.add(part(new BoxGeometry(0.08, 0.36, 0.022), scarfMat, 0, -0.18, 0));
    return tail;
  });

  // Back gear. The scabbard runs from her right shoulder to her left hip under the shield, with
  // the sheathed hilt over her shoulder; the shield sits on the scabbard.
  const scabbard = joint(body, 0, 0.2, -0.17);
  scabbard.rotation.z = 0.55;
  scabbard.add(part(new BoxGeometry(0.075, 0.8, 0.04), leather));
  scabbard.add(part(new BoxGeometry(0.09, 0.07, 0.05), brass, 0, 0.38));
  const chape = part(new ConeGeometry(0.045, 0.08, 4), brass, 0, -0.43);
  chape.rotation.z = Math.PI;
  scabbard.add(chape);
  const sheathed = createBlade();
  sheathed.rotation.z = Math.PI;
  sheathed.position.y = 0.48;
  scabbard.add(sheathed);
  const backShield = createShield();
  backShield.position.set(0.02, 0.24, -0.215);
  backShield.rotation.y = Math.PI;
  body.add(backShield);

  // Arms: a russet shoulder, a cream sleeve, a leather bracer, a bare hand.
  const arms = { left: new Group(), right: new Group() };
  const legs = { left: new Group(), right: new Group() };
  for (const [name, side] of [
    ["left", 1],
    ["right", -1],
  ] as const) {
    const arm = arms[name];
    arm.position.set(0.23 * side, 0.43, 0);
    body.add(arm);
    arm.add(part(new SphereGeometry(0.075, 10, 8), tunic));
    arm.add(part(new CapsuleGeometry(0.058, 0.1, 4, 8), cream, 0, -0.11, 0));
    arm.add(part(new CylinderGeometry(0.066, 0.058, 0.13, 10), leather, 0, -0.24, 0));
    arm.add(part(new SphereGeometry(0.058, 8, 6), skin, 0, -0.34, 0));
    // Legs: dark trousers into a boot with a folded cuff; the sole meets y = 0.
    const leg = legs[name];
    leg.position.set(0.09 * side, -0.06, 0);
    body.add(leg);
    leg.add(part(new CapsuleGeometry(0.065, 0.22, 4, 8), lit(C.trousers), 0, -0.17, 0));
    leg.add(part(new CylinderGeometry(0.095, 0.088, 0.07, 12), lit(C.bootCuff), 0, -0.33, 0));
    leg.add(part(new CylinderGeometry(0.08, 0.075, 0.2, 12), leather, 0, -0.43, 0));
    leg.add(part(new BoxGeometry(0.13, 0.08, 0.22), leather, 0, -0.52, 0.04));
  }

  // The right hand is a bone: `Hero.ts` attaches the blade to it once Wren has one.
  const hand = new Bone();
  hand.name = "RightHand";
  hand.position.set(0, -0.34, 0.02);
  hand.rotation.x = Math.PI / 2;
  arms.right.add(hand);

  // The shield on the left forearm, face out, while drawn; a block turns it to face forward.
  const armShield = createShield();
  arms.left.add(armShield);
  const flashMaterial = new MeshBasicMaterial({
    blending: AdditiveBlending,
    color: C.flash,
    depthWrite: false,
    opacity: 0,
    side: DoubleSide,
    transparent: true,
  });
  const flash = new Mesh(new CircleGeometry(0.34, 24), flashMaterial);
  flash.position.z = 0.04;
  flash.renderOrder = 3;
  armShield.add(flash);

  // The slash arc: a 120° fan in front of her at blade height, revealed right to left as the cut
  // sweeps, then faded. Its index order follows the angle, so the draw range is the reveal.
  const ARC_SEGMENTS = 24;
  const arcMaterial = new MeshBasicMaterial({
    blending: AdditiveBlending,
    color: C.slash,
    depthWrite: false,
    opacity: 0,
    side: DoubleSide,
    transparent: true,
  });
  const arc = new Mesh(
    new RingGeometry(0.5, 1.5, ARC_SEGMENTS, 1, -Math.PI / 2 - 1.05, 2.1),
    arcMaterial,
  );
  arc.rotation.x = -Math.PI / 2 - 0.35;
  arc.position.y = HIP + 0.3;
  arc.renderOrder = 3;
  arc.visible = false;
  root.add(arc);

  // A blob under the feet keeps her planted on bright grass where the shadow map's own is faint.
  const blob = new Mesh(new CircleGeometry(0.36, 18), flat(0x0b1408, 0.32));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.015;
  blob.renderOrder = 2;
  root.add(blob);

  let time = 0;
  let guard = 0;
  return {
    group: root,
    update({ dt, drawn, flash: flashing, progress, speed, state, sword }: IHeroPose): void {
      time += dt;
      const run = Math.min(1, speed / 3);
      const cycle = time * (5 + run * 6);
      const swing = Math.sin(cycle) * 0.9 * run;
      const breath = Math.sin(time * 2.4) * (1 - run);
      guard += ((state === "block" ? 1 : 0) - guard) * Math.min(1, dt * 18);

      // Gear: the blade in hand and the shield on the arm only while drawn or blocking.
      const armed = drawn || state === "block";
      scabbard.visible = sword;
      sheathed.visible = sword && !drawn;
      armShield.visible = armed;
      backShield.visible = !armed;

      body.scale.setScalar(1);
      body.position.set(0, HIP + Math.abs(Math.sin(cycle)) * 0.05 * run + breath * 0.006, 0);
      body.rotation.set(run * 0.14, 0, 0);
      chest.scale.set(1 + breath * 0.012, 1 + breath * 0.02, 1 + breath * 0.012);
      skirt.rotation.set(-swing * 0.08 - run * 0.1, 0, swing * 0.05);
      legs.left.rotation.set(swing, 0, 0);
      legs.right.rotation.set(-swing, 0, 0);
      arms.left.rotation.set(-swing * 0.8, 0, 0.1 + breath * 0.02);
      arms.right.rotation.set(swing * 0.8 - (drawn ? 0.3 : 0), 0, -0.1 - breath * 0.02);
      head.rotation.set(-run * 0.1, Math.sin(time * 0.9) * 0.08 * (1 - run), 0);
      // The cap tip and the scarf tails lag: they lift with speed and flutter with the stride.
      capBase.rotation.set(-Math.PI / 2 - 0.55 + run * 0.4 + Math.sin(time * 2.4) * 0.04, 0, 0);
      capTip.rotation.set(-0.45 + run * 0.25 + Math.sin(cycle - 1.2) * (0.12 + 0.2 * run), 0, 0);
      for (const [i, tail] of tails.entries())
        tail.rotation.set(
          0.2 + run * 1 + Math.sin(time * (3 + 11 * run) + i * 1.7) * (0.05 + 0.15 * run),
          0,
          0.05 * (i === 0 ? -1 : 1),
        );
      armShield.position.set(0.075, -0.22, 0);
      armShield.rotation.set(0, Math.PI / 2, 0);
      flashMaterial.opacity = flashing * 0.85;
      flash.scale.setScalar(1 + (1 - flashing) * 0.6);
      arc.visible = false;

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
        arms.left.rotation.set(-0.6, 0, 0.5);
        const reveal = MathUtils.clamp((progress - 0.3) / 0.22, 0, 1);
        const fade = 1 - MathUtils.clamp((progress - 0.58) / 0.2, 0, 1);
        arc.visible = drawn && reveal > 0 && fade > 0;
        arc.geometry.setDrawRange(0, Math.ceil(reveal * ARC_SEGMENTS) * 6);
        arcMaterial.opacity = 0.9 * fade;
      } else if (state === "block" || guard > 0.01) {
        // The shield comes up across her chest, face forward; she braces lower.
        arms.left.rotation.set(-1.45 * guard, 0, MathUtils.lerp(0.1, -0.3, guard));
        armShield.position.set(
          MathUtils.lerp(0.075, 0, guard),
          MathUtils.lerp(-0.22, -0.3, guard),
          0,
        );
        armShield.rotation.set((Math.PI / 2) * guard, (Math.PI / 2) * (1 - guard), 0);
        body.position.y -= 0.06 * guard;
        body.rotation.x += 0.14 * guard;
      }
      if (state === "push") {
        // Both palms on the block's face: the body leans in from a step back, so her feet stay
        // out of the block while the stride stays short and behind her.
        const step = Math.sin(cycle) * 0.3 * run;
        body.position.z = -0.12;
        body.rotation.x = 0.3;
        arms.left.rotation.set(-1.25, 0, -0.2);
        arms.right.rotation.set(-1.25, 0, 0.2);
        legs.left.rotation.set(-0.35 + step, 0, 0);
        legs.right.rotation.set(-0.35 - step, 0, 0);
      } else if (state === "roll") {
        // A tucked somersault: the body shrinks into a ball and turns about the hip, which lifts
        // enough that the cap never dips under the floor.
        const tuck = Math.sin(progress * Math.PI);
        body.rotation.x = progress * Math.PI * 2;
        body.scale.setScalar(1 - 0.28 * tuck);
        body.position.y = HIP + 0.08 * tuck;
        legs.left.rotation.x = -1.4 * tuck;
        legs.right.rotation.x = -1.4 * tuck;
        arms.left.rotation.set(-1.2 * tuck, 0, 0.3);
        arms.right.rotation.set(-1.2 * tuck, 0, -0.3);
      } else if (state === "hop") {
        legs.left.rotation.x = -0.5;
        legs.right.rotation.x = 0.4;
        arms.left.rotation.z = 0.6;
        arms.right.rotation.z = -0.6;
      } else if (state === "hurt") {
        body.rotation.x = -0.35 * (1 - progress);
        arms.left.rotation.z = 0.5;
        arms.right.rotation.z = -0.5;
      } else if (state === "dead") {
        body.rotation.x = MathUtils.lerp(0, -1.45, Math.min(1, progress * 2));
        body.position.y = MathUtils.lerp(HIP, 0.3, Math.min(1, progress * 2));
      }
    },
  };
}
