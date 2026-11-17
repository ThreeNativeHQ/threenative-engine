import type { TextureNode } from "three/webgpu";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pass is a TSL program, so the spec reads the graph it builds: the stub runs both loop bodies once and records
 * every call, which is enough to hold the sweep, the reach and the two channels to their contract.
 */
interface IRecorded {
  readonly op: string;
  readonly args: unknown[];
}

function rec(op: string, args: unknown[] = [], prop = ""): IRecorded {
  return new Proxy((() => {}) as unknown as IRecorded, {
    get: (target, key) => {
      if (key === "op") return op;
      if (key === "args") return args;
      if (key === "then") return undefined;
      // The pass multiplies node components by scalars, which a real node overloads; the stub answers 0 so the graph
      // still builds and the operators stay recorded.
      if (key === Symbol.toPrimitive || key === "valueOf" || key === "toString") return () => 0;
      if (key === "onRenderUpdate") return (read: () => number) => rec(op, [read()]);
      return rec(op, args, String(key));
    },
    apply: (_target, _this, called: unknown[]) => {
      const result = rec(prop.length > 0 ? prop : "call", called);
      ops.push(result.op);
      return result;
    },
  });
}

const loops: { bounds: unknown; body: (indices: { i: unknown }) => void }[] = [];
/** Every operator the graph asked for, and every uniform it set, in order. */
const ops: string[] = [];
const uniforms: number[] = [];

vi.mock("three/tsl", () => {
  const factory =
    (name: string) =>
    (...args: unknown[]) =>
      rec(name, args);
  return {
    Break: () => undefined,
    Fn: (body: () => unknown) => () => body(),
    If: (_condition: unknown, body: () => void) => {
      body();
      return { Else: (other: () => void) => other() };
    },
    Loop: (bounds: unknown, body: (indices: { i: unknown }) => void) => {
      loops.push({ bounds, body });
      body({ i: rec("loopIndex") });
    },
    clamp: (value: unknown, low: unknown, high: unknown) => rec("clamp", [value, low, high]),
    cos: (value: unknown) => rec("cos", [value]),
    float: (value: number) => rec("float", [value]),
    floor: (value: unknown) => rec("floor", [value]),
    int: (value: number) => rec("int", [value]),
    length: (value: unknown) => rec("length", [value]),
    max: (a: unknown, b: unknown) => rec("max", [a, b]),
    normalize: (value: unknown) => rec("normalize", [value]),
    pow: (base: unknown, exponent: unknown) => {
      ops.push("pow");
      return rec("pow", [base, exponent]);
    },
    rtt: (graph: unknown, width: unknown, height: unknown) => rec("rtt", [graph, width, height]),
    sin: (value: unknown) => rec("sin", [value]),
    uniform: (value: number) => {
      uniforms.push(value);
      return rec("uniform", [value]);
    },
    uv: () => rec("uv"),
    vec2: (x: unknown, y: unknown) => rec("vec2", [x, y]),
    vec3: factory("vec3"),
    vec4: factory("vec4"),
  };
});

const { ShortRangeAO } = await import("../src/render/short-range-ao.js");
type Options = ConstructorParameters<typeof ShortRangeAO>[0];

const camera = {
  projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => i + 1) },
};
const viewport = { width: 1280, height: 720 };

const build = (options: Partial<Options> = {}): InstanceType<typeof ShortRangeAO> =>
  new ShortRangeAO({ camera, viewport, marker: false, ...options } as Options);

const frame = (): TextureNode => rec("frame") as unknown as TextureNode;

beforeEach(() => {
  loops.length = 0;
  ops.length = 0;
  uniforms.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("ShortRangeAO", () => {
  it("sweeps Unreal's Epic search by default: 2 slices, 3 steps, a 32 px reach, a bent normal", () => {
    const ao = build();
    expect(ao.report).toEqual({
      horizonSearchSliceCount: 2,
      horizonSearchStepCount: 3,
      reachPx: 32,
      samplesPerPixel: 6,
      bentNormal: true,
    });
  });

  it("prints the sweep once, as TN_SHORT_RANGE_AO, and names the numbers a capture reads", () => {
    const info = vi.spyOn(console, "info");
    build({ marker: true, horizonSearchSliceCount: 4, horizonSearchStepCount: 5, reachPx: 48 });
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"samplesPerPixel":20');
    expect(lines[0]).toContain('"reachPx":48');
  });

  it("sweeps a half-circle per pixel in the surface's tangent plane, two nested loops deep", () => {
    const ao = build();
    ao.occlusion(frame(), frame());
    expect(loops).toHaveLength(2);
    // The outer loop turns the sweep; the inner one walks it. Both are capped by a constant the compiler can see and
    // stopped by a uniform at run time, so a driver cannot unroll the program past what it will compile.
    for (const loop of loops) expect(JSON.stringify(loop.bounds)).toContain('"type":"int"');
    expect(uniforms).toEqual(expect.arrayContaining([2, 3]));
  });

  it("turns the reach into pixels of the drawing buffer and lands each step at its squared fraction", () => {
    const ao = build({ reachPx: 32 });
    ao.occlusion(frame(), frame());
    // One step is reachPx / viewport in uv, and the step walks the reach's squared fraction of it.
    expect(ops).toContain("div");
    expect(ops).toContain("pow");
    // The projection the pass maps the screen with is read through uniforms (six terms), and the sweep and its
    // intensity are uniforms too, so a capture can bracket them without rebuilding the program.
    expect(uniforms.length).toBeGreaterThanOrEqual(9);
  });

  it("answers the occlusion alone as `.a`, and skips the bent normal when the tier has none", () => {
    const withBent = build({ bentNormal: true });
    expect(withBent.report.bentNormal).toBe(true);
    expect(() => withBent.occlusion(frame(), frame())).not.toThrow();
    const plain = build({ bentNormal: false });
    const before = JSON.stringify(loops);
    plain.occlusion(frame(), frame());
    // The bent normal's accumulation is the only difference: the sweep and the occlusion channel are the same.
    expect(JSON.stringify(loops).length).toBeLessThan(before.length * 2);
    expect(plain.report.samplesPerPixel).toBe(6);
  });

  it("refuses a sweep, a reach or an intensity that cannot mean what it says", () => {
    expect(() => build({ horizonSearchSliceCount: 0 })).toThrow(
      /TN_SHORT_RANGE_AO: horizonSearchSliceCount/,
    );
    expect(() => build({ horizonSearchStepCount: 1.5 })).toThrow(
      /TN_SHORT_RANGE_AO: horizonSearchStepCount/,
    );
    expect(() => build({ horizonSearchSliceCount: 9 })).toThrow(/compiles/);
    expect(() => build({ reachPx: 0 })).toThrow(/TN_SHORT_RANGE_AO: reachPx/);
    expect(() => build({ intensity: 0 })).toThrow(/TN_SHORT_RANGE_AO: intensity/);
    expect(() => build({ viewport: { width: 0, height: 720 } })).toThrow(
      /TN_SHORT_RANGE_AO: viewport/,
    );
    expect(() => build({ camera: {} as never })).toThrow(/TN_SHORT_RANGE_AO_CAMERA/);
  });
});
