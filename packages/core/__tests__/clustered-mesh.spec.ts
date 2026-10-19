import {
  BufferAttribute,
  BufferGeometry,
  Group,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { type IClusterDag, buildClusterDag } from "../../assets/src/virtual/dag.js";
import { ClusteredMesh, type IClusterTable, selectClusterCut } from "../src/clustered-mesh.js";

// PRD-282's runtime, graded against the bake that produced it. The cut has to be exactly the one
// the DAG's own errors imply, watertight from every camera the route will see, and steady under a
// camera that is standing still.

const ROOT_PARENT_ERROR = 3.4028234663852886e38;

interface IBody {
  readonly indices: Uint32Array;
  readonly positions: Float32Array;
}

/** A dense closed body without three.js's unused pole vertices. */
function torusKnot(): IBody {
  // Built by hand rather than by `TorusKnotGeometry` so this spec depends on no geometry factory:
  // a (2,3) torus knot tube, 256 segments around by 32 around the tube.
  const segments = 256;
  const tube = 32;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const u = (i / segments) * Math.PI * 4;
    const cx = (2 + Math.cos((3 * u) / 2)) * Math.cos(u);
    const cy = (2 + Math.cos((3 * u) / 2)) * Math.sin(u);
    const cz = Math.sin((3 * u) / 2);
    for (let j = 0; j < tube; j += 1) {
      const v = (j / tube) * Math.PI * 2;
      const radial = 0.4 * Math.cos(v);
      positions.push(cx + radial * Math.cos(u), cy + radial * Math.sin(u), cz + 0.4 * Math.sin(v));
    }
  }
  for (let i = 0; i < segments; i += 1)
    for (let j = 0; j < tube; j += 1) {
      const a = i * tube + j;
      const b = i * tube + ((j + 1) % tube);
      const c = ((i + 1) % segments) * tube + j;
      const d = ((i + 1) % segments) * tube + ((j + 1) % tube);
      indices.push(a, c, b, b, c, d);
    }
  return { indices: Uint32Array.from(indices), positions: Float32Array.from(positions) };
}

/** Packs a baked DAG exactly as `TN_virtual_geometry` stores it and the loader hands it over. */
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
    bounds[cluster * 4] = record.bounds.centerX;
    bounds[cluster * 4 + 1] = record.bounds.centerY;
    bounds[cluster * 4 + 2] = record.bounds.centerZ;
    bounds[cluster * 4 + 3] = record.bounds.radius;
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

const edgeKey = (a: number, b: number): number => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

