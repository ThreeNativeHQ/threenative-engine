import {
  type BufferGeometry,
  DataTexture,
  DoubleSide,
  Euler,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  type Texture,
  UnsignedByteType,
  Vector3,
} from "three";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";

/**
 * Bullet holes, and any other flat mark a game wants to leave stuck to a wall.
 *
 * ## Why the marks have to persist
 *
 * A hole that fades after half a second is worse than no hole: the player learns their rounds
 * land nowhere. So the pool is large — a couple of hundred marks, recycled round-robin — and the
 * oldest quietly gives up its slot rather than every mark expiring on a timer.
 *
 * ## Why plain meshes and not an `InstancedMesh`
 *
 * One instanced draw call is the obvious implementation, and it does not draw at all here. This
 * engine does not hand the renderer the authored scene; it maintains a mirror of it
 * (`SceneRenderProjection`), and an `InstancedMesh` goes into that mirror's "exact lane" as a
 * shallow proxy. Marks written into the source's instance buffer never reached the screen —
 * verified with an opaque red probe at four times the size, which was equally invisible while the
 * placement counter climbed and the logged positions were correct.
 *
 * Each slot gets its own cloned material, and that is deliberate rather than wasteful. The mirror
 * batches renderables that share a geometry *and* a material into an `InstancedMesh` of its own —
 * straight back into the path that does not draw. A distinct material per slot keeps every mark on
 * the mirror's exact lane, which does. Splitting the pool by variant on top of that is what gives a
 * hole in steel a colder rim than one in wood.
 *
 * ## The offset
 *
 * A decal sitting exactly on the wall z-fights with it, and the artefact is a shimmering ring
 * that reads as a rendering bug rather than a hole. Every mark is pushed `offset` metres along
 * the surface normal instead — `polygonOffset` is the usual answer and it is not dependable
 * across WebGPU pipelines.
 */

/** Deterministic value noise, so a rebuilt texture is byte-identical between runs. */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * One bullet hole: a punched dark core, a bright rim of powdered surface around it, and a few
 * spall streaks running out from the edge. The streaks are what stop it reading as a sticker —
 * a perfect circle on a wall is a dot, and an irregular one is damage.
 */
export function bulletHoleTexture(size = 128): Texture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  // Eight streaks of uneven reach, seeded off fixed constants so the mark is the same every run.
  const streaks = Array.from({ length: 8 }, (_, index) => ({
    angle: (index / 8) * Math.PI * 2 + hash(index, 3) * 0.6,
    reach: 0.5 + hash(index, 7) * 0.34,
    width: 0.06 + hash(index, 11) * 0.09,
  }));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = (x - centre) / centre;
      const py = (y - centre) / centre;
      const radius = Math.sqrt(px * px + py * py);
      const angle = Math.atan2(py, px);
      // Grain keeps the rim from reading as an airbrushed ring.
      const grain = 0.82 + hash(Math.floor(x * 0.7), Math.floor(y * 0.7)) * 0.36;

      let alpha = 0;
      let shade = 0;
      const core = 0.34 * grain;
      const rim = 0.56 * grain;
      if (radius < core) {
        // The hole itself: opaque, and dark rather than pure black so it takes the fog.
        alpha = 1;
        shade = 0.05 + radius * 0.1;
      } else if (radius < rim) {
        // Crushed surface around the entry — the brightest part of a real bullet hole.
        const t = (radius - core) / Math.max(1e-4, rim - core);
        alpha = 1 - t * 0.3;
        shade = 0.22 + t * 0.7;
      } else if (radius < 1) {
        // Dust halo, thinning fast.
        const t = (radius - rim) / (1 - rim);
        alpha = Math.max(0, (1 - t) ** 2.2) * 0.55 * grain;
        shade = 0.78;
      }

      for (const streak of streaks) {
        let delta = Math.abs(angle - streak.angle);
        if (delta > Math.PI) delta = Math.PI * 2 - delta;
        if (radius <= core || radius > streak.reach) continue;
        const across = delta / streak.width;
        if (across > 1) continue;
        const along = 1 - (radius - core) / Math.max(1e-4, streak.reach - core);
        const strength = (1 - across) ** 1.5 * along ** 1.1;
        alpha = Math.max(alpha, strength * 0.9);
        shade = Math.min(shade, 0.14 + (1 - strength) * 0.55);
      }

      const index = (y * size + x) * 4;
      const value = Math.round(Math.min(1, shade) * 255);
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

