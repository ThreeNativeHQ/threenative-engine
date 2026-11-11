import { FrontSide } from "three";
import { describe, expect, it } from "vitest";
import { propMaterial, structureMaterial } from "../templates/minimal/src/render/materials.js";

describe("minimal arena shadows", () => {
  it("cast from the sun-facing faces, so no lit sliver lines the base of a shaded face", () => {
    // A front-sided material casts from its back faces by default (three's `_shadowSide`). For a
    // crate, the back face is the shaded face standing on the floor, so the shadow bias and the PCF
    // kernel lit a 1-3 cm strip of floor along its base: a white line where the crate meets the
    // ground on its shadow side.
    expect(propMaterial.shadowSide).toBe(FrontSide);
    expect(structureMaterial.shadowSide).toBe(FrontSide);
  });
});
