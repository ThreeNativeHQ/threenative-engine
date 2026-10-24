// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Skid marks: dark rubber dashes laid behind the rear tyres in a drift, one instanced mesh in a
// ring, so the oldest mark is reused when the ring is full. One draw call for the whole field.
import { type Group, InstancedMesh, MeshStandardMaterial, Object3D, PlaneGeometry } from "three";
import { C } from "./palette.js";

export class SkidMarks {
  readonly #mesh: InstancedMesh;
  readonly #dummy = new Object3D();
  #next = 0;
  /** The latest end of each live trail, 32 at most; the oldest is reused. */
  readonly #ends: { x: number; y: number; z: number }[] = [];
  #nextEnd = 0;
  laid = 0;

  constructor(
    group: Group,
    readonly capacity = 900,
  ) {
    const material = new MeshStandardMaterial({
      color: C.tyre,
      depthWrite: false,
      opacity: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      roughness: 0.9,
      transparent: true,
    });
    // One metre long, scaled to each segment, so a trail's segments meet end to end.
    this.#mesh = new InstancedMesh(
      new PlaneGeometry(0.26, 1).rotateX(-Math.PI / 2),
      material,
      capacity,
    );
    // A fixed count, with the unused dashes at zero scale: the ring only rewrites matrices, so the
    // draw never changes size while the race runs.
    const hidden = new Object3D();
    hidden.scale.setScalar(0);
    hidden.updateMatrix();
    for (let i = 0; i < capacity; i += 1) this.#mesh.setMatrixAt(i, hidden.matrix);
    this.#mesh.name = "skid-marks";
    this.#mesh.frustumCulled = false;
    group.add(this.#mesh);
  }

  /**
   * A mark up to a tyre's contact point. It joins the nearest trail end up to 1.5 m behind it, so the trail
   * is one strip: overlapping see-through dashes darkened every joint into a bar. A new trail
   * starts with a short dash along `yaw`.
   */
  lay(x: number, y: number, z: number, yaw: number): void {
    let from: { x: number; y: number; z: number } | undefined;
    let best = 1.5 * 1.5;
    const ahead = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    for (const end of this.#ends) {
      const gap = (end.x - x) ** 2 + (end.z - z) ** 2;
      // Only an end behind this tyre along its travel: the other tyre, or a kart alongside, sits
      // across the travel and would draw a zigzag.
      const along = ((x - end.x) * ahead.x + (z - end.z) * ahead.z) / Math.sqrt(gap);
      if (gap > 0.0001 && gap < best && along > 0.87) {
        best = gap;
        from = end;
      }
    }
    const d = this.#dummy;
    if (from === undefined) {
      d.position.set(x, y + 0.03, z);
      d.rotation.set(0, yaw, 0);
      d.scale.set(1, 1, 0.3);
      from = { x, y, z };
      this.#ends[this.#nextEnd] = from;
      this.#nextEnd = (this.#nextEnd + 1) % 32;
    } else {
      d.position.set((x + from.x) / 2, (y + from.y) / 2 + 0.03, (z + from.z) / 2);
      d.rotation.set(0, Math.atan2(-(x - from.x), -(z - from.z)), 0);
      d.scale.set(1, 1, Math.sqrt(best));
      from.x = x;
      from.y = y;
      from.z = z;
    }
    d.updateMatrix();
    this.#mesh.setMatrixAt(this.#next, d.matrix);
    this.#next = (this.#next + 1) % this.capacity;
    this.#mesh.instanceMatrix.needsUpdate = true;
    this.laid += 1;
  }
}
