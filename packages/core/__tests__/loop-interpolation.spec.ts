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

describe.each(["javascript", "engine"] as const)("draw-only transform history, %s path", (path) => {
  /** The same case on both paths: the engine path hands the poses to a model of the C++ history. */
  const interpolationFor = (enabled?: boolean): PhysicsInterpolation =>
    path === "engine"
      ? new PhysicsInterpolation(enabled, fakePoseOwner().owner)
      : new PhysicsInterpolation(enabled);

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
    const interpolation = interpolationFor();
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
    const interpolation = interpolationFor();
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
      const interpolation = interpolationFor();
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
    // On the engine path the C++ restore marks the local transform dirty for every body it wrote,
    // so JavaScript recomposes nothing; plain three on the JavaScript path still needs the call.
    if (path === "engine") {
      expect(plainUpdates).not.toHaveBeenCalled();
      expect(plain.matrixWorldNeedsUpdate).toBe(true);
    } else expect(plainUpdates).toHaveBeenCalledTimes(1);
  });

  it("resets a teleport during a tick and external position edits between ticks", () => {
    const object = new Object3D();
    const interpolation = interpolationFor();
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
      const interpolation = interpolationFor(enabled);
      const remove = interpolation.track(object);
      interpolation.beginTick();
      object.position.x = 2;
      interpolation.endTick();
      interpolation.render(0.5, () => expect(object.position.x).toBe(enabled === false ? 2 : 1));
      expect(log).toHaveBeenLastCalledWith(
        `TN_PHYSICS_INTERPOLATION:${JSON.stringify({ enabled: enabled ?? true, overrideSource: enabled === undefined ? "default" : "defineGame", path, trackedObjects: 1 })}`,
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
    const interpolation = interpolationFor();
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
    const interpolation = interpolationFor();
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

interface IFakePose {
  position: Vector3;
  quaternion: Quaternion;
}

interface IFakeEntry {
  object: Object3D;
  previous: IFakePose;
  current: IFakePose;
  saved: IFakePose;
}

const poseOf = (object: Object3D): IFakePose => ({
  position: object.position.clone(),
  quaternion: object.quaternion.clone(),
});
const samePose = (a: IFakePose, b: IFakePose): boolean =>
  a.position.equals(b.position) && a.quaternion.equals(b.quaternion);

/**
 * The engine's five pose methods (PRD-877 phase 3) over plain arrays, modelled line by line on
 * `packages/runtime-native/src/engine/scene/pose_history.cpp`, so every case can run on the engine
 * path. `calls` keeps the call order. With `write` false it is a spy that touches no transform, so a
 * case can prove JavaScript moved nothing. A write marks the transform dirty, as C++
 * `markLocalTransformDirty` does.
 */
function fakePoseOwner(write = true): { owner: Object3D; calls: string[] } {
  const calls: string[] = [];
  let entries: IFakeEntry[] = [];
  let blended: IFakeEntry[] = [];
  const writePose = (object: Object3D, pose: IFakePose): void => {
    object.position.copy(pose.position);
    object.quaternion.copy(pose.quaternion);
    object.matrixWorldNeedsUpdate = true;
  };
  const owner = new Object3D() as Object3D & Record<string, unknown>;

  owner.__tnPoseWatch = (objects: Object3D[]) => {
    calls.push("watch");
    // A body that was already watched keeps its poses, so adding one resets none beside it.
    entries = objects.map(
      (object) =>
        entries.find((entry) => entry.object === object) ?? {
          object,
          previous: poseOf(object),
          current: poseOf(object),
          saved: poseOf(object),
        },
    );
    blended = [];
    return entries.length;
  };
  owner.__tnPoseReset = (objects: Object3D[]) => {
    calls.push("reset");
    for (const entry of entries) {
      if (!objects.includes(entry.object)) continue;
      entry.previous = poseOf(entry.object);
      entry.current = poseOf(entry.object);
    }
  };
  owner.__tnPoseTick = (phase: number) => {
    calls.push(`tick:${phase}`);
    for (const entry of entries) {
      if (phase >= 1) entry.current = poseOf(entry.object);
      else entry.previous = poseOf(entry.object);
    }
  };
  owner.__tnPoseBlend = (alpha: number) => {
    calls.push("blend");
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
      throw new Error("PoseHistory::blend needs a finite alpha in [0, 1]");
    blended = [];
    for (const entry of entries) {
      const now = poseOf(entry.object);
      // Written since the tick: a discontinuity, never a step to blend across.
      if (!samePose(now, entry.current)) {
        entry.previous = poseOf(entry.object);
        entry.current = poseOf(entry.object);
      }
      entry.saved = now;
      blended.push(entry);
      const pose: IFakePose = {
        position: new Vector3().lerpVectors(entry.previous.position, entry.current.position, alpha),
        quaternion: new Quaternion().slerpQuaternions(
          entry.previous.quaternion,
          entry.current.quaternion,
          alpha,
        ),
      };
      // A body whose blend lands where it already is keeps its matrix caches.
      if (write && !samePose(pose, now)) writePose(entry.object, pose);
    }
  };
  owner.__tnPoseRestore = () => {
    calls.push("restore");
    for (const entry of blended)
      if (write && !samePose(poseOf(entry.object), entry.saved))
        writePose(entry.object, entry.saved);
    blended = [];
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
    const interpolation = new PhysicsInterpolation(undefined, owner);
    interpolation.track(body);
    body.position.set(0, 0, 0);
    interpolation.beginTick();
    body.position.set(4, 0, 0);
    interpolation.endTick();

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      interpolation.render(0.25, () => undefined);
      const logged = info.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.startsWith("TN_PHYSICS_INTERPOLATION:"));
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
