import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNWATCH, booleanUniforms, liveUniforms } from "../src/tsl-uniforms.js";

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

  // The Strata haze composite is `uniform(camera.matrixWorld)`, chained into a post pass and dropped. The
  // wrapper was collected, its edits stopped syncing, and the haze read the eye at the origin.
  it("keeps syncing an edited object value after the game drops its node", async () => {
    const { live, pushed } = setup();
    const eye = { x: 0, y: 0, z: 0 };
    live.uniform(eye);
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      collectGarbage();
    }
    eye.y = 71;
    live.sync();
    expect(pushed.at(-1)).toEqual([0, 71, 0]);
  });

  // The wrapper is kept for the dropped node, but only through the value the game owns: `uniform(new
  // Color())` per material or per world used to pin its node for the page's life, so both the memory and
  // every frame's sync grew without bound.
  it("releases a node whose value the game dropped", async () => {
    const { live } = setup();
    let node: IFakeNode | undefined = live.uniform({ x: 0, y: 0, z: 0 });
    const wrapper = new WeakRef(node);
    node = undefined;
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      collectGarbage();
    }
    expect(wrapper.deref()).toBeUndefined();
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

  // PRD-878: a post chain draws about thirty quads a frame and a particle system dispatches a dozen kernels; each ran
  // every scene hook. The engine names the hooks a draw's graphs read, and only those run.
  it("runs only the hooks the engine says a draw or dispatch reads", () => {
    const ran: string[] = [];
    const asked: unknown[] = [];
    const live = liveUniforms<IFakeNode>(
      () => ({}),
      () => undefined,
      undefined,
      (frame, hooked) => {
        asked.push(frame.kernels ?? frame.scene);
        expect(hooked).toHaveLength(3);
        return frame.scene === "scene" ? undefined : frame.kernels !== undefined ? [2] : [0];
      },
    );
    for (const name of ["fog", "rim", "particle"])
      live.uniform(0).onRenderUpdate?.(() => ran.push(name));
    live.sync({ scene: "scene", frameId: 1 });
    expect(ran).toEqual(["fog", "rim", "particle"]);
    ran.length = 0;
    live.sync({ scene: "quad", frameId: 1 });
    live.sync({ kernels: [5], frameId: 1 });
    expect(ran).toEqual(["fog", "particle"]);
    expect(asked).toEqual(["scene", "quad", [5]]);
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
      // the hooked scalar each sync; the unedited vector only at its first (it is watched, not scanned)
      uniformWriteAttempts: 11,
      uniformLaneWriteAttempts: 13,
      uniformUnchangedWriteAttempts: 9,
      uniformUnchangedLaneWriteAttempts: 9,
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

describe("uniform sync cost", () => {
  // FluidVolume draws 28 targets a step, each a render that synced every object uniform of the whole app: 0.15 to
  // 0.25 ms of CPU per draw. A sync now reads only the uniforms whose value objects were edited since the last one.
  const host = globalThis as {
    __THREENATIVE_DEBUG__?: boolean;
    __tnEngineCost?: Record<string, number>;
  };
  afterEach(() => {
    host.__THREENATIVE_DEBUG__ = undefined;
    host.__tnEngineCost = undefined;
  });
  const attempts = () => host.__tnEngineCost?.uniformWriteAttempts ?? 0;

  it("reads only the edited uniforms when many unrelated uniforms exist", () => {
    host.__THREENATIVE_DEBUG__ = true;
    const { live, pushed } = setup();
    const values = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: 0, z: 0 }));
    for (const value of values) live.uniform(value);
    live.sync({ frameId: 1 });
    const before = attempts();
    (values[7] as { x: number }).x = -1;
    live.sync({ frameId: 1 });
    expect(attempts() - before).toBe(1);
    expect(pushed.at(-1)).toEqual([-1, 0, 0]);
  });

  it("delivers in-place edits between two renders of one frame, to every uniform sharing the object", () => {
    const { live, pushed } = setup();
    const shared = { x: 1, y: 2 };
    live.uniform(shared);
    live.uniform(shared);
    live.sync({ frameId: 3 });
    pushed.length = 0;
    shared.y = 5;
    live.sync({ frameId: 3 });
    expect(pushed).toEqual([
      [1, 5],
      [1, 5],
    ]);
    shared.x = 4;
    live.sync({ frameId: 3 });
    expect(pushed.slice(2)).toEqual([
      [4, 5],
      [4, 5],
    ]);
  });

  it("follows a replaced value object and still scans objects it cannot watch", () => {
    const { live, pushed } = setup();
    const node = live.uniform({ x: 0, y: 0 });
    const next = { x: 1, y: 1 };
    node.value = next;
    next.x = 9;
    live.sync();
    expect(pushed.at(-1)).toEqual([9, 1]);
    let lane = 0;
    const accessor = {
      get x() {
        return lane;
      },
      y: 0,
    };
    live.uniform(accessor);
    live.sync();
    lane = 3;
    live.sync();
    expect(pushed.at(-1)).toEqual([3, 0]);
  });

  it("scans a watched value again once a back end adopts its lanes", () => {
    const { live, pushed } = setup();
    const value: Record<string | symbol, unknown> = { x: 1, y: 1 };
    live.uniform(value);
    live.sync();
    // The Wasm back end's promote: unwatch, then the lanes move behind the engine class's accessors.
    (value[UNWATCH] as () => void)();
    let x = value.x;
    Reflect.deleteProperty(value, "x");
    Object.defineProperty(value, "x", {
      get: () => x,
      set: (next) => {
        x = next;
      },
      configurable: true,
    });
    value.x = 6;
    live.sync();
    expect(pushed.at(-1)).toEqual([6, 1]);
  });
});

