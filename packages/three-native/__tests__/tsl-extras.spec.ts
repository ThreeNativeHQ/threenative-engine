import { describe, expect, it } from "vitest";
import { defineTslExtras } from "../src/tsl-extras.js";

const opacity = { opacity: true };
const extras = defineTslExtras({ materialReferenceOpacity: opacity } as never);

describe("materialReference", () => {
  it("reads the drawn material's opacity, as three's materialReference('opacity', 'float')", () => {
    expect(extras.materialReference("opacity", "float")).toBe(opacity);
    expect(extras.materialReference("opacity")).toBe(opacity);
  });

  it("refuses any other material field by name", () => {
    expect(() => extras.materialReference("roughness", "float")).toThrow(
      /TN_NATIVE_MATERIAL_REFERENCE: materialReference\("roughness", "float"\)/,
    );
    expect(() => extras.materialReference("opacity", "vec3")).toThrow(
      /TN_NATIVE_MATERIAL_REFERENCE/,
    );
  });
});
