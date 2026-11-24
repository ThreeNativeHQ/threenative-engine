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

  it("passes the filtering and refresh arguments to the native reflector", () => {
    const calls: unknown[][] = [];
    const reflector = defineReflector(
      (...args) => {
        calls.push(args);
        return {};
      },
      { Object3D: Stub, PerspectiveCamera: Stub },
    );

    reflector({ excludeInstancedAndSkinned: true, minSize: 25, refreshInterval: 3 });
    expect(calls.at(-1)?.slice(-3)).toEqual([1, 25, 3]);

    reflector({ excludeInstancedAndSkinned: false, minSize: 8 });
    expect(calls.at(-1)?.slice(-3)).toEqual([0, 8, 1]);

    reflector();
    expect(calls.at(-1)?.slice(-3)).toEqual([0, 0, 1]);
  });

  it("refuses a refresh interval below one", () => {
    const reflector = defineReflector(() => ({}), { Object3D: Stub, PerspectiveCamera: Stub });
    expect(() => reflector({ refreshInterval: 0 })).toThrow(/refreshInterval/u);
  });
});
