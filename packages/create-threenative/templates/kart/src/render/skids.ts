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
  laid = 0;

  constructor(
    group: Group,
    readonly capacity = 900,
  ) {
    const material = new MeshStandardMaterial({
      color: C.tyre,
      depthWrite: false,
      opacity: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      roughness: 0.9,
      transparent: true,
    });
    this.#mesh = new InstancedMesh(
      new PlaneGeometry(0.26, 0.7).rotateX(-Math.PI / 2),
      material,
      capacity,
    );
    this.#mesh.count = 0;
    this.#mesh.name = "skid-marks";
    this.#mesh.frustumCulled = false;
    group.add(this.#mesh);
  }

  /** One dash at a tyre's contact point, along the kart's heading. */
  lay(x: number, y: number, z: number, yaw: number): void {
    const d = this.#dummy;
    d.position.set(x, y + 0.03, z);
    d.rotation.set(0, yaw, 0);
    d.updateMatrix();
    this.#mesh.setMatrixAt(this.#next, d.matrix);
    this.#next = (this.#next + 1) % this.capacity;
    this.#mesh.count = Math.min(this.capacity, this.#mesh.count + 1);
    this.#mesh.instanceMatrix.needsUpdate = true;
    this.laid += 1;
  }
}
