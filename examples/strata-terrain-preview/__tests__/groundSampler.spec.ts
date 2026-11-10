import { createRequire } from "node:module";
import { Heightfield, surfaceSampler } from "@threenative/core/world";
import { Mesh, Raycaster, Vector3 } from "three";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The drawn mesh is the reference: every case compares the sampler with a stock Three `Raycaster`
 * on the same geometry, never with a mirrored copy of the sampler's own formula. The last case
 * takes the collider itself as the reference, because that is the ground the player walks on.
 */
function sampleCase(heights: number[], size: number, rows: number, columns: number) {
  const field = new Heightfield({
    rows,
    columns,
    width: size,
    depth: size,
    origin: { x: 0, z: 0 },
    heights: Float32Array.from(heights),
  });
  const mesh = new Mesh(field.toGeometry());
  mesh.updateMatrixWorld(true);
  const sampler = surfaceSampler(field, mesh.matrixWorld);
  const ray = (x: number, z: number): number | null => {
    const hit = new Raycaster(new Vector3(x, 1000, z), new Vector3(0, -1, 0)).intersectObject(
      mesh,
      false,
    )[0];
    return hit?.point.y ?? null;
  };
  return { field, mesh, sampler, ray };
}

const sobel = (col: number, row: number): number => ((col * 7 + row * 13) % 9) - 4;

interface IRapierWorld {
  castRay(ray: unknown, maxToi: number, solid: boolean): { readonly timeOfImpact: number } | null;
  createCollider(descriptor: unknown, body: unknown): unknown;
  createRigidBody(descriptor: unknown): unknown;
  free(): void;
  step(): void;
}

interface IRapierModule {
  ColliderDesc: {
    heightfield(
      rows: number,
      columns: number,
      heights: Float32Array,
      scale: { readonly x: number; readonly y: number; readonly z: number },
      flags?: number,
    ): unknown;
  };
  HeightFieldFlags: { readonly FIX_INTERNAL_EDGES: number };
  Ray: new (
    origin: { readonly x: number; readonly y: number; readonly z: number },
    direction: { readonly x: number; readonly y: number; readonly z: number },
  ) => unknown;
  RigidBodyDesc: { fixed(): unknown };
  World: new (gravity: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }) => IRapierWorld;
  init(): Promise<void>;
}

/**
 * The solver's own shape, from the Rapier copy `@threenative/physics` installed: this example has
 * no Rapier dependency of its own, and a spelled-out triangulation would be a second copy of the
 * one under test. `game.ts` builds the same descriptor, `CollisionShape3D.heightfield` over
 * `toColliderHeights()`, on a fixed body at the mesh's own transform (here the origin).
 */
const RAPIER = createRequire(new URL("../../../packages/physics/package.json", import.meta.url))(
  "@dimforge/rapier3d-compat",
) as IRapierModule;

beforeAll(async () => {
  await RAPIER.init();
});

/**
 * The collider surface height under a world point, or `null` where the collider has no ground.
 *
 * `fromY` is the ray's start: a short ray keeps the solver's float32 time of impact precise (a
 * 10 km fall rounds to a millimetre), so a caller starts it just above the ground it asks about.
 */
function colliderRay(
  field: Heightfield,
  size: number,
): (x: number, z: number, fromY: number) => number | null {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(
      field.rows - 1,
      field.columns - 1,
      field.toColliderHeights(),
      { x: size, y: 1, z: size },
      RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES,
    ),
    world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
  );
  // The broad phase answers only once the world has stepped.
  world.step();
  return (x, z, fromY) => {
    const hit = world.castRay(
      new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }),
      fromY * 2,
      true,
    );
    return hit === null ? null : fromY - hit.timeOfImpact;
  };
}

