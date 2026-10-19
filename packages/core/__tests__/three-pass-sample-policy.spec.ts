import {
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from "three";
// @ts-expect-error Exercise Three's actual private per-object cache manager.
import RenderObjects from "three/src/renderers/common/RenderObjects.js";
import { context } from "three/tsl";
import { MeshBasicNodeMaterial, WGSLNodeBuilder, WebGPURenderer } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";

function shaders(alphaTest: number, policy?: Record<string, unknown>) {
  const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
  Reflect.set(renderer.backend, "renderer", renderer);
  vi.spyOn(Reflect.get(renderer.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
    65_536,
  );
  vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
  if (policy !== undefined) renderer.contextNode = context(policy);
  const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const material = new MeshBasicMaterial({ map, alphaTest });
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  const builder = new WGSLNodeBuilder(mesh, renderer) as WGSLNodeBuilder & {
    build(): void;
    vertexShader: string;
    fragmentShader: string;
    getVaryings(stage: string): string;
  };
  Reflect.set(builder, "camera", new PerspectiveCamera());
  Reflect.set(builder, "scene", new Scene());
  builder.build();
  return {
    builder,
    renderer,
    material,
    vertex: builder.vertexShader,
    fragment: builder.fragmentShader,
  };
}

describe("pass-scoped sample interpolation and position invariance", () => {
  const cutoutPolicy = {
    sampleInterpolation: (material: { alphaTest: number }) => material.alphaTest > 0,
    invariantPosition: true,
  };

  it("keeps ordinary opaque shading at pixel frequency under the selective policy", () => {
    const result = shaders(0, cutoutPolicy);
    expect(result.fragment).not.toContain(", sample)");
    expect(result.fragment).not.toContain(", sample )");
    expect(result.vertex).toContain("@invariant @builtin( position )");
    expect(Reflect.get(result.material, "contextNode")).toBeUndefined();
  });

  it("moves the original cutout's map inputs to sample interpolation on both shader stages", () => {
    const result = shaders(0.5, cutoutPolicy);
    expect(result.vertex).toContain("@interpolate( perspective, sample )");
    expect(result.fragment).toContain("@interpolate( perspective, sample )");
    expect(result.fragment).toContain("discard");
    expect(result.vertex).toContain("@invariant @builtin( position )");
    expect(result.fragment).not.toContain("@invariant");
  });

  it("leaves the same original material and nodes unchanged in the ordinary pass", () => {
    const ordinary = shaders(0.5);
    expect(ordinary.vertex).not.toContain("@invariant");
    expect(ordinary.fragment).not.toContain("@interpolate( perspective, sample )");
    expect(ordinary.fragment).toContain("discard");
  });

  it("preserves flat data and explicit linear interpolation without mutating varying metadata", () => {
    const { builder } = shaders(0.5, cutoutPolicy);
    const varyings = [
      {
        name: "id",
        type: "uint",
        needsInterpolation: true,
        interpolationType: null,
        interpolationSampling: null,
      },
      {
        name: "owner",
        type: "float",
        needsInterpolation: true,
        interpolationType: "flat",
        interpolationSampling: "either",
      },
      {
        name: "motion",
        type: "vec2",
        needsInterpolation: true,
        interpolationType: "linear",
        interpolationSampling: null,
      },
    ];
    Reflect.set(builder, "varyings", varyings);
    const before = structuredClone(varyings);
    const fragment = builder.getVaryings("fragment");
    expect(fragment).toContain("@interpolate(flat, either) id");
    expect(fragment).toContain("@interpolate( flat, either ) owner");
    expect(fragment).toContain("@interpolate( linear, sample ) motion");
    expect(varyings).toEqual(before);
    defined(varyings[2]).interpolationSampling = "centroid";
    expect(() => builder.getVaryings("fragment")).toThrow(/centroid/);
  });

  it("reuses the same object's cache only for the same immutable pass policy and sample count", () => {
    const renderer = {
      contextNode: context(cutoutPolicy),
      backend: { isWebGPUBackend: true },
      _currentSourceMaterial: null,
    };
    const nodes = { getCacheKey: () => 0, delete: vi.fn() };
    const manager = new RenderObjects(
      renderer,
      nodes,
      {},
      { delete: vi.fn() },
      { deleteForRender: vi.fn() },
      {},
    );
    const material = new MeshBasicNodeMaterial();
    const mesh = new Mesh(new PlaneGeometry(), material);
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const lights = {};
    const raster = { id: 1, sampleCount: 4 };
    const get = () => manager.get(mesh, material, scene, camera, lights, raster, null);
    const original = get();
    expect(get()).toBe(original);
    renderer.contextNode = context({ invariantPosition: true, sampleInterpolation: true });
    const replay = get();
    expect(replay).not.toBe(original);
    expect(get()).toBe(replay);
    raster.sampleCount = 1;
    const centre = get();
    expect(centre).not.toBe(replay);
    expect(get()).toBe(centre);
    renderer.contextNode.needsUpdate = true;
    expect(get()).not.toBe(centre);
  });
});

function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture value.");
  return value;
}
