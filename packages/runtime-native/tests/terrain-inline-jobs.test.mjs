import assert from "node:assert/strict";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { test } from "vitest";
import {
  hashSettlement,
  settleInlineTerrainHash,
  startScene,
} from "../conformance/scenes/shared/terrain-inline-jobs.js";

function fakeMesh(name, positions) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2]);
  return { geometry, isMesh: true, name };
}

/**
 * The node side of the workerless terrain row.
 *
 * The native conformance case proves the host settles the ring inline; this pins the exact digest
 * the row requires, so a change to the merge or seam arithmetic fails here, on the source, before
 * a native lane is spent. The browser reference and the desktop capture both assert the same
 * constant, so this is the node inline path the box compares against.
 */
test("a workerless host settles the terrain block and seam bytes to the pinned inline hash", () => {
  const settled = settleInlineTerrainHash();
  assert.equal(settled.hash, "d138e335");
  assert.ok(settled.blocks > 0, "the ring merged blocks");
  assert.ok(settled.bridges > 0, "the ring built bridges");
});

test("the row exports the conformance scene entry the registry names", () => {
  assert.equal(typeof startScene, "function");
  assert.equal(typeof hashSettlement, "function");
});

test("the digest reads the settled bytes, not only which meshes exist", () => {
  const flat = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const moved = [0, 0, 0, 1, 0, 0, 0, 1, 0.5];
  const before = hashSettlement({ children: [fakeMesh("tn-terrain-block:0:0,0", flat)] });
  const after = hashSettlement({ children: [fakeMesh("tn-terrain-block:0:0,0", moved)] });
  assert.notEqual(before, after);
});
