import { DepthTexture, Matrix4, PerspectiveCamera, Scene } from "three";
import { context, pass } from "three/tsl";
import { WGSLNodeBuilder } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepthPyramid, buildDepthPyramid } from "../src/render/depth-pyramid.js";
import { type IRendererLike, createRenderer } from "../src/renderer.js";
import { WorldGpuScene } from "../src/world-gpu-scene.js";

afterEach(() => vi.unstubAllGlobals());

function compile(node: unknown, samples: number) {
  const gpu = {
    contextNode: context(),
    backend: {
      capabilities: { getUniformBufferLimit: () => 65_536 },
      compatibilityMode: false,
      device: {},
      utils: { getTextureSampleData: () => ({ primarySamples: samples }) },
    },
    hasCompatibility: () => true,
    hasFeature: () => false,
  };
  // Three's declarations omit the compute-node path and its generated shader fields.
  const builder = new WGSLNodeBuilder(node as never, gpu as never) as unknown as {
    build(): void;
    computeShader: string;
    uniforms: { compute: { node: { value: unknown } }[] };
  };
  builder.build();
  return builder;
}

describe("readable scene depth", () => {
  it.each(["logarithmicDepthBuffer", "reversedDepthBuffer", "camera.reversedDepth"])(
    "keeps frustum-only culling when the renderer uses %s",
    (setting) => {
      const world = new WorldGpuScene();
      world.key("pine:0:0", Float32Array.from(new Matrix4().elements), 16, {
        group: "pine:0",
        part: 0,
        parts: 1,
      });
      const scenePassDepth = vi.fn(() => ({
        texture: new DepthTexture(8, 8),
        width: 8,
        height: 8,
      }));
      const dispatches: unknown[] = [];
      const renderer = {
        kind: "webgpu",
        raw: { [setting]: true, backend: { hasFeature: () => true } },
        compute: (node: unknown) => {
          dispatches.push(...(Array.isArray(node) ? node : [node]));
        },
        scenePassDepth,
      } as unknown as IRendererLike;
      world.enable(renderer, true, false, false, "measure");
      const camera = new PerspectiveCamera();
      if (setting === "camera.reversedDepth")
        Object.defineProperty(camera, "reversedDepth", { value: true });
      world.dispatch(renderer, camera);
      expect(scenePassDepth).not.toHaveBeenCalled();
      expect(world.report().occlusion?.reason).toBe("refused: nonstandard depth");
      expect(dispatches).toHaveLength(2);
      for (const node of dispatches) expect(compile(node, 1).computeShader).not.toContain("log2");
      world.dispose();
    },
  );

  it("keeps the farthest edge texel through odd-sized reductions", () => {
    const distance = new Float32Array(7 * 5).fill(10);
    distance[distance.length - 1] = 500;
    expect(buildDepthPyramid(distance, 7, 5).levels.at(-1)?.distance[0]).toBe(500);
    const pyramid = new DepthPyramid();
    pyramid.resize(7, 5);
    expect(pyramid.levels).toBe(3);
    pyramid.dispose();
  });

  it("uses the implicit framebuffer attachment without changing targets or texture bookkeeping", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    const canvas = new EventTarget() as HTMLCanvasElement;
    const depth = new DepthTexture(64, 32);
    const target = { depthTexture: null, width: 64, height: 32, samples: 4 };
    const data = {
      depthTexture: depth as DepthTexture | undefined,
      initialized: true,
      version: depth.version,
      bindGroups: new Set(),
    };
    const surface = new DepthTexture(64, 32);
    const getCanvasTarget = vi.fn(() => ({ depthTexture: surface }));
    const setRenderTarget = vi.fn();
    const render = vi.fn();
    const raw = {
      domElement: canvas,
      init: async () => undefined,
      needsFrameBufferTarget: true,
      _getFrameBufferTarget: () => target,
      _textures: { get: (object: unknown) => (object === target ? data : {}) },
      getCanvasTarget,
      getRenderTarget: () => null,
      setRenderTarget,
      render,
      setSize: () => undefined,
    };
    const renderer = await createRenderer({ canvas, webgpuFactory: () => raw });
    const before = { ...data };
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    try {
      expect(renderer.scenePassDepth?.()).toEqual({
        texture: depth,
        width: 64,
        height: 32,
        samples: 4,
      });
      expect(data).toEqual(before);
      expect(depth.isRenderTargetTexture).toBe(false);
      expect(target.depthTexture).toBeNull();
      renderer.render(scene, camera);
      expect(setRenderTarget).not.toHaveBeenCalled();
      expect(render).toHaveBeenCalledExactlyOnceWith(scene, camera);
      expect(getCanvasTarget).not.toHaveBeenCalled();
      // No rendered attachment must refuse, rather than sample untouched presentation depth.
      data.depthTexture = undefined;
      expect(renderer.scenePassDepth?.()).toBeUndefined();
      // An authored scene pass takes precedence over the implicit framebuffer.
      const worldPass = pass(scene, camera);
      worldPass.renderTarget.setSize(64, 32);
      const passDepth = worldPass.renderTarget.depthTexture as DepthTexture;
      // Three sizes the explicit depth when updateRenderTarget runs during the draw.
      passDepth.image.width = 64;
      passDepth.image.height = 32;
      renderer.setOutputNode(worldPass.getTextureNode(), worldPass);
      expect(renderer.scenePassDepth?.()?.texture).toBe(worldPass.renderTarget.depthTexture);
      worldPass.dispose();
    } finally {
      renderer.dispose();
    }
  });

  it.each([1, 4])(
    "resolves every one of %i depth samples into level 0 before reducing it",
    (samples) => {
      const pyramid = new DepthPyramid();
      const depth = new DepthTexture(8, 8);
      const kernels: unknown[] = [];
      pyramid.resize(8, 8);
      pyramid.build(
        { compute: (node) => kernels.push(...(node as unknown[])) },
        depth,
        0.1,
        1000,
        samples,
      );
      const first = compile(kernels[0], samples);
      expect(first.uniforms.compute.some((uniform) => uniform.node.value === depth)).toBe(true);
      expect(first.computeShader.match(/textureLoad\(/g)).toHaveLength(4 * samples);
      expect(first.computeShader).toContain(
        samples > 1 ? "texture_depth_multisampled_2d" : "texture_depth_2d",
      );
      for (let sample = 0; sample < samples; sample += 1) {
        expect(first.computeShader).toContain(`${samples > 1 ? "i32" : "u32"}( ${sample}.0 )`);
      }
      const next = compile(kernels[1], samples);
      expect(next.computeShader).not.toContain("textureLoad(");
      expect(next.uniforms.compute.some((uniform) => uniform.node.value === depth)).toBe(false);
      // A same-size replacement must bind the new depth, not a cached texture from a retired pass.
      const replacement = new DepthTexture(8, 8);
      kernels.length = 0;
      pyramid.build(
        { compute: (node) => kernels.push(...(node as unknown[])) },
        replacement,
        0.1,
        1000,
        samples,
      );
      expect(
        compile(kernels[0], samples).uniforms.compute.some(
          (uniform) => uniform.node.value === replacement,
        ),
      ).toBe(true);
      pyramid.dispose();
    },
  );

  it("binds the resolved pyramid in the same cull after a resize and preserves the main draw buffers", () => {
    const world = new WorldGpuScene();
    world.key("pine:0:0", new Float32Array(new Matrix4().elements), 16, {
      group: "pine:0",
      part: 0,
      parts: 1,
    });
    let depth = new DepthTexture(8, 8);
    const compiled = new Map<unknown, ReturnType<typeof compile>>();
    const dispatches: { name: string; builder: ReturnType<typeof compile> }[] = [];
    const renderer = {
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
      readback: async () => new ArrayBuffer(24),
      compute: (group: unknown) => {
        for (const node of Array.isArray(group) ? group : [group]) {
          let builder = compiled.get(node);
          if (builder === undefined) {
            builder = compile(node, 4);
            compiled.set(node, builder);
          }
          dispatches.push({ name: (node as { name: string }).name, builder });
        }
      },
      scenePassDepth: () => ({
        texture: depth,
        width: depth.image.width,
        height: depth.image.height,
        samples: 4,
      }),
    } as unknown as IRendererLike;
    world.enable(renderer, true, false, false, "measure");
    const camera = new PerspectiveCamera();
    const drawn = world.drawn;
    const args = world.args;
    const regions = [...world.regions];
    try {
      for (const size of [8, 16]) {
        depth = new DepthTexture(size, size);
        dispatches.length = 0;
        world.dispatch(renderer, camera);
        const first = dispatches.find((dispatch) => dispatch.name === "tnDepthPyramid0");
        const cull = dispatches.find((dispatch) => dispatch.name === "worldGpuSceneCull");
        const chain = first?.builder.uniforms.compute.find(
          (uniform) =>
            (uniform.node.value as { isStorageBufferAttribute?: boolean })
              .isStorageBufferAttribute === true,
        )?.node.value;
        expect(chain).toBeDefined();
        expect(cull?.builder.uniforms.compute.some((uniform) => uniform.node.value === chain)).toBe(
          true,
        );
        expect(world.drawn).toBe(drawn);
        expect(world.args).toBe(args);
        expect(world.regions).toEqual(regions);
      }
    } finally {
      world.dispose();
    }
  });
});

