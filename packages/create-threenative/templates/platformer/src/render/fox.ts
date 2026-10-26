// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Chibi fox in a blue jacket, modelled from primitives: no mesh file, no skin, no animation clip.
// Every joint is a group the run cycle below rotates, so the whole character is one procedural rig
// and no asset bytes. Local space is feet at y = 0 facing +X; `createFox` returns the group to
// parent and the one function that poses it, so nothing else knows the rig's joint layout.
import {
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
  type MeshBasicMaterial,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { flat, toon } from "./materials.js";
import { C } from "./palette.js";

export interface IFoxPose {
  readonly dashing: boolean;
  readonly dt: number;
  /** Metres between the fox's feet and the surface under it, for the contact shadow. */
  readonly drop: number;
  readonly grounded: boolean;
  readonly speed: number;
  readonly vy: number;
}

export interface IFox {
  readonly group: Group;
  update(pose: IFoxPose): void;
}
function part(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

export function createFox(): IFox {
  const root = new Group();
  const fur = toon(C.fur);
  const cream = toon(C.cream);
  const jacket = toon(C.jacket);
  const jacketDark = toon(C.jacketDark);
  const ink = toon(C.ink);

  const body = new Group();
  body.position.y = 0.58;
  root.add(body);

  // Torso, then the jacket's hem and collar: not one solid tube.
  const torso = part(new CapsuleGeometry(0.3, 0.24, 4, 10), jacket, 0, 0.2, 0);
  torso.scale.set(1, 1, 0.92);
  body.add(torso);
  body.add(part(new CylinderGeometry(0.33, 0.35, 0.12, 12), jacketDark, 0, -0.02, 0));
  body.add(part(new CylinderGeometry(0.25, 0.28, 0.1, 12), jacketDark, 0, 0.44, 0));

  const belly = part(new SphereGeometry(0.2, 10, 8), cream, 0.2, 0.14, 0);
  belly.scale.set(0.7, 1, 0.9);
  body.add(belly);
  // The backpack and its strap, which is what stops the torso reading as a capsule.
  const pack = part(new BoxGeometry(0.3, 0.34, 0.26), toon(C.pack), -0.26, 0.22, 0);
  const strap = part(new TorusGeometry(0.22, 0.035, 6, 14), toon(C.pack), -0.1, 0.24, 0);
  strap.rotation.y = Math.PI / 2;
  const buckle = part(new CylinderGeometry(0.07, 0.07, 0.06, 8), toon(C.gemLight), -0.42, 0.24, 0);
  buckle.rotation.z = Math.PI / 2;
  body.add(pack, strap, buckle);

  const head = new Group();
  head.position.set(0.02, 0.62, 0);
  body.add(head);

  const skull = part(new SphereGeometry(0.34, 12, 10), fur);
  skull.scale.set(0.95, 0.94, 1);
  head.add(skull);
  const cheeks = part(new SphereGeometry(0.26, 10, 8), cream, 0.12, -0.08, 0);
  cheeks.scale.set(0.85, 0.8, 1.02);
  head.add(cheeks);
  const muzzle = part(new SphereGeometry(0.14, 8, 6), cream, 0.3, -0.07, 0);
  muzzle.scale.set(0.9, 0.75, 0.85);
  head.add(muzzle);
  head.add(part(new SphereGeometry(0.055, 8, 6), ink, 0.42, -0.04, 0));

  for (const side of [-1, 1]) {
    const eye = part(new SphereGeometry(0.062, 8, 6), ink, 0.26, 0.06, 0.15 * side);
    eye.scale.set(0.8, 1.15, 1);
    head.add(eye);
    const glint = part(new SphereGeometry(0.022, 6, 6), toon(0xffffff), 0.31, 0.1, 0.17 * side);
    head.add(glint);
    const ear = new Group();
    ear.position.set(-0.02, 0.28, 0.17 * side);
    ear.rotation.x = -0.35 * side;
    head.add(ear);
    ear.add(part(new ConeGeometry(0.13, 0.3, 8), fur, 0, 0.13, 0));
    ear.add(part(new ConeGeometry(0.075, 0.18, 6), ink, 0.02, 0.13, 0));
  }

  const limbs: Record<"armL" | "armR" | "legL" | "legR", Group> = {
    armL: new Group(),
    armR: new Group(),
    legL: new Group(),
    legR: new Group(),
  };
  for (const [name, side] of [
    ["L", 1],
    ["R", -1],
  ] as const) {
    const arm = limbs[`arm${name}`];
    arm.position.set(0, 0.34, 0.29 * side);
    body.add(arm);
    arm.add(part(new CapsuleGeometry(0.085, 0.16, 4, 8), jacket, 0, -0.12, 0));
    arm.add(part(new SphereGeometry(0.095, 8, 6), cream, 0, -0.27, 0));

    const leg = limbs[`leg${name}`];
    leg.name = `leg${name}`; // read back by `Fox.standingSwing`
    leg.position.set(0, 0.02, 0.14 * side);
    body.add(leg);
    leg.add(part(new CapsuleGeometry(0.1, 0.18, 4, 8), cream, 0, -0.16, 0));
    leg.add(part(new BoxGeometry(0.24, 0.11, 0.15), cream, 0.05, -0.33, 0));
  }

  const tail = new Group();
  tail.position.set(-0.3, 0.18, 0);
  tail.rotation.z = 0.5;
  body.add(tail);
  const tailSegments: Group[] = [];
  const radii = [0.17, 0.19, 0.19, 0.17, 0.13];
  let previous: Group = tail;
  for (let i = 0; i < radii.length; i += 1) {
    const segment = new Group();
    segment.position.x = i === 0 ? -0.12 : -0.19;
    previous.add(segment);
    const colour = i >= radii.length - 1 ? cream : i % 2 === 0 ? fur : cream;
    const ball = part(new SphereGeometry(radii[i] ?? 0.15, 10, 8), colour);
    ball.scale.set(1.05, 1, 1);
    segment.add(ball);
    tailSegments.push(segment);
    previous = segment;
  }

  // The contact shadow: a blob that shrinks with the drop, which is what keeps the fox planted on
  // a bright grass cap where the shadow map's own shadow is easy to lose.
  const blob = new Mesh(
    new CircleGeometry(0.42, 16),
    flat(0x0a2436, { depthWrite: false, opacity: 0.3 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 2;
  root.add(blob);

  let time = 0;
  let cycle = 0; // The run phase advances with speed: a fox standing still stands still.
  return {
    group: root,
    update(pose: IFoxPose): void {
      time += pose.dt;
      const run = Math.min(1, pose.speed / 7);
      const moving = Math.min(1, pose.speed / 0.6);
      cycle += pose.dt * (6 + run * 9) * moving;
      if (pose.grounded) {
        const swing = Math.sin(cycle) * (0.35 + run * 0.75) * moving;
        limbs.legL.rotation.z = swing;
        limbs.legR.rotation.z = -swing;
        limbs.armL.rotation.z = -swing * 0.85;
        limbs.armR.rotation.z = swing * 0.85;
        body.position.y =
          0.58 + Math.abs(Math.sin(cycle)) * 0.06 * run + Math.sin(time * 2.2) * 0.012;
        body.rotation.z = -0.06 - run * 0.16 - (pose.dashing ? 0.16 : 0);
      } else {
        const rise = MathUtils.clamp(pose.vy / 9, -1, 1);
        limbs.legL.rotation.z = MathUtils.lerp(limbs.legL.rotation.z, 0.5 + rise * 0.5, 0.25);
        limbs.legR.rotation.z = MathUtils.lerp(limbs.legR.rotation.z, -0.2 + rise * 0.4, 0.25);
        limbs.armL.rotation.z = MathUtils.lerp(limbs.armL.rotation.z, -1.5 - rise * 0.6, 0.2);
        limbs.armR.rotation.z = MathUtils.lerp(limbs.armR.rotation.z, -1.2 - rise * 0.5, 0.2);
        body.position.y = 0.58;
        body.rotation.z = MathUtils.lerp(body.rotation.z, -0.12, 0.15);
      }
      head.rotation.z = Math.sin(cycle * 0.5) * 0.04 - run * 0.08;
      head.rotation.y = Math.sin(time * 1.3) * 0.06;
      tail.rotation.z = 0.5 - run * 0.55 + Math.sin(time * 3) * 0.08;
      for (const [index, segment] of tailSegments.entries()) {
        segment.rotation.z = Math.sin(time * (5 + run * 4) - index * 0.7) * (0.1 + run * 0.14);
        segment.rotation.y = Math.sin(time * 2.4 - index * 0.5) * 0.1;
      }
      blob.position.y = -pose.drop + 0.02;
      blob.visible = pose.drop < 7;
      const k = MathUtils.clamp(1 - pose.drop / 7, 0.25, 1);
      blob.scale.setScalar(k);
      (blob.material as MeshBasicMaterial).opacity = 0.3 * k;
    },
  };
}
