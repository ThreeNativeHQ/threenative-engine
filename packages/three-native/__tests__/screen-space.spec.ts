import * as upstreamTsl from "three/tsl";
import { describe, expect, it } from "vitest";
import {
  type IScreenSpaceTsl,
  defineScreenSpaceGi,
  defineScreenSpaceReflections,
} from "../src/addons/screen-space.js";

/** A node that answers every property read and call with another node: enough to run the graph body. */
function chain(): unknown {
  const node: unknown = new Proxy(() => undefined, {
    get: (_target, key) => (key === "then" ? undefined : node),
    apply: () => node,
  });
  return node;
}

/** The engine TSL table as the effect uses it; the scene camera's projection must come from `uniform`. */
function stubTsl() {
  const updates: (() => number)[] = [];
  const initial: number[] = [];
  const read: string[] = [];
  const names: readonly (keyof IScreenSpaceTsl)[] = [
    "clamp",
    "dot",
    "float",
    "int",
    "max",
    "min",
    "mix",
    "normalize",
    "reflect",
    "rtt",
    "smoothstep",
    "uv",
    "vec2",
    "vec3",
    "vec4",
  ];
  const tsl: Record<string, unknown> = Object.fromEntries(
    names.map((name) => [name, () => chain()]),
  );
  tsl.Break = () => undefined;
  tsl.Fn = (body: () => unknown) => () => body();
  tsl.If = (_condition: unknown, body: () => void) => {
    body();
    return { Else: (other: () => void) => other() };
  };
  tsl.Loop = (_options: unknown, body: (indices: { i: unknown }) => void) => body({ i: chain() });
  tsl.uniform = (value: number) => {
    initial.push(value);
    const node = chain() as { onRenderUpdate?: unknown };
    return new Proxy(node as object, {
      get: (target, key) =>
        key === "onRenderUpdate"
          ? (callback: () => number) => {
              updates.push(callback);
              return target;
            }
          : (target as Record<string | symbol, unknown>)[key],
    });
  };
  // The quad's own orthographic camera: reading these is the bug this test pins.
  for (const name of ["cameraProjectionMatrix", "cameraNear", "cameraFar"])
    Object.defineProperty(tsl, name, {
      get: () => {
        read.push(name);
        return chain();
      },
    });
  return { tsl: tsl as unknown as IScreenSpaceTsl, updates, initial, read };
}

describe("defineScreenSpaceReflections", () => {
  const camera = {
    near: 0.25,
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => i + 1) },
  };

  it("reads the scene camera's projection through uniforms refreshed every render", () => {
    const { tsl, updates, initial, read } = stubTsl();
    defineScreenSpaceReflections(tsl)(chain(), chain(), chain(), { camera });
    // The six projection terms and the near plane, taken from the camera, not from the quad's own.
    expect(initial).toContain(1);
    expect(initial).toEqual(expect.arrayContaining([1, 6, 9, 10, 11, 15, 0.25]));
    expect(read).toEqual([]);
    camera.projectionMatrix.elements[10] = 99;
    camera.near = 0.5;
    expect(updates.map((update) => update())).toEqual(expect.arrayContaining([99, 0.5]));
  });

  it("refuses a call that names no camera", () => {
    const { tsl } = stubTsl();
    expect(() => defineScreenSpaceReflections(tsl)(chain(), chain(), chain(), {} as never)).toThrow(
      /TN_NATIVE_SSR_CAMERA/,
    );
  });

  it("caps the march at maxSteps, and the capped slices still reach maxDistance", () => {
    const { tsl, make, branches, minCalls } = tracedTsl();
    const node = defineScreenSpaceReflections(tsl)(make(), make(), make(), { camera }) as {
      maxSteps?: object;
    };
    const cap = node.maxSteps;
    expect(cap).toBeDefined();
    // A branch that depends on the cap ends the march: Unreal's per-tier step count.
    expect(branches.some((branch) => cap && branch.sources.has(cap) && branch.broke)).toBe(true);
    // The slice fraction divides by min(maxSteps, 48), so a capped ray still spans maxDistance.
    expect(minCalls.some((args) => args.includes(cap) && args.includes(48))).toBe(true);
  });

  it("skips the march on pixels at or above maxRoughness, and traces every pixel by default", () => {
    const { tsl, make, branches, initial, uniform } = tracedTsl();
    const roughnessNode = uniform(0.7);
    const node = defineScreenSpaceReflections(tsl)(make(), make(), make(), {
      camera,
      roughnessNode,
    }) as { maxRoughness?: object };
    const cut = node.maxRoughness;
    expect(cut).toBeDefined();
    expect(cut && initial.get(cut)).toBe(1);
    // One branch reads both the pixel's roughness and the cut-off: the gate around the per-pixel work.
    expect(
      branches.some(
        (branch) => cut && branch.sources.has(cut) && branch.sources.has(roughnessNode),
      ),
    ).toBe(true);
  });
});

