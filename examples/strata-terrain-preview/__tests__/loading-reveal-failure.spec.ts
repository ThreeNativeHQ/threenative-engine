import { OrthographicCamera, PerspectiveCamera, Scene } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { createLoadingScreen } from "../src/render/loading.js";

afterEach(() => vi.restoreAllMocks());

// A reveal probe that throws is reported by name and never becomes an unhandled rejection.
it("reports a throwing onReveal through console.error, not an unhandled rejection (audit STRATA-12)", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const screen = createLoadingScreen({
      camera: new PerspectiveCamera(),
      scene: new Scene(),
      canvasLayer: {
        scene: new Scene(),
        camera: new OrthographicCamera(-400, 400, 300, -300, 0, 2),
        opaque: false,
      },
      startup: { progress: 1, whenReady: () => Promise.resolve() },
      onReveal: () => {
        throw new Error("Reveal probe requires virtual shadows");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("Reveal probe requires virtual shadows");
    screen.finish();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
