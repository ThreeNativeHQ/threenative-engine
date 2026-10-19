/** Small falsifying check for stand/cover placement and edits surviving distance compaction. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Heightfield } from "@threenative/core/world";
import { Vector3 } from "three";
import { createHorizonGeometry } from "../src/render/horizon.js";
import {
  buildPropVariants,
  createProps,
  flatPropMaterials,
  preparePropTransform,
  readPropTransform,
  variantFor,
  writePropTransform,
} from "../src/render/props.js";
import { grassWeight, scatterProps, slopeDegrees } from "../src/render/scatter.js";

const data = JSON.parse(
  readFileSync(new URL("../src/world/baked.json", import.meta.url), "utf8"),
).forest;
const field = new Heightfield({
  rows: data.resolution,
  columns: data.resolution,
  width: data.size,
  depth: data.size,
  origin: { x: 0, z: 0 },
  heights: Float32Array.from(data.heights),
});
// Decorative continuation must retain the exact collider seam and finite geometry.
const horizon = createHorizonGeometry(data);
const horizonPositions = horizon.getAttribute("position");
for (let i = 0; i < (data.resolution - 1) * 4; i++) {
  assert.ok(
    Math.abs(
      horizonPositions.getY(i) - field.heightAt(horizonPositions.getX(i), horizonPositions.getZ(i)),
    ) < 0.00001,
  );
}
assert.ok(Array.from(horizonPositions.array).every(Number.isFinite));
horizon.dispose();
const scatter = scatterProps({ ...data, field }, { x: 186, z: 76 }, [
  [176, 84, 10],
  [-20, -150, 10],
]);
assert.ok(scatter.counts.spruce >= 2000 && scatter.counts.spruce <= 5000);
assert.equal(new Set(scatter.placements.map((one) => one.id)).size, scatter.placements.length);
const trees = scatter.placements.filter((one) => one.asset === "spruce");
assert.ok(
  trees.some((one) => one.scale < 0.8) && trees.some((one) => one.scale > 1.2),
  "The stand needs young and mature age classes",
);
assert.ok(trees.every((one) => one.scale >= 0.6 && one.scale <= 1.4));
assert.ok(
  trees.every((one) => one.alignToNormal && Math.hypot(one.normal[0], one.normal[2]) < 0.064),
);
assert.ok(
  new Set(trees.map((one) => one.normal.join(","))).size > 100,
  "Tree lean must vary within a stand",
);
for (const [x, z] of [
  [176, 84],
  [-20, -150],
]) {
  const grass = scatter.placements.filter(
    (one) => one.asset === "grass" && Math.hypot(one.position[0] - x, one.position[2] - z) < 25,
  );
  assert.ok(grass.length > 3000, `Missing dense ground cover at ${x},${z}`);
}
for (const cliff of scatter.placements.filter((one) => one.asset === "cliff")) {
  const [x, , z] = cliff.position;
  const reach = 18 * Math.SQRT1_2 * Number(cliff.scale);
  for (const dx of [-reach, 0, reach])
    for (const dz of [-reach, 0, reach]) {
      assert.ok(grassWeight({ ...data, field }, x + dx, z + dz) <= 0.05);
      assert.ok(slopeDegrees({ ...data, field }, x + dx, z + dz) >= 43);
    }
}
// The previously accepted slab crossed this grassy, shallow rotated corner.
assert.ok(
  !scatter.placements.some(
    (one) =>
      one.asset === "cliff" &&
      Math.hypot(one.position[0] + 41.0373, one.position[2] + 94.4282) < 0.01,
  ),
);
// A continuous bare inland scarp still admits embedded cliffs.
const scarp = new Heightfield({
  origin: { x: 0, z: 0 },
  rows: 17,
  columns: 17,
  width: 512,
  depth: 512,
  heights: Float32Array.from(
    { length: 17 * 17 },
    (_, i) => 350 + ((i % 17) / 16 - 0.5) * 512 * Math.tan((52 * Math.PI) / 180),
  ),
});
assert.ok(
  scatterProps({ ...data, field: scarp, lakes: [], rivers: [] }, { x: 186, z: 76 }).counts.cliff >
    0,
);
// Even steep coastal grass ledges cannot acquire the pack's rectangular cliff slab.
assert.equal(scatterProps({ ...data, field, waterLevel: 0 }, { x: 186, z: 76 }).counts.cliff, 0);
// Round 12: outcrops occupy exposed terrain, and beach grass stops above wet sand.
const outcrops = scatter.placements.filter((one) => one.id.endsWith(":outcrop"));
assert.ok(outcrops.length > 30, "Missing real rock outcrops on the forest scarps");
assert.ok(outcrops.every((one) => Number(one.scale) * 24 >= 5 && Number(one.scale) * 24 <= 20));
assert.ok(
  outcrops.every((one) => variantFor(one, one.asset) === 0),
  "Outcrops must share one draw",
);
assert.ok(
  scatter.placements.filter((one) => one.asset === "boulder").every((one) => one.alignToNormal),
);
const coast = JSON.parse(
  readFileSync(new URL("../src/world/baked.json", import.meta.url), "utf8"),
).coastal;
const coastField = new Heightfield({
  rows: coast.resolution,
  columns: coast.resolution,
  width: coast.size,
  depth: coast.size,
  origin: { x: 0, z: 0 },
  heights: Float32Array.from(coast.heights),
});
const shore = scatterProps({ ...coast, world: "coastal", field: coastField }, { x: 180, z: 100 });
assert.ok(
  shore.placements.filter(
    (one) => one.asset === "grass" && one.position[1] < coast.waterLevel + 7.5,
  ).length > 100,
  "Missing dune grass",
);
assert.ok(
  shore.placements
    .filter((one) => one.asset === "grass")
    .every((one) => one.position[1] > coast.waterLevel + 1.8),
);
assert.ok(
  shore.placements
    .filter((one) => one.asset === "spruce")
    .every((one) => one.position[1] >= coast.waterLevel + 7.5),
);
const materials = flatPropMaterials();
const parts = buildPropVariants();
const ground = () => ({ height: 0, offset: 0 });
const placements = [0, 20, 200].map((x, index) => ({
  asset: "riverrock",
  id: `rock:${index}`,
  layer: "test",
  position: [x, 0, 0] as [number, number, number],
  normal: [0, 1, 0] as [number, number, number],
  alignToNormal: false,
  rotation: 0,
  scale: 1,
}));
// Footprint support may be four metres downhill; the dressed crag must still emerge.
const beddedCrag = createProps(
  [
    {
      asset: "mountain",
      id: "check:outcrop",
      layer: "temperate-mountain",
      position: [0, 0, 0],
      normal: [0, 1, 0],
      alignToNormal: false,
      rotation: 0,
      scale: 0.7,
    },
  ],
  () => ({ height: -4, offset: 0 }),
  parts,
  materials,
);
const beddedInstance = beddedCrag.byId.get("check:outcrop");
assert.ok(beddedInstance);
beddedInstance.geometry.computeBoundingBox();
assert.ok(
  (beddedInstance.geometry.boundingBox?.clone().applyMatrix4(beddedInstance.pose).max.y ?? -1) >
    0.5,
  "Footprint grounding plus old burial hides the entire outcrop",
);
beddedCrag.dispose();
const props = createProps(placements, ground, parts, materials);
props.setLevels(new Vector3());
const instance = props.byId.get("rock:0");
assert.ok(instance);
const transform = {
  ...readPropTransform(instance),
  position: [10, 0, 0] as [number, number, number],
};
writePropTransform(instance, preparePropTransform(instance, transform, ground));
props.setLevels(new Vector3(0.3, 0, 0));
assert.equal(readPropTransform(instance).position[0], 10);
for (const draw of props.meshes) {
  assert.equal(draw.userData.placementIds.length, draw.count);
  for (const [index, id] of draw.userData.placementIds.entries()) {
    assert.ok(props.byId.get(id)?.parts.some((part) => part.mesh === draw && part.index === index));
  }
}
const hidden = props.byId.get("rock:2");
assert.ok(hidden);
assert.equal(hidden.parts.length, 0);
const revealed = { ...readPropTransform(hidden), position: [15, 0, 0] as [number, number, number] };
writePropTransform(hidden, preparePropTransform(hidden, revealed, ground));
props.setLevels(new Vector3(0.3, 0, 0));
assert.ok(hidden.parts.length > 0, "A moved culled prop must reappear without camera movement");
props.dispose();
materials.dispose();
for (const list of parts.values()) for (const part of list) part.geometry.dispose();
console.log("Temperate checks passed", scatter.counts);