const FORWARD = new Vector3(0, 0, 1);
// Scratch for `place`; the fire path must not allocate.
const scratchQuaternion = new Quaternion();
const scratchRoll = new Quaternion();
const scratchNormal = new Vector3();

type DecalMesh = Mesh<BufferGeometry, MeshBasicMaterial>;
type DecalFade = { duration: number; opacity: (progress: number) => number };

function fadeOpacity(fade: DecalFade, progress: number): number {
  const opacity = fade.opacity(progress);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new Error("Invalid decal opacity: the authored curve must return a value in [0, 1].");
  return opacity;
}

/** Projection is deliberately limited to static opaque triangles under rigid/uniform transforms. */
function validateReceiver(receiver: Mesh, geometry: BufferGeometry): void {
  const kind = receiver as Mesh & {
    isSkinnedMesh?: boolean;
    isInstancedMesh?: boolean;
    isBatchedMesh?: boolean;
  };
  const materials = Array.isArray(receiver.material) ? receiver.material : [receiver.material];
  const unsupportedMaterial = materials.some((material) => {
    const custom = material as typeof material & {
      isShaderMaterial?: boolean;
      displacementMap?: Texture | null;
      positionNode?: unknown;
      vertexNode?: unknown;
      transmission?: number;
    };
    return (
      material.transparent ||
      material.opacity !== 1 ||
      material.alphaTest > 0 ||
      material.alphaHash ||
      custom.isShaderMaterial ||
      custom.displacementMap != null ||
      custom.positionNode != null ||
      custom.vertexNode != null ||
      (custom.transmission ?? 0) > 0
    );
  });
  if (
    !receiver.isMesh ||
    kind.isSkinnedMesh ||
    kind.isInstancedMesh ||
    kind.isBatchedMesh ||
    receiver.userData.deforming === true ||
    unsupportedMaterial ||
    Object.values(geometry.morphAttributes).some((attributes) => attributes.length > 0) ||
    Object.values(receiver.geometry.morphAttributes).some((attributes) => attributes.length > 0)
  ) {
    throw new Error("Unsupported receiver: decals require a static, opaque, non-instanced mesh.");
  }
  receiver.updateWorldMatrix(true, false);
  const matrix = receiver.matrixWorld;
  const x = new Vector3().setFromMatrixColumn(matrix, 0);
  const y = new Vector3().setFromMatrixColumn(matrix, 1);
  const z = new Vector3().setFromMatrixColumn(matrix, 2);
  const length = x.lengthSq();
  const tolerance = length * 1e-6;
  if (
    !matrix.elements.every(Number.isFinite) ||
    matrix.determinant() <= 0 ||
    length === 0 ||
    Math.abs(y.lengthSq() - length) > tolerance ||
    Math.abs(z.lengthSq() - length) > tolerance ||
    Math.abs(x.dot(y)) > tolerance ||
    Math.abs(x.dot(z)) > tolerance ||
    Math.abs(y.dot(z)) > tolerance
  ) {
    throw new Error(
      "Unsupported receiver: decals require a rigid or positive uniform-scale transform.",
    );
  }
  const position = geometry.getAttribute("position");
  const count = geometry.index?.count ?? position?.count ?? 0;
  if (
    position === undefined ||
    position.itemSize !== 3 ||
    count % 3 !== 0 ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Number.POSITIVE_INFINITY
  ) {
    throw new Error("Unsupported receiver: decals require complete triangle geometry.");
  }
}

/** Keep upstream clipping/UVs, but do not paint a thin receiver's reverse-facing triangles. */
function frontFaces(geometry: BufferGeometry, normal: Vector3): number[] {
  const position = geometry.getAttribute("position");
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const indices: number[] = [];
  for (let index = 0; index < position.count; index += 3) {
    a.fromBufferAttribute(position, index);
    b.fromBufferAttribute(position, index + 1).sub(a);
    c.fromBufferAttribute(position, index + 2).sub(a);
    if (b.cross(c).dot(normal) > 0) indices.push(index, index + 1, index + 2);
  }
  return indices;
}

