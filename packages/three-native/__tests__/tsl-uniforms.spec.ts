import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { booleanUniforms, liveUniforms } from "../src/tsl-uniforms.js";

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

  // The racing template's fog reads the camera's height in `onRenderUpdate(({ camera }) => ...)`, as three
  // passes it. Without a camera the callback fell back to height 0 and the distant ground fogged wrongly.
  it("hands the rendering camera to an update hook, as three's frame does", () => {
    const { live, pushed } = setup();
    const camera = { name: "chase" };
    live
      .uniform(0)
      .onRenderUpdate?.(((frame: { camera?: unknown }) =>
        frame.camera === camera ? 7 : -1) as never);
    live.sync({ camera });
    expect(pushed.at(-1)).toEqual([7]);
  });
});

describe("boolean uniforms", () => {
  // The exposure meter's `enabled` is `uniform(false)`. A back end whose `uniform` takes numbers and vectors only
  // refused it with "TN_TSL uniform: expected a TSL node or number", which stopped the engine player at startup.
  it("keeps a boolean as the live float compared with zero, and answers .value in booleans", () => {
    const { live, pushed } = setup();
    const made: string[] = [];
    const uniform = booleanUniforms(
      (value, type) => {
        if (typeof value === "boolean") throw new Error("expected a TSL node or number");
        return live.uniform(value, type);
      },
      (scalar) => {
        made.push("notEqual");
        return { scalar } as IFakeNode;
      },
    );
    const enabled = uniform(false);
    expect(made).toEqual(["notEqual"]);
    expect(enabled.value).toBe(false);
    enabled.value = true;
    expect(enabled.value).toBe(true);
    expect(pushed.at(-1)).toEqual([1]);
    expect(() => {
      enabled.value = 1;
    }).toThrow("TN_TSL_UNIFORM_VALUE");
    expect(() => uniform(true, "float")).toThrow("requires bool type");
  });

  it("passes numbers through untouched", () => {
    const { live } = setup();
    const uniform = booleanUniforms(live.uniform, () => {
      throw new Error("not a boolean");
    });
    expect(uniform(3).value).toBe(3);
  });
});

interface ILaneWrite {
  node: IFakeNode;
  lanes: number[];
  lanesRef: readonly number[];
}

/** A sink that keeps each lane array's numbers and its identity, so a kept argument shows aliasing. */
function setupLaneIdentity() {
  const writes: ILaneWrite[] = [];
  const live = liveUniforms<IFakeNode>(
    () => ({}),
    (node, lanes) => {
      writes.push({ node, lanes: [...lanes], lanesRef: lanes });
    },
  );
  return { live, writes };
}

function distinctWrites(writes: ILaneWrite[], node: IFakeNode): { writes: number; arrays: number } {
  const own = writes.filter((write) => write.node === node);
  return { writes: own.length, arrays: new Set(own.map((write) => write.lanesRef)).size };
}

/**
 * 32 edits with 24 unchanged syncs between: every edit reaches the sink once with the right lanes,
 * the unchanged syncs (extracted into the uniform's scratch) write nothing, and every write hands
 * the sink its own snapshot, never the scratch a later sync refills.
 */
function exerciseEdits(
  live: ReturnType<typeof liveUniforms<IFakeNode>>,
  writes: ILaneWrite[],
  node: IFakeNode,
  edit: (index: number) => void,
  expected: (index: number) => number[],
): void {
  live.sync();
  for (let index = 0; index < 32; index++) {
    edit(index);
    live.sync();
    for (let pass = 0; pass < 24; pass++) live.sync();
    expect(writes.at(-1)?.lanes).toEqual(expected(index));
  }
  const seen = distinctWrites(writes, node);
  expect(seen.arrays).toBe(seen.writes);
  for (const [index, write] of writes.filter((w) => w.node === node).entries())
    if (index > 0) expect(write.lanesRef).toEqual(write.lanes);
}

