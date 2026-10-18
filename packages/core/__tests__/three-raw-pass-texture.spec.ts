import { FloatType, Mesh, PerspectiveCamera, Scene, type Texture } from "three";
import Bindings from "three/src/renderers/common/Bindings.js";
// @ts-expect-error Three does not declare its internal texture manager.
import Textures from "three/src/renderers/common/Textures.js";
// @ts-expect-error Three does not declare its internal node-sampled texture binding.
import { NodeSampledTexture } from "three/src/renderers/common/nodes/NodeSampledTexture.js";
// @ts-expect-error Three does not declare its internal bind-group builder.
import WebGPUBindingUtils from "three/src/renderers/webgpu/utils/WebGPUBindingUtils.js";
// @ts-expect-error Three does not declare its internal WebGPU utility module.
import WebGPUUtils from "three/src/renderers/webgpu/utils/WebGPUUtils.js";
import { int, ivec2, pass, vec4 } from "three/tsl";
import { WGSLNodeBuilder, WebGPURenderer } from "three/webgpu";
import type { Node, PassNode, TextureNode } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";

interface IRawNode extends TextureNode {
  readonly isRawTextureNode: boolean;
  getUniformHash(): string;
}
interface IRawPass extends PassNode {
  getRawTextureNode(name?: string): IRawNode;
}

function scenePass(samples = 4): IRawPass {
  const owner = pass(new Scene(), new PerspectiveCamera(), { samples }) as IRawPass;
  owner.setSize(426, 240);
  expect(typeof owner.getRawTextureNode).toBe("function");
  return owner;
}

