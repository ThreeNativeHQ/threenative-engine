import {
  BoxGeometry,
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Scene,
  Texture,
  TorusKnotGeometry,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { GPUSceneBVH } from "../src/gpu-scene-bvh.js";
import { type IThreadedScene, flatMaterial, threadScene } from "../src/render/probe-trace.js";

/** The slab test the kernel runs: where the ray enters and leaves a node's box. */
function slab(
  scene: IThreadedScene,
  node: number,
  o: number[],
  inverse: number[],
): [number, number] {
  let near = Number.NEGATIVE_INFINITY;
  let exit = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const t0 = ((scene.bounds[node * 8 + axis] ?? 0) - (o[axis] ?? 0)) * (inverse[axis] ?? 0);
    const t1 = ((scene.bounds[node * 8 + 4 + axis] ?? 0) - (o[axis] ?? 0)) * (inverse[axis] ?? 0);
    near = Math.max(near, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
  }
  return [near, exit];
}

/** The kernel's walk, on the CPU: follow the left child on a box hit, the miss link otherwise. */
function walk(
  scene: IThreadedScene,
  origin: Vector3,
  direction: Vector3,
): { t: number; triangle: number } {
  const best = { t: Number.POSITIVE_INFINITY, triangle: -1 };
  const inverse = [1 / direction.x, 1 / direction.y, 1 / direction.z];
  const o = origin.toArray();
  const d = direction.toArray();
  let node = 0;
  for (let step = 0; step < scene.nodeCount * 2 + 1 && node < scene.nodeCount; step += 1) {
    const [near, exit] = slab(scene, node, o, inverse);
    const boxHit = exit >= Math.max(near, 0) && near < best.t;
    const [miss = 0, offset = 0, count = 0, leaf = 0] = scene.links.subarray(
      node * 4,
      node * 4 + 4,
    );
    if (!boxHit || leaf !== 1) {
      node = boxHit ? node + 1 : miss;
      continue;
    }
    for (let triangle = offset; triangle < offset + count; triangle += 1) {
      const t = triangleHit(scene, triangle, o, d);
      if (t > 1e-4 && t < best.t) Object.assign(best, { t, triangle });
    }
    node = miss;
  }
  return best;
}

function triangleHit(scene: IThreadedScene, triangle: number, o: number[], d: number[]): number {
  const v = (corner: number) =>
    new Vector3().fromArray(scene.triangles, triangle * 12 + corner * 4);
  const a = v(0);
  const e1 = v(1).sub(a);
  const e2 = v(2).sub(a);
  const dir = new Vector3().fromArray(d);
  const p = new Vector3().crossVectors(dir, e2);
  const det = e1.dot(p);
  if (Math.abs(det) < 1e-12) return -1;
  const s = new Vector3().fromArray(o).sub(a);
  const u = s.dot(p) / det;
  const q = new Vector3().crossVectors(s, e1);
  const w = dir.dot(q) / det;
  if (u < 0 || w < 0 || u + w > 1) return -1;
  return e2.dot(q) / det;
}

/** Exact closest hit over every triangle: the referee. */
function bruteForce(scene: IThreadedScene, origin: Vector3, direction: Vector3): number {
  let best = Number.POSITIVE_INFINITY;
  const o = [origin.x, origin.y, origin.z];
  const d = [direction.x, direction.y, direction.z];
  for (let triangle = 0; triangle < scene.triangles.length / 12; triangle += 1) {
    const t = triangleHit(scene, triangle, o, d);
    if (t > 1e-4 && t < best) best = t;
  }
  return best;
}

function room(): Scene {
  const scene = new Scene();
  const walls = new Mesh(
    new BoxGeometry(12, 4, 12, 3, 2, 3),
    new MeshStandardMaterial({ color: 0xcccccc }),
  );
  walls.position.y = 2;
  scene.add(walls);
  const knot = new Mesh(
    new TorusKnotGeometry(0.8, 0.25, 64, 8),
    new MeshBasicMaterial({ color: 0xff2200 }),
  );
  knot.position.set(2, 1.5, -1);
  scene.add(knot);
  const rocks = new InstancedMesh(new IcosahedronGeometry(0.5, 2), new MeshStandardMaterial(), 6);
  for (let index = 0; index < 6; index += 1) {
    rocks.setMatrixAt(index, new Matrix4().makeTranslation(-4 + index * 1.5, 0.5, 3 - index));
  }
  scene.add(rocks);
  return scene;
}

describe("probe trace scene (PRD-603)", () => {
  it("walks the threaded BVH to the exact closest hit with no stack", () => {
    const bvh = new GPUSceneBVH(room());
    const threaded = threadScene(bvh.traceScene);
    expect(threaded.nodeCount).toBeGreaterThan(10);
    let state = 603;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    let hits = 0;
    for (let ray = 0; ray < 400; ray += 1) {
      const origin = new Vector3(
        (random() - 0.5) * 10,
        0.2 + random() * 3.5,
        (random() - 0.5) * 10,
      );
      const direction = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
      const expected = bruteForce(threaded, origin, direction);
      const found = walk(threaded, origin, direction);
      expect(found.t).toBeCloseTo(expected, 5);
      if (Number.isFinite(expected)) hits += 1;
    }
    // Inside a closed room every ray hits something.
    expect(hits).toBe(400);
  });

  it("gives every triangle the slot of its own material, across meshes, groups and instances", () => {
    const scene = room();
    const bvh = new GPUSceneBVH(scene);
    const { materials, triangleMaterials } = bvh.traceScene;
    expect(materials).toHaveLength(3);
    const threaded = threadScene(bvh.traceScene);
    // Each triangle's slot names the material of the mesh it came from, in first-seen order.
    const count = (slot: number) => triangleMaterials.filter((value) => value === slot).length;
    const elements = (mesh: Mesh) =>
      mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count;
    const walls = elements(scene.children[0] as Mesh);
    const knot = elements(scene.children[1] as Mesh);
    const rock = elements(scene.children[2] as Mesh);
    expect([count(0), count(1), count(2)]).toEqual([walls / 3, knot / 3, (rock / 3) * 6]);
    expect(threaded.triangles[3]).toBe(triangleMaterials[0]);
  });

  it("reads lit, unlit and textured materials into the flat table", () => {
    const lit = flatMaterial(
      new MeshStandardMaterial({ color: 0x808080, emissive: 0x220000, emissiveIntensity: 3 }),
    );
    expect(lit.albedo.toArray()).toEqual(new Color(0x808080).toArray());
    expect(lit.emission.r).toBeCloseTo(new Color(0x220000).r * 3, 6);
    expect(lit.ignored).toBe(false);
    const unlit = flatMaterial(
      new MeshBasicMaterial({ color: new Color(0xff0030).multiplyScalar(12) }),
    );
    expect(unlit.albedo.toArray()).toEqual([0, 0, 0]);
    expect(unlit.emission.r).toBeCloseTo(12, 5);
    expect(flatMaterial(new MeshStandardMaterial({ map: new Texture() })).ignored).toBe(true);
  });
});