describe("uniform lane reuse", () => {
  // Every sync extracted a vector into a fresh array literal plus a filter result, even when the
  // lanes matched the last upload and write() returned before the engine call.
  it("writes each edit once as its own snapshot across unchanged syncs", () => {
    const { live, writes } = setupLaneIdentity();
    const origin = { x: 1, y: 2, z: 3 };
    const node = live.uniform(origin);
    exerciseEdits(
      live,
      writes,
      node,
      (index) => {
        origin.x = 10 + index;
      },
      (index) => [10 + index, 2, 3],
    );
    expect(writes).toHaveLength(33);
  });

  it("writes snapshots for hooked scalars, a Color and Vector2/3/4", () => {
    const { live, writes } = setupLaneIdentity();
    let gain = 1;
    const scalar = live.uniform(0);
    scalar.onRenderUpdate?.(() => gain);
    exerciseEdits(
      live,
      writes,
      scalar,
      (index) => {
        gain = 2 + index;
      },
      (index) => [2 + index],
    );

    const color = { r: 0.1, g: 0.2, b: 0.3 };
    const colorNode = live.uniform(color);
    exerciseEdits(
      live,
      writes,
      colorNode,
      (index) => {
        color.r = (index + 1) / 10;
      },
      (index) => [(index + 1) / 10, 0.2, 0.3],
    );

    const v2 = { x: 0, y: 1 };
    const v2Node = live.uniform(v2);
    exerciseEdits(
      live,
      writes,
      v2Node,
      (index) => {
        v2.y = 2 + index;
      },
      (index) => [0, 2 + index],
    );

    const v3 = { x: 0, y: 1, z: 2 };
    const v3Node = live.uniform(v3);
    exerciseEdits(
      live,
      writes,
      v3Node,
      (index) => {
        v3.z = 3 + index;
      },
      (index) => [0, 1, 3 + index],
    );

    const v4 = { x: 0, y: 1, z: 2, w: 3 };
    const v4Node = live.uniform(v4);
    exerciseEdits(
      live,
      writes,
      v4Node,
      (index) => {
        v4.w = 4 + index;
      },
      (index) => [0, 1, 2, 4 + index],
    );
  });

  // The engine refuses lanes that do not fit the uniform's type. Reusing storage must not pad a
  // short value with the lanes of an earlier, wider one.
  it("still refuses a value whose lanes do not fit the uniform type", () => {
    const widths = new WeakMap<IFakeNode, number>();
    const live = liveUniforms<IFakeNode>(
      () => ({}),
      (node, lanes) => {
        const width = widths.get(node);
        if (width !== undefined && width !== lanes.length)
          throw new Error(
            `TN_TSL_UNIFORM_WIDTH: ${lanes.length} lanes for a ${width}-lane uniform`,
          );
      },
    );
    const vec3 = live.uniform({ x: 1, y: 2, z: 3 });
    widths.set(vec3, 3);
    live.sync();
    expect(() => {
      vec3.value = { x: 4, y: 5 };
    }).toThrow("TN_TSL_UNIFORM_WIDTH: 2 lanes for a 3-lane uniform");

    const scalar = live.uniform(1);
    widths.set(scalar, 1);
    scalar.value = 2;
    expect(() => {
      scalar.value = { x: 2, y: 3 };
    }).toThrow("TN_TSL_UNIFORM_WIDTH: 2 lanes for a 1-lane uniform");
  });

  // A refused write must not become the last-successful lanes, or the engine never sees the value.
  it("retries a changed value after the sink throws instead of treating it as uploaded", () => {
    const pushed: number[][] = [];
    let throwOnce = false;
    const live = liveUniforms<IFakeNode>(
      () => ({}),
      (_node, lanes) => {
        pushed.push([...lanes]);
        if (throwOnce) {
          throwOnce = false;
          throw new Error("TN_TSL_SINK: transient");
        }
      },
    );
    const origin = { x: 1, y: 2 };
    live.uniform(origin);
    live.sync();
    origin.x = 9;
    throwOnce = true;
    expect(() => live.sync()).toThrow("TN_TSL_SINK: transient");
    live.sync();
    expect(pushed).toEqual([
      [1, 2],
      [9, 2],
      [9, 2],
    ]);
  });
});

