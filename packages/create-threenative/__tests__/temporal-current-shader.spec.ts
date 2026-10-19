import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, Vector2 } from "three";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { Fn, int, pass, texture, uniform, uv } from "three/tsl";
import {
  FloatType,
  MeshBasicNodeMaterial,
  type Node,
  RenderTarget,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { createTemporalAAResolve } from "../templates/starter/src/render/temporalAAResolve.js";
import { createTemporalCurrentFootprint } from "../templates/starter/src/render/temporalCurrentFootprint.js";
import { createTemporalRejectionCounter } from "../templates/starter/src/render/temporalRejectionCounter.js";
import type { TemporalResolveNode } from "../templates/starter/src/render/temporalResolveDepth.js";

describe("actual finite current WGSL", () => {
  it("builds the full combined contributor/legacy history equation in the actual resolve and counter", async () => {
    const r = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    Reflect.set(r.backend, "renderer", r);
    vi.spyOn(Reflect.get(r.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
      65536,
    );
    vi.spyOn(r, "hasFeature").mockReturnValue(false);
    const camera = new PerspectiveCamera();
    const raw = pass(new Scene(), camera, { samples: 4 }) as ReturnType<typeof pass> & {
      getRawTextureNode(name?: string): ReturnType<typeof texture>;
    };
    const centre = pass(raw.scene, camera);
    raw.setSize(426, 240);
    centre.setSize(426, 240);
    const packet = new RenderTarget(426, 240, { type: FloatType, depthBuffer: false });
    const node = traa(
      raw.getTextureNode(),
      centre.getTextureNode("depth"),
      centre.getTextureNode(),
      camera,
    ) as TemporalResolveNode;
    node._historyRenderTarget.setSize(640, 360);
    node._currentJitterUV = uniform(new Vector2());
    node._previousJitterUV = uniform(new Vector2());
    node._historyValidUniform = uniform(1);
    const producer = {
      active: () => true,
      inputs: {
        colour: raw.getRawTextureNode(),
        depth: raw.getRawTextureNode("depth"),
        motion: raw.getRawTextureNode("velocity"),
        previousDepth: texture(packet.texture),
      },
    };
    const resolve = createTemporalAAResolve(node, uniform(new Vector2()), producer as never);
    resolve.configure(r);
    const material = Reflect.get(node, "_resolveMaterial");
    const mesh = new Mesh(new PlaneGeometry(), material);
    const build = (object: unknown) => {
      const b = new WGSLNodeBuilder(object as Mesh, r) as WGSLNodeBuilder & {
        build(): void;
        fragmentShader: string;
        computeShader: string;
      };
      Reflect.set(b, "camera", camera);
      Reflect.set(b, "scene", raw.scene);
      b.build();
      return b;
    };
    const fragment = build(mesh).fragmentShader;
    expect(fragment).toContain("currentSampleArea");
    expect(fragment).toContain("texture_depth_multisampled_2d");
    expect(fragment).toContain("ceil(");
    expect(fragment).toContain("clamp(");
    const dispatched: unknown[] = [];
    vi.spyOn(r, "compute").mockImplementation((n) => {
      dispatched.push(n);
    });
    vi.spyOn(r, "getArrayBufferAsync").mockResolvedValue(new Uint32Array([0, 640 * 360]).buffer);
    const counter = createTemporalRejectionCounter(defined(resolve.equations()));
    counter.sample(r, 1, 640, 360);
    await counter.settled();
    expect(dispatched).toHaveLength(2);
    const compute = build(dispatched[1]).computeShader;
    expect(compute).toContain("currentSampleArea");
    expect(compute).toContain("texture_depth_multisampled_2d");
    expect(compute).toContain("texture_multisampled_2d<f32>");
    expect(compute).toContain("atomicAdd");
    expect(compute).toContain("ceil(");
    expect(compute).not.toMatch(/textureSample\(/);
    counter.dispose();
    node.dispose();
    raw.dispose();
    centre.dispose();
    packet.dispose();
    mesh.geometry.dispose();
  });
  it("compiles signed raw sample loads, finite polygon areas and weighted HDR moments", () => {
    const r = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    Reflect.set(r.backend, "renderer", r);
    vi.spyOn(Reflect.get(r.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
      65536,
    );
    vi.spyOn(r, "hasFeature").mockReturnValue(false);
    const camera = new PerspectiveCamera();
    const beauty = pass(new Scene(), camera, { samples: 4 }) as ReturnType<typeof pass> & {
      getRawTextureNode(name?: string): ReturnType<typeof texture>;
    };
    beauty.setSize(426, 240);
    const packet = new RenderTarget(426, 240, { type: FloatType, depthBuffer: false });
    const node = traa(
      beauty.getTextureNode(),
      beauty.getTextureNode("depth"),
      beauty.getTextureNode("velocity"),
      camera,
    ) as TemporalResolveNode;
    const current = createTemporalCurrentFootprint(
      {
        colour: beauty.getRawTextureNode(),
        depth: beauty.getRawTextureNode("depth"),
        motion: beauty.getRawTextureNode("velocity"),
        previousDepth: texture(packet.texture),
      },
      node,
      uniform(new Vector2(0.25, -0.375)),
    );
    const mesh = new Mesh(new PlaneGeometry(), new MeshBasicNodeMaterial());
    const builder = new WGSLNodeBuilder(mesh, r) as WGSLNodeBuilder & {
      setShaderStage(stage: string): void;
      flowStagesNode(node: unknown, type: string): { code: string };
      getCodes(stage: string): string;
      getUniforms(stage: string): string;
    };
    builder.setShaderStage("fragment");
    const code = builder.flowStagesNode(
      Fn(() =>
        current
          .reconstruct(uv(), uniform(new Vector2(640, 360)) as unknown as Node<"uvec2">)
          .get("color"),
      )(),
      "vec4",
    ).code;
    expect(builder.getCodes("fragment")).toContain("fn currentSampleArea");
    expect(builder.getCodes("fragment")).toContain("var polygon: array<vec2<f32>,12>");
    expect(code.match(/textureLoad\(/g)?.length).toBe(45);
    expect(code).toContain("i32( 3.0 )");
    expect(builder.getUniforms("fragment")).toContain("texture_multisampled_2d<f32>");
    expect(code).toContain("sqrt");
    expect(code).not.toContain("luminance");
    node.dispose();
    beauty.dispose();
    packet.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
});

function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture value.");
  return value;
}
