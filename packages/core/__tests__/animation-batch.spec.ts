/**
 * PRD-828: the frame's animation rigs queue as data and run in one call. What must hold is the
 * read-back: rig i's status is rig i's, in queue order, and a backend that is absent queues nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type IAnimationTickRig,
  animationTickExecutor,
  clearAnimationTicks,
  demo,
  flushAnimationTicks,
  queueAnimationTick,
  queuedAnimationTicks,
} from "../src/animation-batch.js";

const rig = (dt: number): IAnimationTickRig => ({
  mixer: {},
  action: null,
  strideRoot: null,
  dt,
  elapsed: dt,
  step: true,
  reset: false,
  lastRate: 1,
  clipGroundSpeed: 2,
  strideSync: true,
});

const install = (run: (rigs: readonly IAnimationTickRig[], status: Float64Array) => void) => {
  (globalThis as { __tnAnimationTick?: unknown }).__tnAnimationTick = run;
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__tnAnimationTick");
  clearAnimationTicks();
  vi.restoreAllMocks();
});

describe("the animation tick batch (PRD-828)", () => {
  it("runs every queued rig in one call and reads each rig's own status back", () => {
    const seen: number[] = [];
    let calls = 0;
    install((rigs, status) => {
      calls += 1;
      for (let i = 0; i < rigs.length; i += 1) {
        status[i * 3] = (rigs[i] as IAnimationTickRig).dt * 100;
        status[i * 3 + 1] = 7;
        status[i * 3 + 2] = (i === 1 ? 1 : 2) as number;
      }
    });
    queueAnimationTick(rig(0.1), (result) => {
      seen.push(result.strideRate, result.groundSpeed, result.finished ? 1 : 0);
    });
    queueAnimationTick(rig(0.25), (result) => {
      seen.push(result.strideRate, result.groundSpeed, result.finished ? 1 : 0);
    });
    expect(queuedAnimationTicks()).toBe(2);
    expect(flushAnimationTicks()).toBe(1);
    expect(calls).toBe(1);
    // Rig order is the queue's order, and the flags word splits per rig.
    expect(seen).toEqual([10, 7, 0, 25, 7, 1]);
    expect(queuedAnimationTicks()).toBe(0);
  });

  it("queues nothing when the backend installs no executor, and gives a rig back if it vanishes", () => {
    expect(animationTickExecutor()).toBeUndefined();
    expect(flushAnimationTicks()).toBe(0);
    install(() => undefined);
    expect(animationTickExecutor()).toBeInstanceOf(Function);
    Reflect.deleteProperty(globalThis, "__tnAnimationTick");
    queueAnimationTick(rig(0.1), () => undefined);
    // A rig queued and then abandoned fails closed: leaving it unadvanced silently is the worse bug.
    expect(() => flushAnimationTicks()).toThrow(/TN_ANIM_TICK_EXECUTOR_GONE/u);
    expect(queuedAnimationTicks()).toBe(0);
  });

  it("keeps the queue's own check green", () => {
    expect(demo()).toBe("demo: ok");
  });
});
