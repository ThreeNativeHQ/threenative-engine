// Generated for you. The explorer's look and its procedural pose: every part is a primitive built
// here, so the character can be restyled — or swapped for a rigged model — without touching the
// movement or the footsteps in `src/entities/Explorer.ts`.
import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SnowMaterials } from "./materials.js";

type Point = { x: number; y: number; z: number };

/** Where each boot is, in world space, and whether it is in the air. */
export interface IFootPose {
  readonly side: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly angle: number;
  readonly swing: boolean;
  readonly progress: number;
}

interface ISegment {
  readonly mesh: Mesh;
  readonly length: number;
}

interface ILimb {
  readonly side: number;
  readonly upper: ISegment;
  readonly lower: ISegment;
  readonly end: Object3DLike;
}

type Object3DLike = Group | Mesh;

/** Bake a group's direct child meshes into one mesh per material, keeping child groups. */
function mergeRigid(group: Group): void {
  const byMaterial = new Map<Material, BufferGeometry[]>();
  for (const child of [...group.children]) {
    if (!(child instanceof Mesh) || Array.isArray(child.material)) continue;
    child.updateMatrix();
    const geometry = child.geometry.clone().applyMatrix4(child.matrix);
    const list = byMaterial.get(child.material) ?? [];
    list.push(geometry);
    byMaterial.set(child.material, list);
    group.remove(child);
  }
  for (const [material, geometries] of byMaterial) {
    const merged = mergeGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    if (merged === null) throw new Error("ExplorerModel could not merge a rigid part.");
    const mesh = new Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

const UP = new Vector3(0, 1, 0);
const scratchA = new Vector3();
const scratchB = new Vector3();

/** Two-bone IK: the knee that keeps both bones at length, bent towards `bend`. */
function solveKnee(hip: Point, ankle: Point, upper: number, lower: number, bend: Point): Point {
  let dx = ankle.x - hip.x;
  let dy = ankle.y - hip.y;
  let dz = ankle.z - hip.z;
  let distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-7) {
    dx = 0;
    dy = -1;
    dz = 0;
    distance = 1;
  } else {
    dx /= distance;
    dy /= distance;
    dz /= distance;
  }
  const reach = Math.max(Math.abs(upper - lower) + 1e-6, Math.min(upper + lower - 1e-6, distance));
  const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
  const across = Math.sqrt(Math.max(0, upper * upper - along * along));
  const dot = bend.x * dx + bend.y * dy + bend.z * dz;
  let bx = bend.x - dx * dot;
  let by = bend.y - dy * dot;
  let bz = bend.z - dz * dot;
  const length = Math.hypot(bx, by, bz) || 1;
  bx /= length;
  by /= length;
  bz /= length;
  return {
    x: hip.x + dx * along + bx * across,
    y: hip.y + dy * along + by * across,
    z: hip.z + dz * along + bz * across,
  };
}

export class ExplorerModel {
  readonly root = new Group();
  readonly #torso = new Group();
  readonly #head = new Group();
  readonly #arms: ILimb[] = [];
  readonly #legs: ILimb[] = [];
  readonly #sphere = new SphereGeometry(1, 20, 14);

  constructor(materials: SnowMaterials) {
    const m = materials;
    const torso = this.#torso;
    const head = this.#head;
    this.root.add(torso);
    torso.add(head);
    const blob = (material: Material, p: Point, s: Point, parent: Group = this.root) => {
      const mesh = new Mesh(this.#sphere, material);
      mesh.position.set(p.x, p.y, p.z);
      mesh.scale.set(s.x, s.y, s.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const box = (material: Material, p: Point, s: Point, parent: Group) => {
      const mesh = new Mesh(new BoxGeometry(s.x, s.y, s.z), material);
      mesh.position.set(p.x, p.y, p.z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const tube = (material: Material, points: number[][], radius: number, parent: Group) => {
      const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)));
      const mesh = new Mesh(new TubeGeometry(curve, 16, radius, 6, false), material);
      mesh.castShadow = true;
      parent.add(mesh);
    };
    const v = (x: number, y: number, z: number): Point => ({ x, y, z });

    // Quilted coat, waist and hips.
    blob(m.coat, v(0, 1.29, 0), v(0.292, 0.365, 0.188), torso);
    blob(m.coat, v(0, 1.045, 0), v(0.29, 0.13, 0.193), torso);
    blob(m.pants, v(0, 0.95, 0), v(0.238, 0.135, 0.145));
    for (let quilt = 0; quilt < 5; quilt += 1) {
      const y = 1.07 + quilt * 0.11;
      const profile = Math.sqrt(Math.max(0.3, 1 - ((y - 1.29) / 0.41) ** 2));
      const seam = new Mesh(new TorusGeometry(1, 0.011, 4, 36), m.seam);
      seam.rotation.x = Math.PI / 2;
      seam.scale.set(0.297 * profile, 0.192 * profile, 0.35);
      seam.position.y = y;
      torso.add(seam);
    }
    tube(
      m.rubber,
      [
        [0, 1.02, 0.196],
        [0, 1.3, 0.191],
        [0, 1.56, 0.143],
      ],
      0.009,
      torso,
    );
    box(m.seam, v(-0.14, 1.4, 0.179), v(0.105, 0.12, 0.019), torso);
    blob(m.seam, v(-0.225, 1.1, 0.1), v(0.067, 0.081, 0.055), torso);
    blob(m.seam, v(0.225, 1.1, 0.1), v(0.067, 0.081, 0.055), torso);
    blob(m.coat, v(0, 1.595, 0), v(0.205, 0.13, 0.17), torso);

    // Fur-lined hood, goggles and a dusting of snow on top.
    blob(m.coat, v(0, 1.765, -0.015), v(0.229, 0.249, 0.205), head);
    blob(m.skin, v(0, 1.763, 0.16), v(0.143, 0.171, 0.086), head);
    blob(m.gaiter, v(0, 1.683, 0.222), v(0.146, 0.096, 0.045), head);
    for (let tuft = 0; tuft < 28; tuft += 1) {
      const a = (tuft / 28) * Math.PI * 2;
      blob(
        m.fur,
        v(Math.sin(a) * 0.179, 1.766 + Math.cos(a) * 0.213, 0.17 + Math.sin(tuft * 2.3) * 0.008),
        v(0.038, 0.043, 0.043),
        head,
      );
    }
    blob(m.rubber, v(0, 1.823, 0.244), v(0.174, 0.077, 0.043), head);
    blob(m.lens, v(0, 1.825, 0.274), v(0.154, 0.054, 0.027), head);
    blob(m.snowCap, v(-0.015, 1.96, -0.033), v(0.158, 0.036, 0.143), head);

    // Expedition pack, bedroll and straps.
    blob(m.gaiter, v(0, 1.31, -0.248), v(0.235, 0.3, 0.137), torso);
    blob(m.pants, v(0, 1.49, -0.286), v(0.211, 0.107, 0.124), torso);
    blob(m.coat, v(0, 1.3, -0.373), v(0.124, 0.149, 0.037), torso);
    for (const side of [-1, 1]) {
      tube(
        m.gaiter,
        [
          [side * 0.15, 1.03, 0.175],
          [side * 0.197, 1.4, 0.173],
          [side * 0.17, 1.61, -0.04],
          [side * 0.14, 1.45, -0.32],
        ],
        0.025,
        torso,
      );
      box(m.metal, v(side * 0.191, 1.34, 0.198), v(0.034, 0.048, 0.012), torso);
      blob(m.pants, v(side * 0.222, 1.25, -0.246), v(0.075, 0.135, 0.087), torso);
    }
    const bedroll = new Mesh(new CylinderGeometry(0.095, 0.095, 0.43, 16), m.pants);
    bedroll.rotation.z = Math.PI / 2;
    bedroll.position.set(0, 1, -0.255);
    bedroll.castShadow = true;
    torso.add(bedroll);
    blob(m.snowCap, v(0, 1.592, -0.289), v(0.172, 0.025, 0.086), torso);

    const segment = (material: Material, radius: number, length: number): ISegment => {
      const mesh = new Mesh(
        new CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 6, 12),
        material,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return { length, mesh };
    };
    for (const side of [-1, 1]) {
      const hand = blob(m.gaiter, v(0, 0, 0), v(0.069, 0.09, 0.065));
      this.#arms.push({
        end: hand,
        lower: segment(m.coat, 0.084, 0.3),
        side,
        upper: segment(m.coat, 0.105, 0.32),
      });
      const boot = new Group();
      this.root.add(boot);
      blob(m.rubber, v(0, -0.09, 0), v(0.145, 0.047, 0.259), boot);
      blob(m.boot, v(0, -0.025, 0.048), v(0.138, 0.086, 0.202), boot);
      blob(m.boot, v(0, 0.038, -0.09), v(0.118, 0.145, 0.142), boot);
      blob(m.rubber, v(0, -0.015, 0.183), v(0.132, 0.064, 0.073), boot);
      const cuff = new Mesh(new CylinderGeometry(0.095, 0.117, 0.18, 16), m.gaiter);
      cuff.position.set(0, 0.143, -0.066);
      cuff.castShadow = true;
      boot.add(cuff);
      blob(m.snowCap, v(0.02, 0.055, 0.16), v(0.074, 0.015, 0.046), boot);
      this.#legs.push({
        end: boot,
        lower: segment(m.pants, 0.092, 0.475),
        side,
        upper: segment(m.pants, 0.113, 0.475),
      });
    }
    // The torso, hood and boots never bend internally, so each becomes one mesh per material:
    // dozens of primitives as separate draws cost more than the whole snowfield.
    for (const group of [torso, head, ...this.#legs.map((leg) => leg.end as Group)])
      mergeRigid(group);
  }

  #place(segment: ISegment, from: Point, to: Point): void {
    scratchA.set(from.x, from.y, from.z);
    scratchB.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = scratchB.length();
    segment.mesh.position.copy(scratchA).addScaledVector(scratchB, 0.5);
    segment.mesh.quaternion.setFromUnitVectors(UP, scratchB.normalize());
    segment.mesh.scale.y = length / segment.length;
  }

  /**
   * Pose the body at `position` facing `heading`, with each boot where the gait put it.
   * `cycle` drives the arm swing and torso sway; `speed` scales them.
   */
  pose(
    position: Point,
    heading: number,
    feet: readonly IFootPose[],
    cycle: number,
    speed: number,
    elapsed: number,
  ): void {
    this.root.position.set(position.x, position.y, position.z);
    this.root.rotation.y = heading;
    const gait = Math.sin(cycle * Math.PI * 2);
    const motion = Math.min(1, speed);
    this.#torso.rotation.z = gait * 0.022 * motion;
    this.#torso.rotation.x = speed * 0.022;
    this.#head.rotation.y = Math.sin(elapsed * 0.45) * 0.055 * (1 - motion * 0.6);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    for (const [index, leg] of this.#legs.entries()) {
      const foot = feet[index];
      if (foot === undefined) continue;
      const dx = foot.x - position.x;
      const dz = foot.z - position.z;
      const ankle = { x: dx * cos - dz * sin, y: foot.y - position.y, z: dx * sin + dz * cos };
      const hip = { x: leg.side * 0.145, y: 0.935, z: -0.014 };
      const knee = solveKnee(hip, ankle, 0.475, 0.475, { x: leg.side * 0.08, y: 0, z: 1 });
      this.#place(leg.upper, hip, knee);
      this.#place(leg.lower, knee, ankle);
      leg.end.position.set(ankle.x, ankle.y, ankle.z);
      leg.end.rotation.set(
        foot.swing ? Math.sin(foot.progress * Math.PI * 2) * 0.2 : 0,
        foot.angle - heading,
        0,
      );
    }
    for (const arm of this.#arms) {
      const swing = gait * arm.side * motion;
      const shoulder = { x: arm.side * 0.287, y: 1.49, z: 0 };
      const elbow = { x: arm.side * 0.376, y: 1.215, z: swing * 0.13 - 0.035 };
      const hand = {
        x: arm.side * 0.397,
        y: 0.976 + Math.abs(swing) * 0.027,
        z: swing * 0.23 + 0.055,
      };
      this.#place(arm.upper, shoulder, elbow);
      this.#place(arm.lower, elbow, hand);
      arm.end.position.set(hand.x, hand.y - 0.031, hand.z);
    }
  }
}
