import {
  type Camera,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
  type Vector3,
} from "three";

const BURSTS = 14;
const BURST_TIME = 0.55;
const burstMaterial = new MeshBasicMaterial({ color: 0xffb36b });
const burstGeometry = new SphereGeometry(1, 12, 8);

/** Explosions and hit sparks: a ring of balls that swell and shrink, shared geometry and material. */
export class Bursts {
  readonly group = new Group();
  readonly #meshes: Mesh[] = [];
  readonly #age: number[] = [];
  readonly #size: number[] = [];
  #next = 0;

  constructor() {
    this.group.name = "bursts";
    for (let index = 0; index < BURSTS; index += 1) {
      const mesh = new Mesh(burstGeometry, burstMaterial);
      mesh.visible = false;
      this.group.add(mesh);
      this.#meshes.push(mesh);
      this.#age.push(BURST_TIME);
      this.#size.push(1);
    }
  }

  /** The oldest slot is reused when all are busy. */
  spawn(at: Vector3, size: number): void {
    const index = this.#next;
    this.#next = (this.#next + 1) % BURSTS;
    this.#meshes[index]?.position.copy(at);
    this.#age[index] = 0;
    this.#size[index] = size;
  }

  update(dt: number): void {
    for (const [index, mesh] of this.#meshes.entries()) {
      const age = (this.#age[index] ?? BURST_TIME) + dt;
      this.#age[index] = age;
      mesh.visible = age < BURST_TIME;
      if (mesh.visible)
        mesh.scale.setScalar((this.#size[index] ?? 1) * Math.sin((age / BURST_TIME) * Math.PI));
    }
  }
}

const overlay = (color: number): MeshBasicMaterial =>
  new MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
  });

/** The reticle ahead of the nose and the brackets around the marked target. Both face the camera. */
export class Sights {
  readonly reticle = new Group();
  readonly mark = new Group();

  constructor() {
    this.reticle.name = "reticle";
    this.mark.name = "lock-mark";
    const ring = (inner: number, outer: number, material: MeshBasicMaterial): Mesh => {
      const mesh = new Mesh(new RingGeometry(inner, outer, 32), material);
      mesh.renderOrder = 10;
      return mesh;
    };
    const blue = overlay(0x7fd0ff);
    this.reticle.add(ring(1.05, 1.2, blue), ring(0.1, 0.2, blue));
    const red = overlay(0xff8a4d);
    this.mark.add(ring(0.9, 1, red), ring(0.5, 0.56, red));
    this.mark.visible = false;
  }

  face(camera: Camera): void {
    this.reticle.quaternion.copy(camera.quaternion);
    this.mark.quaternion.copy(camera.quaternion);
  }
}
