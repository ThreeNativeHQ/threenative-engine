// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The items: a banana peel, a green shell, and the rows of rainbow item boxes. The boxes are two
// instanced meshes, a see-through rainbow cube round a glowing core, so twelve boxes are two draw
// calls. A taken box shrinks to nothing and grows back when `Race.ts` says it has respawned.
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  type Group,
  InstancedMesh,
  Mesh,
  Object3D,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import type { ICourse } from "../track/Course.js";
import { at, lit, merge, paint } from "./materials.js";
import { C } from "./palette.js";

/** A peel lying on the road: a yellow arc, brown tips, three limp flaps. */
export function bananaMesh(): Mesh {
  const mesh = new Mesh(
    merge([
      paint(new TorusGeometry(0.3, 0.09, 6, 12, 2.3), C.banana, at(0, 0.1, 0, Math.PI / 2, 0, 0.4), 0.3),
      paint(new SphereGeometry(0.06, 6, 4), C.bananaTip, at(0.27, 0.12, 0.1)),
      paint(new SphereGeometry(0.06, 6, 4), C.bananaTip, at(-0.21, 0.1, 0.22)),
      ...[0, 2.1, 4.2].map((a) =>
        paint(new BoxGeometry(0.14, 0.03, 0.3), C.banana, at(Math.cos(a) * 0.12 - 0.3, 0.05, Math.sin(a) * 0.12, 0, a, 0.4)),
      ),
    ]),
    lit({ roughness: 0.5 }),
  );
  mesh.castShadow = true;
  return mesh;
}

/** A green shell: a dome with a white rim and pale plates. */
export function shellMesh(): Mesh {
  const mesh = new Mesh(
    merge([
      paint(new SphereGeometry(0.4, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), C.shell, at(0, 0.08, 0, 0, 0, 0, 1, 0.8, 1), 0.4),
      paint(new TorusGeometry(0.38, 0.08, 6, 18), C.shellRim, at(0, 0.08, 0, Math.PI / 2)),
      ...[0, 1, 2, 3, 4].map((i) =>
        paint(new SphereGeometry(0.1, 6, 4), C.shellRim, at(Math.cos((i * Math.PI * 2) / 5) * 0.24, 0.3, Math.sin((i * Math.PI * 2) / 5) * 0.24, 0, 0, 0, 1, 0.35, 1)),
      ),
    ]),
    lit({ roughness: 0.35 }),
  );
  mesh.castShadow = true;
  return mesh;
}

/** The rows of item boxes on the course. */
export class ItemBoxes {
  /** World position of each box, row by row, four abreast. */
  readonly spots: { x: number; y: number; z: number }[] = [];
  readonly #shells: InstancedMesh;
  readonly #cores: InstancedMesh;
  readonly #scale: number[] = [];
  readonly #dummy = new Object3D();

  constructor(course: ICourse, group: Group, lanes: readonly number[] = [-4.5, -1.5, 1.5, 4.5]) {
    for (const row of course.boxes) {
      for (const lateral of lanes) {
        const p = { x: 0, y: 0, z: 0 };
        course.pointAt(row, lateral, p);
        p.y += 1.1;
        this.spots.push(p);
        this.#scale.push(1);
      }
    }
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
    this.#shells = new InstancedMesh(
      cube,
      lit({ emissive: 0xffffff, emissiveIntensity: 0.12, opacity: 0.62, roughness: 0.2, transparent: true }),
      this.spots.length,
    );
    this.#cores = new InstancedMesh(
      paint(new OctahedronGeometry(0.34, 0), C.white),
      lit({ emissive: C.boxC, emissiveIntensity: 1.4, roughness: 0.3 }),
      this.spots.length,
    );
    this.#shells.name = "item-boxes";
    this.#cores.name = "item-box-cores";
    this.#shells.castShadow = true;
    group.add(this.#shells, this.#cores);
    this.update(0, () => true);
  }

  /** Spins and bobs the boxes; a box that is not `ready` shrinks away, then grows back. */
  update(time: number, ready: (box: number) => boolean, dt = 1): void {
    const d = this.#dummy;
    this.spots.forEach((spot, i) => {
      const target = ready(i) ? 1 : 0;
      const scale = this.#scale[i]! + (target - this.#scale[i]!) * Math.min(1, dt * 8);
      this.#scale[i] = scale;
      d.position.set(spot.x, spot.y + Math.sin(time * 2.2 + i) * 0.12, spot.z);
      d.rotation.set(0.5, time * 1.6 + i * 0.7, 0.6);
      d.scale.setScalar(Math.max(1e-3, scale));
      d.updateMatrix();
      this.#shells.setMatrixAt(i, d.matrix);
      d.rotation.set(0, -time * 2.4, 0);
      d.updateMatrix();
      this.#cores.setMatrixAt(i, d.matrix);
    });
    this.#shells.instanceMatrix.needsUpdate = true;
    this.#cores.instanceMatrix.needsUpdate = true;
  }
}