describe("exact ground sampler", () => {
  it("uses the drawn triangle planes, not the bilinear height, on a saddle", () => {
    // Row-major [UL, UR, LL, LR]: opposite corners up, adjacent corners down.
    const { field, sampler, ray } = sampleCase([0, 1, 1, 0], 2, 2, 2);
    for (const [x, z] of [
      [0.1, 0.1],
      [-0.1, -0.1],
      [0.25, 0.25],
      [-0.25, -0.25],
    ]) {
      const expected = ray(x as number, z as number) as number;
      expect(Number.isFinite(expected)).toBe(true);
      const sampled = sampler(x as number, z as number) as number;
      expect(sampled).toBeCloseTo(expected, 6);
      // Bilinear floats well above the drawn triangle away from the shared edge.
      expect(Math.abs(sampled - field.heightAt(x as number, z as number))).toBeGreaterThan(0.2);
    }
    // Points on both diagonals and the shared edge agree with the raycaster.
    for (const [x, z] of [
      [0, 0],
      [0.5, 0.5],
      [-0.5, -0.5],
      [0.6, 0.2],
      [-0.6, -0.2],
    ]) {
      const expected = ray(x as number, z as number) as number;
      expect(Number.isFinite(expected)).toBe(true);
      expect(sampler(x as number, z as number)).toBeCloseTo(expected, 6);
    }
  });

  it("matches the raycaster on cell boundaries and interior samples of an irregular grid", () => {
    const rows = 5;
    const columns = 5;
    const heights: number[] = [];
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1) heights.push(sobel(column, row));
    const { sampler, ray } = sampleCase(heights, 4, rows, columns);
    const points: [number, number][] = [
      [-2, -2],
      [0, 0],
      [2, 2],
      [-1, 0],
      [0, -1],
      [1, 0],
      [0, 1],
      [-1.5, 0.5],
      [0.5, 1.5],
      [1.25, -0.75],
      [0.3, 0.3],
      [-0.2, 1.1],
    ];
    for (const [x, z] of points) {
      const expected = ray(x, z) as number;
      expect(Number.isFinite(expected)).toBe(true);
      expect(sampler(x, z)).toBeCloseTo(expected, 6);
    }
  });

  it("matches Float32 vertices, diagonals, and the far bound on a non-binary grid", () => {
    const rows = 17;
    const columns = 17;
    const heights: number[] = [];
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1) heights.push(sobel(column, row));
    const { mesh, sampler, ray } = sampleCase(heights, 10.3, rows, columns);
    const position = mesh.geometry.getAttribute("position");
    const points: [number, number][] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const vertex = row * columns + column;
        points.push([position.getX(vertex), position.getZ(vertex)]);
        if (row === rows - 1 || column === columns - 1) continue;
        const lowerRight = vertex + columns + 1;
        points.push([
          (position.getX(vertex) + position.getX(lowerRight)) / 2,
          (position.getZ(vertex) + position.getZ(lowerRight)) / 2,
        ]);
      }
    }
    for (const [x, z] of points) {
      const expected = ray(x, z);
      expect(expected).not.toBeNull();
      expect(sampler(x, z)).not.toBeNull();
      // The reference is the drawn mesh, whose positions are float32; the sampler answers the
      // field's canonical (float64) triangle, so the two agree to float32 precision, not to 1e-6 m.
      expect(sampler(x, z) as number).toBeCloseTo(expected as number, 5);
    }
  });

  it("follows a translated mesh and matches the raycaster there", () => {
    const { field, mesh } = sampleCase([0, 1, 1, 0], 2, 2, 2);
    mesh.position.set(12, 3, -7);
    mesh.updateMatrixWorld(true);
    const moved = surfaceSampler(field, mesh.matrixWorld);
    for (const [lx, lz] of [
      [-0.25, -0.25],
      [0.25, 0.25],
      [0, 0],
      [0.5, -0.5],
    ]) {
      const hit = new Raycaster(
        new Vector3(12 + (lx as number), 1000, -7 + (lz as number)),
        new Vector3(0, -1, 0),
      ).intersectObject(mesh, false)[0];
      expect(moved(12 + (lx as number), -7 + (lz as number))).toBeCloseTo(
        hit?.point.y as number,
        6,
      );
    }
  });

  it("matches the collider's own triangles at 10 000 seeded points, inside and outside", async () => {
    const rows = 33;
    const columns = 33;
    const size = 256;
    const heights: number[] = [];
    for (let index = 0; index < rows * columns; index += 1)
      heights.push(Math.sin(index * 0.7) * 6 + Math.cos(index * 0.31) * 3);
    const { field, sampler } = sampleCase(heights, size, rows, columns);
    const collider = colliderRay(field, size);
    const half = size / 2 - 0.05;
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed / 0xffffffff;
    };
    let compared = 0;
    let disagreed = 0;
    for (let sample = 0; sample < 10_000; sample += 1) {
      if (sample < 8_000) {
        const x = (next() * 2 - 1) * half;
        const z = (next() * 2 - 1) * half;
        const expected = collider(x, z, field.heightAt(x, z) + 100);
        expect(expected, `collider hit at (${x}, ${z})`).not.toBeNull();
        // 1 mm: the sampler answers the canonical float64 triangle, the collider its float32 copy.
        expect(sampler(x, z), `sampler(${x}, ${z})`).toBeCloseTo(expected as number, 3);
        compared += 1;
        if (Math.abs((expected as number) - field.heightAt(x, z)) > 1e-3) disagreed += 1;
        continue;
      }
      // Past the resident region the player keeps the ray fallback: no ground from either answer.
      const reach = 1 + next() * 64;
      const x = (next() < 0.5 ? -1 : 1) * (size / 2 + reach);
      const z = (next() * 2 - 1) * (size / 2 + 64);
      expect(sampler(x, z), `sampler(${x}, ${z})`).toBeNull();
      expect(collider(x, z, 5_000), `collider(${x}, ${z})`).toBeNull();
    }
    expect(compared).toBe(8_000);
    // The pin bites only if the bilinear height is a different answer at many of these points.
    expect(disagreed).toBeGreaterThan(1_000);
  });

  it("returns null outside the grid and for a rotated topology, so the ray fallback runs", () => {
    const { field, mesh, sampler } = sampleCase([0, 1, 1, 0], 2, 2, 2);
    expect(sampler(2.5, 0)).toBeNull();
    expect(sampler(0, -2.5)).toBeNull();
    mesh.rotation.y = Math.PI / 2;
    mesh.updateMatrixWorld(true);
    const rotated = surfaceSampler(field, mesh.matrixWorld);
    expect(rotated(0, 0)).toBeNull();
  });
});
