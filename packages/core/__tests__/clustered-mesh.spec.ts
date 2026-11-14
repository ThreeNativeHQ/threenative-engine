import {
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Group,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Sphere,
  Vector3,
} from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { type IClusterDag, buildClusterDag } from "../../assets/src/virtual/dag.js";
import {
  ClusterView,
  ClusterWalk,
  ClusteredMesh,
  type IClusterTable,
  NO_CLUSTER_GROUP,
  selectClusterCut,
} from "../src/clustered-mesh.js";

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
  const groups = new Uint32Array(count * 2);
  const parentSpheres = new Float32Array(count * 4);
  const ranges = new Uint32Array(count * 2);
  const sourceSpheres = new Float32Array(count * 4);
  // The bake's own inversion: every cluster a group's simplification produced names that group.
  const sourceGroups = new Uint32Array(count).fill(NO_CLUSTER_GROUP);
  for (let group = 0; group < dag.groups.length; group += 1)
    for (const parent of (dag.groups[group] as (typeof dag.groups)[number]).parents)
      sourceGroups[parent] = group;
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
    groups[cluster * 2] = record.group === -1 ? NO_CLUSTER_GROUP : record.group;
    groups[cluster * 2 + 1] = sourceGroups[cluster] as number;
    sourceSpheres[cluster * 4] = record.sourceSphere.x;
    sourceSpheres[cluster * 4 + 1] = record.sourceSphere.y;
    sourceSpheres[cluster * 4 + 2] = record.sourceSphere.z;
    sourceSpheres[cluster * 4 + 3] = record.sourceSphere.radius;
    parentSpheres[cluster * 4] = record.parentSphere.x;
    parentSpheres[cluster * 4 + 1] = record.parentSphere.y;
    parentSpheres[cluster * 4 + 2] = record.parentSphere.z;
    parentSpheres[cluster * 4 + 3] = record.parentSphere.radius;
  }
  return {
    bounds,
    cones,
    errors,
    groups,
    indices: dag.indices,
    parentSpheres,
    ranges,
    sourceSpheres,
  };
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

/**
 * The quarry cliff's cluster table, synthesized to its real shape: 57,041 clusters over 16 levels.
 *
 * The bake that produces the real one takes minutes and needs 2 million triangles; a scan walks one
 * record per cluster and asks nothing about triangles, so the shape is what a cost measurement needs
 * and the geometry is not. `tile` repeats the table, which is how an asset ten times larger costs
 * ten times more.
 */
function cliffTable(tile: number): IClusterTable {
  const clusters = 57_041;
  const levels = 16;
  const bounds = new Float32Array(clusters * 4 * tile);
  const cones = new Float32Array(clusters * 4 * tile);
  const errors = new Float32Array(clusters * 2 * tile);
  const parentSpheres = new Float32Array(clusters * 4 * tile);
  const ranges = new Uint32Array(clusters * 2 * tile);
  const sourceSpheres = new Float32Array(clusters * 4 * tile);
  let indices = 0;
  for (let slot = 0; slot < clusters * tile; slot += 1) {
    const cluster = slot % clusters;
    // A 12-triangle cluster, which is what the bake's finest level produces.
    ranges[slot * 2] = indices;
    ranges[slot * 2 + 1] = 12;
    indices += 12;
    const level = Math.min(levels - 1, Math.floor(Math.log2(cluster / 8 + 1)));
    const radius = 40 / 2 ** level;
    const angle = cluster * 2.399963;
    const distance = 220 * Math.cbrt((slot / (clusters * tile)) * 1);
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance * 0.4;
    const z = Math.sin(angle * 1.7) * distance;
    bounds.set([x, y, z, radius], slot * 4);
    sourceSpheres.set([x, y, z, radius * 2], slot * 4);
    parentSpheres.set([x, y, z, radius * 4], slot * 4);
    // A level-0 cluster shows no error; each level above shows twice the one below.
    errors[slot * 2] = level === 0 ? 0 : 2 ** (level - 1) * 0.0008;
    errors[slot * 2 + 1] = 2 ** level * 0.0008;
  }
  return {
    bounds,
    cones,
    errors,
    indices: new Uint32Array(indices),
    parentSpheres,
    ranges,
    sourceSpheres,
  };
}

