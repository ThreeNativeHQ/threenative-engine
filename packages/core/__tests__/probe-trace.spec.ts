import {
  BackSide,
  BoxGeometry,
  Color,
  DoubleSide,
  FrontSide,
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
import { color } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { GPUSceneBVH } from "../src/gpu-scene-bvh.js";
import { buildCpuBvh } from "../src/render/cpu-bvh.js";
import {
  type IThreadedScene,
  applyTraceLighting,
  fillRejectedProbes,
  flatMaterial,
  lightingKey,
  lightingStepped,
  octahedralCell,
  octahedralRayTable,
  probeRayDirections,
  threadScene,
  writeMaterialTable,
} from "../src/render/probe-trace.js";

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
  it("steps the lighting at more than one degree or a 4x brightest-channel change", () => {
    const key = (degrees: number, sun: number, sky = 0.2) =>
      lightingKey({
        color: new Color(1, 0.5, 0.2),
        direction: new Vector3(
          Math.sin((degrees * Math.PI) / 180),
          Math.cos((degrees * Math.PI) / 180),
          0,
        ),
        intensity: sun,
        sky: new Color(sky, sky, sky),
      });
    const from = key(0, 1);
    expect(lightingStepped(from, key(0.9, 1))).toBe(false);
    expect(lightingStepped(from, key(1.1, 1))).toBe(true);
    expect(lightingStepped(from, key(0, 3.9))).toBe(false);
    expect(lightingStepped(from, key(0, 4.1))).toBe(true);
    expect(lightingStepped(from, key(0, 0.26))).toBe(false);
    expect(lightingStepped(from, key(0, 0.24))).toBe(true);
    expect(lightingStepped(from, key(0, 1, 1.0))).toBe(true);
    expect(lightingStepped(key(0, 0), key(0, 0))).toBe(false);
    expect(lightingStepped(key(0, 0), key(0, 1))).toBe(true);
    // A scene with no sun (cornell) passes a zero direction: an unlit sun has no direction to step, and three's
    // angleTo reads a zero vector as 90 degrees, which restarted the bake every frame (PRD-831).
    const dark = (x: number, y: number, z: number) =>
      lightingKey({
        color: new Color(0, 0, 0),
        direction: new Vector3(x, y, z),
        intensity: 0,
        sky: new Color(),
      });
    expect(lightingStepped(dark(0, 0, 0), dark(0, 0, 0))).toBe(false);
    expect(lightingStepped(dark(0, 1, 0), dark(1, 0, 0))).toBe(false);
  });

  it("reports a material table unchanged on a second write, even for a colour float32 rounds", () => {
    const material = new MeshBasicMaterial({ color: new Color(0xff0030).multiplyScalar(12) });
    const table = new Float32Array(8);
    expect(writeMaterialTable([material], table).changed).toBe(true);
    expect(writeMaterialTable([material], table).changed).toBe(false);
    material.color.setRGB(0, 0, 0);
    expect(writeMaterialTable([material], table).changed).toBe(true);
    // The side word is how the kernel skips a one-sided surface it meets from behind.
    const sides = [FrontSide, BackSide, DoubleSide].map((side) => {
      const sided = new Float32Array(8);
      writeMaterialTable([new MeshBasicMaterial({ side })], sided);
      return sided[3];
    });
    expect(sides).toEqual([0, 1, 2]);
  });

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
    // A node-coloured unlit surface displays computed light, so it emits none of its own.
    const display = new MeshBasicNodeMaterial();
    display.colorNode = color(0xffffff);
    expect(flatMaterial(display)).toMatchObject({ ignored: true });
    expect(flatMaterial(display).emission.toArray()).toEqual([0, 0, 0]);
    expect(flatMaterial(new MeshBasicNodeMaterial({ color: 0x00ff00 })).emission.g).toBe(1);
  });
});

describe("point lights in the trace lighting (PRD-831)", () => {
  it("copies a point light into the kernel uniforms and clears a light the game removed", () => {
    const kernels = {
      points: [0, 1].map(() => ({
        distance: { value: -1 },
        position: { value: new Vector3() },
        radiance: { value: new Vector3() },
      })),
      sky: { value: new Vector3() },
      sunDirection: { value: new Vector3() },
      sunRadiance: { value: new Vector3() },
    } as unknown as Parameters<typeof applyTraceLighting>[0];
    const lighting = {
      color: new Color(1, 1, 1),
      direction: new Vector3(0, 1, 0),
      intensity: 0,
      points: [
        { color: new Color(1, 0.5, 0), distance: 20, intensity: 4, position: new Vector3(1, 2, 3) },
      ],
      sky: new Color(0, 0, 0),
    };
    applyTraceLighting(kernels, lighting);
    expect(kernels.points[0]?.radiance.value.toArray()).toEqual([4, 2, 0]);
    expect(kernels.points[0]?.position.value.toArray()).toEqual([1, 2, 3]);
    expect(kernels.points[0]?.distance.value).toBe(20);
    expect(kernels.points[1]?.radiance.value.toArray()).toEqual([0, 0, 0]);
    applyTraceLighting(kernels, { ...lighting, points: undefined });
    expect(kernels.points[0]?.radiance.value.toArray()).toEqual([0, 0, 0]);
  });
});

