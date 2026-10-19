import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, Vector2 } from "three";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { Fn, float, int, pass, uniform, uv, vec4, velocity } from "three/tsl";
import type { Node, NodeBuilder } from "three/webgpu";
import { MeshBasicNodeMaterial, WGSLNodeBuilder, WebGPURenderer } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { createTemporalAA } from "../templates/starter/src/render/temporalAA.js";
import { createTemporalRejectionCounter } from "../templates/starter/src/render/temporalRejectionCounter.js";
import {
  CATMULL_ROM_BASIS,
  createExperimentalTemporalResolve,
} from "../templates/starter/src/render/temporalResolve.js";
import {
  type TemporalResolveNode,
  createTemporalDepthRejection,
} from "../templates/starter/src/render/temporalResolveDepth.js";
import {
  createTemporalResolveMath,
  reconstructNeighbourhood,
} from "../templates/starter/src/render/temporalResolveMath.js";

/** Real WGSL generation without a GPU device; only device-capability probes are stubbed. */
function offlineRenderer() {
  const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
  Reflect.set(renderer.backend, "renderer", renderer);
  vi.spyOn(Reflect.get(renderer.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
    65_536,
  );
  vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
  return renderer;
}

/** Compile a graph through the real WGSL node builder and hand back its fragment source. */
function fragment(renderer: WebGPURenderer, mesh: Mesh, graph: unknown): string {
  const builder = new WGSLNodeBuilder(mesh, renderer) as WGSLNodeBuilder & {
    setShaderStage(stage: string): void;
    flowStagesNode(node: unknown, output: string): { code: string };
  };
  builder.setShaderStage("fragment");
  return builder.flowStagesNode(graph, "vec4").code;
}

// Evaluate the authored polynomial independently in the monomial basis. A smoothing B-spline
// would fail the endpoint/interpolation checks even though its weights also sum to one.
const weights = (phase: number) =>
  CATMULL_ROM_BASIS.map((row) =>
    row.reduce<number>((sum, value, power) => sum + value * phase ** power, 0),
  );

describe("authored temporal reconstruction kernel", () => {
  it.each([
    { reversedDepthBuffer: false, logarithmicDepthBuffer: false },
    { reversedDepthBuffer: true, logarithmicDepthBuffer: false },
    { reversedDepthBuffer: false, logarithmicDepthBuffer: true },
    { reversedDepthBuffer: true, logarithmicDepthBuffer: true },
  ])("bounds every integer depth donor before reading or returning it: %j", (depthMode) => {
    const renderer = offlineRenderer();
    const camera = new PerspectiveCamera();
    const scenePass = pass(new Scene(), camera);
    scenePass.setSize(426, 240);
    const source = traa(
      scenePass.getTextureNode(),
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    const mesh = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial());
    try {
      const rejection = createTemporalDepthRejection(source as TemporalResolveNode, depthMode);
      const graph = Fn(() => {
        const sample = rejection.currentDepth(
          uv().mul(source.depthNode.size(int(0)) as Node<"uvec2">),
        );
        return vec4(
          sample.get("closestPositionTexel") as Node<"vec2">,
          sample.get("closestDepth") as Node<"float">,
          float(1),
        );
      })();
      const shader = fragment(renderer, mesh, graph);
      // At a screen edge an unbounded textureLoad may return zero or another in-bounds texel.
      // The depth winner must retain the same legal integer texel for the velocity lookup.
      const donors = [...shader.matchAll(/(\w+) = clamp\( vec2<f32>\( vec2<i32>\(/gu)];
      expect(donors).toHaveLength(9);
      expect(shader.match(/textureLoad\(/gu)).toHaveLength(9);
      expect(shader.match(/textureDimensions\([^\n]* - vec2<f32>\( 1\.0 \)/gu)).toHaveLength(9);
      for (const [, donor] of donors) {
        expect(shader).toContain(`vec2<i32>( ${donor} ), u32( 0u )`);
        expect(shader).toMatch(new RegExp(`\\w+ = ${donor};`));
      }
    } finally {
      source.dispose();
      scenePass.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  it("ordinary blending retains the existing current weight without luminance reweighting", () => {
    const renderer = offlineRenderer();
    const camera = new PerspectiveCamera();
    const scenePass = pass(new Scene(), camera);
    const source = traa(
      scenePass.getTextureNode(),
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    source.edgeDepthDiff = 1;
    const mesh = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial());
    const compile = (blend?: "luminance" | "ordinary") => {
      const graph = createExperimentalTemporalResolve(
        source,
        renderer,
        uniform(new Vector2()),
        "catmull-rom",
        blend,
      );
      const builder = new WGSLNodeBuilder(mesh, renderer) as WGSLNodeBuilder & {
        setShaderStage(stage: string): void;
        flowStagesNode(node: unknown, output: string): { code: string; result: string };
      };
      builder.setShaderStage("fragment");
      return builder.flowStagesNode(graph, "vec4");
    };
    try {
      const weighted = compile("luminance");
      const ordinary = compile("ordinary");
      expect(compile()).toEqual(weighted);
      expect(weighted.code).toContain("0.2126");
      expect(ordinary.code).not.toContain("0.2126");
      const weight = ordinary.code.match(/(?:^|\n)\t(\w+) = 0\.05;/)?.[1];
      expect(weight).toBeDefined();
      expect(ordinary.result).toMatch(new RegExp(`^mix\\( .*?, .*?, ${weight} \\)$`));
    } finally {
      source.dispose();
      scenePass.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  it("installs a default provider kernel that reads the reset flag", () => {
    // The provider, not the experimental arm, is what publishes a frame. A CPU flag assignment is
    // not the proof: this compiles the kernel the provider actually installed.
    const renderer = offlineRenderer();
    const camera = new PerspectiveCamera();
    const scenePass = pass(new Scene(), camera);
    scenePass.setSize(1280, 720);
    const temporal = createTemporalAA(
      scenePass.getTextureNode(),
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    temporal.node.setup({
      context: { velocity },
      renderer,
      getNodeProperties: () => ({}),
    } as unknown as NodeBuilder);
    const installed = (temporal.node as unknown as { _resolveMaterial: { colorNode: unknown } })
      ._resolveMaterial.colorNode;
    const bare = traa(
      scenePass.getTextureNode(),
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    const mesh = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial());
    try {
      const withFlag = fragment(renderer, mesh, installed);
      // A node with no reset flag installed keeps upstream's own history reuse unchanged.
      const withoutFlag = fragment(
        renderer,
        mesh,
        createExperimentalTemporalResolve(bare, renderer, uniform(new Vector2()), "linear"),
      );
      // The installed kernel compares a uniform against the threshold; a kernel with no flag
      // installed folds the same comparison to a constant.
      expect(withFlag).toMatch(/\bobject\.nodeUniform\d+ > 0\.5\b/u);
      expect(withoutFlag).toContain("( 1.0 > 0.5 )");
      expect(withFlag).not.toContain("( 1.0 > 0.5 )");
      // Production retains its named current weight: luminance reweighting biases alternating
      // linear coverage towards the darker sample even when history is correctly registered.
      expect(withFlag).not.toContain("0.2126");
      // The chosen velocity texel and the reused centre colour have independent depth support.
      // An AND guard must read both previous depths; replacing the centre check admits stale red.
      expect(withFlag.match(/textureLoad\([^\n]*clamp\( floor\(/gu)).toHaveLength(2);
      expect(withoutFlag.match(/textureLoad\([^\n]*clamp\( floor\(/gu)).toHaveLength(1);
    } finally {
      temporal.dispose();
      bare.dispose();
      scenePass.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  it("compiles both depth supports in the actual rejection-count compute dispatch", async () => {
    const renderer = offlineRenderer();
    const camera = new PerspectiveCamera();
    const scenePass = pass(new Scene(), camera);
    const temporal = createTemporalAA(
      scenePass.getTextureNode(),
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    const rejection = createTemporalDepthRejection(temporal.node as TemporalResolveNode, renderer);
    const counter = createTemporalRejectionCounter(rejection);
    const compute = vi.spyOn(renderer, "compute").mockImplementation(() => {});
    vi.spyOn(renderer, "getArrayBufferAsync").mockResolvedValue(new Uint32Array([0, 64]).buffer);
    try {
      counter.sample(renderer, 1, 8, 8);
      expect(compute).toHaveBeenCalledTimes(2);
      const dispatch = compute.mock.calls[1]?.[0];
      // Pinned declarations omit the real compute constructor/build surface.
      const builder = new WGSLNodeBuilder(dispatch as never, renderer) as unknown as {
        build(): void;
        computeShader: string;
      };
      builder.build();
      expect(builder.computeShader.match(/textureLoad\([^\n]*clamp\( floor\(/gu)).toHaveLength(2);
      expect(builder.computeShader).not.toContain("textureSample(");
      expect(builder.computeShader).toContain("atomicAdd");
      await counter.settled();
      expect(counter.report(1)?.visited).toBe(64);
    } finally {
      counter.dispose();
      temporal.dispose();
      scenePass.dispose();
      vi.restoreAllMocks();
    }
  });
  it("compiles the active Gaussian gather with nine bounded raw input loads", () => {
    const renderer = offlineRenderer();
    const camera = new PerspectiveCamera();
    const scenePass = pass(new Scene(), camera);
    const beauty = scenePass.getTextureNode();
    const mesh = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial());
    try {
      const jitter = uniform(new Vector2(0.25, -0.375));
      // Assignments to the gathered accumulators must be built inside the same TSL stack as
      // production's resolve Fn; building the returned struct alone omits those statements.
      const graph = Fn(() =>
        reconstructNeighbourhood(beauty, uv(), beauty.size(int(0)) as Node<"uvec2">, jitter).get(
          "color",
        ),
      )();
      const shader = fragment(renderer, mesh, graph);
      expect(shader.match(/textureLoad\(/gu)).toHaveLength(9);
      expect(shader).not.toContain("textureSample(");
      expect(shader).toContain("round(");
      expect(shader).toContain("exp(");
      expect(shader).toContain("clamp(");
      expect(shader).toContain("2.29");
    } finally {
      scenePass.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  it("counts nine point-sampled input texels in the clipping moments", () => {
    const renderer = offlineRenderer();
    const camera = new PerspectiveCamera();
    const scenePass = pass(new Scene(), camera);
    scenePass.setResolutionScale(2 / 3);
    const beauty = scenePass.getTextureNode();
    const source = traa(
      beauty,
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    const mesh = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial());
    try {
      const { varianceClipping } = createTemporalResolveMath(source as TemporalResolveNode);
      // A display pixel can lie between input texels. Every clipping moment still counts the
      // same nine input samples; a filtered centre changes their population with display phase.
      const graph = varianceClipping(
        uv().mul(beauty.size(int(0)) as Node<"uvec2">),
        vec4(0.75),
        float(1),
      );
      const shader = fragment(renderer, mesh, graph);
      expect(shader.match(/textureLoad\(/gu)).toHaveLength(9);
      expect(shader).not.toContain("textureSample(");
    } finally {
      source.dispose();
      scenePass.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  it("interpolates sample centres and preserves constants, ramps and quadratics", () => {
    expect(weights(0)).toEqual([0, 1, 0, 0]);
    expect(weights(1)).toEqual([0, 0, 1, 0]);
    for (const phase of [0.05, 0.2, 0.5, 0.75, 0.95]) {
      const w = weights(phase);
      expect(w.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
      expect(w.reduce((sum, value, i) => sum + value * (i - 1), 0)).toBeCloseTo(phase, 12);
      expect(w.reduce((sum, value, i) => sum + value * (i - 1) ** 2, 0)).toBeCloseTo(
        phase ** 2,
        12,
      );
    }
  });
  it("retains the known negative lobes that require downstream history clipping", () => {
    expect(weights(0.5)).toEqual([-1 / 16, 9 / 16, 9 / 16, -1 / 16]);
  });
});
