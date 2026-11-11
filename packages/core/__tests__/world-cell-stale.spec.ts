import { describe, expect, it } from "vitest";
import { staleRows } from "../src/world-cell-stale.js";

/**
 * The refilter's stale scan over packed rows (PRD-879). The owned engine runs it as
 * `Object3D.__tnStaleEntries`; upstream three runs `staleRows`. The vectors and answers are the
 * native case's (`native_engine_abi_world_stale_entries`), so the two twins answer alike.
 */
const nan = Number.NaN;
// A gated cell whose follow point walked 100 m (two entries of asset 0, one ungated asset 1), a far
// cell no gate can reach, and a placementReach cell.
const slab = Float64Array.from([
  0,
  0,
  64,
  0,
  90,
  0,
  3,
  0,
  0,
  32,
  0,
  32,
  32,
  0,
  32,
  40,
  nan,
  nan,
  nan,
  nan,
  1,
  32,
  0,
  32,
  32,
  0,
  32,
  nan,
  nan,
  nan,
  nan,
  nan,
  0,
  32,
  0,
  32,
  32,
  0,
  32,
  40,
  nan,
  nan,
  nan,
  nan,
  1000,
  0,
  64,
  900,
  950,
  0,
  1,
  0,
  0,
  1032,
  0,
  32,
  1032,
  0,
  32,
  40,
  nan,
  nan,
  nan,
  nan,
  0,
  128,
  64,
  0,
  100,
  1,
  1,
  0,
  2,
  32,
  0,
  160,
  32,
  0,
  160,
  nan,
  0,
  20,
  -5,
  5,
]);
const gates = Float64Array.from([3, 7, 1, 8, 0, 8, 0, 40]);
const query = (gpu: number): Float64Array =>
  Float64Array.from([132, 0, 32, 132, 0, 32, gpu, 1, 40]);

describe("the refilter's stale scan", () => {
  it("names each crossed cell-asset once, nearest distance from the LOD eye", () => {
    expect(staleRows(slab, gates, query(0))).toEqual([0, 0, 68, 2, 2, Math.hypot(68, 96)]);
  });

  it("leaves the gates to the GPU scene and keeps the placementReach boundary", () => {
    expect(staleRows(slab, gates, query(1))).toEqual([2, 2, Math.hypot(68, 96)]);
  });

  it("skips an entry whose follow point and eye stayed within an eighth of its threshold", () => {
    const still = Float64Array.from([32, 0, 32, 32, 0, 32, 0, 1, 40]);
    expect(staleRows(slab.subarray(0, 8 + 3 * 12), gates, still)).toEqual([]);
  });
});
