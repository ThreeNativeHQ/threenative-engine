// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Pip, the hero: a round sprout-keeper in a blue cap, modelled from primitives — no mesh file, no
// skin, no animation clip. Floating gloves and two boots are the limbs, so the run cycle is a few
// rotations and the whole character is one procedural rig. Local space is feet at y = 0, facing
// -Z (Three.js forward); `createHero` returns the group and the one function that poses it.
import {
  CapsuleGeometry,
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

const BODY_Y = 0.82;

export function createHero(): IHero {
  const root = new Group();
  const pivot = new Group();
  pivot.position.y = BODY_Y;
  root.add(pivot);
  const part = (mesh: Mesh, parent: Group, x = 0, y = 0, z = 0): Mesh => {
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  const body = part(new Mesh(new SphereGeometry(0.56, 28, 20), lit(C.body)), pivot);
  body.scale.set(1, 0.96, 0.95);
  const belly = part(
    new Mesh(new SphereGeometry(0.4, 20, 14), lit(C.belly)),
    pivot,
    0,
    -0.12,
    -0.3,
  );
  belly.scale.set(1, 0.95, 0.55);
  // The cap, its brim and a leaf sprout: the silhouette that tells front from back at 30 m.
  const cap = part(
    new Mesh(new SphereGeometry(0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), lit(C.cap)),
    pivot,
    0,
    0.2,
    0,
  );
  cap.scale.set(1.08, 0.82, 1.08);
  const brim = part(new Mesh(new CylinderGeometry(0.38, 0.4, 0.05, 20), lit(C.cap)), pivot);
  brim.position.set(0, 0.24, -0.42);
  brim.rotation.x = 0.25;
  brim.scale.set(1, 1, 0.6);
  const sprout = part(
    new Mesh(new ConeGeometry(0.08, 0.32, 8), lit(C.leaf)),
    pivot,
    0.05,
    0.72,
    0.05,
  );
  sprout.rotation.z = -0.4;
  for (const side of [-1, 1]) {
    const eye = part(
      new Mesh(new CapsuleGeometry(0.055, 0.1, 4, 8), lit(C.ink, { roughness: 0.3 })),
      pivot,
    );
    eye.position.set(0.17 * side, 0.08, -0.5);
    part(
      new Mesh(new SphereGeometry(0.022, 8, 6), flat(C.white)),
      pivot,
      0.17 * side + 0.015,
      0.13,
      -0.555,
    );
  }

  const gloves: Group[] = [];
  const boots: Group[] = [];
  for (const side of [-1, 1]) {
    const glove = new Group();
    glove.position.set(0.72 * side, -0.05, -0.05);
    pivot.add(glove);
    part(new Mesh(new SphereGeometry(0.17, 14, 10), lit(C.gloves)), glove);
    gloves.push(glove);

    const boot = new Group();
    boot.position.set(0.24 * side, -0.56, 0);
    pivot.add(boot);
    const shoe = part(
      new Mesh(new SphereGeometry(0.2, 14, 10), lit(C.boots)),
      boot,
      0,
      -0.1,
      -0.06,
    );
    shoe.scale.set(0.9, 0.7, 1.35);
    boots.push(boot);
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
  const [gloveL, gloveR] = gloves as [Group, Group];
  const [bootL, bootR] = boots as [Group, Group];
  return {
    group: root,
    update(pose: IHeroPose): void {
      time += pose.dt;
      const run = Math.min(1, pose.speed / 9.6);
      const cycle = time * (5 + run * 10);
      const ease = 1 - Math.exp(-pose.dt * 18);
      let pitch = 0;
      let roll = 0;
      let squash = 1;
      let bob = 0;
      let reach = 0;
      const t = pose.actionTime;
      switch (pose.action) {
        case "triple":
        case "backflip":
          // A full forward (triple) or backward (backflip) somersault over the first 0.6 s.
          pitch = (pose.action === "triple" ? -1 : 1) * Math.min(1, t / 0.6) * Math.PI * 2;
          break;
        case "sideflip":
          roll = Math.min(1, t / 0.6) * Math.PI * 2;
          break;
        case "dive":
        case "diveSlide":
          pitch = -1.25;
          reach = 1;
          break;
        case "longJump":
          pitch = -0.55;
          reach = 0.7;
          break;
        case "groundPound":
          pitch = t < 0.25 ? -(t / 0.25) * Math.PI * 2 : 0;
          squash = t < 0.25 ? 0.85 : 0.9;
          break;
        case "crouch":
        case "crouchSlide":
          squash = 0.72;
          break;
        case "ledgeHang":
        case "ledgeClimb":
          reach = -1;
          break;
        default:
          break;
      }
      const grounded = pose.action === "idle" || pose.action === "run" || pose.action === "skid";
      if (grounded) {
        const swing = Math.sin(cycle) * (0.15 + run * 0.65);
        bootL.rotation.x = swing;
        bootR.rotation.x = -swing;
        gloveL.position.z = -0.05 - swing * 0.35;
        gloveR.position.z = -0.05 + swing * 0.35;
        bob = Math.abs(Math.sin(cycle)) * 0.07 * run + Math.sin(time * 2.4) * 0.012;
        pitch = pose.action === "skid" ? 0.35 : -run * 0.2;
      } else {
        const rise = MathUtils.clamp(pose.vy / 12, -1, 1);
        bootL.rotation.x = MathUtils.lerp(bootL.rotation.x, 0.6 - rise * 0.3, ease);
        bootR.rotation.x = MathUtils.lerp(bootR.rotation.x, -0.2 + rise * 0.2, ease);
        gloveL.position.z = MathUtils.lerp(gloveL.position.z, -0.05, ease);
        gloveR.position.z = MathUtils.lerp(gloveR.position.z, -0.05, ease);
      }
      // Gloves: up for a hang, forward for a dive, out to the sides otherwise.
      const gloveY = reach < 0 ? 0.75 : -0.05 + Math.max(0, pose.vy) * 0.015;
      const gloveZ = reach > 0 ? -0.55 * reach : undefined;
      for (const glove of gloves) {
        glove.position.y = MathUtils.lerp(glove.position.y, gloveY, ease);
        if (gloveZ !== undefined) glove.position.z = MathUtils.lerp(glove.position.z, gloveZ, ease);
      }
      pivot.position.y = BODY_Y * squash + bob;
      pivot.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
      pivot.rotation.x = pitch;
      pivot.rotation.z = roll;
      blob.position.y = -pose.drop + 0.02;
      blob.visible = pose.drop < 9;
      const k = MathUtils.clamp(1 - pose.drop / 9, 0.25, 1);
      blob.scale.setScalar(k);
      (blob.material as MeshBasicMaterial).opacity = 0.32 * k;
    },
  };
}
