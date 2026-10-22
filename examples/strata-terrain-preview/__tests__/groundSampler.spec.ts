import { Heightfield } from "@threenative/core/world";
import { Mesh, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createGroundSampler } from "../src/render/groundSampler.js";

/**
 * The drawn mesh is the reference: every case compares the sampler with a stock Three `Raycaster`
 * on the same geometry, never with a mirrored copy of the sampler's own formula.
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
  const sampler = createGroundSampler(field, mesh.geometry, mesh.matrixWorld);
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
      expect(sampler(x, z) as number).toBeCloseTo(expected as number, 6);
    }
  });

  it("follows a translated mesh and matches the raycaster there", () => {
    const { field, mesh } = sampleCase([0, 1, 1, 0], 2, 2, 2);
    mesh.position.set(12, 3, -7);
    mesh.updateMatrixWorld(true);
    const moved = createGroundSampler(field, mesh.geometry, mesh.matrixWorld);
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

  it("returns null outside the grid and for a rotated topology, so the ray fallback runs", () => {
    const { field, mesh, sampler } = sampleCase([0, 1, 1, 0], 2, 2, 2);
    expect(sampler(2.5, 0)).toBeNull();
    expect(sampler(0, -2.5)).toBeNull();
    mesh.rotation.y = Math.PI / 2;
    mesh.updateMatrixWorld(true);
    const rotated = createGroundSampler(field, mesh.geometry, mesh.matrixWorld);
    expect(rotated(0, 0)).toBeNull();
  });
});
