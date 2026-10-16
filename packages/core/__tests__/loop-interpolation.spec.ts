import { Object3D, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { PhysicsInterpolation } from "../src/interpolation.js";
import { FixedStepLoop } from "../src/loop.js";

function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return (
    Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean
  );
}

describe("fixed-step motion presentation", () => {
  it.each([56, 75, 120, 144])("presents constant speed smoothly at %i Hz", (hz) => {
    const body = new Object3D();
    const positions: number[] = [];
    const interpolation = new PhysicsInterpolation();
    interpolation.track(body);
    const loop = new FixedStepLoop({
      interpolation,
      onUpdate: (dt) => {
        body.position.x += 2 * dt;
      },
      onRender: (alpha) =>
        interpolation.render(alpha, () => {
          positions.push(body.position.x);
          return undefined;
        }),
    });
    loop.stepFrame(0);
    for (let frame = 1; frame <= hz * 3; frame++) loop.stepFrame((frame * 1000) / hz);
    const deltas = positions
      .slice(3)
      .map((position, index) => position - (positions[index + 2] ?? Number.NaN));
    expect(coefficientOfVariation(deltas)).toBeLessThan(0.1);
  });
});

describe("draw-only transform history", () => {
  it("exposes bounded alpha, including stalls, backward time, and a frozen clock", () => {
    const alphas: number[] = [];
    const loop = new FixedStepLoop({
      onUpdate: () => undefined,
      onRender: (alpha) => {
        alphas.push(alpha);
        return undefined;
      },
    });
    for (const time of [0, 5, 17, 24, 10000, 9990, 10020]) loop.stepFrame(time);
    expect(loop.frameTime).toBe(10020);
    expect(alphas[1]).toBeCloseTo(0.3);
    expect(alphas.every((alpha) => alpha >= 0 && alpha < 1)).toBe(true);
  });

  it("slerps rotation and restores solved transforms even when a draw throws", () => {
    const object = new Object3D();
    const interpolation = new PhysicsInterpolation();
    interpolation.track(object);
    interpolation.beginTick();
    object.position.x = 2;
    object.rotateY(Math.PI / 2);
    interpolation.endTick();
    expect(() =>
      interpolation.render(0.5, () => {
        expect(object.position.x).toBe(1);
        expect(object.rotation.y).toBeCloseTo(Math.PI / 4);
        throw new Error("draw failed");
      }),
    ).toThrow("draw failed");
    expect(object.position.x).toBe(2);
    expect(object.rotation.y).toBeCloseTo(Math.PI / 2);
    object.updateWorldMatrix(true, false);
    expect(object.getWorldPosition(new Vector3()).x).toBe(2);
  });

  it("leaves settled matrix caches untouched while restoring moving objects", () => {
    const settled = new Object3D();
    settled.position.set(4, 2, 1);
    settled.updateMatrixWorld(true);
    settled.matrixAutoUpdate = false;
    const moving = new Object3D();
    const interpolation = new PhysicsInterpolation();
    interpolation.track(settled);
    interpolation.track(moving);
    interpolation.beginTick();
    moving.position.x = 2;
    interpolation.endTick();
    interpolation.render(0.5, () => {
      expect(moving.position.x).toBe(1);
      expect(settled.matrixWorldNeedsUpdate).toBe(false);
    });
    expect(moving.position.x).toBe(2);
    expect(settled.matrixWorldNeedsUpdate).toBe(false);
    interpolation.render(0.5, () => {
      settled.position.x = 99;
    });
    expect(settled.position.x).toBe(4);
  });

  it("resets a teleport during a tick and external position edits between ticks", () => {
    const object = new Object3D();
    const interpolation = new PhysicsInterpolation();
    interpolation.track(object);
    interpolation.beginTick();
    object.position.x = 100;
    interpolation.reset(object);
    interpolation.endTick();
    interpolation.render(0.5, () => expect(object.position.x).toBe(100));
    object.position.x = 200;
    interpolation.render(0.5, () => expect(object.position.x).toBe(200));
  });

  it.each([false, true, undefined])("reports global override %s and tracked count", (enabled) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const object = new Object3D();
      const interpolation = new PhysicsInterpolation(enabled);
      const remove = interpolation.track(object);
      interpolation.beginTick();
      object.position.x = 2;
      interpolation.endTick();
      interpolation.render(0.5, () => expect(object.position.x).toBe(enabled === false ? 2 : 1));
      expect(log).toHaveBeenLastCalledWith(
        `TN_PHYSICS_INTERPOLATION:${JSON.stringify({ enabled: enabled ?? true, overrideSource: enabled === undefined ? "default" : "defineGame", trackedObjects: 1 })}`,
      );
      remove();
      remove();
      interpolation.render(0.5, () => expect(object.position.x).toBe(2));
      expect(log.mock.calls.at(-1)?.[0]).toContain('"trackedObjects":0');
    } finally {
      log.mockRestore();
    }
  });

  it("clears scene history and protects a new registration from stale removals", () => {
    const object = new Object3D();
    const interpolation = new PhysicsInterpolation();
    const removeOld = interpolation.track(object);
    interpolation.beginTick();
    object.position.x = 2;
    interpolation.endTick();
    interpolation.clear();
    object.position.x = 100;
    interpolation.track(object);
    removeOld();
    interpolation.beginTick();
    object.position.x = 102;
    interpolation.endTick();
    interpolation.render(0.5, () => expect(object.position.x).toBe(101));
  });

  it("does not delay frozen tick-counted playtests", () => {
    const object = new Object3D();
    const interpolation = new PhysicsInterpolation();
    interpolation.track(object);
    const loop = new FixedStepLoop({
      interpolation,
      onUpdate: () => {
        object.position.x += 1;
      },
      requestFrame: () => 0,
    });
    loop.start(0);
    loop.advance(2);
    interpolation.render(loop.clockFrozen ? 1 : loop.alpha, () =>
      expect(object.position.x).toBe(2),
    );
    loop.stop();
  });
});