describe("one uniform crossing a sync (PRD-828)", () => {
  /** A back end with the batched sink: every crossing is recorded, single or batched. */
  function batched() {
    const single: number[][] = [];
    const batches: { counts: number[]; lanes: number[] }[] = [];
    const live = liveUniforms<IFakeNode>(
      () => ({}),
      (_node, lanes) => {
        single.push([...lanes]);
      },
      (_nodes, counts, lanes) => {
        batches.push({ counts: [...counts], lanes: [...lanes] });
      },
    );
    return { live, single, batches };
  }

  it("crosses once for every uniform a sync changed", () => {
    // The debug census counts each engine crossing a write makes.
    const host = globalThis as {
      __THREENATIVE_DEBUG__?: boolean;
      __tnEngineCost?: Record<string, number>;
    };
    host.__THREENATIVE_DEBUG__ = true;
    host.__tnEngineCost = {};
    const { live, single, batches } = batched();
    host.__THREENATIVE_DEBUG__ = undefined;
    let gain = 1;
    for (let i = 0; i < 3; i++) live.uniform(0).onRenderUpdate?.(() => gain + i);
    const tint = { r: 0, g: 0, b: 0 };
    live.uniform(tint);
    live.sync({ frameId: 1 });
    gain = 10;
    tint.g = 0.5;
    batches.length = 0;
    single.length = 0;
    const before = host.__tnEngineCost.uniformWriteCrossings ?? 0;
    live.sync({ frameId: 2 });
    expect(single).toEqual([]);
    expect(batches).toEqual([{ counts: [1, 1, 1, 3], lanes: [10, 11, 12, 0, 0.5, 0] }]);
    expect((host.__tnEngineCost.uniformWriteCrossings ?? 0) - before).toBe(1);
    host.__tnEngineCost = undefined;
  });

  it("delivers an edit made between two renders of one frame to the second", () => {
    const { live, batches } = batched();
    const tint = { r: 0, g: 0, b: 0 };
    let renders = 0;
    live.uniform(tint);
    live.uniform(0).onRenderUpdate?.(() => ++renders);
    live.sync({ frameId: 3 });
    tint.r = 0.25; // FluidVolume edits uniforms between its passes
    live.sync({ frameId: 3 });
    expect(renders).toBe(2);
    expect(batches.at(-1)).toEqual({ counts: [1, 3], lanes: [2, 0.25, 0, 0] });
  });

  it("crosses nothing on a nested render that changed nothing, and runs frame hooks once a frame", () => {
    const { live, single, batches } = batched();
    type Hooked = IFakeNode & { onFrameUpdate(callback: () => unknown): void };
    let frames = 0;
    (live.uniform(0) as Hooked).onFrameUpdate(() => ++frames);
    live.uniform({ x: 1, y: 2 });
    live.sync({ frameId: 4 });
    const crossings = batches.length + single.length;
    for (let pass = 0; pass < 10; pass++) live.sync({ frameId: 4 });
    expect(batches.length + single.length).toBe(crossings);
    // A frame hook registered between two renders of a frame still runs in the second.
    let late = 0;
    (live.uniform(0) as Hooked).onFrameUpdate(() => ++late);
    live.sync({ frameId: 4 });
    live.sync({ frameId: 4 });
    expect([frames, late]).toEqual([1, 1]);
  });

  it("writes a failed batch again at the next sync", () => {
    let fail = true;
    const batches: number[][] = [];
    const live = liveUniforms<IFakeNode>(
      () => ({}),
      () => {},
      (_nodes, _counts, lanes) => {
        batches.push([...lanes]);
        if (fail) throw new Error("TN_TSL_SINK: transient");
      },
    );
    live.uniform({ x: 1, y: 2 });
    expect(() => live.sync()).toThrow("TN_TSL_SINK: transient");
    fail = false;
    live.sync();
    expect(batches).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });
});

// prd249's splat loop reads `uniformArray(values).element(i)` at the loop's node index (PRD-854).
describe("uniformArray at a node index", () => {
  it("selects among the constant elements with the index node", () => {
    const made: string[] = [];
    const node = (label: string) => ({
      label,
      onRenderUpdate: () => node(label),
      equal: (k: number) => ({
        select: (a: { label: string }, b: { label: string }) => {
          made.push(`${label}==${k}?${a.label}:${b.label}`);
          return node(`(${label}==${k}?${a.label}:${b.label})`);
        },
      }),
    });
    let serial = 0;
    const live = liveUniforms<ReturnType<typeof node>>(
      () => node(`u${serial++}`),
      () => {},
    );
    const picked = live.uniformArray([1, 2, 3]).element(node("i")) as unknown as { label: string };
    expect(picked.label).toBe("(i==0?u2:(i==1?u1:u0))");
    expect(made).toHaveLength(2);
    expect(() => live.uniformArray([1]).element(1.5)).toThrow(/TN_TSL_UNIFORM_ARRAY/u);
  });
});