function seamsOf(indices: ArrayLike<number>, weld: Uint32Array): Map<number, number> {
  const uses = new Map<number, number>();
  for (let slot = 0; slot < indices.length; slot += 3)
    for (let corner = 0; corner < 3; corner += 1) {
      const key = edgeKey(
        weld[indices[slot + corner] as number] as number,
        weld[indices[slot + ((corner + 1) % 3)] as number] as number,
      );
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  return uses;
}

let body: IBody;
let dag: IClusterDag;
let table: IClusterTable;
let weld: Uint32Array;
let sourceSeams: Map<number, number>;

beforeAll(async () => {
  body = torusKnot();
  dag = await buildClusterDag(body.indices, body.positions);
  table = pack(dag);
  // Positions are unique per vertex in this body, so welding is the identity — but the hole count
  // is computed the same way it is on a real asset.
  weld = Uint32Array.from({ length: body.positions.length / 3 }, (_, index) => index);
  sourceSeams = seamsOf(body.indices, weld);
}, 120_000);

function geometry(): BufferGeometry {
  const created = new BufferGeometry();
  created.setAttribute("position", new BufferAttribute(body.positions, 3));
  return created;
}

function holesInCut(selection: Uint32Array, selected: number): number {
  const cut: number[] = [];
  for (let slot = 0; slot < selected; slot += 1) {
    const cluster = selection[slot] as number;
    const start = table.ranges[cluster * 2] as number;
    const count = table.ranges[cluster * 2 + 1] as number;
    for (let index = start; index < start + count; index += 1)
      cut.push(table.indices[index] as number);
  }
  let holes = 0;
  for (const [key, uses] of seamsOf(cut, weld))
    if (uses !== 2 && (sourceSeams.get(key) ?? 0) === 2) holes += 1;
  return holes;
}

describe("selectClusterCut", () => {
  it("AC1 — picks exactly the clusters the DAG's own errors imply", () => {
    const camera = new Vector3(0, 0, 6);
    const scale = 540;
    const out = new Uint32Array(dag.clusters.length);
    const selected = selectClusterCut(table, camera, scale, 1, out);

    // The oracle: the same rule walked over the DAG's own records rather than the packed table.
    const project = (
      error: number,
      sphere: { radius: number; x: number; y: number; z: number },
    ): number =>
      (error * scale) /
      Math.max(
        Math.hypot(camera.x - sphere.x, camera.y - sphere.y, camera.z - sphere.z) - sphere.radius,
        1e-4,
      );
    const expected: number[] = [];
    for (let cluster = 0; cluster < dag.clusters.length; cluster += 1) {
      const record = dag.clusters[cluster] as (typeof dag.clusters)[number];
      const own = project(record.error, record.sourceSphere);
      const parent = Number.isFinite(record.parentError)
        ? project(record.parentError, record.parentSphere)
        : Number.POSITIVE_INFINITY;
      if (own <= 1 && parent > 1) expected.push(cluster);
    }

    expect([...out.subarray(0, selected)]).toEqual(expected);
    expect(selected).toBeGreaterThan(0);
    expect(selected).toBeLessThan(dag.clusters.length);
  });

  it("AC2 — leaves no hole, from any camera on a sweep in and out", () => {
    const out = new Uint32Array(dag.clusters.length);
    const cracked: { distance: number; holes: number; triangles: number }[] = [];
    for (let step = 0; step <= 40; step += 1) {
      // From inside the tube's radius out to far enough that one cluster covers the body.
      const distance = 0.2 * 1.25 ** step;
      const camera = new Vector3(distance * 0.6, distance * 0.5, distance);
      const selected = selectClusterCut(table, camera, 540, 1, out);
      const holes = holesInCut(out, selected);
      if (holes > 0)
        cracked.push({
          distance,
          holes,
          triangles: [...out.subarray(0, selected)].reduce(
            (sum, cluster) => sum + (table.ranges[cluster * 2 + 1] as number) / 3,
            0,
          ),
        });
    }
    expect(cracked).toEqual([]);
  });

  it("AC2 red — projecting both errors through the cluster's own sphere cracks it", () => {
    // The mutation: one sphere per cluster instead of the group spheres either side. It is the
    // obvious implementation and it is wrong — two clusters that share a seam then flip at
    // different distances.
    const naive: IClusterTable = {
      ...table,
      parentSpheres: table.bounds,
      sourceSpheres: table.bounds,
    };
    const out = new Uint32Array(dag.clusters.length);
    let cracked = 0;
    for (let step = 0; step <= 40; step += 1) {
      const distance = 0.2 * 1.25 ** step;
      const camera = new Vector3(distance * 0.6, distance * 0.5, distance);
      const selected = selectClusterCut(naive, camera, 540, 1, out);
      if (holesInCut(out, selected) > 0) cracked += 1;
    }
    expect(cracked).toBeGreaterThan(0);
  });

  it("draws everything when nothing resolves, and one cluster when the camera is far enough", () => {
    const out = new Uint32Array(dag.clusters.length);
    const near = selectClusterCut(table, new Vector3(0, 0, 0.001), 540, 1, out);
    const nearTriangles = [...out.subarray(0, near)].reduce(
      (sum, cluster) => sum + (table.ranges[cluster * 2 + 1] as number) / 3,
      0,
    );
    expect(nearTriangles).toBe(body.indices.length / 3);

    const far = selectClusterCut(table, new Vector3(0, 0, 1e6), 540, 1, out);
    expect(far).toBe(dag.roots.length);
  });
});

describe("ClusteredMesh", () => {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  /**
   * Jitter amplitude and the band that has to swallow it, in the body's own units.
   *
   * Measured on this body at six units out: 0.004, 0.01, 0.02, 0.05 and 0.1 change the cut on
   * *none* of 120 frames, 0.2 changes it on 14 and 0.5 on 78. The band is therefore proven at the
   * amplitude where flicker actually starts rather than at one picked to make it look necessary —
   * and the fact that a tenth of a unit does not move the cut is itself the reassuring half of the
   * result.
   */
  const JITTER = 0.2;
  const BAND = 0.5;

  it("draws the whole mesh before anything cuts it", () => {
    // Virtual geometry ships on by default, so a game that never calls `update` — or one whose
    // first frame renders before the loop's first cut — has to get exactly what an ordinary `Mesh`
    // would have drawn. Starting invisible would turn the default into a blank screen.
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);

    expect(mesh.visible).toBe(true);
    expect(mesh.drawnTriangles).toBe(body.indices.length / 3);
    expect(mesh.geometry.drawRange.count).toBe(body.indices.length);

    // And it is the source triangle set, not merely the right count.
    const drawn = new Set<string>();
    const index = mesh.geometry.getIndex();
    if (index === null) throw new Error("the mesh has no index");
    const key = (a: number, b: number, c: number): string =>
      [a, b, c].sort((left, right) => left - right).join(",");
    for (let slot = 0; slot < mesh.drawnTriangles * 3; slot += 3)
      drawn.add(
        key(
          index.array[slot] as number,
          index.array[slot + 1] as number,
          index.array[slot + 2] as number,
        ),
      );
    const expected = new Set<string>();
    for (let slot = 0; slot < body.indices.length; slot += 3)
      expected.add(
        key(
          body.indices[slot] as number,
          body.indices[slot + 1] as number,
          body.indices[slot + 2] as number,
        ),
      );
    expect(drawn).toEqual(expected);
  });

  it("only ever takes detail away from the full mesh", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    const whole = mesh.drawnTriangles;
    camera.position.set(0, 0, 40);

    expect(mesh.update(camera, 1080)).toBeLessThan(whole);
  });

  it("writes the cut into the buffer the GPU actually draws", () => {
    // `Uint32BufferAttribute` copies the array it is handed. Using it here meant every cut was
    // written into a buffer nothing ever read, and the mesh drew a range of zeros — degenerate
    // triangles, an empty screen, and not one error anywhere.
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    camera.position.set(0, 0, 6);
    const triangles = mesh.update(camera, 1080);
    const index = mesh.geometry.getIndex();
    if (index === null) throw new Error("the mesh has no index");

    const drawn = (index.array as Uint32Array).subarray(0, triangles * 3);
    expect(drawn.some((value) => value !== 0)).toBe(true);
    // And it is the selected clusters' triangles, in order.
    const out = new Uint32Array(dag.clusters.length);
    const selected = selectClusterCut(
      table,
      new Vector3(0, 0, 6),
      1080 / (2 * Math.tan((60 * Math.PI) / 360)),
      1,
      out,
    );
    const expected: number[] = [];
    for (let slot = 0; slot < selected; slot += 1) {
      const cluster = out[slot] as number;
      const start = table.ranges[cluster * 2] as number;
      const count = table.ranges[cluster * 2 + 1] as number;
      for (let position = start; position < start + count; position += 1)
        expected.push(table.indices[position] as number);
    }
    expect([...drawn]).toEqual(expected);
  });

  it("compacts the cut into one index range and reports what it drew", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    camera.position.set(0, 0, 6);
    const triangles = mesh.update(camera, 1080);

    expect(triangles).toBeGreaterThan(0);
    expect(mesh.drawnClusters).toBeGreaterThan(0);
    expect(mesh.visible).toBe(true);
    expect(mesh.geometry.drawRange.count).toBe(triangles * 3);
    expect(mesh.geometry.getIndex()?.count).toBeGreaterThanOrEqual(triangles * 3);
  });

  it("draws more as the camera closes in", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    camera.position.set(0, 0, 40);
    const far = mesh.update(camera, 1080);
    camera.position.set(0, 0, 4);
    const near = mesh.update(camera, 1080);

    expect(near).toBeGreaterThan(far);
  });

  /** A camera that is standing still and breathing, at an amplitude that does flip a cluster. */
  const jitter = (frame: number): void => {
    camera.position.set(
      Math.sin(frame) * JITTER,
      Math.cos(frame * 1.7) * JITTER,
      6 + Math.sin(frame * 0.7) * JITTER,
    );
  };

  it("AC3 — a camera standing still and breathing does not change the cut", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      recutDistance: BAND,
    });
    camera.position.set(0, 0, 6);
    const cutKey = (): string => {
      const triangles = mesh.update(camera, 1080);
      return `${mesh.drawnClusters}:${triangles}`;
    };
    const settled = cutKey();
    let flickers = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      jitter(frame);
      if (cutKey() !== settled) flickers += 1;
    }
    expect(flickers).toBe(0);
  });

  it("AC3 red — without the band the same jitter flickers the cut", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      recutDistance: 0,
    });
    camera.position.set(0, 0, 6);
    const cutKey = (): string => {
      const triangles = mesh.update(camera, 1080);
      return `${mesh.drawnClusters}:${triangles}`;
    };
    const settled = cutKey();
    let flickers = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      jitter(frame);
      if (cutKey() !== settled) flickers += 1;
    }
    // Pasted into the PRD: this is the flicker the band removes.
    expect(flickers).toBeGreaterThan(0);
  });

  it("AC5 — a camera that resolves nothing leaves the mesh invisible", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      // Nothing may show any error at all, and the finest level still shows some, so nothing is
      // eligible except at the very front — the empty cut this AC is about.
      errorPixels: -1,
    });
    camera.position.set(0, 0, 6);

    expect(mesh.update(camera, 1080)).toBe(0);
    expect(mesh.visible).toBe(false);
    expect(mesh.geometry.drawRange.count).toBe(0);
  });

  it("AC5 — and picks itself back up when the camera comes back", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      errorPixels: -1,
    });
    camera.position.set(0, 0, 6);
    mesh.update(camera, 1080);
    expect(mesh.visible).toBe(false);

    mesh.errorPixels = 1;
    expect(mesh.update(camera, 1080)).toBeGreaterThan(0);
    expect(mesh.visible).toBe(true);
  });

  it("keeps the game's surface, and swapping it swaps what draws", () => {
    const first = new MeshBasicMaterial();
    const mesh = new ClusteredMesh(geometry(), first, table);
    expect(mesh.material).toBe(first);

    const second = new MeshBasicMaterial();
    mesh.material = second;
    expect(mesh.material).toBe(second);
  });

  it("refuses a table it cannot draw rather than drawing nonsense", () => {
    expect(
      () =>
        new ClusteredMesh(geometry(), new MeshBasicMaterial(), {
          ...table,
          errors: new Float32Array(2),
        }),
    ).toThrow(/table\.errors holds 2 values/u);
    expect(
      () =>
        new ClusteredMesh(geometry(), new MeshBasicMaterial(), {
          ...table,
          ranges: Uint32Array.from([0, 4, ...table.ranges.subarray(2)]),
        }),
    ).toThrow(/names indices 0\.\.4/u);
  });

  it("refuses a camera it cannot project through", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    expect(() => mesh.update(camera, 0)).toThrow(/positive viewport height/u);
    expect(() =>
      mesh.update({ matrixWorld: camera.matrixWorld, updateWorldMatrix: () => {} } as never, 1080),
    ).toThrow(/needs a perspective camera/u);
  });
});