describe("the CPU BVH for an engine whose MeshBVH builds no tree (PRD-831)", () => {
  it("finds the same closest hit as every triangle tested, for 300 rays", () => {
    const geometry = new TorusKnotGeometry(1, 0.3, 64, 8);
    const source = geometry.getAttribute("position").array as Float32Array;
    const index = Uint32Array.from(geometry.getIndex()?.array ?? []);
    const { nodes, order } = buildCpuBvh(source, index);
    const ordered = new Uint32Array(index.length);
    order.forEach((triangle, slot) => {
      ordered.set(index.subarray(triangle * 3, triangle * 3 + 3), slot * 3);
    });
    const padded = new Float32Array((source.length / 3) * 4);
    for (let vertex = 0; vertex < source.length / 3; vertex += 1)
      padded.set(source.subarray(vertex * 3, vertex * 3 + 3), vertex * 4);
    const scene = threadScene({
      indices: ordered,
      materials: [new MeshStandardMaterial()],
      nodes,
      positions: padded,
      triangleMaterials: new Uint32Array(index.length / 3),
    });
    expect([...order].sort((a, b) => a - b)).toEqual(
      Array.from({ length: index.length / 3 }, (_, i) => i),
    );
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let hits = 0;
    for (let ray = 0; ray < 300; ray += 1) {
      const origin = new Vector3(random() * 8 - 4, random() * 8 - 4, random() * 8 - 4);
      const direction = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
      const expected = bruteForce(scene, origin, direction);
      const found = walk(scene, origin, direction).t;
      if (Number.isFinite(expected)) hits += 1;
      expect(found).toBeCloseTo(expected, 4);
    }
    expect(hits).toBeGreaterThan(10);
  });
});

describe("rejected probes take their open neighbours' light (PRD-603)", () => {
  it("fills a probe that saw back faces from its open face neighbours, ring by ring, and counts it", () => {
    // A 4 x 1 x 1 row: probe 0 sits inside a wall (every ray met a back face), probe 1 behind it saw a few, 2 and 3 are open.
    const coefficients = new Float32Array(4 * 27);
    coefficients.fill(100, 0, 27); // the outside light the walled-in probe saw
    coefficients.fill(80, 27, 54);
    coefficients.fill(2, 54, 81);
    coefficients.fill(4, 81, 108);
    const shares = Float32Array.from([1, 0.1, 0, 0]);
    const rejected = fillRejectedProbes(coefficients, shares, { x: 4, y: 1, z: 1 });
    expect(rejected).toBe(2);
    // Probe 1 takes probe 2 (its one open neighbour); probe 0 then takes probe 1.
    expect(coefficients[27]).toBe(2);
    expect(coefficients[0]).toBe(2);
    expect(coefficients[81]).toBe(4);
  });

  it("keeps an open probe as traced and leaves a field with no open probe unchanged", () => {
    const coefficients = new Float32Array(2 * 27).fill(7);
    expect(
      fillRejectedProbes(coefficients, Float32Array.from([0, 1 / 64]), { x: 2, y: 1, z: 1 }),
    ).toBe(0);
    expect(fillRejectedProbes(coefficients, Float32Array.from([1, 1]), { x: 2, y: 1, z: 1 })).toBe(
      2,
    );
    expect([...coefficients].every((v) => v === 7)).toBe(true);
  });
});

describe("an octahedral radiance map per probe, as Unreal's radiance cache stores (PRD-831)", () => {
  it("puts each ray in the cell its direction encodes to, and gives every cell at least one ray", () => {
    const rays = 1024;
    const resolution = 8;
    const directions = probeRayDirections(rays);
    const table = octahedralRayTable(directions, rays, resolution);
    const cells = resolution * resolution;
    let entries = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      const count = table.ranges[cell * 4 + 1] ?? 0;
      expect(count).toBeGreaterThan(0);
      entries += count;
    }
    // 1,024 rays over 64 cells: no cell is empty, so no ray is reused.
    expect(entries).toBe(rays);
    for (let cell = 0; cell < cells; cell += 1) {
      const start = table.ranges[cell * 4] ?? 0;
      const ray = table.rays[start * 4] ?? 0;
      const d = [
        directions[ray * 4] ?? 0,
        directions[ray * 4 + 1] ?? 0,
        directions[ray * 4 + 2] ?? 0,
      ];
      expect(octahedralCell(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, resolution)).toBe(cell);
    }
  });

  it("fills an empty cell with the nearest ray when there are fewer rays than cells", () => {
    const table = octahedralRayTable(probeRayDirections(16), 16, 8);
    for (let cell = 0; cell < 64; cell += 1) expect(table.ranges[cell * 4 + 1]).toBeGreaterThan(0);
  });

  it("maps the six axes to six different cells", () => {
    const axes = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const;
    const cells = new Set(axes.map(([x, y, z]) => octahedralCell(x, y, z, 8)));
    expect(cells.size).toBe(6);
  });

  it("fills a rejected probe's map from its open neighbours, beside its SH", () => {
    const coefficients = new Float32Array(2 * 27).fill(5);
    const maps = new Float32Array(2 * 4).fill(0);
    maps.fill(9, 4, 8);
    fillRejectedProbes(coefficients, Float32Array.from([1, 0]), { x: 2, y: 1, z: 1 }, [
      { data: maps, stride: 4 },
    ]);
    expect([...maps.slice(0, 4)]).toEqual([9, 9, 9, 9]);
  });
});
