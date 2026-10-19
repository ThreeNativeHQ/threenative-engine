import { describe, expect, it, vi } from "vitest";

/**
 * On the native engine, `reflector()` returns a pass the engine draws itself: three never runs its
 * `updateBefore` (`updateBeforeType` is `"none"`), and reading the hook throws so a wrapper cannot
 * silently run nothing. The bundle guard is a three-renderer workaround, so a surface with explicit
 * layers must build over such a pass (Midway's ocean on `engine: "threenative"`).
 */
const engine = vi.hoisted(() => ({ layers: [] as number[] }));
vi.mock("three/tsl", async (original) => {
  const { Object3D } = await import("three");
  return {
    ...(await original<object>()),
    reflector: () => {
      const camera = { layers: { mask: 1 } };
      const pass = {
        updateBeforeType: "none",
        get updateBefore(): never {
          throw new Error("TN_NATIVE_REFLECTOR_UPDATE_HOOK");
        },
        set updateBefore(_hook: unknown) {
          throw new Error("TN_NATIVE_REFLECTOR_UPDATE_HOOK");
        },
        get getVirtualCamera() {
          return () => camera;
        },
        set getVirtualCamera(wrapper: () => { layers: { mask: number } }) {
          engine.layers.push(wrapper().layers.mask);
        },
      };
      return { target: new Object3D(), _reflectorBaseNode: pass };
    },
  };
});

const { WaterSurface3D } = await import("../src/water-surface.js");

describe("a water reflection over the native engine's reflector", () => {
  it("builds with explicit layers and applies them to the engine's virtual camera", () => {
    expect(
      () =>
        new WaterSurface3D({
          level: 0,
          maxThickness: 14,
          reflection: { resolutionScale: 0.5, layers: 1 << 3 },
        }),
    ).not.toThrow();
    expect(engine.layers).toEqual([1 << 3]);
  });
});
