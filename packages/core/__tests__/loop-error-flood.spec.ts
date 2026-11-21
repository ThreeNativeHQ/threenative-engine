import { describe, expect, it } from "vitest";
import { FixedStepLoop } from "../src/loop.js";

/** Studio trial 2026-11-20T15-30: a half-edited scene threw on every frame. Each error that escaped the
 * frame callback reached the Vite dev server, which fell minutes behind and never sent the hot update
 * that fixed the code, so the page threw for the rest of the run. */
describe("a frame that throws on every frame", () => {
  const brokenLoop = () => {
    const state = {
      error: "rankRace is not defined" as string | undefined,
      next: undefined as ((time: number) => void) | undefined,
      updates: 0,
    };
    const loop = new FixedStepLoop({
      cancelFrame: () => undefined,
      onUpdate: () => {
        state.updates += 1;
        if (state.error !== undefined) throw new ReferenceError(state.error);
      },
      requestFrame: (callback) => {
        state.next = callback;
        return 1;
      },
    });
    loop.start(0);
    const frames = (from: number, to: number): number => {
      let escaped = 0;
      for (let frame = from; frame <= to; frame++)
        try {
          state.next?.((frame * 1000) / 60);
        } catch {
          escaped += 1;
        }
      return escaped;
    };
    return { frames, loop, state };
  };

  it("lets the error escape once per five seconds, not once per frame", () => {
    const { frames } = brokenLoop();
    expect(frames(1, 600)).toBe(2);
  });

  it("keeps running, so the fixed code takes over, and a new error escapes at once", () => {
    const { frames, state } = brokenLoop();
    expect(frames(1, 10)).toBe(1);
    state.error = undefined;
    const before = state.updates;
    expect(frames(11, 20)).toBe(0);
    expect(state.updates).toBeGreaterThan(before);
    state.error = "RIVALS is not defined";
    expect(frames(21, 30)).toBe(1);
  });
});