describe.skipIf(process.env.TN_BENCH !== "1")("the cost of asset size (TN_BENCH=1)", () => {
  it("the flat scan follows the table's size, not the size of the cut", () => {
    const scale = 1080 / (2 * Math.tan((60 * Math.PI) / 360));
    const camera = new Vector3(0, 40, 260);
    const timings: number[] = [];
    for (const tile of [1, 2, 4, 8]) {
      const packed = cliffTable(tile);
      const out = new Uint32Array(packed.ranges.length / 2);
      const runs: number[] = [];
      let selected = 0;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        selected = selectClusterCut(packed, camera, scale, 1, out);
        runs.push(performance.now() - started);
      }
      // The minimum, not the median: this runs wherever someone asked for the number, and on a
      // loaded machine the noise is all upward — the fastest run is the closest to the cost.
      const fastest = runs.sort((a, b) => a - b)[0] as number;
      timings.push(fastest);
      // Pasted into the PRD: the number Phase 1's gate is priced with.
      console.log(
        `TN_CLUSTER_SCAN:${JSON.stringify({ clusters: packed.ranges.length / 2, ms: fastest, selected, tile })}`,
      );
    }
    // Eight times the table costs more than twice the time: the scan follows the asset, not the cut.
    // Deliberately loose, because a busy machine can make one tile read slower than a bigger one;
    // the printed numbers are the measurement, this is the guard against the scan having become
    // constant in the asset's size.
    expect(timings.at(-1) as number).toBeGreaterThan((timings[0] as number) * 2);
  }, 600_000);
});

