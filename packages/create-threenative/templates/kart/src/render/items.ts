// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The items: a banana peel, a green shell, and the rows of rainbow item boxes, each a see-through
// rainbow cube round a glowing core. A taken box shrinks to nothing and grows back when `Race.ts`
// says it has respawned.
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  type Group,
  Mesh,
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
      paint(
        new TorusGeometry(0.3, 0.09, 6, 12, 2.3),
        C.banana,
        at(0, 0.1, 0, Math.PI / 2, 0, 0.4),
        0.3,
      ),
      paint(new SphereGeometry(0.06, 6, 4), C.bananaTip, at(0.27, 0.12, 0.1)),
      paint(new SphereGeometry(0.06, 6, 4), C.bananaTip, at(-0.21, 0.1, 0.22)),
      ...[0, 2.1, 4.2].map((a) =>
        paint(
          new BoxGeometry(0.14, 0.03, 0.3),
          C.banana,
          at(Math.cos(a) * 0.12 - 0.3, 0.05, Math.sin(a) * 0.12, 0, a, 0.4),
        ),
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
      paint(
        new SphereGeometry(0.4, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        C.shell,
        at(0, 0.08, 0, 0, 0, 0, 1, 0.8, 1),
        0.4,
      ),
      paint(new TorusGeometry(0.38, 0.08, 6, 18), C.shellRim, at(0, 0.08, 0, Math.PI / 2)),
      ...[0, 1, 2, 3, 4].map((i) =>
        paint(
          new SphereGeometry(0.1, 6, 4),
          C.shellRim,
          at(
            Math.cos((i * Math.PI * 2) / 5) * 0.24,
            0.3,
            Math.sin((i * Math.PI * 2) / 5) * 0.24,
            0,
            0,
            0,
            1,
            0.35,
            1,
          ),
        ),
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
  readonly #shells: Mesh[] = [];
  readonly #cores: Mesh[] = [];
  readonly #scale: number[] = [];

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
    const shell = lit({
      emissive: 0xffffff,
      emissiveIntensity: 0.12,
      opacity: 0.62,
      roughness: 0.2,
      transparent: true,
    });
    const coreGeometry = paint(new OctahedronGeometry(0.34, 0), C.white);
    const core = lit({ emissive: C.boxC, emissiveIntensity: 1.4, roughness: 0.3 });
    for (const row of course.boxes) {
      for (const lateral of lanes) {
        const p = { x: 0, y: 0, z: 0 };
        course.pointAt(row, lateral, p);
        p.y += 1.1;
        this.spots.push(p);
        this.#scale.push(1);
        // One mesh per box, not an instanced row: the owned Wasm engine draws an InstancedMesh's
        // first matrices but not later setMatrixAt writes, so instanced boxes never spun or shrank.
        const box = new Mesh(cube, shell);
        box.name = "item-box";
        box.castShadow = true;
        const glow = new Mesh(coreGeometry, core);
        glow.name = "item-box-core";
        this.#shells.push(box);
        this.#cores.push(glow);
        group.add(box, glow);
      }
    }
    this.update(0, () => true);
  }

  /**
   * Spins and bobs the boxes; a box that is not `ready` shrinks away, then grows back. A box within
   * 4.5 m of `eye` (the camera) shrinks too, so the chase camera never flies through one.
   */
  update(
    time: number,
    ready: (box: number) => boolean,
    dt = 1,
    eye?: { x: number; y: number; z: number },
  ): void {
    this.spots.forEach((spot, i) => {
      const box = this.#shells[i];
      const glow = this.#cores[i];
      if (box === undefined || glow === undefined) return;
      const target = ready(i) ? 1 : 0;
      const scale = (this.#scale[i] ?? 0) + (target - (this.#scale[i] ?? 0)) * Math.min(1, dt * 8);
      this.#scale[i] = scale;
      const near = eye ? Math.hypot(spot.x - eye.x, spot.y - eye.y, spot.z - eye.z) : 9;
      const size = scale * Math.min(1, Math.max(0, (near - 2.5) / 2));
      box.visible = glow.visible = size > 0.01;
      if (!box.visible) return;
      const y = spot.y + Math.sin(time * 2.2 + i) * 0.12;
      box.position.set(spot.x, y, spot.z);
      box.rotation.set(0.5, time * 1.6 + i * 0.7, 0.6);
      box.scale.setScalar(size);
      glow.position.set(spot.x, y, spot.z);
      glow.rotation.set(0, -time * 2.4, 0);
      glow.scale.setScalar(size);
    });
  }
}