/** TSL nodes that remember the uniforms they were built from, so a test can name what a branch depends on. */
function tracedTsl() {
  const sources = new WeakMap<object, Set<object>>();
  const from = (inputs: unknown[]): Set<object> =>
    new Set(inputs.flatMap((input) => [...(sources.get(input as object) ?? [])]));
  const make = (deps = new Set<object>()): object => {
    const node: object = new Proxy(() => undefined, {
      get: (_target, key) => (key === "then" ? undefined : make(deps)),
      apply: (_target, _this, args: unknown[]) => make(new Set([...deps, ...from(args)])),
    });
    sources.set(node, deps);
    return node;
  };
  const initial = new WeakMap<object, unknown>();
  const uniform = (value?: unknown): object => {
    const deps = new Set<object>();
    const node = make(deps);
    deps.add(node);
    initial.set(node, value);
    return node;
  };
  const branches: { sources: Set<object>; broke: boolean }[] = [];
  const minCalls: unknown[][] = [];
  let current: { broke: boolean } | undefined;
  const tsl: Record<string, unknown> = {
    Break: () => {
      if (current) current.broke = true;
    },
    Fn: (body: () => unknown) => () => body(),
    If: (condition: unknown, body: () => void) => {
      const branch = { sources: from([condition]), broke: false };
      branches.push(branch);
      const outer = current;
      current = branch;
      body();
      current = outer;
      return { Else: (other: () => void) => other() };
    },
    Loop: (_options: unknown, body: (indices: { i: unknown }) => void) => body({ i: make() }),
    rtt: () => ({}),
    uniform,
  };
  for (const name of ["clamp", "dot", "float", "int", "max", "min", "mix", "normalize", "reflect"])
    tsl[name] = (...args: unknown[]) => {
      if (name === "min") minCalls.push(args);
      return make(from(args));
    };
  for (const name of ["smoothstep", "uv", "vec2", "vec3", "vec4"])
    tsl[name] = (...args: unknown[]) => make(from(args));
  return { tsl: tsl as unknown as IScreenSpaceTsl, make, branches, minCalls, initial, uniform };
}

