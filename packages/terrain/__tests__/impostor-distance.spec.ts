// The biome's `far.impostor` was validated and read by nothing, so the engine's whole-asset impostor
// never engaged. This holds the wiring both ways — a stated value reaches the package, and a caller's
// own value wins — and refuses a value core would reject at load, naming the species.
import { describe, expect, it } from "vitest";
import { withImpostorDistances } from "../src/biome/bake-biome.js";

const asset = {
  bounds: {
    max: [1, 4, 1] as [number, number, number],
    min: [-1, 0, -1] as [number, number, number],
  },
  glb: "pine.glb",
  lods: [
    { distance: 0, glb: "pine.glb" },
    { distance: 60, glb: "pine.glb" },
  ],
};

/** Only the fields this helper reads: the foliage rule the biome states. */
function spec(impostor: number): never {
  return { foliage: [{ far: { impostor }, species: "pine" }], look: "forest" } as never;
}

describe("the biome's far-impostor distance", () => {
  it("should reach the world package's impostorDistance", () => {
    expect(withImpostorDistances({ pine: asset }, spec(110))?.pine?.impostorDistance).toBe(110);
  });

  it("should let a caller's own distance win", () => {
    const given = { pine: { ...asset, impostorDistance: 200 } };
    expect(withImpostorDistances(given, spec(110))?.pine?.impostorDistance).toBe(200);
  });

  it("should leave the assets untouched when no biome value is stated", () => {
    expect(
      withImpostorDistances({ pine: asset }, { foliage: [], look: "forest" } as never),
    ).toEqual({
      pine: asset,
    });
  });

  it("should refuse a distance inside an authored LOD gate", () => {
    expect(() => withImpostorDistances({ pine: asset }, spec(30))).toThrow(
      /impostorDistance \(30\) must follow every authored LOD gate \(furthest 60\)/u,
    );
  });
});
