import { readFileSync } from "node:fs";
import { Data3DTexture, Vector3 } from "three";
import { LUTCubeLoader as UpstreamLUTCubeLoader } from "three/addons/loaders/LUTCubeLoader.js";
import { describe, expect, it, vi } from "vitest";
import { defineLUTCubeLoader } from "../src/addons/lut-cube-loader.js";
import { definePostEffects } from "../src/addons/post-effects.js";
import { type ITslRuntime, type TslArgValue, defineTsl } from "../src/browser-tsl.js";
import { defineStruct } from "../src/tsl-struct.js";

const source = readFileSync(
  "packages/create-threenative/templates/starter/public/grade.cube",
  "utf8",
);

const cubeClasses = {
  // quality-allow: generated engine declarations omit the Data3DTexture source constructor and image record.
  textureClass: Data3DTexture as unknown as Parameters<
    typeof defineLUTCubeLoader
  >[0]["textureClass"],
  vectorClass: Vector3,
};

describe("starter post bindings", () => {
  it.each([1009, 1015] as const)("parses the starter LUT like upstream at type %s", (type) => {
    const Loader = defineLUTCubeLoader(cubeClasses, async () => source);
    const own = new Loader().setType(type).parse(source);
    const reference = new UpstreamLUTCubeLoader().setType(type).parse(source);
    expect(own.title).toBe(reference.title);
    expect(own.size).toBe(reference.size);
    expect(own.domainMin).toEqual(reference.domainMin);
    expect(own.domainMax).toEqual(reference.domainMax);
    expect(own.texture3D.image).toEqual(
      (reference.texture3D as unknown as { image: unknown }).image,
    );
    for (const key of [
      "type",
      "minFilter",
      "magFilter",
      "wrapS",
      "wrapT",
      "wrapR",
      "generateMipmaps",
    ] as const)
      expect(own.texture3D[key]).toBe(reference.texture3D[key]);
  });

  it("loads through the supplied asset reader and reports failures to the manager", async () => {
    const read = vi.fn(async () => source);
    const Loader = defineLUTCubeLoader(cubeClasses, read);
    const manager = { itemStart: vi.fn(), itemEnd: vi.fn(), itemError: vi.fn() };
    const loader = new Loader(manager).setPath("assets/");
    expect((await loader.loadAsync("grade.cube")).size).toBeGreaterThan(1);
    expect(read).toHaveBeenCalledWith("assets/grade.cube");
    read.mockRejectedValueOnce(new Error("missing asset"));
    await expect(loader.loadAsync("missing.cube")).rejects.toThrow("missing asset");
    expect(manager.itemError).toHaveBeenCalledWith("assets/missing.cube");
    expect(manager.itemEnd).toHaveBeenCalledWith("assets/missing.cube");
  });

  it("rejects malformed cube files instead of uploading incomplete or invalid data", () => {
    const Loader = defineLUTCubeLoader(cubeClasses, async () => source);
    const loader = new Loader();
    for (const text of [
      "",
      "LUT_3D_SIZE 1",
      "LUT_3D_SIZE 2\n0 0 0",
      `${source}\n0 0 0`,
      source.replace("LUT_3D_SIZE", "LUT_1D_SIZE"),
    ])
      expect(() => loader.parse(text)).toThrow(/TN_LUT_/u);
    expect(() => loader.setType(1016)).toThrow("TN_LUT_TYPE");
  });

  it("passes game nodes unchanged and connects TRAA properties to native parameters", () => {
    const values = new Map<string, number>();
    const effect = {
      __effect: (name: string, value?: number) => {
        if (value !== undefined) values.set(name, value);
        return values.get(name) ?? 0;
      },
    };
    const make = () => vi.fn(() => effect);
    const tsl = {
      ao: make(),
      denoise: make(),
      smaa: make(),
      bloom: make(),
      traa: make(),
      film: make(),
      lut3D: make(),
    };
    const effects = definePostEffects(tsl);
    const input = {};
    const intensity = {};
    const uv = {};
    const lut = {};
    const depth = {};
    const velocity = {};
    const camera = {};
    expect(effects.film(input, intensity, uv)).toBe(effect);
    expect(tsl.film).toHaveBeenCalledWith(input, intensity, uv);
    effects.lut3D(input, lut, 9, intensity);
    expect(tsl.lut3D).toHaveBeenCalledWith(input, lut, 9, intensity);
    const temporal = effects.traa(input, depth, velocity, camera) as unknown as {
      depthThreshold: number;
      useSubpixelCorrection: boolean;
    };
    temporal.depthThreshold = 0.002;
    temporal.useSubpixelCorrection = false;
    expect(values.get("depthThreshold")).toBe(0.002);
    expect(temporal.depthThreshold).toBe(0.002);
    expect(temporal.useSubpixelCorrection).toBe(false);
    expect(() => (temporal as unknown as { setup: () => void }).setup()).toThrow(
      "TN_NATIVE_TRAA_LIFECYCLE_UNBOUND",
    );
    expect(tsl.traa).toHaveBeenCalledWith(input, depth, velocity, camera);
  });

  it("uses the existing struct schema and preserves positional member order", () => {
    const instance = { newStruct: vi.fn() };
    const newStruct = vi.fn(() => instance);
    const make = vi.fn(() => ({ newStruct }));
    const struct = defineStruct(make);
    const Sample = struct({ color: "vec4", weight: "float" }, "Sample");
    const color = {};
    const weight = {};
    Sample(color, weight);
    expect(make).toHaveBeenCalledWith("Sample", "color", "vec4", "weight", "float");
    expect(newStruct).toHaveBeenCalledWith(color, weight);
    expect(() => Sample(color)).toThrow("TN_TSL_STRUCT_VALUES");
  });
  it("routes the Wasm names, node methods and live parameters into the shared native table", () => {
    const calls: { name: string; receiver: number | null; args: readonly TslArgValue[] }[] = [];
    let next = 0;
    const runtime: ITslRuntime = {
      call: (name, receiver, args) => {
        calls.push({ name, receiver, args });
        return ++next;
      },
      release: vi.fn(),
      set: vi.fn(),
      setUniform: vi.fn(),
      setPost: vi.fn(),
      effectParameter: vi.fn(() => 0),
    };
    const { exports: tsl } = defineTsl(runtime);
    const float = tsl.float as (value: number) => object;
    const value = float(0.5);
    for (const name of [
      "film",
      "lut3D",
      "traa",
      "luminance",
      "viewZToOrthographicDepth",
      "viewZToPerspectiveDepth",
      "logarithmicDepthToViewZ",
    ])
      (tsl[name] as (...args: unknown[]) => unknown)(value, value, value, value);
    expect(calls.slice(1).map(({ name }) => name)).toEqual([
      "film",
      "lut3D",
      "traa",
      "luminance",
      "viewZToOrthographicDepth",
      "viewZToPerspectiveDepth",
      "logarithmicDepthToViewZ",
    ]);
    for (const call of calls.slice(1)) expect(call.args[0]).toEqual({ kind: "node", node: 1 });
    expect(tsl.vertexIndex).toBeDefined();
    expect(calls.at(-1)?.name).toBe("constant:vertexIndex");
    const struct = tsl.struct as (
      layout: Record<string, string>,
      name: string,
    ) => (...values: unknown[]) => { get(name: string): unknown };
    struct({ color: "vec4" }, "Sample")(value).get("color");
    expect(calls.slice(-3).map(({ name }) => name)).toEqual(["struct", "newStruct", "get"]);
  });
});