describe("the view-pruned walk", () => {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  /** Seeded, so a failure names the pose that produced it and the run repeats exactly. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  /** `count` poses standing `4..30` units from the body and aimed near it. */
  function poses(count: number): PerspectiveCamera[] {
    const random = seeded(600);
    const made: PerspectiveCamera[] = [];
    for (let index = 0; index < count; index += 1) {
      const pose = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
      const distance = 4 + random() * 26;
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      pose.position.set(
        Math.sin(phi) * Math.cos(theta) * distance,
        Math.cos(phi) * distance,
        Math.sin(phi) * Math.sin(theta) * distance,
      );
      pose.lookAt((random() - 0.5) * 0.6, (random() - 0.5) * 0.6, (random() - 0.5) * 0.6);
      pose.updateMatrixWorld(true);
      made.push(pose);
    }
    return made;
  }

  /**
   * The clusters the walk should keep, computed the long way: the oracle's own set, minus anything
   * whose descent the view volume would rightly stop.
   *
   * A subtree is only pruned at a cluster too coarse to draw, and the sphere tested there is the one
   * that produced that cluster — which encloses everything below it (checked by the bake's own
   * invariant in the DAG spec). An oracle cluster therefore survives exactly when every ancestor's
   * producing sphere touches the frustum.
   */
  function expectedCut(pose: PerspectiveCamera, scale: number): number[] {
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(pose.projectionMatrix, pose.matrixWorldInverse),
    );
    const eye = new Vector3().setFromMatrixPosition(pose.matrixWorld);
    const out = new Uint32Array(dag.clusters.length);
    const selected = selectClusterCut(table, eye, scale, 1, out);
    const sourceGroups = new Uint32Array(dag.clusters.length).fill(NO_CLUSTER_GROUP);
    for (let group = 0; group < dag.groups.length; group += 1)
      for (const parent of (dag.groups[group] as (typeof dag.groups)[number]).parents)
        sourceGroups[parent] = group;
    const parentsOf = (cluster: number): number[] => {
      const group = (dag.clusters[cluster] as (typeof dag.clusters)[number]).group;
      return group < 0 ? [] : [...(dag.groups[group] as (typeof dag.groups)[number]).parents];
    };
    const kept: number[] = [];
    for (let slot = 0; slot < selected; slot += 1) {
      const cluster = out[slot] as number;
      let ancestor = cluster;
      let survives = true;
      for (;;) {
        const parents = parentsOf(ancestor);
        if (parents.length === 0) break;
        ancestor = parents[0] as number;
        const sphere = (dag.clusters[ancestor] as (typeof dag.clusters)[number]).sourceSphere;
        const centre = new Vector3(sphere.x, sphere.y, sphere.z);
        if (!frustum.intersectsSphere(new Sphere(centre, sphere.radius))) {
          survives = false;
          break;
        }
      }
      if (survives) kept.push(cluster);
    }
    return kept;
  }

  it("AC-1 — selects exactly what the oracle selects of what the view holds, on 200 poses", () => {
    const walk = new ClusterWalk(table);
    const view = new ClusterView();
    const out = new Uint32Array(dag.clusters.length);
    const scale = 1080 / (2 * Math.tan((60 * Math.PI) / 360));
    const wrong: { clusters: number; expected: number; pose: number }[] = [];
    poses(200).forEach((pose, index) => {
      view.setFromCamera(pose, 0);
      view.setTransform(new Matrix4());
      const eye = new Vector3().setFromMatrixPosition(pose.matrixWorld);
      const walked = [...out.subarray(0, walk.select(eye, scale, 1, view, out))];
      const expected = expectedCut(pose, scale);
      const difference = walked.filter((cluster) => !expected.includes(cluster)).length;
      if (walked.length !== expected.length || difference > 0)
        wrong.push({ clusters: difference, expected: expected.length, pose: index });
    });
    // Zero differences, both ways: nothing the view holds is dropped and nothing extra is drawn.
    expect(wrong).toEqual([]);
  });

  it("AC-1 — a turn inside the margin keeps a cut that is still complete", () => {
    const scale = 1080 / (2 * Math.tan((60 * Math.PI) / 360));
    const margin = 0.15;
    const walk = new ClusterWalk(table);
    const view = new ClusterView();
    const out = new Uint32Array(dag.clusters.length);
    const cutAt = (pose: PerspectiveCamera): number[] => {
      view.setFromCamera(pose, margin);
      view.setTransform(new Matrix4());
      const eye = new Vector3().setFromMatrixPosition(pose.matrixWorld);
      return [...out.subarray(0, walk.select(eye, scale, 1, view, out))];
    };
    const turned = (pose: PerspectiveCamera): PerspectiveCamera => {
      const copy = pose.clone();
      const spin = new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0).applyQuaternion(pose.quaternion),
        margin * 0.8,
      );
      copy.quaternion.premultiply(spin);
      copy.updateMatrixWorld(true);
      return copy;
    };
    const missing: number[] = [];
    poses(200).forEach((pose, index) => {
      const kept = cutAt(pose);
      // What the turned camera needs has to be inside what the unturned one kept: this is the hole
      // a turn would otherwise reveal, and the reason the frustum is widened at all.
      for (const cluster of cutAt(turned(pose)))
        if (!kept.includes(cluster)) {
          missing.push(index);
          break;
        }
    });
    expect(missing).toEqual([]);
  });

  it("cuts the same mesh to the same triangles through `update`", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    expect(mesh.viewCullReport).toBe("on");
    const walk = new ClusterWalk(table);
    const view = new ClusterView();
    const out = new Uint32Array(dag.clusters.length);
    const scale = 1080 / (2 * Math.tan((60 * Math.PI) / 360));
    for (const pose of poses(20)) {
      camera.copy(pose);
      camera.updateMatrixWorld(true);
      mesh.update(camera, 1080);
      view.setFromCamera(camera, mesh.viewMargin);
      view.setTransform(new Matrix4());
      const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
      const selected = walk.select(eye, scale, 1, view, out);
      let triangles = 0;
      for (let slot = 0; slot < selected; slot += 1)
        triangles += (table.ranges[(out[slot] as number) * 2 + 1] as number) / 3;
      expect(mesh.drawnTriangles).toBe(triangles);
    }
  });

  it("draws nothing outside the view that the oracle would have drawn", () => {
    // The point of the exercise, on the body this spec bakes: a camera that sees a corner of it
    // submits fewer triangles than the oracle does, and the triangles it drops are the ones behind.
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      viewCull: false,
    });
    // Close enough that the body spills out of the frame at 60 degrees, which is the case a mesh in
    // a route is in most of the time.
    camera.position.set(0, 0, 2);
    camera.lookAt(0, 0, 0);
    const whole = mesh.update(camera, 1080);
    const behind = mesh.drawnTrianglesOutsideView;
    mesh.viewCull = true;
    const pruned = mesh.update(camera, 1080);

    expect(behind).toBeGreaterThan(0);
    expect(pruned).toBeLessThan(whole);
    expect(mesh.viewCullReport).toBe("on");
  });

  it("keeps the unpruned cut, and says so, for a mesh that casts shadows", () => {
    const probe = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table);
    probe.castShadow = true;
    const unpruned = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      viewCull: false,
    });
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    expect(probe.viewCullReport).toBe("off (castShadow)");
    expect(probe.update(camera, 1080)).toBe(unpruned.update(camera, 1080));
  });

  it("keeps the unpruned cut, and says so, when the game turns it off", () => {
    const mesh = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      viewCull: false,
    });
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    const unpruned = new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, {
      viewCull: false,
    });

    expect(mesh.viewCullReport).toBe("off (viewCull = false)");
    expect(mesh.update(camera, 1080)).toBe(unpruned.update(camera, 1080));
  });

  it("refuses a margin no camera turn can be measured by", () => {
    expect(
      () => new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, { viewMargin: -1 }),
    ).toThrow(/viewMargin must be a turn/u);
    expect(
      () => new ClusteredMesh(geometry(), new MeshBasicMaterial(), table, { viewMargin: 2 }),
    ).toThrow(/viewMargin must be a turn/u);
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
    // And it is the selected clusters' triangles. The *order* clusters come out in is the walk's
    // own — it descends the DAG rather than scanning the table — so the claim compared here is the
    // one that matters to the GPU: the same triangles, none missing and none extra.
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
    const trianglesOf = (values: ArrayLike<number>): string[] => {
      const keys: string[] = [];
      for (let slot = 0; slot < values.length; slot += 3)
        keys.push(
          [values[slot] as number, values[slot + 1] as number, values[slot + 2] as number]
            .sort((left, right) => left - right)
            .join(","),
        );
      return keys.sort();
    };
    expect(trianglesOf(drawn)).toEqual(trianglesOf(expected));
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
