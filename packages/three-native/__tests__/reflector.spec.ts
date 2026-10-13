import { describe, expect, it } from "vitest";
import { defineReflector } from "../src/reflector.js";

class Stub {}

describe("defineReflector", () => {
  it("reports no JS update, the contract core's WaterSurface3D reads before it wraps one", () => {
    const reflector = defineReflector(() => ({}), { Object3D: Stub, PerspectiveCamera: Stub });
    const pass = (reflector() as { _reflectorBaseNode: { updateBeforeType: string } })
      ._reflectorBaseNode;
    expect(pass.updateBeforeType).toBe("none");
    expect(() => (pass as unknown as { updateBefore: unknown }).updateBefore).toThrow(
      "TN_NATIVE_REFLECTOR_UPDATE_HOOK",
    );
  });
});