function renderer() {
  const value = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
  Reflect.set(value.backend, "renderer", value);
  vi.spyOn(Reflect.get(value.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
    65_536,
  );
  vi.spyOn(value, "hasFeature").mockReturnValue(false);
  return value;
}

describe("stored raw pass attachments", () => {
  it("borrows the owner texture with a distinct raw uniform identity", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode();
    const resolved = owner.getTextureNode() as IRawNode;
    expect(raw.value).toBe(resolved.value);
    expect(raw.isRawTextureNode).toBe(true);
    expect(raw.getUniformHash()).not.toBe(resolved.getUniformHash());
    expect(raw.getSampler()).toBe(false);
    expect(owner.getRawTextureNode()).toBe(raw);
    expect(raw.value).toBe(owner.renderTarget.texture);
  });

  it("retains raw view identity and pass dependency through sample-load clones", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode();
    const loaded = raw.load(ivec2(2, 3)).level(int(3)) as IRawNode;
    expect(loaded.isRawTextureNode).toBe(true);
    expect(loaded.value).toBe(raw.value);
    expect(loaded.getUniformHash()).toBe(raw.getUniformHash());
    const builder = new WGSLNodeBuilder(new Mesh(), renderer()) as WGSLNodeBuilder & {
      getNodeProperties(node: unknown): Record<string, unknown>;
    };
    loaded.setup(builder);
    expect(builder.getNodeProperties(loaded).passNode).toBe(owner);
    expect(loaded.getSampler()).toBe(false);
  });

  it("declares both resolved and raw resources honestly without a raw sampler", () => {
    const owner = scenePass();
    const builder = new WGSLNodeBuilder(new Mesh(), renderer()) as WGSLNodeBuilder & {
      getUniformFromNode(node: unknown, type: string, stage: string): unknown;
      getUniforms(stage: string): string;
      bindings: Record<string, Record<string, unknown[]>>;
    };
    const resolved = owner.getTextureNode();
    const raw = owner.getRawTextureNode();
    builder.getUniformFromNode(resolved, "texture", "fragment");
    builder.getUniformFromNode(raw, "texture", "fragment");
    const wgsl = builder.getUniforms("fragment");
    expect(wgsl.match(/texture_2d<f32>/gu)).toHaveLength(1);
    expect(wgsl.match(/texture_multisampled_2d<f32>/gu)).toHaveLength(1);
    expect(wgsl.match(/: sampler;/gu)).toHaveLength(1);
    const bindings = builder.bindings.fragment?.[raw.groupNode.name] ?? [];
    expect(bindings).toHaveLength(3);
  });

  it("rejects single-sample and filtered raw requests", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode();
    const builder = new WGSLNodeBuilder(new Mesh(), renderer());
    expect(() => raw.clone().setSampler(true).setup(builder)).toThrow(/raw.*load/iu);
    owner.renderTarget.samples = 1;
    expect(() => owner.getRawTextureNode()).toThrow(/multisampl/iu);
    expect(() => raw.setup(builder)).toThrow(/multisampl/iu);
  });

  it("keeps disposal with the pass owner and refuses a disposed owner", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode();
    const release = vi.spyOn(owner.renderTarget, "dispose");
    raw.dispose();
    expect(release).not.toHaveBeenCalled();
    owner.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => raw.setup(new WGSLNodeBuilder(new Mesh(), renderer()))).toThrow(/disposed/iu);
  });

  it("compiles raw and resolved loads together with the raw sample and dimensions", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode();
    const resolved = owner.getTextureNode();
    const builder = new WGSLNodeBuilder(new Mesh(), renderer()) as WGSLNodeBuilder & {
      setShaderStage(stage: string): void;
      flowStagesNode(node: unknown, output: string): { code: string };
      getUniforms(stage: string): string;
    };
    builder.setShaderStage("fragment");
    const code = builder.flowStagesNode(
      raw
        .load(ivec2(2, 3))
        .level(int(3))
        .add(resolved.load(ivec2(2, 3)))
        .add(vec4((raw.size(int(0)) as Node<"uvec2">).x))
        .toVar(),
      "vec4",
    ).code;
    const declarations = builder.getUniforms("fragment");
    const rawName = /var (\w+) : texture_multisampled_2d<f32>/u.exec(declarations)?.[1];
    const resolvedName = /var (\w+) : texture_2d<f32>/u.exec(declarations)?.[1];
    expect(rawName).toBeDefined();
    expect(resolvedName).toBeDefined();
    expect(rawName).not.toBe(resolvedName);
    expect(code).toContain(`textureLoad( ${rawName},`);
    expect(code).toContain(`textureLoad( ${resolvedName},`);
    expect(code).toContain("i32( 3.0 )");
    expect(code).toContain(`textureDimensions( ${rawName} )`);
    expect(code).not.toContain(`textureDimensions( ${rawName},`);
  });

  it("binds the actual retained raw resource and refreshes its view after replacement", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode();
    const texture = raw.value as Texture;
    const data: Record<string, unknown> = {};
    const views: unknown[] = [];
    function resource(id: string) {
      return {
        width: 426,
        height: 240,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        createView: () => ({ id }),
      };
    }
    data.texture = resource("resolved");
    data.msaaTexture = resource("raw-a");
    const backend = {
      get: (value: unknown) => (value === texture ? data : {}),
      device: {
        createBindGroup: (descriptor: { entries: { resource: unknown }[] }) => {
          views.push(descriptor.entries[0]?.resource);
          return {};
        },
      },
    };
    const utils = new WebGPUBindingUtils(backend);
    const group = {
      name: "raw",
      bindings: [{ isSampledTexture: true, texture, textureNode: raw }],
    };
    utils.createBindGroup(group, {});
    data.msaaTexture = resource("raw-b");
    utils.createBindGroup(group, {});
    expect(views).toEqual([{ id: "raw-a" }, { id: "raw-b" }]);
    expect(data.texture).not.toBe(data.msaaTexture);
    Reflect.deleteProperty(data, "msaaTexture");
    expect(() => utils.createBindGroup(group, {})).toThrow(/raw.*attachment/iu);
    data.msaaTexture = resource("revived");
    owner.dispose();
    expect(() => utils.createBindGroup(group, {})).toThrow(/disposed/iu);
  });

  it("rebuilds a settled sampled-pass binding after resize and destruction-only invalidation", () => {
    const owner = scenePass();
    owner.setSize(1600, 900);

    const backendEntries = new WeakMap<object, Record<string, unknown>>();
    const backendData = (key: object) => {
      let data = backendEntries.get(key);
      if (data === undefined) {
        data = {};
        backendEntries.set(key, data);
      }
      return data;
    };
    const backend = {
      get: backendData,
      has: (key: object) => backendEntries.has(key),
      delete: (key: object) => backendEntries.delete(key),
      createTexture: (texture: Texture, options: { width: number; height: number }) => {
        backendData(texture).texture = {
          width: options.width,
          height: options.height,
          destroyed: false,
        };
      },
      destroyTexture: (texture: Texture) => {
        const resource = backendData(texture).texture as { destroyed: boolean } | undefined;
        if (resource !== undefined) resource.destroyed = true;
      },
      createBindings: (group: { bindings: object[] }) => {
        backendData(group).bindGroup = group;
        backendData(group).groups = group.bindings.map(
          (binding) => backendData((binding as { texture: Texture }).texture).texture,
        );
        backendData(group).versions = [];
      },
      updateBindings: vi.fn((group: { bindings: object[] }) => {
        backendData(group).groups = group.bindings.map(
          (binding) => backendData((binding as { texture: Texture }).texture).texture,
        );
        backendData(group).versions = [];
      }),
      deleteBindGroupData: (group: object) => {
        backendData(group).groups = [];
        backendData(group).versions = [];
      },
    };
    const info = {
      memory: { renderTargets: 0 },
      createTexture: vi.fn(),
      destroyTexture: vi.fn(),
    };
    const textures = new Textures({}, backend, info);
    textures.updateRenderTarget(owner.renderTarget);

    const output = owner.getTextureNode();
    const binding = new NodeSampledTexture("output", output, {});
    const group = { name: "output", bindings: [binding] };
    const textureData = textures.get(owner.renderTarget.texture);
    textureData.bindGroups.add(group);
    const settled = { value: false };
    const nodes = {
      isSettled: () => settled.value,
      updateGroup: (_binding: object, isSettled: boolean) => !isSettled,
    };
    const bindings = new Bindings(backend, nodes, textures, {}, { bindings: undefined }, info);
    const renderObject = { getBindings: () => [group] };
    bindings.updateForRender(renderObject);
    settled.value = true;

    owner.setSize(1360, 765);
    textures.updateRenderTarget(owner.renderTarget);
    const resizedResource = backendData(owner.renderTarget.texture).texture;
    expect(resizedResource).toMatchObject({ width: 1360, height: 765, destroyed: false });

    bindings.updateForRender(renderObject);

    expect(backend.updateBindings).toHaveBeenCalled();
    expect(backendData(group).groups).toEqual([resizedResource]);

    const bindingData = backendData(group);
    Object.assign(bindingData, { groups: undefined, versions: undefined, forceUpdate: true });
    backend.updateBindings.mockClear();

    // A resource may be destroyed/recreated without changing the sampled Texture object's
    // version. `forceUpdate` must be sufficient to rebuild the cached GPU bind group in that case.
    bindings.updateForRender(renderObject);

    expect(backend.updateBindings).toHaveBeenCalledTimes(1);
    expect(bindingData.forceUpdate).toBe(false);
    expect(bindingData.groups).toEqual([resizedResource]);
  });

  it("rebuilds a sampled binding layout when a destroyed 4x target becomes single-sample", () => {
    const owner = scenePass();
    owner.setSize(1600, 900);

    const backendEntries = new WeakMap<object, Record<string, unknown>>();
    const backendData = (key: object) => {
      let data = backendEntries.get(key);
      if (data === undefined) {
        data = {};
        backendEntries.set(key, data);
      }
      return data;
    };
    const layouts: Record<string, unknown>[][] = [];
    const backend = {
      get: backendData,
      has: (key: object) => backendEntries.has(key),
      delete: (key: object) => backendEntries.delete(key),
      device: {
        createBindGroupLayout: vi.fn((descriptor: { entries: Record<string, unknown>[] }) => {
          layouts.push(descriptor.entries);
          return {};
        }),
        createBindGroup: vi.fn((descriptor: unknown) => descriptor),
      },
      utils: undefined as unknown,
      createTexture: (texture: Texture, options: { width: number; height: number }) => {
        const resource = {
          width: options.width,
          height: options.height,
          mipLevelCount: 1,
          destroyed: false,
          createView: vi.fn(() => ({ texture })),
        };
        const data = backendData(texture);
        data.texture = resource;
        if (texture.renderTarget?.samples === 4) data.msaaTexture = resource;
      },
      destroyTexture: vi.fn((texture: Texture) => {
        const resource = backendData(texture).texture as { destroyed: boolean } | undefined;
        if (resource !== undefined) resource.destroyed = true;
      }),
      createBindings: (group: object, bindings: object[], cacheIndex: number, version: number) =>
        layoutUtils.createBindings(group, bindings, cacheIndex, version),
      updateBindings: vi.fn(
        (group: object, bindings: object[], cacheIndex: number, version: number) =>
          layoutUtils.createBindings(group, bindings, cacheIndex, version),
      ),
      deleteBindGroupData: (group: object) => {
        backendData(group).groups = [];
        backendData(group).versions = [];
      },
    };
    backend.utils = new WebGPUUtils(backend);
    const info = {
      memory: { renderTargets: 0 },
      createTexture: vi.fn(),
      destroyTexture: vi.fn(),
    };
    const textures = new Textures({}, backend, info);
    textures.updateRenderTarget(owner.renderTarget);

    const texture = owner.renderTarget.texture;
    const binding = new NodeSampledTexture("output", owner.getRawTextureNode(), {});
    const group = { name: "output", bindings: [binding] };
    const layoutUtils = new WebGPUBindingUtils(backend);
    const settled = { value: false };
    const nodes = {
      isSettled: () => settled.value,
      updateGroup: (_binding: object, isSettled: boolean) => !isSettled,
    };
    const bindings = new Bindings(backend, nodes, textures, {}, { bindings: undefined }, info);
    bindings.updateForRender({ getBindings: () => [group] });
    settled.value = true;
    const textureData = textures.get(texture);
    const firstLayoutKey = backendData(group).layoutKey;
    expect(layouts).toHaveLength(1);
    expect(layouts[0]?.[0]?.texture).toMatchObject({ multisampled: true });

    // No manual `textureData.bindGroups.add(group)`: production tracks the first binding itself.
    Reflect.get(textures, "_destroyTexture").call(textures, texture);

    expect(backendData(group).forceUpdate).toBe(true);

    const alternateOwner = pass(new Scene(), new PerspectiveCamera(), { samples: 1 }) as IRawPass;
    alternateOwner.setSize(800, 600);
    textures.updateRenderTarget(alternateOwner.renderTarget);
    const alternateTexture = alternateOwner.renderTarget.texture;
    const alternateTextureData = textures.get(alternateTexture);
    group.bindings[0] = new NodeSampledTexture("output", alternateOwner.getTextureNode(), {});
    bindings.updateForRender({ getBindings: () => [group] });
    expect(layouts).toHaveLength(2);
    expect(layouts[1]?.[0]?.texture).not.toHaveProperty("multisampled");
    expect(backendData(group).layoutKey).not.toBe(firstLayoutKey);
    expect(backend.updateBindings).toHaveBeenCalledTimes(1);
    expect(group.bindings[0]?.texture).toBe(alternateTexture);
    expect(backendData(group).forceUpdate).toBe(false);
    expect(textureData.bindGroups.has(group)).toBe(true);
    expect(alternateTextureData.bindGroups.has(group)).toBe(true);
    expect(backendData(group).trackedTextures).toEqual(
      new Set([textureData, alternateTextureData]),
    );

    // Two render objects acquired this group through updateForRender. Releasing one keeps both
    // historical texture registrations until the final owner releases the group.
    Reflect.get(bindings, "_destroyBindings").call(bindings, [group]);
    expect(textureData.bindGroups.has(group)).toBe(true);
    expect(alternateTextureData.bindGroups.has(group)).toBe(true);

    backendData(group).forceUpdate = false;
    Reflect.get(bindings, "_destroyBindings").call(bindings, [group]);
    expect(textureData.bindGroups.has(group)).toBe(false);
    expect(alternateTextureData.bindGroups.has(group)).toBe(false);

    Reflect.get(textures, "_destroyTexture").call(textures, texture);
    Reflect.get(textures, "_destroyTexture").call(textures, alternateTexture);
    expect(backendData(group).forceUpdate).toBe(false);
  });

  it("keeps raw and resolved layout entries separate on the same owner texture", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode();
    const texture = raw.value;
    const utils = new WebGPUBindingUtils({
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
      hasFeature: () => true,
    });
    const entries = utils._createLayoutEntries({
      bindings: [
        { isSampledTexture: true, texture, textureNode: owner.getTextureNode(), visibility: 2 },
        { isSampledTexture: true, texture, textureNode: raw, visibility: 2 },
      ],
    });
    expect(entries[0].texture.multisampled).toBeUndefined();
    expect(entries[1].texture.multisampled).toBe(true);
    expect(entries[1].texture.sampleType).toBe("unfilterable-float");
    texture.type = FloatType;
    const floating = utils._createLayoutEntries({
      bindings: [
        { isSampledTexture: true, texture, textureNode: owner.getTextureNode(), visibility: 2 },
        { isSampledTexture: true, texture, textureNode: raw, visibility: 2 },
      ],
    });
    expect(floating[0].texture.sampleType).toBe("float");
    expect(floating[1].texture.sampleType).toBe("unfilterable-float");
  });

  it("declares and binds the stored depth attachment with a depth-only view", () => {
    const owner = scenePass();
    const raw = owner.getRawTextureNode("depth");
    const builder = new WGSLNodeBuilder(new Mesh(), renderer());
    Reflect.get(builder, "getUniformFromNode").call(builder, raw, "texture", "fragment");
    expect(Reflect.get(builder, "getUniforms").call(builder, "fragment")).toContain(
      "texture_depth_multisampled_2d",
    );
    const createView = vi.fn(() => ({ depth: true }));
    const data: { texture: { createView: (...args: unknown[]) => unknown } } = {
      texture: { createView },
    };
    const backend = {
      get: (value: unknown) => (value === raw.value ? data : {}),
      utils: { getTextureSampleData: () => ({ primarySamples: 4 }) },
      device: { createBindGroup: vi.fn(() => ({})) },
    };
    const utils = new WebGPUBindingUtils(backend);
    const binding = { isSampledTexture: true, texture: raw.value, textureNode: raw, visibility: 2 };
    const group = { name: "depth", bindings: [binding] };
    const layout = utils._createLayoutEntries(group);
    expect(layout[0].texture).toMatchObject({ multisampled: true, sampleType: "depth" });
    utils.createBindGroup(group, {});
    expect(createView).toHaveBeenCalledWith({
      dimension: "2d",
      aspect: "depth-only",
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    const replacement = vi.fn(() => ({ depth: "replacement" }));
    data.texture = { createView: replacement };
    utils.createBindGroup(group, {});
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
