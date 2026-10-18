import { DepthTexture, Mesh, PerspectiveCamera, PlaneGeometry, Scene } from "three";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { texture } from "three/tsl";
import { RenderTarget, WGSLNodeBuilder, WebGPURenderer } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";

interface ITextureLoadBuilder {
  generateTextureLoad(
    texture: unknown,
    property: string,
    uv: string,
    level: string | null,
    depth: string | null,
    offset: string | null,
  ): string;
}

function builderWithSamples(primarySamples: number): ITextureLoadBuilder {
  const renderer = {
    backend: {
      capabilities: { getUniformBufferLimit: () => 65_536 },
      compatibilityMode: false,
      device: {},
      utils: { getTextureSampleData: () => ({ primarySamples }) },
    },
    hasCompatibility: () => false,
    hasFeature: () => false,
  } as never;
  return new WGSLNodeBuilder(
    new Mesh(undefined, undefined),
    renderer,
  ) as unknown as ITextureLoadBuilder;
}

// naga v25 (wgpu-native v25.0.2.2) rejects a u32 sample index on a multisampled
// textureLoad while every backend accepts i32, so the multisampled operand must
// be i32 and the mip-level operand stays u32.
describe("WGSL multisampled textureLoad sample index", () => {
  it("emits an i32 sample index for a multisampled depth texture", () => {
    const builder = builderWithSamples(4);
    const snippet = builder.generateTextureLoad(
      new DepthTexture(4, 4),
      "nodeUniform4",
      "vec2( 0, 0 )",
      null,
      null,
      null,
    );

    expect(snippet).toBe("textureLoad( nodeUniform4, vec2( 0, 0 ), i32( 0u ) )");
  });

  it("keeps a u32 mip level for a single-sampled texture", () => {
    const builder = builderWithSamples(1);
    const snippet = builder.generateTextureLoad(
      new DepthTexture(4, 4),
      "nodeUniform4",
      "vec2( 0, 0 )",
      null,
      null,
      null,
    );

    expect(snippet).toBe("textureLoad( nodeUniform4, vec2( 0, 0 ), u32( 0u ) )");
  });

  it("keeps the mip-level operand u32 for array textures", () => {
    const builder = builderWithSamples(4);
    const snippet = builder.generateTextureLoad(
      new DepthTexture(4, 4),
      "nodeUniform4",
      "vec2( 0, 0 )",
      "0",
      "0",
      null,
    );

    expect(snippet).toContain("u32( 0 )");
    expect(snippet).not.toContain("i32(");
  });
});

describe("SMAA weights texture sampling", () => {
  it("samples the single-level edges at explicit mip zero inside all four bounded searches", () => {
    vi.stubGlobal(
      "Image",
      class {
        src = "";
      },
    );
    const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    Reflect.set(renderer.backend, "renderer", renderer);
    vi.spyOn(
      Reflect.get(renderer.backend, "capabilities"),
      "getUniformBufferLimit",
    ).mockReturnValue(65_536);
    vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
    const input = new RenderTarget(64, 64);
    const effect = smaa(texture(input.texture));
    const geometry = new PlaneGeometry();
    try {
      effect.setup({ getSharedContext: () => ({}) } as never);
      const mesh = new Mesh(geometry, Reflect.get(effect, "_materialWeights"));
      const builder = new WGSLNodeBuilder(mesh, renderer);
      Reflect.set(builder, "camera", new PerspectiveCamera());
      Reflect.set(builder, "scene", new Scene());
      builder.build();
      const shader = builder.fragmentShader;
      const searches = [
        ...shader.matchAll(/for \( var i : i32 = 0; i < 8; i \+\+ \) \{([\s\S]*?)break;/g),
      ];
      expect(searches).toHaveLength(4);
      expect(Reflect.get(effect, "_renderTargetEdges").texture.generateMipmaps).toBe(false);
      for (const [, body] of searches) {
        expect(body).toMatch(/textureSampleLevel\( [^\n]+, 0\.0 \)/);
        expect(body).not.toContain("textureSample(");
      }
    } finally {
      effect.dispose();
      geometry.dispose();
      input.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