describe("defineScreenSpaceGi", () => {
  const camera = {
    near: 0.25,
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => i + 1) },
  };

  it("reads the scene camera's projection through uniforms, for both call shapes", () => {
    for (const call of [camera, { camera }]) {
      const { tsl, updates, initial, read } = stubTsl();
      defineScreenSpaceGi(tsl)(chain(), chain(), chain(), call);
      expect(initial).toEqual(expect.arrayContaining([1, 6, 9, 10, 11, 15, 0.25]));
      expect(read).toEqual([]);
      expect(updates.length).toBeGreaterThan(0);
    }
  });

  it("asks the fallback tier along each ray that hits, as Lumen samples its radiance cache per ray direction", () => {
    // A hit replaces what the cache holds along that ray, not the cache's mean over the hemisphere: rays into a dark
    // corner find dark walls while the bright directions leave the screen, and a mean turns every hit into a loss.
    const { tsl } = stubTsl();
    let depth = 0;
    const loop = tsl.Loop as unknown as (
      options: unknown,
      body: (indices: { i: unknown }) => void,
    ) => void;
    (tsl as unknown as Record<string, unknown>).Loop = (
      options: unknown,
      body: (indices: { i: unknown }) => void,
    ) => {
      depth += 1;
      loop(options, body);
      depth -= 1;
    };
    const calls: { inRayLoop: boolean; args: unknown[] }[] = [];
    defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
      camera,
      fallback: (position, direction) => {
        calls.push({ inRayLoop: depth > 0, args: [position, direction] });
        return chain();
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inRayLoop).toBe(true);
    expect(calls[0]?.args.every((node) => node !== undefined)).toBe(true);
  });

  it("hands the fallback tier the receiver's normal as well as the ray, in both gathers", () => {
    // A cache read along a ray must still be taken from the receiver's side of its surface. Offset along the ray
    // instead, a corner's reads land half a cell inside the next wall, and `hit - cache` draws a black line there.
    for (const probes of [
      undefined,
      { downsampleFactor: 16, viewport: { width: 1280, height: 720 } },
    ]) {
      const { tsl } = stubTsl();
      const calls: unknown[][] = [];
      defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
        camera,
        fallback: (...args: unknown[]) => {
          calls.push(args);
          return chain();
        },
        ...(probes === undefined ? {} : { probes }),
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(args).toHaveLength(3);
        expect(args.every((node) => node !== undefined)).toBe(true);
      }
    }
  });

  describe("with screen probes", () => {
    const viewport = { width: 1280, height: 720 };

    it("traces one texel per ray and keeps a six-texel irradiance octahedron per probe", () => {
      const { tsl } = stubTsl();
      const sizes: unknown[][] = [];
      (tsl as unknown as Record<string, unknown>).rtt = (_: unknown, w: unknown, h: unknown) => {
        sizes.push([w, h]);
        return chain();
      };
      defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
        camera,
        probes: { downsampleFactor: 16, viewport },
      });
      // 80 x 45 probes: 8 x 8 rays each, then 6 x 6 irradiance texels each, then the full-frame gather.
      expect(sizes).toEqual([
        [640, 360],
        [480, 270],
        [null, null],
      ]);
    });

    it("rounds the probe grid up so the last tile still has its probe", () => {
      const { tsl } = stubTsl();
      const sizes: unknown[][] = [];
      (tsl as unknown as Record<string, unknown>).rtt = (_: unknown, w: unknown, h: unknown) => {
        sizes.push([w, h]);
        return chain();
      };
      defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
        camera,
        probes: { downsampleFactor: 16, viewport: { width: 1920, height: 1080 } },
      });
      expect(sizes[0]).toEqual([960, 544]);
    });

    it("asks the fallback tier in the trace pass, along each ray, and refuses a grid it cannot build", () => {
      const { tsl } = stubTsl();
      let passes = 0;
      (tsl as unknown as Record<string, unknown>).rtt = () => {
        passes += 1;
        return chain();
      };
      const askedIn: number[] = [];
      defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
        camera,
        fallback: () => {
          askedIn.push(passes);
          return chain();
        },
        probes: { downsampleFactor: 16, viewport },
      });
      // Pass 0 is the trace: each ray texel subtracts the cache along its own direction before the filter mixes rays.
      expect(askedIn).toEqual([0]);
      for (const probes of [
        { downsampleFactor: 0, viewport },
        { downsampleFactor: 16, viewport: { width: 0, height: 720 } },
        { downsampleFactor: 16, tracingOctahedronResolution: 1, viewport },
      ])
        expect(() =>
          defineScreenSpaceGi(tsl)(chain(), chain(), chain(), { camera, probes }),
        ).toThrow(/TN_NATIVE_SCREEN_PROBES/);
    });
  });

  it("labels every pass of the gather with the SSGI stage, and the reflections with none", () => {
    const stageOfEach = (build: (tsl: IScreenSpaceTsl) => void): unknown[] => {
      const { tsl } = stubTsl();
      const stages: unknown[] = [];
      (tsl as unknown as Record<string, unknown>).rtt = (
        _: unknown,
        __: unknown,
        ___: unknown,
        options: { gpuStage?: string },
      ) => {
        stages.push(options.gpuStage);
        return chain();
      };
      build(tsl);
      return stages;
    };
    const viewport = { width: 1280, height: 720 };
    expect(
      stageOfEach((tsl) => defineScreenSpaceGi(tsl)(chain(), chain(), chain(), { camera })),
    ).toEqual(["SSGI"]);
    expect(
      stageOfEach((tsl) =>
        defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
          camera,
          probes: { downsampleFactor: 16, viewport },
        }),
      ),
    ).toEqual(["SSGI", "SSGI", "SSGI"]);
    // A timed pass keeps the label on its own group only, so the stage times that group alone.
    const timed = (timedPass: string | null) =>
      stageOfEach((tsl) =>
        defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
          camera,
          probes: { downsampleFactor: 16, viewport, timedPass: timedPass as "trace" },
        }),
      );
    const S = "SSGI";
    const _ = undefined;
    expect(timed("trace")).toEqual([S, _, _]);
    expect(timed("filter")).toEqual([_, S, _]);
    expect(timed("gather")).toEqual([_, _, S]);
    expect(timed(null)).toEqual([_, _, _]);
    expect(() => timed("denoise")).toThrow(/TN_NATIVE_SCREEN_PROBES/);
    expect(
      stageOfEach((tsl) =>
        defineScreenSpaceReflections(tsl)(chain(), chain(), chain(), { camera }),
      ),
    ).toEqual([undefined]);
  });

  it("refuses a call that names no camera", () => {
    const { tsl } = stubTsl();
    expect(() => defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {} as never)).toThrow(
      /TN_NATIVE_SSGI_CAMERA/,
    );
  });
});

