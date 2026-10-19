import { Matrix4, PerspectiveCamera, Scene, Vector3 } from "three";
import { pass } from "three/tsl";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- the registered visual scene is plain ESM without type declarations.
import { assertScaledTransition } from "../conformance/scenes/shared/temporal-aa-scaled.js";
import {
  projectedMotion,
  reprojectedHistory,
} from "../conformance/scenes/shared/temporal-velocity-probe.js";

describe("temporal fixture CPU motion oracle", () => {
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  it("uses current minus previous NDC, without converting it to UV twice", () => {
    const result = projectedMotion(
      new Vector3(1, 0, -5),
      new Vector3(0, 0, -5),
      new Matrix4(),
      new Matrix4(),
      camera.projectionMatrix,
      camera.projectionMatrix,
    );
    expect(result.x).toBeCloseTo(0.2);
    expect(result.y).toBe(0);
  });
  it("subtracts camera movement and preserves the upward-positive NDC convention", () => {
    const view = new Matrix4().makeTranslation(-1, 0, 0);
    const result = projectedMotion(
      new Vector3(1, 1, -5),
      new Vector3(0, 0, -5),
      view,
      new Matrix4(),
      camera.projectionMatrix,
      camera.projectionMatrix,
    );
    expect(result.x).toBe(0);
    expect(result.y).toBeCloseTo(0.2);
  });
});

describe("temporal fixture history coordinate", () => {
  const width = 800;
  const height = 400;
  // A tenth of a frame is not a binary fraction, so each coordinate is compared on its own.
  const near = (pixel: [number, number], x: number, y: number) => {
    expect(pixel[0]).toBeCloseTo(x);
    expect(pixel[1]).toBeCloseTo(y);
  };
  it("lands a matching vector on the previously projected point, and misses it by the whole motion at zero", () => {
    // A point at the raster centre that moved a tenth of the frame left and a tenth down since the
    // frame before: its measured velocity is that NDC delta, and its history sample has to land on
    // the 360x220 the same point projected to then.
    const previousNdc = new Vector3(-0.1, -0.1, 0);
    const matching = reprojectedHistory([400, 200], [0.1, 0.1], previousNdc, width, height);
    near(matching.previous, 360, 220);
    near(matching.history, 360, 220);
    // A vector that reads zero stays on the current pixel and misses the previous location by
    // hypot( 40, 20 ), which is the point's whole per-frame motion.
    const zero = reprojectedHistory([400, 200], [0, 0], previousNdc, width, height);
    expect(
      Math.hypot(zero.history[0] - zero.previous[0], zero.history[1] - zero.previous[1]),
    ).toBeGreaterThan(40);
  });
  it("counts y from the top of the raster, so a point that rose leaves its history sample lower", () => {
    const rose = reprojectedHistory([400, 200], [0, 0.2], new Vector3(0, -0.2, 0), width, height);
    near(rose.previous, 400, 240);
    near(rose.history, 400, 240);
  });
});

describe("scaled temporal conformance raster contract", () => {
  it.each([
    { width: 800, height: 600 },
    { width: 1280, height: 720 },
  ])(
    "accepts the pinned pass raster through a height-only transition at $width x $height",
    ({ width, height }) => {
      const scenePass = pass(new Scene(), new PerspectiveCamera(50, width / height));
      scenePass.setResolutionScale(2 / 3);
      const measured = (displayHeight: number) => {
        scenePass.setSize(width, displayHeight);
        return {
          displayWidth: width,
          displayHeight,
          inputWidth: scenePass.renderTarget.width,
          inputHeight: scenePass.renderTarget.height,
          depthHistoryWidth: scenePass.renderTarget.width,
          depthHistoryHeight: scenePass.renderTarget.height,
          resolveWidth: width,
          resolveHeight: displayHeight,
          historyWidth: width,
          historyHeight: displayHeight,
          farBorderBeyondInput: true,
          farBorderMax: 1,
        };
      };
      try {
        const opening = measured(height);
        const resized = measured(Math.round((height * 2) / 3));
        expect(() => assertScaledTransition(opening, resized, "CPU pass raster")).not.toThrow();
        expect(() =>
          assertScaledTransition(
            opening,
            { ...resized, inputHeight: resized.inputHeight + 1 },
            "wrong raster",
          ),
        ).toThrow(/input/);
      } finally {
        scenePass.dispose();
      }
    },
  );
});
