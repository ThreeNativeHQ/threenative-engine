import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { followShip, setupCamera } from "../templates/sailing/src/render/camera.js";
import { createHeightReconciler } from "../templates/sailing/src/render/ocean.js";

const sample = (height: number, verticalVelocity: number, staleFrames: number) => ({
  height,
  verticalVelocity,
  staleFrames,
});

describe("Sailing height-copy reconciliation", () => {
  it("keeps the first measured wave velocity and preserves height and velocity on landing", () => {
    const read = createHeightReconciler();
    expect(read(sample(2, 1, 2), 10, 0.1)).toMatchObject({ height: 2.2, verticalVelocity: 1 });
    const before = read(sample(2, 1, 3), 11, 0.1);
    const after = read(sample(4, 2, 1), 11, 0.1);
    expect(after.height).toBeCloseTo(before.height, 12);
    expect(after.verticalVelocity).toBeCloseTo(before.verticalVelocity, 12);
    expect(read(sample(4, 2, 3), 13, 0.1)).toMatchObject({
      height: 4.6,
      verticalVelocity: 2,
      correction: 0,
    });
  });

  it("rebases a second landing before the previous measured interval finishes", () => {
    const read = createHeightReconciler();
    read(sample(2, 1, 2), 10, 0.1);
    read(sample(4, 2, 1), 11, 0.1);
    const before = read(sample(4, 2, 2), 12, 0.1);
    const after = read(sample(3, 0.4, 1), 12, 0.1);
    expect(after.height).toBeCloseTo(before.height, 12);
    expect(after.verticalVelocity).toBeCloseTo(before.verticalVelocity, 12);
    expect(read(sample(3, 0.4, 2), 13, 0.1).correction).toBe(0);
  });

  it("leaves duplicate clock observations unchanged and resets a rewound clock", () => {
    const read = createHeightReconciler();
    read(sample(2, 1, 2), 10, 0.1);
    const landed = read(sample(4, 2, 1), 11, 0.1);
    expect(read(sample(4, 2, 1), 11, 0.1)).toEqual(landed);
    expect(read(sample(1, 0.5, 1), 3, 0.1)).toMatchObject({
      height: 1.05,
      verticalVelocity: 0.5,
      correction: 0,
    });
  });

  it.each([
    [Number.NaN, 0.1],
    [Number.POSITIVE_INFINITY, 0.1],
    [1, 0],
    [1, -1],
    [1, Number.NaN],
  ])("rejects invalid clock frame %s and delta %s", (frame, delta) => {
    expect(() => createHeightReconciler()(sample(1, 0, 0), frame, delta)).toThrow(
      "height prediction",
    );
  });
});

describe("Sailing chase camera startup", () => {
  it("starts on the authored chase pose, then keeps easing later follow updates", () => {
    const camera = new PerspectiveCamera();
    setupCamera(camera);
    const seaAtCamera = () => 8;
    const initialTarget = { x: 0, y: 0.24, z: 7 };

    followShip(camera, initialTarget, 0, 1 / 60, seaAtCamera);

    expect(camera.position.toArray()).toEqual([2.3, 9.5, 15.8]);
    const aim = new Vector3(0, 2.14, 1.8);
    const expectedDirection = aim.sub(camera.position).normalize();
    expect(camera.getWorldDirection(new Vector3()).distanceTo(expectedDirection)).toBeLessThan(
      1e-12,
    );

    const before = camera.position.clone();
    const movedTarget = { x: 10, y: 0.24, z: 7 };
    followShip(camera, movedTarget, 0, 0.1, seaAtCamera);
    expect(camera.position.x).toBeCloseTo(before.x + (12.3 - before.x) * 0.36, 12);
    expect(camera.position.y).toBe(9.5);
  });
});