/** One family of marks: its own material, its own slots, its own recycle cursor. */
type Variant = {
  readonly slots: DecalMesh[];
  readonly material: MeshBasicMaterial;
  cursor: number;
};

export class DecalField<TVariant extends string> {
  readonly #variants = new Map<TVariant, Variant>();
  readonly #geometry: PlaneGeometry;
  readonly #parent: Object3D;
  readonly #size: number;
  readonly #projected = new Map<
    DecalMesh,
    { receiver: Mesh; removed: () => void; elapsed: number; fade?: DecalFade }
  >();
  readonly #offset: number;
  #placed = 0;
  #capacity = 0;
  #disposed = false;
  /** Slots stop being submitted once their pipeline exists. See `settle`. */
  #settled = false;

  constructor(
    parent: Object3D,
    options: {
      /** Slots per variant. Every variant gets the same budget. */
      countPerVariant: number;
      /** Edge length of one mark in metres, before the per-place scale multiplier. */
      size: number;
      /** Borrowed: the caller retains ownership and disposes this after its last user. */
      map: Texture;
      /** Tint per variant: a hole in steel keeps a colder rim than one in wood. */
      tints: Readonly<Record<TVariant, number>>;
      /** Metres along the surface normal, to clear the wall it is stuck to. */
      offset?: number;
      renderOrder?: number;
    },
  ) {
    this.#parent = parent;
    this.#size = options.size;
    this.#offset = options.offset ?? 0.018;
    this.#geometry = new PlaneGeometry(options.size, options.size);
    for (const [name, tint] of Object.entries(options.tints) as [TVariant, number][]) {
      const material = new MeshBasicMaterial({
        color: tint,
        depthWrite: false,
        map: options.map,
        // A hole punched through a thin prop should read from behind it too, and back-face
        // culling on a single quad is the difference between a mark and a mark that blinks out.
        side: DoubleSide,
        transparent: true,
      });
      const slots: DecalMesh[] = [];
      for (let index = 0; index < options.countPerVariant; index += 1) {
        const mesh = new Mesh(this.#geometry, material.clone());
        // Present from the first frame at a size nothing can see, so this material's pipeline is
        // built during loading rather than on the frame the first round lands.
        mesh.scale.setScalar(0.0001);
        mesh.visible = true;
        // Marks scatter across the whole town and each is smaller than a hand; the per-mesh
        // cull test costs more than drawing it.
        mesh.frustumCulled = false;
        mesh.renderOrder = options.renderOrder ?? 23;
        parent.add(mesh);
        slots.push(mesh);
      }
      this.#capacity += options.countPerVariant;
      this.#variants.set(name, { slots, material, cursor: 0 });
    }
  }

  /**
   * Stop drawing the slots that have not been used yet.
   *
   * Every slot is resident and `frustumCulled = false` from frame one so its pipeline is built
   * during loading rather than on the frame the first round lands. The cost of that trick is that
   * 224 invisible quads are submitted every frame forever, and on a phone the draw call is the
   * expensive part, not the triangle: a Pixel 8 was spending more per frame outside game logic
   * (37.5 ms at p99) than inside it (6.7 ms), with 1,100 draw calls of which roughly a third were
   * placeholders for marks nobody had made yet.
   *
   * Once the pipeline is compiled it stays compiled, so hiding a slot afterwards costs nothing to
   * undo — `place` simply shows it again. Call this a second or two into the scene, not on the
   * first frame, or the compile this exists to force will not have happened yet.
   */
  settle(): void {
    this.#settled = true;
    for (const family of this.#variants.values()) {
      for (const mesh of family.slots) {
        if (mesh.scale.x <= 0.001) mesh.visible = false;
      }
    }
  }

  /** Marks placed since construction. A playtest reads this to prove a round left something. */
  get placed(): number {
    return this.#placed;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /**
   * Stick a mark on a surface. `normal` is expected in world space, already transformed off the
   * struck object — a raycast's `face.normal` is object-local and will send marks into walls.
   */
  place(point: Vector3, normal: Vector3, variant: TVariant, scale = 1): void {
    const family = this.#variants.get(variant);
    if (family === undefined) return;
    const mesh = family.slots[family.cursor % family.slots.length];
    family.cursor += 1;
    if (mesh === undefined) return;
    this.#releaseProjection(mesh);
    this.#placed += 1;
    scratchNormal.copy(normal).normalize();
    scratchQuaternion.setFromUnitVectors(FORWARD, scratchNormal);
    // Spin about the normal so a wall taking a burst does not end up tiled with the same mark.
    scratchRoll.setFromAxisAngle(FORWARD, (this.#placed * 2.399) % (Math.PI * 2));
    scratchQuaternion.multiply(scratchRoll);
    mesh.quaternion.copy(scratchQuaternion);
    mesh.position.copy(point).addScaledVector(scratchNormal, this.#offset);
    mesh.scale.setScalar(scale);
    mesh.visible = true;
    // The renderer reads the mark off its world matrix, and this slot was moved after the last
    // scene update; without this the mark renders one frame behind, at its previous hit.
    mesh.updateMatrixWorld(true);
  }

  /**
   * Opt-in projection: pass the existing hit object and its authored/base geometry from the game.
   * `point`, `normal`, `depth` and the size multiplier are world-space. Returns false on a miss or
   * absent slot. Only this receiver is clipped; nearby objects are never projected onto. The
   * upstream corner/overlap distortion remains: keep depth narrow for thin or concave surfaces.
   * `uvRect` selects normalized atlas bounds without mutating the borrowed map. Optional fade
   * duration is seconds; its authored opacity curve receives normalized progress in [0, 1).
   * Call `update(dt)` each frame for expiry and receivers removed through an ancestor subtree.
   */
  project(
    receiver: Mesh,
    geometry: BufferGeometry,
    point: Vector3,
    normal: Vector3,
    variant: TVariant,
    options: {
      depth: number;
      scale?: number;
      uvRect?: readonly [number, number, number, number];
      fade?: DecalFade;
    },
  ): boolean {
    const family = this.#variants.get(variant);
    const mesh = family?.slots[family.cursor % family.slots.length];
    if (family === undefined || mesh === undefined) return false;
    const size = this.#size * (options.scale ?? 1);
    if (
      ![
        point.x,
        point.y,
        point.z,
        normal.x,
        normal.y,
        normal.z,
        size,
        options.depth,
        this.#offset,
      ].every(Number.isFinite) ||
      size <= 0 ||
      options.depth <= 0 ||
      !Number.isFinite(normal.lengthSq()) ||
      normal.lengthSq() === 0
    ) {
      throw new Error(
        "Invalid decal projector: finite point/normal and positive size/depth required.",
      );
    }
    if (this.#offset < 0 || this.#offset > options.depth / 2)
      throw new Error("Invalid decal bias: offset must be in [0, projector depth / 2].");
    const rect = options.uvRect;
    if (
      rect !== undefined &&
      (rect.length !== 4 ||
        !rect.every(Number.isFinite) ||
        rect[0] < 0 ||
        rect[1] < 0 ||
        rect[2] > 1 ||
        rect[3] > 1 ||
        rect[0] >= rect[2] ||
        rect[1] >= rect[3])
    )
      throw new Error("Invalid decal atlas rectangle: ordered UV bounds in [0, 1] required.");
    // Snapshot timing so mutating a caller's options cannot invalidate a live mark.
    const fade = options.fade === undefined ? undefined : { ...options.fade };
    if (
      fade !== undefined &&
      (!Number.isFinite(fade.duration) || fade.duration <= 0 || typeof fade.opacity !== "function")
    )
      throw new Error("Invalid decal fade: positive finite duration and opacity curve required.");
    const opacity = fade === undefined ? 1 : fadeOpacity(fade, 0);
    validateReceiver(receiver, geometry);
    if (!this.#contains(receiver))
      throw new Error("Unsupported receiver: mesh is outside the field's parent.");
    const direction = normal.clone().normalize();
    const orientation = new Quaternion().setFromUnitVectors(FORWARD, direction);
    orientation.multiply(
      new Quaternion().setFromAxisAngle(FORWARD, ((this.#placed + 1) * 2.399) % (Math.PI * 2)),
    );
    // A proxy borrows the authored geometry without ever swapping the receiver's render LOD.
    const source = new Mesh(geometry, receiver.material);
    source.matrixWorld.copy(receiver.matrixWorld);
    const projected = new DecalGeometry(
      source,
      point,
      new Euler().setFromQuaternion(orientation),
      new Vector3(size, size, options.depth),
    );
    const indices = frontFaces(projected, direction);
    if (indices.length === 0) {
      projected.dispose();
      return false;
    }
    projected.setIndex(indices);
    if (rect !== undefined) {
      const uv = projected.getAttribute("uv");
      for (let i = 0; i < uv.count; i += 1)
        uv.setXY(
          i,
          rect[0] + uv.getX(i) * (rect[2] - rect[0]),
          rect[1] + uv.getY(i) * (rect[3] - rect[1]),
        );
    }
    projected.translate(
      direction.x * this.#offset,
      direction.y * this.#offset,
      direction.z * this.#offset,
    );
    projected.applyMatrix4(new Matrix4().copy(receiver.matrixWorld).invert());
    this.#releaseProjection(mesh);
    mesh.geometry = projected;
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.setScalar(1);
    mesh.visible = true;
    mesh.material.opacity = opacity;
    receiver.add(mesh);
    const removed = (): void => this.#releaseProjection(mesh);
    this.#projected.set(mesh, { receiver, removed, elapsed: 0, fade });
    receiver.addEventListener("removed", removed);
    mesh.updateWorldMatrix(true, false);
    family.cursor += 1;
    this.#placed += 1;
    return true;
  }

  /** Release marks before a receiver is destroyed; its geometry and material remain borrowed. */
  removeReceiver(receiver: Mesh): void {
    for (const [mesh, entry] of this.#projected) {
      if (entry.receiver === receiver) this.#releaseProjection(mesh);
    }
  }

  /** Advance authored fades and clean detached ancestors, visiting at most the slot capacity. */
  update(dt = 0): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error("Invalid decal timestep: finite nonnegative seconds required.");
    for (const [mesh, entry] of this.#projected) {
      if (!this.#contains(entry.receiver)) {
        this.#releaseProjection(mesh);
        continue;
      }
      if (entry.fade === undefined) continue;
      const elapsed = Math.min(entry.elapsed + dt, entry.fade.duration);
      if (elapsed >= entry.fade.duration) this.#releaseProjection(mesh);
      else {
        mesh.material.opacity = fadeOpacity(entry.fade, elapsed / entry.fade.duration);
        entry.elapsed = elapsed;
      }
    }
  }

  #contains(object: Object3D): boolean {
    for (let current: Object3D | null = object; current !== null; current = current.parent) {
      if (current === this.#parent) return true;
    }
    return false;
  }

  #releaseProjection(mesh: DecalMesh): void {
    const entry = this.#projected.get(mesh);
    if (entry === undefined) return;
    entry.receiver.removeEventListener("removed", entry.removed);
    this.#projected.delete(mesh);
    mesh.geometry.dispose();
    mesh.geometry = this.#geometry;
    this.#parent.add(mesh);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.setScalar(0.0001);
    mesh.visible = false;
    mesh.material.opacity = 1;
  }

  /** Registered as an entity so a scenario can assert that a round actually left a mark. */
  debug(): { capacity: number; placed: number } {
    return { capacity: this.#capacity, placed: this.#placed };
  }

  /** Wipe every mark. Slots stay allocated; only their size goes back to nothing. */
  clear(): void {
    for (const family of this.#variants.values()) {
      for (const mesh of family.slots) {
        this.#releaseProjection(mesh);
        mesh.scale.setScalar(0.0001);
        if (this.#settled) mesh.visible = false;
      }
      family.cursor = 0;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const family of this.#variants.values()) {
      for (const mesh of family.slots) {
        this.#releaseProjection(mesh);
        mesh.removeFromParent();
        mesh.material.dispose();
      }
      family.material.dispose();
    }
    this.#variants.clear();
    this.#geometry.dispose();
  }
}
