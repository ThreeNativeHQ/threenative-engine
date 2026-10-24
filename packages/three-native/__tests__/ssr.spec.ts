import { describe, expect, it, vi } from "vitest";
import { type IEffectTsl, definePostEffects } from "../src/addons/post-effects.js";
import { type ITslRuntime, defineTsl } from "../src/browser-tsl.js";

function fixture() {
  const state = new Map<string, number>();
  const node = {
    __effect: vi.fn((name: string, value?: number) => {
      if (value !== undefined) state.set(name, value);
      return state.get(name) ?? 0;
    }),
  };
  const make = vi.fn(() => node);
  const effects = definePostEffects({
    ao: make,
    denoise: make,
    smaa: make,
    bloom: make,
    traa: make,
    film: make,
    lut3D: make,
    ssr: make,
  });
  return { effects, state, node, make };
}

describe("native SSR facade", () => {
  it("routes material inputs and live uniforms through the shared native effect", () => {
    const { effects, state, node, make } = fixture();
    const color = {};
    const depth = {};
    const normal = {};
    const metal = {};
    const rough = {};
    const result = effects.ssr(color, depth, normal, {
      camera: {},
      metalnessNode: metal,
      roughnessNode: rough,
      reflectNonMetals: true,
    }) as unknown as {
      maxDistance: { value: number };
      thickness: { value: number };
      opacity: { value: number };
      quality: { value: number };
      blurQuality: { value: number };
      resolutionScale: number;
      getTextureNode(): unknown;
    };
    expect(make).toHaveBeenCalledWith(color, depth, normal, metal, rough);
    expect(state.get("reflectNonMetals")).toBe(1);
    for (const [name, value] of [
      ["maxDistance", 30],
      ["thickness", 0.2],
      ["opacity", 0.6],
      ["quality", 0.75],
      ["blurQuality", 3],
    ] as const) {
      result[name].value = value;
      expect(state.get(name)).toBe(value);
      state.set(name, value / 2);
      expect(result[name].value).toBe(value / 2);
    }
    result.resolutionScale = 0.5;
    expect(state.get("resolutionScale")).toBe(0.5);
    state.set("resolutionScale", 0.25);
    expect(result.resolutionScale).toBe(0.25);
    expect(result.getTextureNode()).toBe(node);
  });

  it("uses null material defaults and refuses unavailable SSR modes by name", () => {
    const { effects, make } = fixture();
    effects.ssr({}, {}, {}, { camera: {} });
    expect(make).toHaveBeenCalledWith({}, {}, {}, null, null);
    for (const option of ["stochastic", "envImportanceSampling", "environmentNode", "diffuseNode"])
      expect(() => effects.ssr({}, {}, {}, { camera: {}, [option]: true })).toThrow(option);
    expect(() => effects.ssr({}, {}, {})).toThrow("camera");
  });

  it("routes the Wasm SSR name and mutations into the common native ABI", () => {
    const runtime: ITslRuntime = {
      call: vi.fn(() => 1),
      release: vi.fn(),
      set: vi.fn(),
      setUniform: vi.fn(),
      setPost: vi.fn(),
      effectParameter: vi.fn(() => 0),
      compute: vi.fn(),
      readStorage: vi.fn(),
      deleteStorage: vi.fn(),
    };
    const { exports: tsl } = defineTsl(runtime);
    const value = (tsl.float as (value: number) => unknown)(1);
    const reflection = definePostEffects(tsl as unknown as IEffectTsl).ssr(value, value, value, {
      camera: {},
      metalnessNode: value,
      roughnessNode: value,
    }) as unknown as { opacity: { value: number }; resolutionScale: number; blurQuality: number };
    expect(runtime.call).toHaveBeenLastCalledWith(
      "ssr",
      null,
      Array.from({ length: 5 }, () => ({ kind: "node", node: 1 })),
    );
    reflection.opacity.value = 0.75;
    expect(runtime.effectParameter).toHaveBeenLastCalledWith(1, "opacity", 0.75);
    reflection.resolutionScale = 0.5;
    expect(runtime.effectParameter).toHaveBeenLastCalledWith(1, "resolutionScale", 0.5);
    reflection.blurQuality = 3;
    expect(runtime.effectParameter).toHaveBeenLastCalledWith(1, "blurQuality", 3);
  });
});
