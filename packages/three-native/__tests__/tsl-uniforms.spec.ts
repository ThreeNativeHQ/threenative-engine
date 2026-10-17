import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { liveUniforms } from "../src/tsl-uniforms.js";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

interface IFakeNode {
  value?: unknown;
  onRenderUpdate?(callback: () => unknown): IFakeNode;
}

/** A back end whose node wrapper is all JS holds, as `wrap` makes it: the engine owns the graph. */
function setup() {
  const pushed: number[][] = [];
  const live = liveUniforms<IFakeNode>(
    () => ({}),
    (_node, lanes) => {
      pushed.push([...lanes]);
    },
  );
  return { live, pushed };
}

describe("uniform update hooks", () => {
  // The racing template's fill gain is `uniform(0).onRenderUpdate(...)`, chained into a material and
  // then dropped. The wrapper was collected, the hook stopped, and the fill stayed at its first value.
  it("keeps running an update hook after the game drops its node", async () => {
    const { live, pushed } = setup();
    let gain = 1;
    live.uniform(0).onRenderUpdate?.(() => gain);
    live.sync();
    expect(pushed.at(-1)).toEqual([1]);
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      collectGarbage();
    }
    gain = 0;
    live.sync();
    expect(pushed.at(-1)).toEqual([0]);
  });
});
