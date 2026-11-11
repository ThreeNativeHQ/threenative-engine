import { Object3D, Quaternion, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("arms the engine's own recompose instead of crossing for it, as plain three still calls it", () => {
    // On the Wasm engine the walk composes a node's own matrix from the pose the restore just wrote, so the
    // restore arms the flag that walk reads: one crossing a body a frame before (300 on the stress lab).
    const engine = new Object3D() as Object3D & { __tnCopyMatrixWorld?: () => void };
    engine.__tnCopyMatrixWorld = () => undefined;
    const engineUpdates = vi.spyOn(engine, "updateMatrix");
    const plain = new Object3D();
    const plainUpdates = vi.spyOn(plain, "updateMatrix");
    for (const object of [engine, plain]) {
      const interpolation = new PhysicsInterpolation();
      interpolation.track(object);
      interpolation.beginTick();
      object.position.x = 2;
      interpolation.endTick();
      object.matrixWorldNeedsUpdate = false;
      interpolation.render(0.5, () => expect(object.position.x).toBe(1));
      expect(object.position.x).toBe(2);
    }

    expect(engineUpdates).not.toHaveBeenCalled();
    expect(engine.matrixWorldNeedsUpdate).toBe(true);
    expect(plainUpdates).toHaveBeenCalledTimes(1);
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
        `TN_PHYSICS_INTERPOLATION:${JSON.stringify({ enabled: enabled ?? true, overrideSource: enabled === undefined ? "default" : "defineGame", path: "javascript", trackedObjects: 1 })}`,
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

/** The names PRD-877 Phase 1 adds, and the three regions they stand for. */
const INTERPOLATION_REGIONS = ["interpolationTick", "interpolationBlend", "interpolationRestore"];

describe("interpolation cost, measured only under debug telemetry", () => {
  type Bag = Record<string, number> | undefined;
  const host = globalThis as unknown as Record<string, unknown>;
  const cost = (): Record<string, number> => (host.__tnEngineCost as Bag) ?? {};
  const sources = (): Record<string, unknown> => (host.__tnDebugSources as Bag) ?? {};

  function forgetInterpolationNames(): void {
    for (const bag of [host.__tnEngineCost, host.__tnDebugSources] as Record<string, unknown>[]) {
      if (bag === undefined) continue;
      for (const name of Object.keys(bag)) if (name.startsWith("interpolation")) delete bag[name];
    }
  }

  function oneTickAndOneRender(bodies: Object3D[]): void {
    const interpolation = new PhysicsInterpolation();
    for (const body of bodies) interpolation.track(body);
    interpolation.beginTick();
    for (const [index, body] of bodies.entries()) body.position.x = index;
    interpolation.endTick();
    interpolation.render(0.5, () => undefined);
  }

  afterEach(() => {
    forgetInterpolationNames();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports the three regions for one tick and one render of 100 objects, and none with telemetry off", () => {
    forgetInterpolationNames();
    vi.stubEnv("TN_DEBUG", "1");
    oneTickAndOneRender(Array.from({ length: 100 }, () => new Object3D()));

    // One tick is beginTick plus endTick, so the tick region is entered twice.
    expect(cost().interpolationTickCalls).toBe(2);
    expect(cost().interpolationBlendCalls).toBe(1);
    expect(cost().interpolationRestoreCalls).toBe(1);
    for (const region of INTERPOLATION_REGIONS) {
      expect(cost()[`${region}Ms`]).toBeGreaterThanOrEqual(0);
      expect(sources()[`${region}Calls`]).toEqual({
        area: "update",
        caller: expect.stringContaining("PhysicsInterpolation"),
        unit: "count",
      });
    }

    forgetInterpolationNames();
    vi.unstubAllEnvs();
    oneTickAndOneRender(Array.from({ length: 100 }, () => new Object3D()));

    expect(Object.keys(cost()).filter((name) => name.startsWith("interpolation"))).toEqual([]);
    expect(Object.keys(sources()).filter((name) => name.startsWith("interpolation"))).toEqual([]);
  });
});

/**
 * A stand-in for the engine's five pose methods (PRD-877 phase 3) over plain arrays. `record` keeps
 * the call order; `write` decides whether it behaves like C++ (blending the objects) or like a spy
 * that touches nothing, so a case can prove which side moved the transforms.
 */
function fakePoseOwner(write: boolean): { owner: Object3D; calls: string[] } {
  const calls: string[] = [];
  const previous = new Map<Object3D, Vector3>();
  const previousRotation = new Map<Object3D, Quaternion>();
  const current = new Map<Object3D, Vector3>();
  const currentRotation = new Map<Object3D, Quaternion>();
  const saved = new Map<Object3D, { position: Vector3; quaternion: Quaternion }>();
  const owner = new Object3D() as Object3D & Record<string, unknown>;

  owner.__tnPoseWatch = (objects: Object3D[]) => {
    calls.push("watch");
    return objects.length;
  };
  owner.__tnPoseReset = (objects: Object3D[]) => {
    calls.push("reset");
    for (const object of objects) {
      previous.set(object, object.position.clone());
      previousRotation.set(object, object.quaternion.clone());
      current.set(object, object.position.clone());
      currentRotation.set(object, object.quaternion.clone());
    }
  };
  owner.__tnPoseTick = (phase: number) => {
    calls.push(`tick:${phase}`);
    if (!write) return;
    const from = phase >= 1 ? current : previous;
    const fromRotation = phase >= 1 ? currentRotation : previousRotation;
    for (const object of owner.trackedObjects as Object3D[]) {
      from.set(object, object.position.clone());
      fromRotation.set(object, object.quaternion.clone());
    }
  };
  owner.__tnPoseBlend = (alpha: number) => {
    calls.push("blend");
    if (!write) return;
    for (const object of owner.trackedObjects as Object3D[]) {
      saved.set(object, { position: object.position.clone(), quaternion: object.quaternion.clone() });
      const a = previous.get(object);
      const b = current.get(object);
      const ra = previousRotation.get(object);
      const rb = currentRotation.get(object);
      if (a === undefined || b === undefined || ra === undefined || rb === undefined) continue;
      object.position.lerpVectors(a, b, alpha);
      object.quaternion.slerpQuaternions(ra, rb, alpha);
    }
  };
  owner.__tnPoseRestore = () => {
    calls.push("restore");
    if (!write) return;
    for (const object of owner.trackedObjects as Object3D[]) {
      const held = saved.get(object);
      if (held === undefined) continue;
      object.position.copy(held.position);
      object.quaternion.copy(held.quaternion);
    }
  };
  return { owner: owner as Object3D, calls };
}

describe("the engine path, when the host carries the five pose methods", () => {
  it("makes exactly four calls on a frame whose tracked set did not change, and writes nothing", () => {
    const body = new Object3D();
    const { owner, calls } = fakePoseOwner(false);
    const interpolation = new PhysicsInterpolation(undefined, owner);
    interpolation.track(body);
    expect(interpolation.path).toBe("engine");

    interpolation.beginTick();
    body.position.x = 2;
    interpolation.endTick();
    const solved = body.position.clone();
    interpolation.render(0.5, () => undefined);

    // The track above changed the set, so the frame after it watches once; every frame after that
    // must not.
    expect(calls).toEqual(["watch", "tick:0", "tick:1", "blend", "restore"]);

    calls.length = 0;
    interpolation.beginTick();
    interpolation.endTick();
    interpolation.render(0.5, () => undefined);
    expect(calls).toEqual(["tick:0", "tick:1", "blend", "restore"]);

    // The spy wrote nothing, so if JavaScript had blended the body itself it would have moved.
    expect(body.position.equals(solved)).toBe(true);
  });

  it("leaves the pose to the owner and reports the engine path", () => {
    const body = new Object3D();
    const { owner } = fakePoseOwner(true);
    owner.trackedObjects = [body];
    const interpolation = new PhysicsInterpolation(undefined, owner);
    interpolation.track(body);
    body.position.set(0, 0, 0);
    interpolation.beginTick();
    body.position.set(4, 0, 0);
    interpolation.endTick();

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      interpolation.render(0.25, () => undefined);
      const logged = info.mock.calls.map((call) => String(call[0])).find((line) =>
        line.startsWith("TN_PHYSICS_INTERPOLATION:"),
      );
      expect(logged).toContain('"path":"engine"');
    } finally {
      info.mockRestore();
    }
    // The owner blended and restored; the body is back on the pose the tick solved.
    expect(body.position.x).toBeCloseTo(4);
  });

  it("reaches the same poses as the JavaScript path", () => {
    const solved = [0, 2.5, -7];
    const blended: number[] = [];
    for (const useEngine of [false, true]) {
      const body = new Object3D();
      const { owner } = fakePoseOwner(true);
      owner.trackedObjects = [body];
      const interpolation = useEngine
        ? new PhysicsInterpolation(undefined, owner)
        : new PhysicsInterpolation();
      interpolation.track(body);
      interpolation.beginTick();
      body.position.set(solved[0], solved[1], solved[2]);
      interpolation.endTick();
      let seen = 0;
      interpolation.render(0.4, () => {
        seen = body.position.x;
      });
      expect(body.position.x).toBeCloseTo(solved[0]);
      blended.push(seen);
    }
    expect(blended[0]).toBeCloseTo(blended[1]);
  });
});
