// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The items: a burr, an acorn, and the rows of rainbow item boxes. The boxes are two
// instanced meshes, a see-through rainbow cube round a glowing core, so every box is two draw
// calls in all. A taken box shrinks to nothing and grows back when `Race.ts` says it has respawned.
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  type Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import type { ICourse } from "../track/Course.js";
import { at, lit, merge, paint } from "./materials.js";
import { C } from "./palette.js";

/** Spike directions: the twelve corners of an icosahedron, so the spikes stand evenly. */
const SPIKES = new IcosahedronGeometry(1, 0).getAttribute("position");
const spikeAxes = Array.from({ length: SPIKES.count }, (_, i) =>
  new Vector3().fromBufferAttribute(SPIKES, i).normalize(),
).filter((axis, i, all) => all.findIndex((other) => other.distanceTo(axis) < 1e-3) === i);

/**
 * A burr dropped on the road: a round seed head bristling with pale hooked spikes, the size of a
 * football so it reads from the chase camera. Shared by every burr.
 */
const BURR = merge([
  paint(new IcosahedronGeometry(0.24, 1), C.burr, at(0, 0.34, 0), 0.35),
  ...spikeAxes.map((axis) =>
    paint(
      new ConeGeometry(0.06, 0.22, 5),
      C.burrTip,
      new Matrix4().compose(
        axis
          .clone()
          .multiplyScalar(0.3)
          .add(new Vector3(0, 0.34, 0)),
        new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis),
        new Vector3(1, 1, 1),
      ),
    ),
  ),
]);

/**
 * An acorn rolled up the road: a tan nut under a dark scaly cap with a stub of stalk, upright and
 * spinning as it runs. Shared by every acorn.
 */
const ACORN = merge([
  paint(new SphereGeometry(0.28, 14, 10), C.acorn, at(0, 0.36, 0, 0, 0, 0, 1, 1.25, 1), 0.3),
  paint(
    new SphereGeometry(0.31, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    C.acornCap,
    at(0, 0.52, 0, 0, 0, 0, 1, 0.7, 1),
    0.4,
  ),
  paint(new CylinderGeometry(0.04, 0.05, 0.16, 6), C.acornCap, at(0, 0.78, 0, 0, 0, 0.3)),
]);

export function burrMesh(): Mesh {
  const mesh = new Mesh(BURR, lit({ roughness: 0.8 }));
  mesh.castShadow = true;
  return mesh;
}

export function acornMesh(): Mesh {
  const mesh = new Mesh(ACORN, lit({ roughness: 0.55 }));
  mesh.castShadow = true;
  return mesh;
}

/** The rows of item boxes on the course. */
export class ItemBoxes {
  /** World position of each box, row by row, four abreast. */
  readonly spots: { x: number; y: number; z: number }[] = [];
  readonly #cubes: InstancedMesh;
  readonly #cores: InstancedMesh;
  readonly #scale: number[] = [];
  readonly #dummy = new Object3D();

  constructor(course: ICourse, group: Group, lanes: readonly number[] = [-4.5, -1.5, 1.5, 4.5]) {
    // Each face of the cube one of three colours, so it reads as a rainbow while it turns.
    const cube = new BoxGeometry(1.15, 1.15, 1.15).toNonIndexed();
    const faces = [C.boxA, C.boxB, C.boxC, C.boxA, C.boxB, C.boxC];
    const colours = new Float32Array(cube.getAttribute("position").count * 3);
    const tint = new Color();
    for (let v = 0; v < colours.length / 3; v += 1) {
      tint.set(faces[Math.floor(v / 6)] ?? C.white);
      colours.set([tint.r, tint.g, tint.b], v * 3);
    }
    cube.setAttribute("color", new BufferAttribute(colours, 3));
    for (const row of course.boxes) {
      for (const lateral of lanes) {
        const p = { x: 0, y: 0, z: 0 };
        course.pointAt(row, lateral, p);
        p.y += 1.1;
        this.spots.push(p);
        this.#scale.push(1);
      }
    }
    this.#cubes = new InstancedMesh(
      cube,
      lit({
        emissive: 0xffffff,
        emissiveIntensity: 0.12,
        opacity: 0.62,
        roughness: 0.2,
        transparent: true,
      }),
      this.spots.length,
    );
    this.#cores = new InstancedMesh(
      paint(new OctahedronGeometry(0.34, 0), C.white),
      lit({ emissive: C.boxC, emissiveIntensity: 1.4, roughness: 0.3 }),
      this.spots.length,
    );
    this.#cubes.name = "item-boxes";
    this.#cores.name = "item-box-cores";
    this.#cubes.castShadow = true;
    group.add(this.#cubes, this.#cores);
    this.update(0, () => true);
  }

  /**
   * Spins and bobs the boxes; a box that is not `ready` shrinks away, then grows back. A box within
   * 6.5 m of `eye` (the camera) shrinks too, gone by 3.5 m, so the chase camera never flies through one.
   */
  update(
    time: number,
    ready: (box: number) => boolean,
    dt = 1,
    eye?: { x: number; y: number; z: number },
  ): void {
    const d = this.#dummy;
    this.spots.forEach((spot, i) => {
      const target = ready(i) ? 1 : 0;
      const scale = (this.#scale[i] ?? 0) + (target - (this.#scale[i] ?? 0)) * Math.min(1, dt * 8);
      this.#scale[i] = scale;
      const near = eye ? Math.hypot(spot.x - eye.x, spot.y - eye.y, spot.z - eye.z) : 9;
      d.position.set(spot.x, spot.y + Math.sin(time * 2.2 + i) * 0.12, spot.z);
      d.rotation.set(0.5, time * 1.6 + i * 0.7, 0.6);
      d.scale.setScalar(Math.max(1e-3, scale * Math.min(1, Math.max(0, (near - 3.5) / 3))));
      d.updateMatrix();
      this.#cubes.setMatrixAt(i, d.matrix);
      d.rotation.set(0, -time * 2.4, 0);
      d.updateMatrix();
      this.#cores.setMatrixAt(i, d.matrix);
    });
    this.#cubes.instanceMatrix.needsUpdate = true;
    this.#cores.instanceMatrix.needsUpdate = true;
  }
}
