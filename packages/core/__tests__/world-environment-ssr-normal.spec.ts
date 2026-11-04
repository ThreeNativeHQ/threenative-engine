import { PerspectiveCamera, Scene } from "three";
import { vec4 } from "three/tsl";
import { expect, it, vi } from "vitest";
import { type OutputRenderer, WorldEnvironment } from "../src/look/world-environment.js";

const normals = vi.hoisted(() => [] as { levelNode?: unknown }[]);
vi.mock("three/addons/tsl/display/SSRNode.js", async (actual) => {
  const real = await actual<typeof import("three/addons/tsl/display/SSRNode.js")>();
  return {
    ...real,
    ssr: (_color: unknown, _depth: unknown, normal: { levelNode?: unknown }) => {
      normals.push(normal);
      return Object.assign(vec4(0), { maxDistance: { value: 0 }, maxSteps: { value: 0 } });
    },
  };
});

// The starter on Windows CI (D3D12, Microsoft Basic Render Driver): three's SSRNode samples the normal inside
// its march loop, and an implicit-gradient sample in a dynamic loop makes FXC try to unroll it and fail
// ("X3511: unable to unroll loop"). The normal target has no mips, so level 0 reads the same texels.
it("hands the reflection march a normal sampled at level 0, so FXC compiles the loop", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const target: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createRenderChain({ stages }) {
      const stage = stages?.find((entry) => entry.name === "ssr");
      if (!stage) throw new Error("missing ssr stage");
      try {
        stage.build(vec4(1), { tier: "high" });
      } catch {
        // The fake march is enough to reach the normal input; the composite is not under test.
      }
      return { applied: { stages: ["ssr"], dropped: [] }, dispose() {} };
    },
  };
  new WorldEnvironment({
    autoExposureEnabled: false,
    tonemapMode: "aces",
    ssrEnabled: true,
    bloomEnabled: false,
    screenSpaceAA: "disabled",
  })
    .apply(target, new Scene(), new PerspectiveCamera())
    ?.dispose?.();
  expect(normals.length).toBeGreaterThan(0);
  for (const normal of normals) expect(normal.levelNode ?? null).not.toBeNull();
});

// A game hands the chain its scene's triangles (`reflectionTrace` on the target), and the stage traces them
// instead of marching the screen, so a chrome ball reflects what stands around it (Unreal's Lumen reflections).
it("traces the target's reflectionTrace instead of marching the screen", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  normals.length = 0;
  const weight = vi.fn(() => vec4(1).x);
  const reflectionTrace = { weight, maxRoughnessToTrace: 0.4 } as unknown as NonNullable<
    Parameters<WorldEnvironment["apply"]>[3]
  >["reflectionTrace"];
  const target: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createRenderChain({ stages }) {
      const stage = stages?.find((entry) => entry.name === "ssr");
      if (!stage) throw new Error("missing ssr stage");
      stage.build(vec4(1), { tier: "high" });
      return { applied: { stages: ["ssr"], dropped: [] }, dispose() {} };
    },
  };
  new WorldEnvironment({
    autoExposureEnabled: false,
    tonemapMode: "aces",
    ssrEnabled: true,
    bloomEnabled: false,
    screenSpaceAA: "disabled",
  })
    .apply(target, new Scene(), new PerspectiveCamera(), { reflectionTrace })
    ?.dispose?.();
  expect(weight).toHaveBeenCalled();
  expect(normals).toEqual([]);
});

// A traced hit in shadow takes the sky light, as Unreal's hit lighting does: E / pi on each axis of the environment.
it("measures the sky light a traced hit takes from a CPU environment", async () => {
  const { DataTexture, FloatType, RGBAFormat } = await import("three");
  const { skyAmbientCube } = await import("../src/look/reflection-trace.js");
  const width = 64;
  const height = 32;
  const data = new Float32Array(width * height * 4);
  // Radiance 1 above the horizon, 0 below: a surface facing up sees all of it, one facing down none.
  for (let row = height / 2; row < height; row++)
    data.fill(1, row * width * 4, (row + 1) * width * 4);
  const cube = skyAmbientCube(new DataTexture(data, width, height, RGBAFormat, FloatType), 2);
  expect(cube?.[2]?.[0]).toBeCloseTo(2, 1);
  expect(cube?.[3]?.[0]).toBeCloseTo(0, 5);
  expect(cube?.[0]?.[1]).toBeCloseTo(1, 1);
  expect(skyAmbientCube(null)).toBeUndefined();
});
