import { MeshoptSimplifier } from "meshoptimizer";
import { SphereGeometry, TorusKnotGeometry } from "three";
import { describe, expect, it } from "vitest";
import { type IClusterDag, buildClusterDag, selectCut } from "../src/virtual/dag.js";

// PRD-281's whole claim is one invariant: a parent's error is never below its children's, and the
// cut that follows from it is watertight at every threshold. These tests take the cut at many
// thresholds on real dense bodies and count holes, and then break the two things that make it hold
// — the monotonic error and the locked group boundary — to show that each of them is load-bearing
// rather than decorative.

interface IBody {
  readonly indices: Uint32Array;
  readonly positions: Float32Array;
}

function fromGeometry(geometry: { attributes: unknown; index: unknown }): IBody {
  const attribute = (geometry.attributes as { position: { array: ArrayLike<number> } }).position;
  const index = geometry.index as { array: ArrayLike<number> } | null;
  if (index === null) throw new Error("test bodies must be indexed");
  return {
    indices: Uint32Array.from(index.array),
    positions: Float32Array.from(attribute.array),
  };
}

/** Several closed shells that touch nothing, which is the case the partition has no adjacency for. */
function manyShells(count: number): IBody {
  const indices: number[] = [];
  const positions: number[] = [];
  for (let shell = 0; shell < count; shell += 1) {
    const geometry = fromGeometry(new SphereGeometry(0.5, 32, 16) as never);
    const base = positions.length / 3;
    for (let slot = 0; slot < geometry.positions.length; slot += 3) {
      positions.push((geometry.positions[slot] as number) + shell * 4);
      positions.push(geometry.positions[slot + 1] as number);
      positions.push(geometry.positions[slot + 2] as number);
    }
    for (const value of geometry.indices) indices.push(value + base);
  }
  return { indices: Uint32Array.from(indices), positions: Float32Array.from(positions) };
}