describe("uniform sync cost", () => {
  // Lantern Vale renders about ten post passes a frame, and every pass synced every uniform: 832 engine
  // writes a frame for values that had not changed.
  it("writes a hooked uniform only when its value changes", () => {
    const { live, pushed } = setup();
    let gain = 5;
    live.uniform(0).onRenderUpdate?.(() => gain);
    for (let pass = 0; pass < 10; pass++) live.sync({ frameId: 1 } as never);
    expect(pushed).toEqual([[5]]);
    gain = 6;
    live.sync({ frameId: 2 } as never);
    expect(pushed).toEqual([[5], [6]]);
  });

  it("writes an edited vector once per edit, however many renders follow", () => {
    const { live, pushed } = setup();
    const origin = { x: 1, y: 2 };
    live.uniform(origin);
    for (let pass = 0; pass < 10; pass++) live.sync();
    expect(pushed).toEqual([[1, 2]]);
    origin.x = 3;
    live.sync();
    live.sync();
    expect(pushed).toEqual([
      [1, 2],
      [3, 2],
    ]);
  });

  it("runs a frame update once per renderer frame and a render update once per render", () => {
    const { live } = setup();
    let frames = 0;
    let renders = 0;
    const hooked = live.uniform(0) as IFakeNode & { onFrameUpdate(callback: () => unknown): void };
    hooked.onFrameUpdate(() => ++frames);
    live.uniform(0).onRenderUpdate?.(() => ++renders);
    for (let pass = 0; pass < 10; pass++) live.sync({ frameId: 7 } as never);
    live.sync({ frameId: 8 } as never);
    expect(frames).toBe(2);
    expect(renders).toBe(11);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("debug uniform repeated post work", () => {
  it("counts repeated quad syncs, unchanged lanes and callback CPU with call sites", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    vi.stubGlobal("__tnDebugSources", {});
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => ++clock);
    const { live, pushed } = setup();
    live.uniform({ x: 1, y: 2, z: 3 });
    const callback = vi.fn(() => 7);
    live.uniform(0).onRenderUpdate?.(callback);
    for (let quad = 0; quad < 10; quad++) live.sync({ frameId: 7 });
    expect(callback).toHaveBeenCalledTimes(10);
    expect(pushed).toEqual([[7], [1, 2, 3]]);
    const host = globalThis as {
      __tnEngineCost?: Record<string, number>;
      __tnDebugSources?: Record<string, { caller: string; lever?: string; unit?: string }>;
    };
    expect(host.__tnEngineCost).toMatchObject({
      uniformSyncCalls: 10,
      uniformWriteAttempts: 20,
      uniformLaneWriteAttempts: 40,
      uniformUnchangedWriteAttempts: 18,
      uniformUnchangedLaneWriteAttempts: 36,
      uniformWrites: 2,
      uniformLaneWrites: 4,
      uniformRenderCallbacks: 10,
      uniformCallbackMs: 10,
    });
    expect(host.__tnEngineCost?.uniformSyncMs).toBeGreaterThan(10);
    const name = Object.keys(host.__tnEngineCost ?? {}).find(
      (key) => key.startsWith("uniformCallback:") && key.endsWith("Ms"),
    );
    expect(name).toBeDefined();
    expect(host.__tnDebugSources?.[name ?? ""]?.caller).toContain("tsl-uniforms.spec");
    expect(host.__tnDebugSources?.uniformSyncMs?.unit).toBe("ms");
    expect(host.__tnDebugSources?.uniformCallbackMs?.unit).toBe("ms");
    expect(host.__tnDebugSources?.[name ?? ""]?.unit).toBe("ms");
    expect(host.__tnDebugSources?.uniformSyncMs?.lever).toContain("PERFORMANCE-LEARNINGS.md#");
  });

  it("keeps off backend writes and lane-snapshot allocations identical without clocks or stacks", () => {
    function run(enabled: boolean) {
      vi.stubEnv("TN_DEBUG", enabled ? "1" : "0");
      vi.stubGlobal("__tnEngineCost", undefined);
      const { live, writes } = setupLaneIdentity();
      const value = { x: 1, y: 2 };
      live.uniform(value);
      const now = vi.spyOn(performance, "now");
      const slice = vi.spyOn(Array.prototype, "slice");
      for (let quad = 0; quad < 10; quad++) live.sync({ frameId: 7 });
      const census = {
        clocks: now.mock.calls.length,
        snapshots: slice.mock.calls.length,
        writes: writes.map((write) => write.lanes),
      };
      now.mockRestore();
      slice.mockRestore();
      return census;
    }
    const off = run(false);
    const on = run(true);
    expect(off).toEqual({ clocks: 0, snapshots: 1, writes: [[1, 2]] });
    expect(on.snapshots).toBe(off.snapshots);
    expect(on.writes).toEqual(off.writes);
    expect(on.clocks).toBeGreaterThan(0);
  });
});
