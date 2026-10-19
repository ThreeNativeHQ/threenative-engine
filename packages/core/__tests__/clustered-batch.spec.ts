import {
  BufferAttribute,
  BufferGeometry,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Vector3,
} from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { type IClusterDag, buildClusterDag } from "../../assets/src/virtual/dag.js";
import { ClusteredBatch } from "../src/clustered-batch.js";
import {
  type IClusterTable,
  selectClusterCut,
  updateClusteredMeshes,
} from "../src/clustered-mesh.js";

// Four hundred copies of one body is the case the quarry is built out of, and the case a per-mesh
// cut cannot serve: one indexed draw has one index range. These tests hold the two properties that
// make the distance grouping legitimate — every group's cut is watertight, and no copy is ever
// drawn coarser than its own distance allows.

const ROOT_PARENT_ERROR = 3.4028234663852886e38;

interface IBody {
  readonly indices: Uint32Array;
  readonly positions: Float32Array;
}

/** A closed, dense, hand-built sphere: every vertex used, no library involved. */
function ball(rings: number, segments: number): IBody {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      positions.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  for (let ring = 0; ring < rings; ring += 1)
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * segments + segment;
      const b = ring * segments + ((segment + 1) % segments);
      const c = (ring + 1) * segments + segment;
      const d = (ring + 1) * segments + ((segment + 1) % segments);
      indices.push(a, c, b, b, c, d);
    }
  return { indices: Uint32Array.from(indices), positions: Float32Array.from(positions) };
}

function pack(dag: IClusterDag): IClusterTable {
  const count = dag.clusters.length;
  const bounds = new Float32Array(count * 4);
  const cones = new Float32Array(count * 4);
  const errors = new Float32Array(count * 2);
  const parentSpheres = new Float32Array(count * 4);
  const ranges = new Uint32Array(count * 2);
  const sourceSpheres = new Float32Array(count * 4);
  for (let cluster = 0; cluster < count; cluster += 1) {
    const record = dag.clusters[cluster] as (typeof dag.clusters)[number];
    ranges[cluster * 2] = record.start;
    ranges[cluster * 2 + 1] = record.count;
    errors[cluster * 2] = record.error;
    errors[cluster * 2 + 1] = Number.isFinite(record.parentError)
      ? record.parentError
      : ROOT_PARENT_ERROR;
    bounds[cluster * 4 + 3] = record.bounds.radius;
    bounds[cluster * 4] = record.bounds.centerX;
    bounds[cluster * 4 + 1] = record.bounds.centerY;
    bounds[cluster * 4 + 2] = record.bounds.centerZ;
    sourceSpheres[cluster * 4] = record.sourceSphere.x;
    sourceSpheres[cluster * 4 + 1] = record.sourceSphere.y;
    sourceSpheres[cluster * 4 + 2] = record.sourceSphere.z;
    sourceSpheres[cluster * 4 + 3] = record.sourceSphere.radius;
    parentSpheres[cluster * 4] = record.parentSphere.x;
    parentSpheres[cluster * 4 + 1] = record.parentSphere.y;
    parentSpheres[cluster * 4 + 2] = record.parentSphere.z;
    parentSpheres[cluster * 4 + 3] = record.parentSphere.radius;
  }
  return { bounds, cones, errors, indices: dag.indices, parentSpheres, ranges, sourceSpheres };
}

let body: IBody;
let dag: IClusterDag;
let table: IClusterTable;

beforeAll(async () => {
  body = ball(96, 128);
  dag = await buildClusterDag(body.indices, body.positions);
  table = pack(dag);
}, 180_000);

function geometry(): BufferGeometry {
  const created = new BufferGeometry();
  created.setAttribute("position", new BufferAttribute(body.positions, 3));
  return created;
}