describe("ClusteredMesh cloning", () => {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);

  /** This mesh's triangles, with the camera `z` units out from where it stands. */
  function cutAt(mesh: ClusteredMesh, z: number): number {
    camera.position.set(0, 0, z);
    return mesh.update(camera, 1080);
  }

  // three clones through `new this.constructor().copy(source)`, so any game that stands a second
  // copy of a cooked model where it wants a statue used to die in `assertTable` before it drew
  // anything. Lumen-hall's authored statues did, from the first model the default cook produced.
  it("clones into a mesh that draws the same thing", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    const triangles = cutAt(mesh, 6);
    const clone = mesh.clone();

    expect(clone.table).toBe(mesh.table);
    // A copy starts at the authored detail, exactly as a fresh mesh does, and only gives it up
    // once something cuts it.
    expect(clone.drawnTriangles).toBe(body.indices.length / 3);
    expect(cutAt(clone, 6)).toBe(triangles);
    expect(clone.geometry.drawRange).toEqual(mesh.geometry.drawRange);
    expect(clone.geometry.getIndex()?.array).not.toBe(mesh.geometry.getIndex()?.array);
  });

  it("clones inside a group, which is how a game places a second copy", () => {
    const figure = new Group();
    figure.add(new ClusteredMesh(geometry(), new MeshBasicMaterial(), table));
    const clone = figure.clone(true);
    const copied = clone.children[0] as ClusteredMesh;

    expect(copied).toBeInstanceOf(ClusteredMesh);
    expect(copied.table).toBe((figure.children[0] as ClusteredMesh).table);
  });

  it("keeps the vertices shared and the cut its own, so the two are placed independently", () => {
    // Sharing the geometry wholesale would be cheaper still and wrong: the cut lives in the
    // geometry's index buffer, so two meshes on one geometry would overwrite each other's index
    // every frame and both would draw whichever one spoke last. Sharing the vertex buffers by
    // reference keeps one copy of them on the GPU — three keys its attributes on the attribute —
    // and still lets each mesh hold a cut of its own.
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    const beside = mesh.clone();

    expect(beside.geometry).not.toBe(mesh.geometry);
    expect(beside.geometry.attributes.position).toBe(mesh.geometry.attributes.position);

    const near = cutAt(mesh, 6);
    expect(cutAt(beside, 6)).toBe(near);

    const across = mesh.clone();
    across.position.set(0, 0, 400);
    expect(cutAt(across, 6)).toBeLessThan(near);
    // And cutting the far copy left the near one drawing what it was drawing.
    expect(cutAt(mesh, 6)).toBe(near);
  });

  it("disposes without taking the source's shared data with it", () => {
    // The rule, since sharing is the point: a clone shares the baked table and the vertex
    // attributes, and the geometry that owns them disposes them for everyone — exactly as three's
    // own `Mesh.copy` shares geometry and material. What a clone owns outright is its cut.
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    const clone = mesh.clone();
    let sourceDisposed = false;
    mesh.geometry.addEventListener("dispose", () => {
      sourceDisposed = true;
    });

    clone.geometry.dispose();

    expect(sourceDisposed).toBe(false);
    expect(clone.geometry.attributes.position).toBe(mesh.geometry.attributes.position);
    expect(mesh.table).toBe(table);
    expect(mesh.drawnTriangles).toBe(body.indices.length / 3);
  });
});
