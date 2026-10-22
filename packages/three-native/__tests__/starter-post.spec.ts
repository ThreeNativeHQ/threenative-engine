import { readFileSync } from "node:fs";
import { Data3DTexture, OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { LUTCubeLoader as UpstreamLUTCubeLoader } from "three/addons/loaders/LUTCubeLoader.js";
import TRAANode from "three/addons/tsl/display/TRAANode.js";
import { rtt as upstreamRtt, vec4 } from "three/tsl";
import { NodeMaterial, QuadMesh, RenderTarget } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { defineLUTCubeLoader } from "../src/addons/lut-cube-loader.js";
import { definePostEffects } from "../src/addons/post-effects.js";
import { type IBrowserRuntime, defineBrowserClasses } from "../src/browser-backend.js";
import { type ITslRuntime, type TslArgValue, defineTsl } from "../src/browser-tsl.js";
import { loadCatalog } from "../src/catalog.js";
import { defineRtt } from "../src/rtt.js";
import { defineStruct } from "../src/tsl-struct.js";
import { defineWgslFn } from "../src/wgsl-fn.js";

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
    const filter = effects.denoise(input, depth, null, camera) as unknown as { gpuStage?: string };
    expect(filter.gpuStage).toBeUndefined();
    filter.gpuStage = "SSGI";
    expect(values.get("stage")).toBe(1);
    expect(filter.gpuStage).toBe("SSGI");
    expect(() => {
      filter.gpuStage = "AO";
    }).toThrow("TN_GPU_STAGE");
    const temporal = effects.traa(input, depth, velocity, camera) as unknown as {
      depthThreshold: number;
      useSubpixelCorrection: boolean;
    };
    temporal.depthThreshold = 0.002;
    temporal.useSubpixelCorrection = false;
    expect(values.get("depthThreshold")).toBe(0.002);
    expect(temporal.depthThreshold).toBe(0.002);
    expect(temporal.useSubpixelCorrection).toBe(false);

    expect(tsl.traa).toHaveBeenCalledWith(input, depth, velocity, camera);
  });

  it("matches upstream TRAA camera offsets and clears them through setup callbacks", () => {
    for (const Camera of [PerspectiveCamera, OrthographicCamera]) {
      const camera = new Camera();
      const referenceCamera = new Camera();
      const reference = new TRAANode(
        null as never,
        null as never,
        null as never,
        referenceCamera as never,
      ) as unknown as {
        setViewOffset(w: number, h: number): void;
        clearViewOffset(): void;
        dispose(): void;
      };
      Object.assign(reference, { _velocityNode: { setProjectionMatrix: vi.fn() } });
      const state = new Map<string, number>();
      const effect = {
        __effect(name: string, value?: number) {
          if (value !== undefined) state.set(name, value);
          return state.get(name) ?? 0;
        },
      };
      const make = () => effect;
      const temporal = definePostEffects({
        ao: make,
        denoise: make,
        smaa: make,
        bloom: make,
        traa: make,
        film: make,
        lut3D: make,
      }).traa({}, {}, {}, camera) as unknown as {
        setup(builder: unknown): unknown;
        setViewOffset(w: number, h: number): void;
        clearViewOffset(): void;
      };
      const context: { onBeforeRenderPipeline?: () => void; onAfterRenderPipeline?: () => void } =
        {};
      expect(
        temporal.setup({
          context: { renderPipeline: { context } },
          renderer: {
            getDrawingBufferSize: (target: { set(w: number, h: number): unknown }) =>
              target.set(320, 240),
          },
        }),
      ).toBe(effect);
      for (let i = 0; i < 96; ++i) {
        context.onBeforeRenderPipeline?.();
        reference.setViewOffset(320, 240);
        expect(camera.projectionMatrix.elements).toEqual(referenceCamera.projectionMatrix.elements);
        expect(state.get("viewOffset")).toBe(1);
        context.onAfterRenderPipeline?.();
        reference.clearViewOffset();
        expect(camera.projectionMatrix.elements).toEqual(referenceCamera.projectionMatrix.elements);
        expect((camera as unknown as { view?: { enabled: boolean } }).view?.enabled).toBe(false);
        expect(state.get("viewOffset")).toBe(0);
      }
      reference.dispose();
    }
  });

  it("links positional and named WGSL arguments with their declared scalar and vector types", () => {
    const invoke = vi.fn();
    const make = vi.fn(() => ({ invoke }));
    const wgslFn = defineWgslFn(make);
    const code =
      "fn area(sample: u32, lo: vec2<f32>, hi: vec2<f32>) -> f32 { return f32(sample); }";
    const area = wgslFn(code);
    expect(make).toHaveBeenCalledWith(code, "area", "float", "uint", "vec2", "vec2");
    const lo = {};
    const hi = {};
    area(1, lo, hi);
    expect(invoke).toHaveBeenLastCalledWith(1, lo, hi);
    area({ hi, sample: 2, lo });
    expect(invoke).toHaveBeenLastCalledWith(2, lo, hi);
    expect(() => area(1, lo)).toThrow("TN_TSL_WGSL_ARGUMENTS");
    expect(() => wgslFn("fn invalid(x) {} ")).toThrow("TN_TSL_WGSL_DECLARATION");
    expect(() => wgslFn(code, [area])).toThrow("TN_TSL_WGSL_INCLUDES");
  });

  it("forwards RTT filter, extent, dirty, disposal and scale mutations to its scheduled target", () => {
    const state = new Map<string, number>([
      ["actualWidth", 40],
      ["actualHeight", 20],
    ]);
    const effect = vi.fn((name: string, value?: number) => {
      if (value !== undefined) state.set(name, value);
      return state.get(name) ?? 0;
    });
    const make = vi.fn(() => ({ __effect: effect, __rtt: vi.fn() }));
    const node = defineRtt(make, { NodeMaterial, QuadMesh, RenderTarget })({}, null, null, {
      depthBuffer: false,
      type: 1016,
      minFilter: 1003,
      magFilter: 1003,
    }) as unknown as {
      autoUpdate: boolean;
      textureNeedsUpdate: boolean;
      renderTarget: {
        width: number;
        height: number;
        texture: { minFilter: number };
        setSize(w: number, h: number): void;
        dispose(): void;
      };
      setResolutionScale(value: number): void;
    };
    expect(make).toHaveBeenCalledWith({}, 0, 0, 1003, 1003);
    expect([node.renderTarget.width, node.renderTarget.height]).toEqual([1, 1]);
    node.autoUpdate = false;
    node.textureNeedsUpdate = true;
    node.renderTarget.setSize(80, 40);
    node.renderTarget.texture.minFilter = 1006;
    node.setResolutionScale(0.5);
    expect([node.renderTarget.width, node.renderTarget.height]).toEqual([80, 40]);
    expect(node.renderTarget.texture.minFilter).toBe(1006);
    node.renderTarget.dispose();
    expect(Object.fromEntries(state)).toMatchObject({
      autoUpdate: 0,
      textureNeedsUpdate: 1,
      resolutionScale: 0.5,
    });
    expect(() =>
      defineRtt(make, { NodeMaterial, QuadMesh, RenderTarget })({}, 1, 1, { samples: 4 }),
    ).toThrow("TN_TSL_RTT_OPTION");
  });

  it("labels an RTT pass with a GPU stage, keeps the label off the render target, and refuses an unknown one", () => {
    const state = new Map<string, number>();
    const effect = vi.fn((name: string, value?: number) => {
      if (value !== undefined) state.set(name, value);
      return state.get(name) ?? 0;
    });
    const make = vi.fn(() => ({ __effect: effect, __rtt: vi.fn() }));
    const options = { type: 1016, gpuStage: "SSGI" };
    defineRtt(make, { NodeMaterial, QuadMesh, RenderTarget })({}, null, null, options);
    expect(state.get("stage")).toBe(1);
    const unlabelled = new Map<string, number>();
    defineRtt(
      () => ({
        __effect: (name: string, value?: number) => {
          if (value !== undefined) unlabelled.set(name, value);
          return 0;
        },
        __rtt: vi.fn(),
      }),
      { NodeMaterial, QuadMesh, RenderTarget },
    )({}, null, null, { type: 1016 });
    expect(unlabelled.has("stage")).toBe(false);
    expect(() =>
      defineRtt(make, { NodeMaterial, QuadMesh, RenderTarget })({}, null, null, {
        type: 1016,
        gpuStage: "Bloom",
      }),
    ).toThrow("TN_GPU_STAGE");
  });

  it("uses a real quad material and follows upstream manual RTT updates", () => {
    const state = new Map<string, number>([
      ["autoUpdate", 1],
      ["textureNeedsUpdate", 1],
      ["width", 16],
      ["height", 8],
      ["resolutionScale", 1],
    ]);
    const bind = vi.fn();
    const node = defineRtt(
      () => ({
        __rtt: bind,
        __effect(name: string, value?: number) {
          if (value !== undefined) state.set(name, value);
          return state.get(name) ?? 0;
        },
      }),
      { NodeMaterial, QuadMesh, RenderTarget },
    )(vec4(1), 16, 8) as unknown as {
      autoUpdate: boolean;
      textureNeedsUpdate: boolean;
      needsUpdate: boolean;
      version: number;
      setup(builder: unknown): unknown;
      updateBefore(frame: unknown): void;
      _quadMesh: QuadMesh;
      renderTarget: RenderTarget;
    };
    const source = vec4(1);
    const reference = upstreamRtt(source, 16, 8);
    const target = {};
    const renderer = { getRenderTarget: () => target, setRenderTarget: vi.fn(), render: vi.fn() };
    const builder = { getSharedContext: () => ({}) };
    node.setup(builder);
    const material = node._quadMesh.material as NodeMaterial;
    expect(material.isNodeMaterial).toBe(true);
    expect(material.name).toBe("RTT");
    expect(material.version).toBeGreaterThan(0);
    expect(bind).toHaveBeenCalledWith(node.renderTarget, node._quadMesh);
    node.autoUpdate = false;
    reference.autoUpdate = false;
    node.updateBefore({ renderer });
    reference.updateBefore({ renderer } as never);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(target);
    expect(node.textureNeedsUpdate).toBe(false);
    renderer.render.mockClear();
    node.needsUpdate = true;
    reference.needsUpdate = true;
    expect(node.version).toBe(reference.version);
    node.updateBefore({ renderer });
    reference.updateBefore({ renderer } as never);
    expect(renderer.render).not.toHaveBeenCalled();
    node.textureNeedsUpdate = true;
    node.updateBefore({ renderer });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    reference.renderTarget?.dispose();
  });

  it("schedules atomic stores and adds through the Wasm statement scopes", () => {
    const calls: string[] = [];
    let serial = 0;
    // storage is over an engine BufferAttribute, so the classes come from the registry over a bare engine.
    let handle = 0;
    const engine: IBrowserRuntime = {
      typeId: () => 1,
      construct: (name) => ({ key: `${name}:0:${++handle}:1`, type: 1 }),
      invoke: () => null,
      get: () => 2,
      set: vi.fn(),
      release: vi.fn(),
      setCallback: vi.fn(),
    };
    const registry = JSON.parse(
      readFileSync("packages/three-native/api/native-registry.json", "utf8"),
    ) as Parameters<typeof defineBrowserClasses>[0];
    const { classes } = defineBrowserClasses(registry, engine, loadCatalog(process.cwd()));
    const { exports: tsl } = defineTsl(
      {
        call: (name) => {
          calls.push(name);
          return ++serial;
        },
        release: vi.fn(),
        set: vi.fn(),
        setUniform: vi.fn(),
        setPost: vi.fn(),
        effectParameter: vi.fn(),
        compute: vi.fn(),
        readStorage: vi.fn(),
        deleteStorage: vi.fn(),
      },
      classes as never,
    );
    const buffer = (
      tsl.instancedArray as (
        count: number,
        type: string,
      ) => { toAtomic(): { element(index: number): object } }
    )(2, "uint").toAtomic();
    (tsl.Fn as (f: () => void) => () => unknown)(() => {
      const target = buffer.element(0);
      (tsl.atomicStore as (...args: unknown[]) => unknown)(target, 0);
      (tsl.atomicAdd as (...args: unknown[]) => unknown)(target, 1);
    })();
    expect(calls).toEqual([
      "scope:open",
      "storage:object",
      "atomicStore",
      "atomicAdd",
      "scope:close",
    ]);
  });

  it("builds an Fn with parameters per call and chains setLayout", () => {
    const calls: string[] = [];
    let serial = 0;
    const { exports: tsl } = defineTsl({
      call: (name) => {
        calls.push(name);
        return ++serial;
      },
      release: vi.fn(),
      set: vi.fn(),
      setUniform: vi.fn(),
      setPost: vi.fn(),
      effectParameter: vi.fn(),
      compute: vi.fn(),
      readStorage: vi.fn(),
      deleteStorage: vi.fn(),
    });
    const seen: unknown[] = [];
    const blend = (
      tsl.Fn as (f: (input: [unknown, unknown]) => unknown) => {
        (...args: unknown[]): unknown;
        setLayout(layout: object): unknown;
      }
    )(([colour, weight]: [unknown, unknown]) => {
      seen.push(colour, weight);
    });
    expect(blend.setLayout({ name: "blend" })).toBe(blend);
    expect(calls).toEqual([]);
    const left = blend(1, 2);
    expect(left).not.toBe(blend(1, 2));
    expect(calls.filter((name) => name === "scope:open")).toHaveLength(2);
    expect((seen[0] as object | undefined) !== undefined).toBe(true);
    expect(typeof seen[0]).toBe("object");
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
  it("refreshes typed object-property references before each render", () => {
    const setUniform = vi.fn();
    let next = 0;
    const { exports: tsl, sync } = defineTsl({
      call: () => ++next,
      release: vi.fn(),
      set: vi.fn(),
      setPost: vi.fn(),
      setUniform,
      effectParameter: vi.fn(() => 0),
      compute: vi.fn(),
      readStorage: vi.fn(),
      deleteStorage: vi.fn(),
    });
    const reference = tsl.reference as (
      property: string,
      type: string,
      object?: unknown,
    ) => {
      object: unknown;
      value: unknown;
    };
    const shadow = { bias: 0.01 };
    const node = reference("bias", "float", shadow);
    shadow.bias = 0.02;
    sync();
    expect(setUniform).toHaveBeenLastCalledWith(1, [0.02]);
    node.object = { bias: 0.03 };
    sync();
    expect(node.value).toBe(0.03);
    const vector = { nested: { color: new Vector3(1, 2, 3) } };
    reference("nested.color", "vec3", vector);
    vector.nested.color.x = 4;
    sync();
    expect(setUniform).toHaveBeenLastCalledWith(2, [4, 2, 3]);
    expect(() => reference("bias", "mat4", shadow)).toThrow("TN_TSL_REFERENCE_TYPE");
    expect(() => reference("bias", "float")).toThrow("TN_TSL_REFERENCE_OBJECT");
    expect(() => reference("bias", "vec3", shadow)).toThrow("TN_TSL_REFERENCE_VALUE");
    node.object = { bias: Number.NaN };
    expect(sync).toThrow("TN_TSL_REFERENCE_VALUE");
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
      compute: vi.fn(),
      readStorage: vi.fn(),
      deleteStorage: vi.fn(),
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