/** Disconnected alpha-cutout cards — the shape a Fab foliage primitive is, and why it stalls. */
function cards(count: number): IBody {
  const indices: number[] = [];
  const positions: number[] = [];
  const perRow = Math.ceil(Math.sqrt(count));
  for (let card = 0; card < count; card += 1) {
    const base = positions.length / 3;
    const x = (card % perRow) * 2;
    const y = Math.floor(card / perRow) * 2;
    positions.push(x, y, 0, x + 0.5, y, 0, x + 0.5, y + 0.5, 0, x, y + 0.5, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { indices: Uint32Array.from(indices), positions: Float32Array.from(positions) };
}

function edgeKey(a: number, b: number): number {
  return a < b ? a * 4294967296 + b : b * 4294967296 + a;
}

function countEdges(indices: ArrayLike<number>, weld: Uint32Array): Map<number, number> {
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

interface ICutSeams {
  /** Interior edges the cut left open — a hole the camera can see through. */
  readonly holes: number;
  /** Edges covered more than twice — the same surface drawn by two levels at once. */
  readonly overlaps: number;
  readonly triangles: number;
}

function inspectCut(dag: IClusterDag, body: IBody, threshold: number): ICutSeams {
  const weld = MeshoptSimplifier.generatePositionRemap(body.positions, 3);
  const sourceEdges = countEdges(body.indices, weld);
  const cut: number[] = [];
  for (const cluster of selectCut(dag, threshold)) {
    const record = dag.clusters[cluster] as (typeof dag.clusters)[number];
    for (let slot = record.start; slot < record.start + record.count; slot += 1)
      cut.push(dag.indices[slot] as number);
  }
  const uses = countEdges(cut, weld);
  let holes = 0;
  let overlaps = 0;
  for (const [key, count] of uses) {
    // An edge the source mesh itself only used once is a real border, not a hole in the cut.
    if (count === 1 && (sourceEdges.get(key) ?? 0) !== 1) holes += 1;
    if (count > 2 && (sourceEdges.get(key) ?? 0) <= 2) overlaps += 1;
  }
  return { holes, overlaps, triangles: cut.length / 3 };
}

/** Every group error, plus a sweep either side of it: the boundary cases are where a cut cracks. */
function thresholds(dag: IClusterDag): number[] {
  const errors = dag.groups.map((group) => group.error).sort((a, b) => a - b);
  const top = (errors[errors.length - 1] ?? 1) * 1.5;
  const sampled = new Set<number>([0, top]);
  for (const error of errors) {
    sampled.add(error);
    sampled.add(error * 0.999);
    sampled.add(error * 1.001);
  }
  for (let step = 0; step <= 40; step += 1) sampled.add((top * step) / 40);
  return [...sampled].sort((a, b) => a - b);
}

describe("the cluster DAG", () => {
  it("cuts without a hole at every threshold, on a dense closed body", async () => {
    const body = fromGeometry(new TorusKnotGeometry(1, 0.4, 256, 32) as never);
    const dag = await buildClusterDag(body.indices, body.positions);

    const cracked = thresholds(dag)
      .map((threshold) => ({ threshold, ...inspectCut(dag, body, threshold) }))
      .filter((row) => row.holes > 0 || row.overlaps > 0);
    expect(cracked).toEqual([]);
  }, 120_000);

  it("cuts without a hole at every threshold, on a body of disconnected shells", async () => {
    const body = manyShells(12);
    const dag = await buildClusterDag(body.indices, body.positions);

    const cracked = thresholds(dag)
      .map((threshold) => ({ threshold, ...inspectCut(dag, body, threshold) }))
      .filter((row) => row.holes > 0 || row.overlaps > 0);
    expect(cracked).toEqual([]);
  }, 120_000);

  it("never records a parent error below a child's", async () => {
    const body = fromGeometry(new TorusKnotGeometry(1, 0.4, 256, 32) as never);
    const dag = await buildClusterDag(body.indices, body.positions);

    const inversions = dag.groups.filter((group) =>
      group.children.some(
        (child) => (dag.clusters[child] as { error: number }).error > group.error,
      ),
    );
    expect(inversions).toEqual([]);
    expect(dag.groups.length).toBeGreaterThan(0);
  }, 120_000);

  it("AC2 red — dropping the children's errors from the parent's cracks the cut", async () => {
    const body = fromGeometry(new TorusKnotGeometry(1, 0.4, 256, 32) as never);
    const dag = await buildClusterDag(body.indices, body.positions);

    // The mutation PRD-281 §1 names: `parentError = groupSimplifyError` instead of
    // `max(groupSimplifyError, max(childErrors))`. Nothing else about the bake changes.
    const mutated: IClusterDag = {
      ...dag,
      clusters: dag.clusters.map((cluster) =>
        cluster.group === -1
          ? cluster
          : {
              ...cluster,
              parentError: (dag.groups[cluster.group] as { simplifyError: number }).simplifyError,
            },
      ),
    };

    const cracked = thresholds(dag)
      .map((threshold) => ({ threshold, ...inspectCut(mutated, body, threshold) }))
      .filter((row) => row.holes > 0);
    expect(cracked.length).toBeGreaterThan(0);
  }, 120_000);

  it("AC3 red — simplifying a group with its rim free cracks the cut", async () => {
    const body = fromGeometry(new TorusKnotGeometry(1, 0.4, 256, 32) as never);
    const dag = await buildClusterDag(body.indices, body.positions, { unlockGroupBoundary: true });

    const cracked = thresholds(dag)
      .map((threshold) => ({ threshold, ...inspectCut(dag, body, threshold) }))
      .filter((row) => row.holes > 0);
    expect(cracked.length).toBeGreaterThan(0);
  }, 120_000);

  it("AC4 — the same input bytes bake to the same DAG", async () => {
    const body = fromGeometry(new SphereGeometry(1, 128, 64) as never);
    const first = await buildClusterDag(body.indices, body.positions);
    const second = await buildClusterDag(body.indices, body.positions);

    expect(second.indices).toEqual(first.indices);
    expect(second.clusters).toEqual(first.clusters);
    expect(second.groups).toEqual(first.groups);
  }, 180_000);

  it("AC6 — one connected body converges to a single root, shedding half a level at a time", async () => {
    const body = fromGeometry(new TorusKnotGeometry(1, 0.4, 256, 32) as never);
    const dag = await buildClusterDag(body.indices, body.positions);

    expect(dag.stopReason).toBe("root");
    expect(dag.roots).toHaveLength(1);
    for (let level = 1; level < dag.levels.length; level += 1) {
      const previous = (dag.levels[level - 1] as { triangleCount: number }).triangleCount;
      const current = (dag.levels[level] as { triangleCount: number }).triangleCount;
      expect(current).toBeLessThanOrEqual(previous * 0.98);
    }
  }, 120_000);

  it("AC6 — the awful body terminates on the shells' own floor, not on the level cap", async () => {
    const body = manyShells(12);
    const dag = await buildClusterDag(body.indices, body.positions);

    // meshoptimizer will not take a closed shell below about 64 triangles, so twelve of them cannot
    // become one cluster. The loop is required to *stop*, know that it stopped, and leave a root
    // set that is still watertight — which the crack test above already showed it is.
    expect(dag.stopReason).toBe("stalled");
    expect(dag.roots.length).toBeGreaterThan(1);
    expect(dag.roots.length).toBeLessThan(
      (dag.levels[0] as { clusterCount: number }).clusterCount / 4,
    );
  }, 120_000);

  it("AC6 red — a level cap the body cannot reach is reported as a cap", async () => {
    const body = fromGeometry(new TorusKnotGeometry(1, 0.4, 256, 32) as never);
    const dag = await buildClusterDag(body.indices, body.positions, { maxLevels: 2 });

    expect(dag.stopReason).toBe("cap");
    expect(dag.roots.length).toBeGreaterThan(1);
  }, 120_000);

  it("AC6 red — a body of alpha-cutout cards stalls on its very first fold, at 100%", async () => {
    const body = cards(400);
    const dag = await buildClusterDag(body.indices, body.positions);

    // Not the shells' 64-triangle floor: no collapse at all. Every edge of every card is a border
    // edge, so `LockBorder` holds the whole body still and the only remaining candidates are the
    // quads' diagonals, which collapse to nothing. PRD-485's Hornbeam foliage: 745,328 triangles
    // whose DAG therefore reports every level at the source count, and the bake declines it.
    expect(dag.stopReason).toBe("stalled");
    expect(dag.groups).toHaveLength(0);
    for (const level of dag.levels) expect(level.triangleCount).toBe(body.indices.length / 3);
  }, 120_000);

  it("refuses a malformed mesh rather than baking nonsense", async () => {
    await expect(buildClusterDag(new Uint32Array([0, 1]), new Float32Array(9))).rejects.toThrow(
      /non-empty triangle list/,
    );
    await expect(buildClusterDag(new Uint32Array([0, 1, 9]), new Float32Array(9))).rejects.toThrow(
      /outside the 3-vertex buffer/,
    );
  });
});
