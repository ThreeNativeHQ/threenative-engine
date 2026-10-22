import { describe, expect, test } from "vitest";

import { materialFieldNames, materialFieldValues } from "../src/material-fields.js";

/** A material as the engine's web back end builds it: the fields are enumerable accessors of the prototype. */
function engineMaterial(): object {
  const prototype = {};
  for (const [name, value] of Object.entries({ roughness: 0.5, map: { isTexture: true } }))
    Object.defineProperty(prototype, name, { enumerable: true, get: () => value });
  return Object.create(prototype) as object;
}

describe("materialFieldNames and materialFieldValues", () => {
  test("should list the fields of an engine material, which Object.keys cannot see", () => {
    const material = engineMaterial();
    expect(Object.keys(material)).toEqual([]);
    expect(materialFieldNames(material)).toEqual(["roughness", "map"]);
    expect(materialFieldValues(material)).toEqual([0.5, { isTexture: true }]);
  });

  test("should list the own fields of a plain three material", () => {
    const material = { roughness: 0.2, name: "x" };
    expect(materialFieldNames(material)).toEqual(["roughness", "name"]);
    expect(materialFieldValues(material)).toEqual([0.2, "x"]);
  });
});
