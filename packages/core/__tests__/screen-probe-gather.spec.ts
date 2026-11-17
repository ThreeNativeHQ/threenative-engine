import type { Node } from "three/webgpu";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gather composes the engine's TSL program, so the spec reads the graph it builds instead of a GPU frame: every
 * node factory records the operator and its arguments, and `ssgi` records the options it is handed.
 */
interface IRecorded {
  readonly op: string;
  readonly args: unknown[];
}

/** A recording stand-in for a TSL node: it answers every property and call, and remembers what it was asked. */
function rec(op: string, args: unknown[] = [], prop = ""): IRecorded {
  return new Proxy((() => {}) as unknown as IRecorded, {
    get: (target, key) => {
      if (key === "op") return op;
      if (key === "args") return args;
      if (key === "then") return undefined;
      // `uniform(read).onRenderUpdate(read)` refreshes a value each render, as three's and the engine's both do.
      if (key === "onRenderUpdate") return (read: () => number) => rec(op, [read()]);
      return rec(op, args, String(key));
    },
    apply: (_target, _this, called: unknown[]) => rec(prop.length > 0 ? prop : "call", called),
  });
}

const engine: {
  calls: { color: unknown; depth: unknown; normal: unknown; options: Record<string, unknown> }[];
  updates: (() => number)[];
} = { calls: [], updates: [] };

vi.mock("three/tsl", () => {
  const factory =
    (name: string) =>
    (...args: unknown[]) =>
      rec(name, args);
  return {
    float: (value: number) => rec("float", [value]),
    max: (a: unknown, b: unknown) => rec("max", [a, b]),
    normalize: (value: unknown) => rec("normalize", [value]),
    uniform: (value: number) => {
      const node = rec("uniform", [value]) as unknown as {
        onRenderUpdate: (read: () => number) => unknown;
      };
      return node;
    },
    vec3: factory("vec3"),
  };
});

vi.mock("three/addons/tsl/display/SSGINode.js", () => ({
  ssgi: (color: unknown, depth: unknown, normal: unknown, options: Record<string, unknown>) => {
    engine.calls.push({ color, depth, normal, options });
    return rec("gather");
  },
}));

const { ScreenProbeGather } = await import("../src/render/screen-probe-gather.js");
type Options = ConstructorParameters<typeof ScreenProbeGather>[0];

/** The three inputs `gather()` takes, as placeholders: the spec reads the graph, not the pixels. */
const frame = (): Node<"vec4"> => rec("frame") as unknown as Node<"vec4">;
const sceneDepth = (): Node<"float"> => rec("depth") as unknown as Node<"float">;
const sceneNormal = (): Node<"vec4"> => rec("normal") as unknown as Node<"vec4">;

const camera = {
  near: 0.25,
  projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => i + 1) },
  matrixWorld: {
    elements: Array.from({ length: 16 }, (_, i) => (i === 12 ? 7 : i === 13 ? 8 : 0)),
  },
};
const viewport = { width: 1920, height: 1080 };

function gather(options: Partial<Options> = {}) {
  const instance = new ScreenProbeGather({
    camera,
    viewport,
    marker: false,
    ...options,
  } as Options);
  return instance;
}

