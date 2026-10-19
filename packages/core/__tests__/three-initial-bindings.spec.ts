import { DepthTexture, LinearFilter, Mesh, NearestFilter, Texture } from "three";
import Bindings from "three/src/renderers/common/Bindings.js";
// @ts-expect-error Exercise Three's real node-based texture reference binding.
import { NodeSampledTexture } from "three/src/renderers/common/nodes/NodeSampledTexture.js";
// @ts-expect-error Exercise Three's real node-based sampler reference binding.
import NodeSampler from "three/src/renderers/common/nodes/NodeSampler.js";
import { texture } from "three/tsl";
import { WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";

describe("initial GPU bindings after asynchronous node compilation", () => {
  it.each(["texture", "sampler"])(
    "uses the node's current %s reference before creating the first bind group",
    (kind) => {
      const previousDepth = new DepthTexture(1280, 720);
      const currentDepth = new DepthTexture(1, 1);
      const node = { value: previousDepth };
      const binding =
        kind === "texture"
          ? new NodeSampledTexture("depth", node, {})
          : new NodeSampler("depthSampler", node);
      const uploaded: DepthTexture[] = [];
      const bound: DepthTexture[] = [];
      const group = { bindings: [binding] };
      const manager = new Bindings(
        { createBindings: () => bound.push(binding.texture) },
        {},
        {
          updateTexture: (texture: DepthTexture) => uploaded.push(texture),
          updateSampler: (sampler: { texture: DepthTexture }) => uploaded.push(sampler.texture),
        },
        {},
        {},
        {},
      );

      // A viewport node can switch from the scene's MSAA depth copy to the output target
      // while compileAsync yields. Its binding still holds the previous reference.
      node.value = currentDepth;
      manager.getForRender({ getBindings: () => [group] });

      expect(uploaded).toEqual([currentDepth]);
      expect(bound).toEqual([currentDepth]);
      expect(binding.texture).toBe(currentDepth);
    },
  );
});

// The bind-group layout freezes sampler inclusion once, in WGSLNodeBuilder#getUniformFromNode.
// #getUniforms used to re-derive it from live texture filter state, so a texture that changes
// between binding creation and code generation emitted a WGSL declaration the layout did not
// match. Dawn then rejects the pipeline with "Binding type in the shader (sampler) doesn't match
// the type in the layout (texture)" and every later binding in the group is off by one.
const FRAGMENT = "fragment";

interface IBinding {
  isSampledTexture?: boolean;
  isSampler?: boolean;
}

interface ISamplerBindingBuilder {
  bindings: Record<string, Record<string, IBinding[]>>;
  getUniformFromNode(node: unknown, type: string, shaderStage: string): unknown;
  getUniforms(shaderStage: string): string;
}

// A NodeSampledTexture extends Sampler, so both the sampler and its texture carry `isSampler`.
// The layout serializes the sampler entry only when the binding is a sampler and not a texture.
function isSamplerBinding(binding: IBinding): boolean {
  return binding.isSampler === true && binding.isSampledTexture !== true;
}

function samplerBindingBuilder(): ISamplerBindingBuilder {
  const renderer = {
    backend: {
      capabilities: { getUniformBufferLimit: () => 65_536 },
      compatibilityMode: false,
      device: {},
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    hasCompatibility: () => true,
    hasFeature: () => false,
  } as never;
  return new WGSLNodeBuilder(
    new Mesh(undefined, undefined),
    renderer,
  ) as unknown as ISamplerBindingBuilder;
}

function declaredBindings(wgsl: string): { binding: number; kind: "sampler" | "texture" }[] {
  const pattern = /@binding\(\s*(\d+)\s*\)\s*@group\(\s*(\d+)\s*\)\s*var\s+\w+\s*:\s*([^;]+);/g;
  return [...wgsl.matchAll(pattern)].map((match) => ({
    binding: Number(match[1]),
    kind: match[3]?.includes("sampler") === true ? "sampler" : "texture",
  }));
}

function expectDeclarationsMatchLayout(
  builder: ISamplerBindingBuilder,
  node: { groupNode: { name: string } },
  wgsl: string,
): void {
  const layout = builder.bindings[FRAGMENT]?.[node.groupNode.name] ?? [];
  const declarations = declaredBindings(wgsl);
  expect(declarations.map((declaration) => declaration.kind)).toEqual(
    layout.map((binding) => (isSamplerBinding(binding) ? "sampler" : "texture")),
  );
  // The layout serializes bindGroup.bindings positionally, so @binding(n) must map to entry n.
  expect(declarations.map((declaration) => declaration.binding)).toEqual(
    layout.map((_binding, index) => index),
  );
}

describe("WGSL sampler declarations follow the frozen bind-group layout", () => {
  it("keeps the declaration when a texture turns unfilterable after binding creation", () => {
    const builder = samplerBindingBuilder();
    // Defaults are filterable, so binding creation freezes a sampler into the layout.
    const node = texture(new Texture());
    builder.getUniformFromNode(node, "texture", FRAGMENT);
    const sampled = node.value as Texture;
    sampled.minFilter = NearestFilter;
    sampled.magFilter = NearestFilter;

    const wgsl = builder.getUniforms(FRAGMENT);

    expect(wgsl).toContain("_sampler");
    expectDeclarationsMatchLayout(builder, node, wgsl);
  });

  it("omits the declaration when a texture turns filterable after binding creation", () => {
    const builder = samplerBindingBuilder();
    const node = texture(new Texture());
    const sampled = node.value as Texture;
    sampled.minFilter = NearestFilter;
    sampled.magFilter = NearestFilter;
    // Binding creation saw an unfilterable texture, so the layout has no sampler entry.
    builder.getUniformFromNode(node, "texture", FRAGMENT);
    sampled.minFilter = LinearFilter;
    sampled.magFilter = LinearFilter;

    const wgsl = builder.getUniforms(FRAGMENT);

    expect(wgsl).not.toContain("_sampler");
    expectDeclarationsMatchLayout(builder, node, wgsl);
  });
});
