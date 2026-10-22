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
});

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

  it("asks the fallback tier once per pixel, with a position and a normal", () => {
    const { tsl } = stubTsl();
    const calls: unknown[][] = [];
    defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
      camera,
      fallback: (position, normal) => {
        calls.push([position, normal]);
        return chain();
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.every((node) => node !== undefined)).toBe(true);
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
      // 80 x 45 probes: 8 x 8 rays each, then 6 x 6 irradiance texels each, three spatial filter passes over those texels,
      // then the full-frame gather.
      expect(sizes).toEqual([
        [640, 360],
        [480, 270],
        [480, 270],
        [480, 270],
        [480, 270],
        [null, null],
      ]);
    });

    it("runs as many spatial filter passes as it is asked for, none included", () => {
      for (const [spatialFilterPasses, filterPasses] of [
        [0, 0],
        [1, 1],
        [5, 5],
      ] as const) {
        const { tsl } = stubTsl();
        const sizes: unknown[][] = [];
        (tsl as unknown as Record<string, unknown>).rtt = (_: unknown, w: unknown, h: unknown) => {
          sizes.push([w, h]);
          return chain();
        };
        defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
          camera,
          probes: { downsampleFactor: 16, spatialFilterPasses, viewport },
        });
        // trace, irradiance, the filter passes, gather
        expect(sizes).toHaveLength(3 + filterPasses);
        expect(sizes.slice(2, 2 + filterPasses)).toEqual(Array(filterPasses).fill([480, 270]));
      }
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

    it("asks the fallback tier once per ray, and refuses a grid it cannot build", () => {
      const { tsl } = stubTsl();
      let calls = 0;
      defineScreenSpaceGi(tsl)(chain(), chain(), chain(), {
        camera,
        fallback: () => {
          calls += 1;
          return chain();
        },
        probes: { downsampleFactor: 16, viewport },
      });
      expect(calls).toBe(1);
      for (const probes of [
        { downsampleFactor: 0, viewport },
        { downsampleFactor: 16, viewport: { width: 0, height: 720 } },
        { downsampleFactor: 16, tracingOctahedronResolution: 1, viewport },
        { downsampleFactor: 16, spatialFilterPasses: -1, viewport },
        { downsampleFactor: 16, spatialFilterPasses: 1.5, viewport },
        { downsampleFactor: 16, spatialFilterPasses: 9, viewport },
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
    ).toEqual(Array(6).fill("SSGI")); // trace, irradiance, 3 filter passes, gather
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