beforeEach(() => {
  engine.calls = [];
  engine.updates = [];
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("ScreenProbeGather", () => {
  it("places Unreal's Epic grid by default: one probe per 16 x 16 pixels, 8 x 8 rays each", () => {
    const instance = gather();
    expect(instance.report).toEqual({
      downsampleFactor: 16,
      tracingOctahedronResolution: 8,
      viewportWidth: 1920,
      viewportHeight: 1080,
      probes: 120 * 68,
      raysPerProbe: 64,
      worldTrace: false,
    });
    expect(instance.report.probes).toBe(8160);
  });

  it("reports the grid it placed once, as TN_SCREEN_PROBE_GATHER, and stays silent when asked", () => {
    const info = vi.spyOn(console, "info");
    gather({ downsampleFactor: 32, tracingOctahedronResolution: 4, marker: true });
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    // 60 x 34 probes: 1080 / 32 rounds up, so the last row still has its probe.
    expect(lines[0]).toContain('"probes":2040');
    expect(lines[0]).toContain('"raysPerProbe":16');
  });

  it("hands the engine the probe block, and no tier below until the game supplies one", () => {
    gather({ timedPass: "filter" }).gather(frame(), sceneDepth(), sceneNormal());
    expect(engine.calls).toHaveLength(1);
    const { options } = engine.calls[0] as (typeof engine.calls)[number];
    expect(options.probes).toEqual({
      downsampleFactor: 16,
      tracingOctahedronResolution: 8,
      viewport,
      timedPass: "filter",
    });
    expect(options.camera).toBe(camera);
    // Nothing is asked outside the screen: a miss adds nothing and the pixel keeps the cache's mean, as before PRD-640
    // Phase 2. Both tiers appear only with `world`.
    expect(options.fallback).toBeUndefined();
    expect(options.miss).toBeUndefined();
  });

  it("refuses a grid, a viewport or a pass that cannot mean what it says", () => {
    expect(() => gather({ downsampleFactor: 0 })).toThrow(
      /TN_SCREEN_PROBE_GATHER: downsampleFactor/,
    );
    expect(() => gather({ downsampleFactor: 12.5 })).toThrow(/downsampleFactor/);
    expect(() => gather({ tracingOctahedronResolution: 1 })).toThrow(
      /TN_SCREEN_PROBE_GATHER: tracingOctahedronResolution/,
    );
    expect(() => gather({ viewport: { width: 0, height: 1080 } })).toThrow(
      /TN_SCREEN_PROBE_GATHER: viewport/,
    );
    expect(() => gather({ timedPass: "trace" as never })).not.toThrow();
    expect(() => gather({ timedPass: "denoise" as never })).toThrow(
      /TN_SCREEN_PROBE_GATHER: timedPass/,
    );
  });

  it("refuses to read its nodes before it built the gather", () => {
    const instance = gather();
    expect(() => instance.getGINode()).toThrow(/TN_SCREEN_PROBE_GATHER_UNBUILT/);
    expect(() => instance.getAONode()).toThrow(/TN_SCREEN_PROBE_GATHER_UNBUILT/);
  });
});

describe("the tier past the screen", () => {
  const tiers = () => {
    const trace: {
      rays: { origin: unknown; direction: unknown; far: unknown }[];
      hit: { hit: unknown; position: unknown };
    } = {
      rays: [],
      hit: { hit: rec("hit"), position: rec("hitPosition") },
    };
    const reads: unknown[][] = [];
    return {
      trace,
      reads,
      radiance: (...args: unknown[]) => {
        reads.push(args);
        return rec("cacheRadiance") as unknown as Node<"vec3">;
      },
    };
  };
  const missOf = () =>
    (
      engine.calls[0]?.options as {
        miss: (a: unknown, b: unknown, c: unknown) => IRecorded;
      }
    ).miss;

  it("reads the cache at the surface a missed ray found, not the pixel's own mean", () => {
    const { radiance, trace, reads } = tiers();
    const instance = gather({
      radiance,
      trace: {
        trace: (ray: { origin: unknown; direction: unknown; far: unknown }) => {
          trace.rays.push(ray);
          return trace.hit;
        },
      } as unknown as Options["trace"],
    });
    instance.gather(frame(), sceneDepth(), sceneNormal());
    const answer = missOf()(rec("viewPosition"), rec("viewDirection"), rec("viewNormal"));
    // The walk is bounded by the cache's cell, along the ray, off the surface it left.
    expect(trace.rays).toHaveLength(1);
    expect(trace.rays[0]?.far).toBe(1);
    expect(trace.rays[0]?.origin).toBeDefined();
    expect(trace.rays[0]?.direction).toBeDefined();
    // The read lands where the walk ended: the hit's position when it found one, else the cell it reached.
    expect(reads).toHaveLength(2);
    const [at] = reads[0] as [IRecorded, IRecorded];
    expect(at?.op).toBe("select");
    expect(at?.args[0]).toBe(trace.hit.position);
    // The pixel's own light comes out, so the composite that already added it does not count it twice.
    expect(answer.op).toBe("sub");
  });

  it("reads the cache at the cell it reached when the walk finds nothing", () => {
    const { radiance, trace, reads } = tiers();
    trace.hit = { hit: rec("hit", [0]), position: rec("hitPosition") };
    const instance = gather({
      radiance,
      cacheCellSize: 2,
      trace: {
        trace: (ray: { origin: unknown; direction: unknown; far: unknown }) => {
          trace.rays.push(ray);
          return trace.hit;
        },
      } as unknown as Options["trace"],
    });
    instance.gather(frame(), sceneDepth(), sceneNormal());
    missOf()(rec("viewPosition"), rec("viewDirection"), rec("viewNormal"));
    expect(trace.rays[0]?.far).toBe(2);
    const [at] = reads[0] as [IRecorded];
    expect(at?.op).toBe("select");
    // The other side of the select is the point the ray reached: origin + direction x the cell.
    expect((at?.args[1] as IRecorded).op).toBe("add");
  });

  it("reads the tier below a hit along the ray, through the scene camera's world matrix", () => {
    const { radiance, reads } = tiers();
    const instance = gather({ radiance });
    instance.gather(frame(), sceneDepth(), sceneNormal());
    const fallback = (
      engine.calls[0]?.options as {
        fallback: (a: unknown, b: unknown, c: unknown) => IRecorded;
      }
    ).fallback;
    fallback(rec("viewPosition"), rec("viewDirection"), rec("viewNormal"));
    expect(reads).toHaveLength(1);
    // A view-space point becomes a world one, so the game answers in the space its cache lives in.
    expect((reads[0]?.[0] as IRecorded).op).toBe("add");
  });

  it("walks only when the game registered a packed scene: without one there is no miss tier", () => {
    const { radiance, trace } = tiers();
    const instance = gather({ radiance });
    expect(instance.report.worldTrace).toBe(false);
    instance.gather(frame(), sceneDepth(), sceneNormal());
    expect((engine.calls[0]?.options as { fallback?: unknown }).fallback).toBeDefined();
    expect((engine.calls[0]?.options as { miss?: unknown }).miss).toBeUndefined();
    expect(trace.rays).toEqual([]);
  });

  it("hands a game's own tier below over untouched, so the graph stays the one it tuned", () => {
    const { radiance } = tiers();
    const own = (..._args: unknown[]) => rec("ownTier");
    const instance = gather({ fallback: own as unknown as Options["fallback"], radiance });
    instance.gather(frame(), sceneDepth(), sceneNormal());
    expect((engine.calls[0]?.options as { fallback?: unknown }).fallback).toBe(own);
  });

  it("refuses a walk it cannot leave the screen with, a cell of no length, and a walk with nothing to read", () => {
    const { radiance } = tiers();
    const packed = { trace: () => ({}) } as unknown as Options["trace"];
    expect(() =>
      gather({
        camera: { near: 0.25, projectionMatrix: camera.projectionMatrix } as never,
        radiance,
        trace: packed,
      }),
    ).toThrow(/TN_SCREEN_PROBE_GATHER_CAMERA/);
    expect(() => gather({ radiance, trace: packed, cacheCellSize: 0 })).toThrow(
      /TN_SCREEN_PROBE_GATHER: cacheCellSize/,
    );
    expect(() => gather({ trace: packed })).toThrow(/TN_SCREEN_PROBE_GATHER_RADIANCE/);
  });
});
