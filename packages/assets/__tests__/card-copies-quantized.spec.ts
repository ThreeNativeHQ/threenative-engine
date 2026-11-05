import { type Accessor, Document, MathUtils } from "@gltf-transform/core";
import { expect, it } from "vitest";

/**
 * A far-level crown whose cards fill the top of the quantized volume.
 *
 * A cooked POSITION is a normalized int16 spanning [-1, 1], so a card the thinner scales past the
 * volume has nowhere to go: `setElement` encodes through `encodeNormalizedInt`, which clamps to
 * [-1, 1]. Every card here spans y 0.8 → 1.0 about a 0.9 centroid and is scaled 2x, so its top
 * corner lands at 1.1 and its bottom at 0.7 — outside the volume on top, inside it below.
 */
function cardCrown(quantized: boolean): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions: number[] = [];
  const indices: number[] = [];
  const cards = 40;
  // Clustered inside one grid cell, so the thinner keeps some and drops the rest.
  for (let card = 0; card < cards; card += 1) {
    const x = (card % 8) * 0.001;
    const z = Math.floor(card / 8) * 0.001;
    const base = positions.length / 3;
    positions.push(x, 0.8, z, x + 0.05, 0.8, z, x + 0.05, 1.0, z, x, 1.0, z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const stored = quantized
    ? Int16Array.from(positions, (value) => MathUtils.encodeNormalizedInt(value, 5122))
    : Float32Array.from(positions);
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor()
        .setType("VEC3")
        .setArray(stored)
        .setNormalized(quantized)
        .setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setType("SCALAR")
        .setArray(Uint32Array.from(indices))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial("needle").setAlphaMode("MASK").setAlphaCutoff(0.5));
  document
    .createScene()
    .addChild(
      document.createNode("needle").setMesh(document.createMesh("needle").addPrimitive(primitive)),
    );
  return document;
}

/** One height per appended card copy, in the order the thinner appends them: four per card. */
function copyHeights(position: Accessor, base: number): number[] {
  const heights: number[] = [];
  const element: number[] = [];
  for (let vertex = base; vertex < position.getCount(); vertex += 1)
    heights.push(position.getElement(vertex, element)[1] as number);
  return heights;
}

it("keeps a scaled card's geometry when POSITION is a normalized int16 accessor", async () => {
  const { thinFoliageCards } = await import("../src/lod/generate.js");
  const document = cardCrown(true);
  const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
  if (primitive === undefined) throw new Error("no primitive");
  const base = (primitive.getAttribute("POSITION") as Accessor).getCount();

  expect(thinFoliageCards(document, 0.14)).toBe(1);

  // Every attribute is replaced by a grown accessor, so the base one no longer reports the copies.
  const heights = copyHeights(primitive.getAttribute("POSITION") as Accessor, base);
  expect(heights.length).toBeGreaterThan(0);
  // The thinner keeps a quarter of the cards and scales each 2x about its centroid.
  for (let copy = 0; copy < heights.length; copy += 4) {
    const card = heights.slice(copy, copy + 4);
    expect(Math.max(...card) - Math.min(...card)).toBeCloseTo(0.4, 3);
  }
  expect(Math.max(...heights)).toBeGreaterThan(1);
});
