import { describe, expect, it, vi } from "vitest";

// The owned Wasm engine refuses a mat4 uniform (`TN_TSL uniform: argument 0 is not a TSL node ...`).
// A world builds a WorldGpuScene whether or not its GPU scene ever runs, so building one must not
// ask the backend for that uniform: only the occlusion kernel that reads it may.
vi.mock("three/tsl", async (importOriginal) => {
  const tsl = await importOriginal<typeof import("three/tsl")>();
  return {
    ...tsl,
    uniform: (value: unknown, ...rest: unknown[]) => {
      if ((value as { isMatrix4?: boolean } | null)?.isMatrix4 === true)
        throw new TypeError(
          "TN_TSL uniform: argument 0 is not a TSL node, number, string or three value",
        );
      return (tsl.uniform as (...args: unknown[]) => unknown)(value, ...rest);
    },
  };
});

describe("WorldGpuScene on a backend without mat4 uniforms", () => {
  it("builds without asking for the occlusion view uniform", async () => {
    const { WorldGpuScene } = await import("../src/world-gpu-scene.js");
    expect(() => new WorldGpuScene()).not.toThrow();
  });
});
