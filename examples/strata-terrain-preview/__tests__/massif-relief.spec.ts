import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { type HorizonSurroundings, setHorizonSurroundings } from "../src/render/ground/horizon.js";
import { buildCollarRelief } from "../src/render/ground/terrain.js";

// PRD-866: the collar's relief map reads a placed massif at the tile's own 4 m cells, in the same
// texture binding (the ground samples sixteen), and leaves every collar texel as it was.
it("adds the massif's 4 m relief beside the collar's, collar texels unchanged", () => {
  const horizon = JSON.parse(
    readFileSync(new URL("../src/world/horizon.json", import.meta.url), "utf8"),
  ) as HorizonSurroundings;
  const forest = horizon.forest;
  const massif = forest?.massif;
  if (!forest || !massif) throw new Error("the forest bake places no massif");
  expect(massif.spacing).toBeLessThanOrEqual(4);
  setHorizonSurroundings({ ...horizon, forest: { ...forest, massif: undefined } });
  const plain = buildCollarRelief("forest")?.texture.image;
  setHorizonSurroundings(horizon);
  const atlas = buildCollarRelief("forest")?.texture.image;
  if (!plain || !atlas) throw new Error("no collar relief");
  const n = forest.resolution;
  expect(plain.width).toBe(n);
  expect(atlas.width).toBe(n + massif.columns);
  expect(atlas.height).toBe(Math.max(n, massif.rows));
  const before = plain.data as Uint16Array;
  const after = atlas.data as Uint16Array;
  for (let row = 0; row < n; row++)
    expect(after.subarray(row * atlas.width * 4, (row * atlas.width + n) * 4)).toEqual(
      before.subarray(row * n * 4, (row + 1) * n * 4),
    );
  // Every massif texel holds a unit normal: its x and z lanes are not the zero of an unwritten texel.
  let written = 0;
  for (let row = 0; row < massif.rows; row++)
    for (let column = 0; column < massif.columns; column++) {
      const texel = (row * atlas.width + n + column) * 4;
      if (after[texel] !== 0 || after[texel + 1] !== 0) written++;
    }
  expect(written / (massif.rows * massif.columns)).toBeGreaterThan(0.9);
}, 60_000);
