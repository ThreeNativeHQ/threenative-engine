import { MeshoptSimplifier } from "meshoptimizer";
import { TorusKnotGeometry } from "three";
import { describe, expect, it } from "vitest";
import { createSimplifyPool } from "../src/lod/simplify-pool.js";

describe("terrain LOD CPU pool", () => {
  it("rejects queued targets when disposed", async () => {
    const pool = createSimplifyPool(1);
    const jobs = Array.from({ length: 3 }, () =>
      pool.simplify(
        new Uint32Array([0, 1, 2]),
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        3,
        new Float32Array(),
        0,
        [],
        null,
        3,
        0,
        [],
      ),
    );
    const settled = Promise.allSettled(jobs);
    await pool.dispose();
    expect((await settled).map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
  });
  it("matches serial indices and errors, in target order, across reused workers", async () => {
    await MeshoptSimplifier.ready;
    const geometry = new TorusKnotGeometry(1, 0.4, 64, 16);
    const positions = Float32Array.from(geometry.getAttribute("position").array);
    const normals = Float32Array.from(geometry.getAttribute("normal").array);
    const indices = Uint32Array.from(geometry.getIndex()?.array ?? []);
    const pool = createSimplifyPool(2);
    try {
      const args = [0.002, 0.006, 0.02, 0.06].map(
        (error): Parameters<typeof MeshoptSimplifier.simplifyWithAttributes> => [
          indices,
          positions,
          3,
          normals,
          3,
          [1, 1, 1],
          null,
          3,
          error,
          ["LockBorder"],
        ],
      );
      const expected = args.map((args) => MeshoptSimplifier.simplifyWithAttributes(...args));
      expect(await Promise.all(args.map((args) => pool.simplify(...args)))).toEqual(expected);
      expect(await Promise.all(args.map((args) => pool.simplify(...args)))).toEqual(expected);
    } finally {
      geometry.dispose();
      await pool.dispose();
    }
  });

  it("rejects invalid input without stranding later jobs", async () => {
    const pool = createSimplifyPool(1);
    const indices = new Uint32Array([0, 1, 2]);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    try {
      await expect(
        pool.simplify(indices, positions, 3, new Float32Array(), 0, [], null, 3, -1, []),
      ).rejects.toThrow("Assertion failed");
      const [result] = await pool.simplify(
        indices,
        positions,
        3,
        new Float32Array(),
        0,
        [],
        null,
        3,
        0,
        [],
      );
      expect(result).toEqual(indices);
    } finally {
      await pool.dispose();
    }
    await expect(
      pool.simplify(indices, positions, 3, new Float32Array(), 0, [], null, 3, 0, []),
    ).rejects.toThrow("exited");
  });
});