/**
 * Upstream three r187's own node system as the engine's TSL table, with each render-to-texture answered by a named
 * stand-in. It runs the shipped graph against the node classes the caller's chain is authored in, and the stand-ins
 * make the answer's dependency tree walkable back to the pass it reads.
 */
function upstreamTable() {
  const gathers: unknown[] = [];
  const tsl = {
    ...upstreamTsl,
    rtt: () => {
      // Three's `_getChildren` reads an own node's accessors too, so the stand-in answers the pass's scale as well.
      const gather = Object.assign(upstreamTsl.vec4(0.5), {
        getResolutionScale: () => 0.5,
        setResolutionScale: () => {},
      }) as unknown;
      gathers.push(gather);
      return gather;
    },
  };
  return { tsl: tsl as unknown as IScreenSpaceTsl, gathers };
}

/** Every node the answer is built from. */
function dependenciesOf(node: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  (node as { traverse(callback: (child: unknown) => void): void }).traverse((child) =>
    seen.add(child),
  );
  return seen;
}

describe("the gather's occlusion", () => {
  const camera = {
    near: 0.25,
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => i + 1) },
  };

  // three's SSGINode answers `pow(clamp(1 - occludedShare), aoIntensity)` out of the same pass target, and its
  // caller multiplies the lit frame by it (three r187 SSGINode.js:637-638, 651). Answering a constant 1 dropped the
  // term: the frame kept the light the occluder blocked and SSGI only added its gather (PRD-617 AC-7, 2026-11-02).
  it("answers the share the gather blocked, so the frame it multiplies darkens", () => {
    const { tsl, gathers } = upstreamTable();
    const node = defineScreenSpaceGi(tsl)(chain(), chain(), chain(), camera);
    expect(gathers).toHaveLength(1);
    expect(dependenciesOf(node.getAONode()).has(gathers[0])).toBe(true);
  });

  it("answers the probe gather's share, not a constant", () => {
    const { tsl, gathers } = upstreamTable();
    const node = defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
      camera,
      probes: { downsampleFactor: 16, viewport: { width: 1280, height: 720 } },
    });
    expect(gathers).toHaveLength(3);
    expect(dependenciesOf(node.getAONode()).has(gathers[2])).toBe(true);
  });

  // With a cache tier below, a ray that hits already returns `hit - cache`: the frame keeps the cache along that ray
  // and the gather swaps it for what the ray found. Multiplying the frame by the hit share too removed that light a
  // second time, and the direct light with it (cornell corner floor 61 against Unreal's 98, 2026-11-06).
  it("answers no occlusion over a fallback tier, for both gathers, since each hit already replaced the cache", () => {
    for (const probes of [
      undefined,
      { downsampleFactor: 16, viewport: { width: 1280, height: 720 } },
    ]) {
      const { tsl, gathers } = upstreamTable();
      const node = defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
        camera,
        fallback: () => upstreamTsl.vec3(0.2),
        ...(probes === undefined ? {} : { probes }),
      });
      for (const gather of gathers)
        expect(dependenciesOf(node.getAONode()).has(gather)).toBe(false);
    }
  });
});
