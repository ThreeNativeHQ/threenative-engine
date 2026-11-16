// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Skid marks: a dark rubber strip behind each rear tyre in a slide or under a locked brake, one
// segment per mark in an instanced ring, so the oldest mark is reused when the ring is full. One
// draw call for the whole field.
import { Color, InstancedMesh, MeshStandardMaterial, Object3D, PlaneGeometry } from "three";

/** The tarmac and the tyre, as `materials.ts` paints them. */
const ROAD = 0x4a4a4a;
const TYRE = 0x1a1d22;

export class SkidMarks {
  readonly #mesh: InstancedMesh;
  readonly #dummy = new Object3D();
  #next = 0;
  /** Where each tyre's trail ends, by the key the race lays it under. */
  readonly #ends = new Map<string, { x: number; y: number; z: number }>();
  laid = 0;

  constructor(
    group: Object3D,
    readonly capacity = 6000,
  ) {
    // Opaque rubber, most of the way from the tarmac to the tyre: see-through strips darkened
    // wherever two trails crossed or two segments met, and a line read as a brick pattern.
    const material = new MeshStandardMaterial({
      color: new Color(ROAD).lerp(new Color(TYRE), 0.72),
      polygonOffset: true,
      polygonOffsetFactor: -2,
      roughness: 0.9,
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
    this.#mesh.receiveShadow = true;
    group.add(this.#mesh);
  }

  /**
   * A mark from where this tyre's trail ends up to its contact point, so the trail is one strip
   * whose segments meet end to end: a trail joined by nearness alone jumped to the next tyre and laid a zigzag.
   * A trail end more than 4 m away starts a new trail (a car on nitro covers 0.4 m between
   * two marks), and a new trail lays nothing yet.
   */
  lay(trail: string, x: number, y: number, z: number): void {
    const from = this.#ends.get(trail);
    const gap =
      from === undefined ? Number.POSITIVE_INFINITY : (x - from.x) ** 2 + (z - from.z) ** 2;
    if (from === undefined || gap > 4 * 4) {
      this.#ends.set(trail, { x, y, z });
      return;
    }
    // Half a metre a segment: 6 000 of them is three kilometres of rubber before the ring reuses.
    if (gap < 0.5 * 0.5) return;
    const d = this.#dummy;
    // Pitched along the road, not flat: a level segment on a slope sinks one half under the
    // asphalt, and the trail reads as dashes.
    d.position.set((x + from.x) / 2, (y + from.y) / 2 + 0.03, (z + from.z) / 2);
    d.lookAt(x, y + 0.03, z);
    d.scale.set(1, 1, Math.hypot(Math.sqrt(gap), y - from.y));
    from.x = x;
    from.y = y;
    from.z = z;
    d.updateMatrix();
    this.#mesh.setMatrixAt(this.#next, d.matrix);
    this.#next = (this.#next + 1) % this.capacity;
    this.#mesh.instanceMatrix.needsUpdate = true;
    this.laid += 1;
  }
}