describe("pyramid GPU timestamps", () => {
  it("timestamps the whole resolve/reduction group, resolves with cadence off, and consumes each sample once", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    const canvas = new EventTarget() as HTMLCanvasElement;
    const pool = { queryOffsets: new Map<string, number>(), timestamps: new Map<string, number>() };
    const backend = { trackTimestamp: true, timestampQueryPool: { compute: pool } };
    const info = { frame: 0, compute: { timestamp: 0 } };
    const groups: unknown[] = [];
    const resolves: { type: string; enabled: boolean }[] = [];
    const raw = {
      domElement: canvas,
      backend,
      info,
      init: async () => undefined,
      compute: (group: unknown) => {
        groups.push(group);
        if (backend.trackTimestamp)
          pool.queryOffsets.set(
            `compute:${groups.length}:f${info.frame}`,
            pool.queryOffsets.size * 2,
          );
      },
      resolveTimestampsAsync: async (type = "render") => {
        resolves.push({ type, enabled: backend.trackTimestamp });
        if (!backend.trackTimestamp || type !== "compute") return undefined;
        const uids = [...pool.queryOffsets.keys()];
        pool.queryOffsets.clear();
        await Promise.resolve();
        for (const uid of uids) pool.timestamps.set(uid, 0.25);
        info.compute.timestamp = 0.25;
        return 0.25;
      },
      render: () => undefined,
      setSize: () => undefined,
    };
    const renderer = await createRenderer({
      canvas,
      gpuTimestampFrameInterval: 2,
      webgpuFactory: () => raw,
    });
    const pyramid = new DepthPyramid();
    pyramid.resize(8, 8);
    const depth = new DepthTexture(8, 8);
    try {
      renderer.beginFrame?.();
      pyramid.build(renderer, depth, 0.1, 1000, 4);
      const group = groups[0] as { name: string }[];
      expect(group.map((node) => node.name)).toEqual([
        "tnDepthPyramid0",
        "tnDepthPyramid1",
        "tnDepthPyramid2",
      ]);
      expect(renderer.gpuPyramidMs?.()).toBeUndefined();
      renderer.beginFrame?.(); // Cadence off when the frame asks to resolve.
      renderer.compute({});
      expect(backend.trackTimestamp).toBe(false);
      renderer.resolveGpuFrame();
      expect(backend.trackTimestamp).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      // Three refuses to resolve with the cadence off; the queries stay queued for the next sampled
      // frame (develop's GpuFrameObservation contract), so nothing is read yet.
      expect(resolves.every((resolve) => !resolve.enabled)).toBe(true);
      expect(renderer.gpuPyramidMs?.()).toBeUndefined();
      renderer.beginFrame?.(); // Sampled again: the queued pyramid queries resolve.
      renderer.resolveGpuFrame();
      await Promise.resolve();
      await Promise.resolve();
      expect(resolves.some((resolve) => resolve.type === "compute" && resolve.enabled)).toBe(true);
      expect(renderer.gpuPyramidMs?.()).toBe(0.25);
      expect(renderer.gpuPyramidMs?.()).toBeUndefined();
      expect(renderer.gpuComputeMs?.()).toBe(0.25);
      renderer.beginFrame?.(); // Cadence off again.
      // Extra dispatches do not change the frame's sample decision.
      pyramid.build(renderer, depth, 0.1, 1000, 4);
      expect(pool.queryOffsets.size).toBe(0);
      renderer.compute({});
      renderer.beginFrame?.();
      pyramid.build(renderer, depth, 0.1, 1000, 4);
      renderer.resolveGpuFrame();
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.gpuPyramidMs?.()).toBe(0.25);
      expect(renderer.gpuPyramidMs?.()).toBeUndefined();
    } finally {
      pyramid.dispose();
      renderer.dispose();
    }
  });
});
