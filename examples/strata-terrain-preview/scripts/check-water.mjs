/** Run: pnpm exec tsx scripts/check-water.mjs. Shared example water regressions. */
import assert from "node:assert/strict";
import { Heightfield } from "@threenative/core/world";
import { buildPropVariants } from "../src/render/props.js";
import { createRivers } from "../src/render/river.js";
import { scatterProps } from "../src/render/scatter.js";

const field = new Heightfield({
  rows: 17,
  columns: 17,
  width: 64,
  depth: 64,
  origin: { x: 0, z: 0 },
  heights: new Float32Array(17 * 17),
});
const rivers = [
  {
    id: "first",
    points: [
      [-10, 1, -5],
      [10, 1, -5],
    ],
    width: 4,
  },
  {
    id: "braid",
    points: [
      [-10, 1, 5],
      [10, 1, 5],
    ],
    width: 4,
  },
];
const one = createRivers(rivers.slice(0, 1), field, true);
const both = createRivers(rivers, field, true);
try {
  assert.ok(one.mesh.geometry.index.count > 0, "First channel must be wet");
  assert.equal(
    both.mesh.geometry.index.count,
    one.mesh.geometry.index.count * 2,
    "Each wet channel must contribute triangles",
  );
  assert.equal(both.mesh.geometry.groups.filter((group) => group.count > 0).length, 2);
} finally {
  one.dispose();
  both.dispose();
}
const flooded = scatterProps(
  {
    field,
    colors: [],
    resolution: 17,
    size: 64,
    waterLevel: null,
    world: "tundra",
    rivers: [
      {
        points: [
          [-100, 2, 0],
          [100, 2, 0],
        ],
        width: 100,
      },
    ],
  },
  { x: 0, z: 0 },
);
assert.equal(
  flooded.placements.filter((p) => ["grass", "scrub", "sapling"].includes(p.asset)).length,
  0,
  "Dry cover cannot grow under a stream",
);

const saplings = buildPropVariants(undefined, 2);
try {
  for (const [name, parts] of saplings) {
    if (!name.startsWith("sapling:")) continue;
    const height = Math.max(
      ...parts.map((part) => {
        part.geometry.computeBoundingBox();
        return part.geometry.boundingBox.max.y;
      }),
    );
    assert.ok(Math.abs(height - 2) < 0.00001, "Fallback krummholz keeps its authored height");
  }
} finally {
  for (const parts of saplings.values()) for (const part of parts) part.geometry.dispose();
}
console.log(
  "PASS: both channels draw; flooded tundra has no dry cover; fallback saplings are small.",
);