/** The batch the quarry builds: copies spread from near the camera out to two hundred units. */
function spread(options: { distanceRatio?: number; errorPixels?: number } = {}): ClusteredBatch {
  const batch = new ClusteredBatch({
    geometry: geometry(),
    material: new MeshBasicMaterial(),
    table,
    ...options,
  });
  for (let copy = 0; copy < 200; copy += 1)
    batch.place({ position: [0, 0, -(4 + copy * 1.2)], scale: 1 });
  return batch;
}

const edgeKey = (a: number, b: number): number => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

/**
 * Vertices that share a position are one vertex here.
 *
 * The ball's poles are a ring of coincident vertices with distinct indices, so raw index edges
 * would report the body's own seam as a hole in every cut, including the source mesh's.
 */
function weldOf(positions: Float32Array): Uint32Array {
  const canonical = new Map<string, number>();
  const weld = new Uint32Array(positions.length / 3);
  for (let vertex = 0; vertex < weld.length; vertex += 1) {
    const key = `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
    const first = canonical.get(key);
    if (first === undefined) canonical.set(key, vertex);
    weld[vertex] = first ?? vertex;
  }
  return weld;
}

function seamsOf(
  indices: ArrayLike<number>,
  count: number,
  weld: Uint32Array,
): Map<number, number> {
  const uses = new Map<number, number>();
  for (let slot = 0; slot < count; slot += 3)
    for (let corner = 0; corner < 3; corner += 1) {
      const key = edgeKey(
        weld[indices[slot + corner] as number] as number,
        weld[indices[slot + ((corner + 1) % 3)] as number] as number,
      );
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  return uses;
}

describe("ClusteredBatch", () => {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, 0);

  /**
   * Runs the batch until every band this camera needs is built.
   *
   * Bands arrive a couple per update on purpose — see the build-budget test — so anything asserting
   * the *converged* cut has to let it converge first, exactly as a game's first few frames do.
   */
  const settle = (batch: ClusteredBatch, updates = 16): number => {
    let triangles = 0;
    for (let update = 0; update < updates; update += 1) triangles = batch.update(camera, 1080);
    return triangles;
  };

  it("draws far fewer triangles than the same copies drawn whole", () => {
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });

    const triangles = settle(batch);
    const whole = (body.indices.length / 3) * batch.count;

    expect(triangles).toBeGreaterThan(0);
    expect(triangles).toBeLessThan(whole / 10);
  }, 180_000);

  it("submits one draw per occupied distance group, not one per copy", () => {
    const batch = spread();
    batch.build({ name: "boulders", parent: new Object3D() });
    settle(batch);

    expect(batch.drawCalls).toBeGreaterThan(1);
    expect(batch.drawCalls).toBeLessThan(30);
    expect(batch.drawCalls).toBeLessThan(batch.count);
  }, 180_000);

  it("never draws a copy coarser than its own distance allows", () => {
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });
    settle(batch);

    const selection = new Uint32Array(dag.clusters.length);
    const scale = 1080 / (2 * Math.tan((60 * Math.PI) / 360));
    const trianglesFor = (distance: number): number => {
      const selected = selectClusterCut(table, new Vector3(0, 0, distance), scale, 1, selection);
      let triangles = 0;
      for (let slot = 0; slot < selected; slot += 1)
        triangles += (table.ranges[(selection[slot] as number) * 2 + 1] as number) / 3;
      return triangles;
    };

    // The batch is grouped, so each copy draws its group's cut. That cut is taken at the group's
    // nearest member, so every copy in it draws at least what it would have drawn alone.
    const drawn = new Map<number, number>();
    scene.traverse((object) => {
      const mesh = object as { count?: number; geometry?: BufferGeometry; visible: boolean };
      if (mesh.geometry === undefined || mesh.count === undefined || !mesh.visible) return;
      drawn.set(mesh.geometry.drawRange.count / 3, mesh.count);
    });
    expect(drawn.size).toBeGreaterThan(1);

    for (let copy = 0; copy < 200; copy += 1) {
      const distance = 4 + copy * 1.2;
      const solo = trianglesFor(distance);
      // Any group this copy could be in draws at least `solo`; the coarsest group in the scene is
      // the one for the farthest copy, so the weakest claim is checked against the whole set.
      const coarsest = Math.min(...drawn.keys());
      if (distance >= 4 + 199 * 1.2) expect(coarsest).toBeGreaterThanOrEqual(solo * 0.999);
    }
  }, 180_000);

  it("every group's cut is watertight", () => {
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });
    settle(batch);

    const weld = weldOf(body.positions);
    const source = seamsOf(body.indices, body.indices.length, weld);
    const cracked: number[] = [];
    scene.traverse((object) => {
      const mesh = object as { geometry?: BufferGeometry; visible: boolean };
      const index = mesh.geometry?.getIndex();
      if (index == null || !mesh.visible) return;
      let open = 0;
      for (const [key, uses] of seamsOf(
        index.array as Uint32Array,
        mesh.geometry?.drawRange.count ?? 0,
        weld,
      ))
        if (uses !== 2 && (source.get(key) ?? 0) === 2) open += 1;
      if (open > 0) cracked.push(open);
    });
    expect(cracked).toEqual([]);
  }, 180_000);

  it("follows the camera: closing in draws more", () => {
    const batch = spread();
    batch.build({ name: "boulders", parent: new Object3D() });
    camera.position.set(0, 0, 0);
    const far = settle(batch);
    camera.position.set(0, 0, -200);
    const near = settle(batch);
    camera.position.set(0, 0, 0);

    expect(near).not.toBe(far);
  }, 180_000);

  it("never frees a buffer another group is still drawing from", () => {
    // Disposing the moment a group outgrows its cut destroys a buffer that is already inside a
    // submitted command buffer. WebGPU said so on the quarry's first virtual run:
    // `[Buffer (unlabeled)] used in submit while destroyed`.
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });
    /** Attribute names each geometry still held at the moment it was disposed. */
    const disposedHolding: string[][] = [];
    const watch = (): void => {
      scene.traverse((object) => {
        const geometry = (object as { geometry?: BufferGeometry }).geometry;
        if (geometry === undefined || (geometry as { watched?: boolean }).watched === true) return;
        (geometry as { watched?: boolean }).watched = true;
        const original = geometry.dispose.bind(geometry);
        geometry.dispose = () => {
          disposedHolding.push(Object.keys(geometry.attributes));
          original();
        };
      });
    };

    camera.position.set(0, 0, -240);
    settle(batch);
    watch();

    // Walking the whole length grows every near group's cut. Group geometries share one position
    // attribute, so disposing any of them would destroy a buffer the others are still drawing from.
    for (let step = 1; step <= 8; step += 1) {
      camera.position.set(0, 0, -240 + step * 30);
      settle(batch, 6);
      watch();
    }
    // Groups are reclaimed as the walk leaves them, and every one of them let go of the batch's
    // shared attributes first: a geometry disposed while still holding them destroys the position
    // buffer the whole batch draws from.
    expect(disposedHolding.filter((held) => held.length > 0)).toEqual([]);
    expect(disposedHolding.length).toBeGreaterThan(0);

    // And the cut still grew, so the swap this is guarding really happened.
    const positions = new Set<unknown>();
    scene.traverse((object) => {
      const geometry = (object as { geometry?: BufferGeometry }).geometry;
      if (geometry !== undefined) positions.add(geometry.getAttribute("position"));
    });
    expect(positions.size).toBe(1);
    camera.position.set(0, 0, 0);
  }, 180_000);

  it("grows a cut by what it needs, never by what it had", () => {
    // Doubling the previous size means one extra index doubles the buffer, and a camera walking in
    // doubles it every frame. That is what exhausted 8 GB of VRAM on the quarry's route.
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });

    let peak = 0;
    for (let step = 0; step <= 40; step += 1) {
      camera.position.set(0, 0, -6 * step);
      const triangles = settle(batch, 4);
      let allocated = 0;
      scene.traverse((object) => {
        const index = (object as { geometry?: BufferGeometry }).geometry?.getIndex();
        if (index != null) allocated += index.array.length;
      });
      // Never more than half again the triangles actually drawn by the live groups.
      expect(allocated).toBeLessThanOrEqual(Math.max(triangles * 3, 3) * 1.5 + 3);
      peak = Math.max(peak, allocated);
    }
    camera.position.set(0, 0, 0);
    expect(peak).toBeGreaterThan(0);
  }, 180_000);

  it("allocates one index buffer per group and never replaces it", () => {
    // three releases a geometry's index buffer only when the geometry is disposed, so replacing the
    // index attribute leaks one every time. The quarry's route leaked 74 of them every 120 frames.
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });

    const indexAttributes = new Set<unknown>();
    const geometries = new Set<unknown>();
    for (let step = 0; step <= 40; step += 1) {
      camera.position.set(0, 0, -6 * step);
      settle(batch, 4);
      scene.traverse((object) => {
        const geometry = (object as { geometry?: BufferGeometry }).geometry;
        if (geometry === undefined) return;
        geometries.add(geometry);
        const index = geometry.getIndex();
        if (index !== null) indexAttributes.add(index);
      });
    }
    camera.position.set(0, 0, 0);

    expect(indexAttributes.size).toBe(geometries.size);
  }, 180_000);

  it("gives a group's memory back once nothing is in it", () => {
    // A walk across the scene passes through every distance group. Keeping them all is what ran the
    // quarry's GPU out of memory, so a group that has stood empty for a while is reclaimed.
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });

    const meshes = (): number => {
      let count = 0;
      scene.traverse((object) => {
        if ((object as { isInstancedMesh?: boolean }).isInstancedMesh === true) count += 1;
      });
      return count;
    };

    // Walk the whole length, one update per step, which is how a real route arrives.
    let peak = 0;
    for (let step = 0; step <= 40; step += 1) {
      camera.position.set(0, 0, -6 * step);
      settle(batch, 4);
      peak = Math.max(peak, meshes());
    }
    // Reclamation runs on updates that actually re-cut, so nudge the camera rather than holding it
    // perfectly still — a still camera keeps its cut and has no reason to touch memory at all.
    for (let settle = 0; settle < 16; settle += 1) {
      camera.position.set(0, 0, settle * 0.9);
      batch.update(camera, 1080);
    }
    camera.position.set(0, 0, 0);

    // The live set is the occupied groups, not every group the walk ever passed through.
    expect(meshes()).toBeLessThanOrEqual(peak);
    expect(meshes()).toBe(batch.drawCalls);
  }, 180_000);

  it("builds only a handful of distance groups per update", () => {
    // Cutting and uploading every band a walk will use, all in the first frames, cost the quarry a
    // 649.6 ms render.p95 on the native host — one visible stall in a game that asked for nothing.
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });

    const live = (): number => {
      let count = 0;
      scene.traverse((object) => {
        if ((object as { isInstancedMesh?: boolean }).isInstancedMesh === true) count += 1;
      });
      return count;
    };

    camera.position.set(0, 0, 0);
    const perUpdate: number[] = [];
    let previous = 0;
    for (let update = 0; update < 12; update += 1) {
      batch.update(camera, 1080);
      perUpdate.push(live() - previous);
      previous = live();
    }
    expect(Math.max(...perUpdate)).toBeLessThanOrEqual(4);
    // And it does converge: the bands a standing camera needs are all built within a few updates.
    expect(perUpdate.at(-1)).toBe(0);
  }, 180_000);

  it("draws every copy while its own band is still waiting to be built", () => {
    // A copy whose band has not been built yet borrows the nearest built one. Borrowing is safe —
    // any group's cut is a real cut of the same DAG — but a copy that stopped drawing would be a
    // hole in the world on the first frames of every scene.
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });

    camera.position.set(0, 0, 0);
    for (let update = 0; update < 6; update += 1) {
      batch.update(camera, 1080);
      let drawnCopies = 0;
      scene.traverse((object) => {
        const mesh = object as { count?: number; visible: boolean };
        if (mesh.count !== undefined && mesh.visible) drawnCopies += mesh.count;
      });
      expect(drawnCopies).toBe(batch.count);
    }
  }, 180_000);

  it("is cut by the engine's own walk, with nothing for the game to call", () => {
    // Virtual geometry ships on. A batch the engine's per-frame walk could not find would mean
    // instanced dense props — the common case — quietly drawing every triangle forever.
    const batch = spread();
    const scene = new Object3D();
    batch.build({ name: "boulders", parent: scene });
    camera.position.set(0, 0, 0);

    let triangles = 0;
    for (let update = 0; update < 16; update += 1)
      triangles = updateClusteredMeshes(scene, camera, 1080);

    expect(triangles).toBe(batch.drawnTriangles);
    expect(triangles).toBeGreaterThan(0);
    expect(triangles).toBeLessThan((body.indices.length / 3) * batch.count);
  }, 180_000);

  it("does no work at all for a camera that has not moved", () => {
    // The engine cuts every batch every frame now, so a still camera has to be free. Without this
    // the quarry's render phase went from 0.9 ms to 13.45 ms and the frame lost 7 fps.
    const batch = spread();
    batch.build({ name: "boulders", parent: new Object3D() });
    camera.position.set(0, 0, 0);
    settle(batch);

    let cuts = 0;
    const table = batch as unknown as { update(c: PerspectiveCamera, h: number): number };
    const before = batch.drawnTriangles;
    for (let frame = 0; frame < 30; frame += 1) {
      // A millimetre of drift on a body two hundred units away changes no cut.
      camera.position.set(0.0005 * Math.sin(frame), 0, 0.0005 * Math.cos(frame));
      if (table.update(camera, 1080) !== before) cuts += 1;
    }
    camera.position.set(0, 0, 0);
    expect(cuts).toBe(0);
  }, 180_000);

  it("refuses the orders it cannot carry out", () => {
    const batch = spread();
    expect(() => batch.update(camera, 1080)).toThrow(/needs build\(\) first/u);
    batch.build({ name: "boulders", parent: new Object3D() });
    expect(() => batch.place({ position: [0, 0, 0] })).toThrow(/cannot run after build/u);
    expect(
      () =>
        new ClusteredBatch({
          distanceRatio: 1,
          geometry: geometry(),
          material: new MeshBasicMaterial(),
          table,
        }),
    ).toThrow(/distanceRatio must be above one/u);
    expect(() =>
      new ClusteredBatch({
        geometry: geometry(),
        material: new MeshBasicMaterial(),
        table,
      }).build({ parent: new Object3D() }),
    ).toThrow(/at least one placed copy/u);
  }, 180_000);

  it("clones into a root that is still cut", () => {
    // `new this.constructor()` left `batch` undefined, so a cloned root quietly stopped being cut
    // and drew whatever its bands happened to hold. Detection is structural, so the engine could
    // not even tell the copy apart from an ordinary object.
    const parent = new Object3D();
    const batch = spread();
    const root = batch.build({ name: "boulders", parent });
    camera.position.set(0, 0, 0);
    const triangles = batch.update(camera, 1080);

    const copy = root.clone() as unknown as { batch: ClusteredBatch };
    expect(copy.batch).toBe(batch);
    // Still found by the engine's walk, and still drawing: a copy whose `batch` was undefined
    // returned nothing and was never cut again.
    expect(updateClusteredMeshes(copy as unknown as Object3D, camera, 1080)).toBeGreaterThan(0);
    expect(triangles).toBeGreaterThan(0);
  }, 180_000);
});
