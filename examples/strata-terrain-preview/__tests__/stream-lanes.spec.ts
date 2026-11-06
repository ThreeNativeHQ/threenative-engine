import { expect, it } from "vitest";
import { createStreamLanes } from "../src/render/streamLanes.js";

// PRD-806 E17. `editorView` served the terrain update's prop stream and the prop-drag restream from
// one generation counter, so a drag that fired while an update was streaming superseded the update:
// its stream answered `undefined`, the freshly built mesh was disposed, and `mesh`, `terrain`,
// `groundAt` and `renderedRecipe` stayed on the previous revision with no later update scheduled.
it("keeps the terrain update current when a prop drag restreams props", () => {
  const lanes = createStreamLanes<"terrain" | "props">();
  const terrainUpdate = lanes.open("terrain");
  const dragRestream = lanes.open("props");

  expect(dragRestream()).toBe(true);
  expect(terrainUpdate()).toBe(true);
});

it("supersedes only the lane that opened a newer stream", () => {
  const lanes = createStreamLanes<"terrain" | "props">();
  const firstUpdate = lanes.open("terrain");
  const dragRestream = lanes.open("props");
  const secondUpdate = lanes.open("terrain");

  expect(firstUpdate()).toBe(false);
  expect(secondUpdate()).toBe(true);
  expect(dragRestream()).toBe(true);
});

it("drops a prop restream the committed terrain has overtaken", () => {
  const lanes = createStreamLanes<"terrain" | "props">();
  const dragRestream = lanes.open("props");

  lanes.supersede("props");

  expect(dragRestream()).toBe(false);
});
