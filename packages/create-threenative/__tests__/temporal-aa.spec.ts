import { type Color, PerspectiveCamera, Scene, Vector2 } from "three";
import { context, mrt, output, pass, rtt, velocity } from "three/tsl";
import type {
  Node,
  NodeBuilder,
  NodeFrame,
  RenderTarget,
  Texture,
  TextureNode,
} from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderChain } from "../../core/src/render/chain.js";
import { createTemporalAA } from "../templates/starter/src/render/temporalAA.js";
import { createTemporalAAFrame } from "../templates/starter/src/render/temporalAAFrame.js";
import {
  type TemporalAAProvider,
  temporalAAStages,
} from "../templates/starter/src/render/temporalAAStage.js";
import { createTemporalDepthRejection } from "../templates/starter/src/render/temporalResolveDepth.js";

afterEach(() => vi.restoreAllMocks());

describe("current producer input ownership", () => {
  it("resets the next successful temporal frame after its wrapped input draw failed before temporal update", () => {
    let fail = false;
    const f = fixture({
      current: true,
      inputDraw: () => {
        if (fail) throw new Error("input replay failed");
      },
    });
    try {
      f.temporal.node.updateBefore(f.frame);
      f.temporal.node.updateBefore(f.frame);
      expect(f.temporal.report().historyValid).toBe(true);
      fail = true;
      expect(() => f.scenePass.updateBefore(f.frame)).toThrow("input replay failed");
      fail = false;
      f.scenePass.updateBefore(f.frame);
      f.temporal.node.updateBefore(f.frame);
      expect(f.temporal.report()).toMatchObject({
        historyValid: false,
        resetReason: "scene-reset",
      });
      f.temporal.node.updateBefore(f.frame);
      expect(f.temporal.report().historyValid).toBe(true);
    } finally {
      f.temporal.dispose();
      f.scenePass.dispose();
    }
  });
  it("uses the original lane for a composed colour, foreign depth/motion or camera", () => {
    const camera = new PerspectiveCamera();
    const source = pass(new Scene(), camera);
    const other = pass(new Scene(), camera);
    source.setMRT(mrt({ output, velocity }));
    const original = source.updateBefore;
    for (const inputs of [
      [
        source.getTextureNode().mul(0.9),
        source.getTextureNode("depth"),
        source.getTextureNode("velocity"),
        camera,
      ],
      [
        source.getTextureNode(),
        other.getTextureNode("depth"),
        source.getTextureNode("velocity"),
        camera,
      ],
      [
        source.getTextureNode(),
        source.getTextureNode("depth"),
        other.getTextureNode("velocity"),
        camera,
      ],
      [
        source.getTextureNode(),
        source.getTextureNode("depth"),
        source.getTextureNode("velocity"),
        new PerspectiveCamera(),
      ],
    ] as const) {
      const provider = createTemporalAA(inputs[0], inputs[1], inputs[2], inputs[3], source);
      expect(source.updateBefore).toBe(original);
      provider.dispose();
    }
    const owned = createTemporalAA(
      source.getTextureNode(),
      source.getTextureNode("depth"),
      source.getTextureNode("velocity"),
      camera,
      source,
    );
    expect(source.updateBefore).not.toBe(original);
    owned.dispose();
    expect(source.updateBefore).toBe(original);
    source.dispose();
    other.dispose();
  });
});

const DISPLAY = { width: 1920, height: 1080 };
/** Two thirds, the deliberate fraction the scaled fixture uses; not a divisor of the display. */
const SCALED = 2 / 3;
const INPUT = {
  width: Math.floor(DISPLAY.width * SCALED),
  height: Math.floor(DISPLAY.height * SCALED),
};

type Copy = { from: Texture; to: Texture };
type PipelineCallbacks = {
  onBeforeRenderPipeline?: () => void;
  onAfterRenderPipeline?: () => void;
};

/** The renderer surface the overridden updateBefore drives, and the order it drives it in. */
function stubRenderer(display = DISPLAY) {
  const order: string[] = [];
  const copies: Copy[] = [];
  const computed: unknown[] = [];
  const words = new Uint32Array(2);
  const size = new Vector2(display.width, display.height);
  let target: RenderTarget | null = null;
  // What the device hands back for the two words: a healthy copy, a short one, or a failure.
  let readback: () => Promise<ArrayBuffer> = () => Promise.resolve(words.buffer);
  const renderer = {
    autoClear: true,
    logarithmicDepthBuffer: false,
    reversedDepthBuffer: false,
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: "",
    contextNode: context(),
    backend: { isWebGPUBackend: false },
    getOutputRenderTarget: () => null,
    getRenderTarget: () => target,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getRenderObjectFunction: () => null,
    getPixelRatio: () => 1,
    getMRT: () => null,
    getClearColor: (into: Color) => into,
    getClearAlpha: () => 1,
    getScissorTest: () => false,
    setMRT: () => {},
    setRenderObjectFunction: () => {},
    setClearColor: () => {},
    setPixelRatio: () => {},
    setScissorTest: () => {},
    setRenderTarget: (next: RenderTarget | null) => {
      target = next;
    },
    getDrawingBufferSize: (into: Vector2) => into.copy(size),
    initRenderTarget: () => {
      order.push("init");
    },
    render: () => {
      order.push("resolve");
    },
    copyTextureToTexture: (from: Texture, to: Texture) => {
      order.push("copy");
      copies.push({ from, to });
    },
    // The rejection counter dispatches a one-thread reset and one group per display pixel, then
    // copies the two words back. The words are what the test decides the GPU produced.
    compute: (node: unknown) => {
      order.push(typeof node === "object" && node !== null ? "compute" : "compute?");
      computed.push(node);
    },
    deleteAttribute: () => {},
    getArrayBufferAsync: () => readback(),
  };
  return {
    computed,
    copies,
    order,
    renderer,
    words,
    setDisplay(width: number, height: number) {
      size.set(width, height);
    },
    setReadback(next: () => Promise<ArrayBuffer>) {
      readback = next;
    },
  };
}

function fixture(
  options: {
    display?: { width: number; height: number };
    resolutionScale?: number;
    colour?: (scenePass: ReturnType<typeof pass>) => Node;
    renderPipeline?: boolean;
    /** Who owns the pipeline callbacks before the provider's first setup runs. */
    pipelineCallbacks?: PipelineCallbacks;
    current?: boolean;
    inputDraw?: () => void;
  } = {},
) {
  // GPU execution belongs to the runtime fixture. Unit tests isolate sizing, reset and lifetime.
  const display = options.display ?? DISPLAY;
  // The scene pass sizes its own target from the drawing buffer, so the input raster is that buffer
  // scaled and floored. Reading the scale from the pass keeps one sizing rule.
  const scale = options.resolutionScale ?? SCALED;
  const input = {
    width: Math.floor(display.width * scale),
    height: Math.floor(display.height * scale),
  };
  const camera = new PerspectiveCamera(50, display.width / display.height);
  const scenePass = pass(new Scene(), camera);
  if (scale !== 1) scenePass.setResolutionScale(scale);
  scenePass.setSize(display.width, display.height);
  // Render-target initialization normally sizes depth on the GPU renderer.
  scenePass.getTextureNode("depth").value.image = { width: input.width, height: input.height };
  if (options.current) scenePass.setMRT(mrt({ output, velocity }));
  if (options.inputDraw)
    scenePass.updateBefore = () => {
      options.inputDraw?.();
      return undefined;
    };
  const temporal = createTemporalAA(
    options.colour?.(scenePass) ?? scenePass.getTextureNode(),
    scenePass.getTextureNode("depth"),
    scenePass.getTextureNode("velocity"),
    camera,
    options.current ? scenePass : undefined,
  );
  const stub = stubRenderer(display);
  const frame = { renderer: stub.renderer } as unknown as NodeFrame;
  const node = temporal.node as unknown as {
    _historyRenderTarget: RenderTarget;
    _resolveRenderTarget: RenderTarget;
    _historyValidUniform: { value: number };
  };
  const dependencies: Record<string, unknown> = {};
  // A render pipeline is what asks the node for its first jitter, once before the scene pass draws
  // and once after the chain, in that order.
  const pipeline = {
    context: { ...options.pipelineCallbacks } as PipelineCallbacks,
  };
  const builder = {
    context: {
      velocity,
      ...(options.renderPipeline === true ? { renderPipeline: pipeline } : {}),
    },
    // The pipeline callback reads the drawing buffer through the builder's renderer.
    renderer: stub.renderer,
    getNodeProperties: () => dependencies,
  } as unknown as NodeBuilder;
  temporal.node.setup(builder);
  return {
    builder,
    camera,
    computed: stub.computed,
    copies: stub.copies,
    dependencies,
    frame,
    node,
    order: stub.order,
    pipeline,
    scenePass,
    stub,
    temporal,
    words: stub.words,
  };
}

/**
 * The real `RenderChain` and the generated `traa` stage over the same stubbed renderer, optionally
 * mutated: the stage still builds the provider and still owns every frame of its work, but the node
 * it hands the chain is the scene pass's own colour target rather than the reconstructed output.
 */
function chainFixture(lowResolutionPassthrough = false) {
  const camera = new PerspectiveCamera(50, DISPLAY.width / DISPLAY.height);
  const scenePass = pass(new Scene(), camera);
  scenePass.setResolutionScale(SCALED);
  scenePass.setSize(DISPLAY.width, DISPLAY.height);
  scenePass.getTextureNode("depth").value.image = { width: INPUT.width, height: INPUT.height };
  const stub = stubRenderer();
  let graph: unknown;
  let provider: TemporalAAProvider | undefined;
  const stages = temporalAAStages(
    { camera, depthNode: scenePass.getTextureNode("depth"), tier: "high" },
    {
      onProvider: (next) => {
        provider = next;
      },
    },
  ).map((stage) =>
    lowResolutionPassthrough
      ? {
          ...stage,
          build: (input: unknown, context: Parameters<typeof stage.build>[1]) => {
            stage.build(input, context);
            return input;
          },
        }
      : stage,
  );
  const chain = new RenderChain({
    renderer: {
      kind: "webgpu",
      raw: stub.renderer,
      setOutputNode: (node) => {
        graph = node;
      },
      clearOutputNode: () => {},
    },
    input: scenePass.getTextureNode(),
    worldPass: scenePass,
    request: { stages: ["traa"], velocity: { pass: scenePass } },
    stages,
  });
  const builder = {
    context: { velocity },
    renderer: stub.renderer,
    getNodeProperties: () => ({}),
  } as unknown as NodeBuilder;
  const frame = { renderer: stub.renderer } as unknown as NodeFrame;
  return {
    chain,
    scenePass,
    stub,
    provider: (): TemporalAAProvider => {
      if (provider === undefined) throw new Error("The chain never built its traa stage.");
      return provider;
    },
    /** The node the chain presents, unwrapped from the velocity context it wraps it in. */
    presented: (): Node => {
      let node = graph as Node;
      while ((node as { isContextNode?: boolean }).isContextNode === true)
        node = (node as unknown as { node: Node }).node;
      return node;
    },
    /** One frame as the pipeline drives it: compile, then the provider's own per-frame work. */
    draw: async (rejected: number): Promise<void> => {
      const pixels = DISPLAY.width * DISPLAY.height;
      stub.words[0] = rejected;
      stub.words[1] = pixels;
      provider?.node.setup(builder);
      provider?.node.updateBefore(frame);
      await provider?.settledRejection();
    },
    dispose: (): void => {
      chain.dispose();
      scenePass.dispose();
    },
  };
}

/** The raster a presented node publishes, whether it reconstructs one or samples the input. */
function outputRaster(node: Node): { width: number; height: number } {
  const reconstruction = node as { _resolveRenderTarget?: RenderTarget };
  const sampled = node as TextureNode & {
    isRTTNode?: boolean;
    renderTarget?: RenderTarget;
    passNode?: { renderTarget: RenderTarget };
  };
  const target =
    reconstruction._resolveRenderTarget ??
    (sampled.isRTTNode ? sampled.renderTarget : sampled.passNode?.renderTarget);
  if (target === undefined) throw new Error("The presented node publishes no render target.");
  return { width: target.width, height: target.height };
}

/** The one output-raster contract under test: a 0.67 input is presented at the display raster. */
function expectDisplayRaster(node: Node): void {
  const raster = outputRaster(node);
  if (raster.width !== DISPLAY.width || raster.height !== DISPLAY.height)
    throw new Error(
      `The presented raster is ${String(raster.width)}x${String(raster.height)}, not the display raster ${String(DISPLAY.width)}x${String(DISPLAY.height)}.`,
    );
}

describe("opt-in temporal AA", () => {
  it("presents a display-sized raster from a 0.67 input and rejects the low-resolution passthrough", async () => {
    const rejected = 4;
    const pixels = DISPLAY.width * DISPLAY.height;
    const reconstruction = chainFixture();
    await reconstruction.draw(rejected);
    // The scene pass really did render below the display, and the chain still presents the frame.
    expect({
      width: reconstruction.scenePass.renderTarget?.width,
      height: reconstruction.scenePass.renderTarget?.height,
    }).toEqual({ width: INPUT.width, height: INPUT.height });
    expect(reconstruction.chain.applied.stages).toEqual(["traa"]);
    expect(() => expectDisplayRaster(reconstruction.presented())).not.toThrow();
    // The same frame records both rasters, its history state and the share the GPU rejected.
    expect(reconstruction.provider().report()).toMatchObject({
      frame: 1,
      historyValid: false,
      resetReason: "initial",
      inputWidth: INPUT.width,
      inputHeight: INPUT.height,
      outputWidth: DISPLAY.width,
      outputHeight: DISPLAY.height,
      rejection: { frame: 1, fraction: rejected / pixels, visited: pixels, staleFrames: 0 },
    });
    reconstruction.dispose();

    // The mutation: the stage builds the same provider, and the chain is handed the input target.
    const passthrough = chainFixture(true);
    await passthrough.draw(rejected);
    expect(() => expectDisplayRaster(passthrough.presented())).toThrow(
      `The presented raster is ${String(INPUT.width)}x${String(INPUT.height)}, not the display raster ${String(DISPLAY.width)}x${String(DISPLAY.height)}.`,
    );
    // It fails on the output raster itself, not on a missing measurement or a startup refusal.
    expect(outputRaster(passthrough.presented())).toEqual({
      width: INPUT.width,
      height: INPUT.height,
    });
    expect(passthrough.provider().report().rejection).toMatchObject({ visited: pixels });
    passthrough.dispose();
  });

  it("registers input-pass dependencies before temporal update and sizing", () => {
    const { dependencies, temporal, scenePass } = fixture();
    expect(Object.values(dependencies)).toContain(temporal.node.beautyNode);
    expect(Object.values(dependencies)).toContain(temporal.node.depthNode);
    expect(Object.values(dependencies)).toContain(temporal.node.velocityNode);
    temporal.dispose();
    scenePass.dispose();
  });

  it("resolves a smaller input raster into display-sized targets", () => {
    const { temporal, frame, copies, node, scenePass } = fixture();
    temporal.node.updateBefore(frame);
    expect(temporal.report()).toMatchObject({
      frame: 1,
      historyValid: false,
      resetReason: "initial",
      inputWidth: INPUT.width,
      inputHeight: INPUT.height,
      outputWidth: DISPLAY.width,
      outputHeight: DISPLAY.height,
    });
    // Both targets hold the display raster, which a resolve without this override would not.
    expect(node._resolveRenderTarget.width).toBe(DISPLAY.width);
    expect(node._resolveRenderTarget.height).toBe(DISPLAY.height);
    expect(node._historyRenderTarget.width).toBe(DISPLAY.width);
    expect(node._historyRenderTarget.height).toBe(DISPLAY.height);
    // No copy crosses the rasters: input colour can only seed a display target at full resolution.
    expect(copies.some((copy) => copy.from === scenePass.renderTarget.texture)).toBe(false);
    // The kernel reads this flag to publish a reset frame verbatim instead of seeding colour.
    expect(node._historyValidUniform.value).toBe(0);
    temporal.node.updateBefore(frame);
    expect(temporal.report()).toMatchObject({ frame: 2, historyValid: true, resetReason: null });
    expect(node._historyValidUniform.value).toBe(1);
    temporal.node.updateBefore(frame);
    expect(temporal.report()).toMatchObject({
      frame: 3,
      historyValid: true,
      outputWidth: DISPLAY.width,
      outputHeight: DISPLAY.height,
    });
    // One input-sized depth texture serves every frame, and only the draw writes resolve.
    const depthTexture = scenePass.getTextureNode("depth").value;
    const depthTargets = copies.filter((copy) => copy.from === depthTexture).map((copy) => copy.to);
    expect(depthTargets).toHaveLength(3);
    expect(depthTargets[1]).toBe(depthTargets[0]);
    expect(depthTargets[2]).toBe(depthTargets[0]);
    expect((depthTargets[0] as { image: { width: number } }).image.width).toBe(INPUT.width);
    expect(depthTargets[0]).not.toBe(node._historyRenderTarget.depthTexture);
    expect(copies.filter((copy) => copy.to === node._resolveRenderTarget.texture)).toHaveLength(0);
    expect(copies.filter((copy) => copy.to === node._historyRenderTarget.texture)).toHaveLength(3);
    temporal.dispose();
    scenePass.dispose();
  });

  it("seeds the depth history before the resolve, so no frame samples an unwritten texture", () => {
    const { temporal, frame, copies, order, scenePass } = fixture();
    temporal.node.updateBefore(frame);
    const depthTexture = scenePass.getTextureNode("depth").value;
    const seed = copies.findIndex((copy) => copy.from === depthTexture);
    // A fresh depth history is written before the draw that reads it; a later frame leaves it alone.
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(order.indexOf("resolve"));
    const beforeSecondFrame = copies.length;
    temporal.node.updateBefore(frame);
    const carried = copies.slice(beforeSecondFrame).find((copy) => copy.from === depthTexture);
    expect(carried).toBeDefined();
    temporal.dispose();
    scenePass.dispose();
  });

  it("jitters the input lattice when the scene pass draws, not the canvas", () => {
    const { camera, temporal, frame, node, pipeline, scenePass } = fixture({
      renderPipeline: true,
    });
    // The pipeline callback runs before the scene pass draws, so the lattice it sets is the one the
    // scene pass renders on. Upstream asks for the drawing buffer here instead.
    expect(pipeline.context.onBeforeRenderPipeline).toBeTypeOf("function");
    pipeline.context.onBeforeRenderPipeline?.();
    expect(camera.view?.enabled).toBe(true);
    expect(camera.view?.fullWidth).toBe(INPUT.width);
    expect(camera.view?.fullHeight).toBe(INPUT.height);
    temporal.node.updateBefore(frame);
    expect(camera.view?.fullWidth).toBe(INPUT.width);
    expect(node._resolveRenderTarget.width).toBe(DISPLAY.width);
    expect(node._historyRenderTarget.height).toBe(DISPLAY.height);
    temporal.dispose();
    scenePass.dispose();
  });

  it("jitters the raster the scene pass is about to render, not the one it last used", () => {
    const { camera, temporal, frame, pipeline, scenePass, stub } = fixture({
      renderPipeline: true,
    });
    temporal.node.updateBefore(frame);
    // A height-only display resize. The scene pass sizes its own target in its `updateBefore`, which
    // runs after this callback, so the target still carries the raster it last rendered into.
    stub.setDisplay(1280, 480);
    pipeline.context.onBeforeRenderPipeline?.();
    expect(camera.view?.enabled).toBe(true);
    expect(camera.view?.fullWidth).toBe(853);
    expect(camera.view?.fullHeight).toBe(320);
    // The target still holds the raster the pass last rendered into, which is not this frame's.
    expect(scenePass.renderTarget.height).not.toBe(camera.view?.fullHeight);
    temporal.dispose();
    scenePass.dispose();
  });

  it("keeps the caller's projection while the jitter lattice is the input raster", () => {
    const { camera, temporal, frame, pipeline, scenePass } = fixture({
      // A raster whose floored two-thirds is not the display's aspect, so a lattice that overwrites
      // the caller's framing cannot pass for the caller's framing.
      display: { width: 1280, height: 720 },
      renderPipeline: true,
    });
    const authored = camera.aspect;
    const authoredProjection = camera.projectionMatrix.clone();
    const draw = (): void => {
      pipeline.context.onBeforeRenderPipeline?.();
      temporal.node.updateBefore(frame);
      pipeline.context.onAfterRenderPipeline?.();
    };
    pipeline.context.onBeforeRenderPipeline?.();
    // The lattice is the raster the scene pass is about to render, one input texel wide.
    expect(camera.view?.enabled).toBe(true);
    expect(camera.view?.fullWidth).toBe(scenePass.renderTarget.width);
    expect(camera.view?.fullHeight).toBe(scenePass.renderTarget.height);
    expect(camera.aspect).toBe(authored);
    temporal.node.updateBefore(frame);
    pipeline.context.onAfterRenderPipeline?.();
    // Unjittered, the projection is the caller's own again, which is what history reprojects against.
    expect(camera.projectionMatrix.equals(authoredProjection)).toBe(true);
    // The opening frame is the initial reset; applying the lattice is not another one.
    expect(temporal.report()).toMatchObject({ historyValid: false, resetReason: "initial" });
    draw();
    expect(temporal.report()).toMatchObject({ historyValid: true, resetReason: null });
    camera.position.x = 1;
    draw();
    expect(temporal.report()).toMatchObject({ historyValid: true, resetReason: null });
    // Only a projection change the caller made invalidates history.
    camera.fov = 70;
    draw();
    expect(temporal.report()).toMatchObject({
      historyValid: false,
      resetReason: "projection-change",
    });
    temporal.dispose();
    scenePass.dispose();
  });

  it("seeds current colour on restart only while both rasters match", () => {
    const matched = fixture({ display: INPUT, resolutionScale: 1 });
    matched.temporal.node.updateBefore(matched.frame);
    expect(matched.temporal.report()).toMatchObject({
      historyValid: false,
      resetReason: "initial",
      inputWidth: INPUT.width,
      outputWidth: INPUT.width,
    });
    expect(
      matched.copies.some((copy) => copy.from === matched.scenePass.renderTarget.texture),
    ).toBe(true);
    expect(matched.node._historyRenderTarget.width).toBe(INPUT.width);
    expect(matched.node._resolveRenderTarget.height).toBe(INPUT.height);
    matched.temporal.node.updateBefore(matched.frame);
    const seeded = matched.copies.length;
    expect(matched.order.filter((event) => event === "init")).toHaveLength(2);
    matched.temporal.resetHistory("camera-cut");
    matched.temporal.node.updateBefore(matched.frame);
    expect(matched.temporal.report()).toMatchObject({
      frame: 3,
      historyValid: false,
      resetReason: "camera-cut",
    });
    expect(matched.node._historyValidUniform.value).toBe(0);
    // A camera cut publishes this frame and seeds both targets, so only a reset adds copies.
    expect(matched.copies.length).toBe(seeded + 4);
    matched.temporal.dispose();
    matched.scenePass.dispose();
  });

  it("invalidates projection changes before jitter, not ordinary camera motion", () => {
    const { temporal, camera, frame, pipeline, scenePass } = fixture({ renderPipeline: true });
    // One frame as the pipeline drives it: jitter on the input lattice, then the chain, then the
    // clear that advances the jitter index.
    const draw = (): void => {
      pipeline.context.onBeforeRenderPipeline?.();
      temporal.node.updateBefore(frame);
      pipeline.context.onAfterRenderPipeline?.();
    };
    draw();
    camera.position.x = 1;
    draw();
    expect(temporal.report().historyValid).toBe(true);
    camera.fov = 70;
    draw();
    expect(temporal.report()).toMatchObject({
      historyValid: false,
      resetReason: "projection-change",
    });
    temporal.dispose();
    scenePass.dispose();
  });

  it("invalidates an input raster change and keeps resolving at display size", () => {
    const { temporal, frame, node, scenePass } = fixture({ resolutionScale: 1 });
    temporal.node.updateBefore(frame);
    scenePass.setSize(640, 360);
    scenePass.getTextureNode("depth").value.image = { width: 640, height: 360 };
    temporal.node.updateBefore(frame);
    expect(temporal.report()).toMatchObject({
      historyValid: false,
      resetReason: "resize",
      inputWidth: 640,
      inputHeight: 360,
      outputWidth: DISPLAY.width,
      outputHeight: DISPLAY.height,
    });
    expect(node._resolveRenderTarget.width).toBe(DISPLAY.width);
    // A changed input raster is a fresh depth history, not a stretched one.
    const depthTexture = scenePass.getTextureNode("depth").value;
    const last = temporal.node as unknown as { _previousDepthNode: { value: Texture } };
    expect((last._previousDepthNode.value.image as { width: number }).width).toBe(640);
    expect(depthTexture.width).toBe(640);
    temporal.dispose();
    scenePass.dispose();
  });

  it("reallocates the depth history on a height-only input resize at constant width", () => {
    const { temporal, frame, copies, order, scenePass } = fixture({ resolutionScale: 1 });
    temporal.node.updateBefore(frame);
    const seams = temporal.node as unknown as { _previousDepthNode: { value: Texture } };
    const carried = seams._previousDepthNode.value;
    const release = vi.spyOn(carried, "dispose");
    // A height-only raster change is the case a width-only guard cannot see: the sink is the right
    // width and the wrong height, so every later frame reprojects against a mismatched texture.
    scenePass.setSize(INPUT.width, 360);
    scenePass.getTextureNode("depth").value.image = { width: INPUT.width, height: 360 };
    // Both traces are indexed from this frame's boundary: an earlier frame's resolve would satisfy
    // the seed-before-resolve comparison without saying anything about the frame that reseeds.
    const copiesBefore = copies.length;
    const orderBefore = order.length;
    temporal.node.updateBefore(frame);
    const fresh = seams._previousDepthNode.value;
    expect(temporal.report()).toMatchObject({
      historyValid: false,
      resetReason: "resize",
      inputWidth: INPUT.width,
      inputHeight: 360,
      outputWidth: DISPLAY.width,
      outputHeight: DISPLAY.height,
    });
    expect(fresh).not.toBe(carried);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fresh.image).toMatchObject({ width: INPUT.width, height: 360 });
    // The node samples the fresh sink, and it is seeded before that frame's resolve reads it.
    const seed = copies.findIndex((copy) => copy.to === fresh) - copiesBefore;
    const resolve = order.indexOf("resolve", orderBefore) - orderBefore;
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(resolve);
    temporal.dispose();
    scenePass.dispose();
  });

  it("invalidates a display raster change", () => {
    const { temporal, frame, node, scenePass, stub } = fixture();
    temporal.node.updateBefore(frame);
    stub.setDisplay(2560, 1440);
    temporal.node.updateBefore(frame);
    expect(temporal.report()).toMatchObject({
      historyValid: false,
      resetReason: "resize",
      inputWidth: INPUT.width,
      outputWidth: 2560,
      outputHeight: 1440,
    });
    expect(node._resolveRenderTarget.width).toBe(2560);
    expect(node._historyRenderTarget.height).toBe(1440);
    temporal.dispose();
    scenePass.dispose();
  });

  it("refuses a display raster below its input raster", () => {
    const { temporal, frame, scenePass, stub } = fixture();
    stub.setDisplay(640, 360);
    expect(() => temporal.node.updateBefore(frame)).toThrow(/below its input raster/);
    temporal.dispose();
    scenePass.dispose();
  });

  it("refuses mismatched velocity dimensions instead of sampling an unrelated raster", () => {
    const { temporal, frame, scenePass } = fixture();
    temporal.node.velocityNode.value.image = { width: 8, height: 8 };
    expect(() => temporal.node.updateBefore(frame)).toThrow(/same raster/);
    temporal.dispose();
    scenePass.dispose();
  });

  it.each(["depth", "velocity", "renderer", "colour"] as const)(
    "reseeds both targets when the %s input recovers after a rejected frame",
    (input) => {
      const { temporal, frame, copies, scenePass, node } = fixture({
        display: INPUT,
        resolutionScale: 1,
      });
      try {
        temporal.node.updateBefore(frame);
        temporal.node.updateBefore(frame);
        const validReport = temporal.report();
        expect(validReport.historyValid).toBe(true);
        const texture =
          input === "depth" ? temporal.node.depthNode.value : temporal.node.velocityNode.value;
        const image = texture.image;
        const renderer = frame.renderer;
        const colourPass = Reflect.get(temporal.node.beautyNode, "passNode");
        const copyCount = copies.length;
        if (input === "depth" || input === "velocity") texture.image = { width: 8, height: 8 };
        else if (input === "renderer") frame.renderer = null;
        else Reflect.set(temporal.node.beautyNode, "passNode", undefined);
        expect(() => temporal.node.updateBefore(frame)).toThrow(
          input === "renderer"
            ? /requires a renderer/
            : input === "colour"
              ? /materialized colour/
              : /same raster/,
        );
        expect(temporal.report()).toEqual(validReport);
        expect(copies).toHaveLength(copyCount);
        texture.image = image;
        frame.renderer = renderer;
        Reflect.set(temporal.node.beautyNode, "passNode", colourPass);
        temporal.node.updateBefore(frame);
        expect(temporal.report()).toMatchObject({
          frame: 3,
          historyValid: false,
          resetReason: "scene-reset",
        });
        expect(copies.slice(-2)).toEqual([
          { from: scenePass.renderTarget.texture, to: node._resolveRenderTarget.texture },
          { from: scenePass.renderTarget.texture, to: node._historyRenderTarget.texture },
        ]);
        temporal.node.updateBefore(frame);
        expect(temporal.report()).toMatchObject({
          frame: 4,
          historyValid: true,
          resetReason: null,
        });
      } finally {
        temporal.dispose();
        scenePass.dispose();
      }
    },
  );

  it.each([false, true])(
    "jitters composed RTT colour on its own raster (automatic resize: %s)",
    (automatic) => {
      let colour: ReturnType<typeof rtt> | undefined;
      const f = fixture({
        display: { width: 1280, height: 720 },
        renderPipeline: true,
        colour: (scenePass) => {
          // The generated environment composes exposure before temporal AA. Exercise that real RTT
          // seam with a smaller input, both fixed-sized and automatically sized by Three.
          colour = automatic
            ? rtt(scenePass.getTextureNode().mul(2))
            : rtt(scenePass.getTextureNode().mul(2), 853, 480);
          if (automatic) {
            colour.setResolutionScale(SCALED);
            colour.setSize(1280, 720);
          }
          return colour;
        },
      });
      try {
        f.pipeline.context.onBeforeRenderPipeline?.();
        expect(f.camera.view).toMatchObject({ enabled: true, fullWidth: 853, fullHeight: 480 });
        f.temporal.node.updateBefore(f.frame);
        expect(f.temporal.report()).toMatchObject({ inputWidth: 853, inputHeight: 480 });
        f.pipeline.context.onAfterRenderPipeline?.();
        f.stub.setDisplay(1280, 480);
        f.pipeline.context.onBeforeRenderPipeline?.();
        expect(f.camera.view).toMatchObject({ fullWidth: 853, fullHeight: automatic ? 320 : 480 });
        // The automatic target still has last frame's size before its update; a stale-size fix fails.
        expect(colour?.renderTarget?.height).toBe(480);
        f.pipeline.context.onAfterRenderPipeline?.();
      } finally {
        f.temporal.dispose();
        f.scenePass.dispose();
        colour?.renderTarget?.dispose();
      }
    },
  );

  it("fails closed when the pinned resolve seams are missing", () => {
    const { temporal, frame, scenePass } = fixture();
    const seams = temporal.node as unknown as { _resolveMaterial?: unknown };
    const resolveMaterial = seams._resolveMaterial;
    Reflect.deleteProperty(seams, "_resolveMaterial");
    expect(() => temporal.node.updateBefore(frame)).toThrow(/pinned TRAANode resolve seams/);
    seams._resolveMaterial = resolveMaterial;
    temporal.dispose();
    scenePass.dispose();
  });

  it("releases temporal targets once and rejects use after disposal", () => {
    const { temporal, frame, node, scenePass } = fixture();
    const release = vi.spyOn(node._historyRenderTarget, "dispose");
    temporal.dispose();
    temporal.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => temporal.node.updateBefore(frame)).toThrow(/disposed/);
    expect(() => temporal.resetHistory()).toThrow(/disposed/);
    scenePass.dispose();
  });

  it("counts every display pixel between the resolve and the depth history copy", async () => {
    const { computed, order, temporal, frame, words, scenePass } = fixture();
    temporal.node.updateBefore(frame);
    // Reset first, in its own dispatch, then one count: a partial sum can never be read.
    expect(computed).toHaveLength(2);
    expect(order.indexOf("resolve")).toBeLessThan(order.indexOf("compute"));
    // The count lands after the resolve and before this frame's depth history copy, so the kernel
    // reads the previous depth and the matrices that resolve drew with.
    const count = order.lastIndexOf("compute");
    expect(order.indexOf("resolve")).toBeLessThan(count);
    expect(order.slice(count).every((step) => step === "compute" || step === "copy")).toBe(true);
    words[0] = DISPLAY.width * DISPLAY.height;
    words[1] = DISPLAY.width * DISPLAY.height;
    await temporal.settledRejection();
    expect(temporal.report().rejection).toEqual({
      frame: 1,
      fraction: 1,
      visited: DISPLAY.width * DISPLAY.height,
      staleFrames: 0,
    });
    // A reset frame carries no legal history at any pixel, so 1.0 is the decision, not an estimate.
    temporal.dispose();
    scenePass.dispose();
  });
  it("publishes a new current-depth packet after both resolve and counter readers", () => {
    const f = fixture();
    const equations = createTemporalDepthRejection(
      f.temporal.node as never,
      f.stub.renderer as never,
    );
    const frame = createTemporalAAFrame(
      f.temporal.node as never,
      f.camera,
      f.scenePass.getTextureNode("depth"),
      { value: 0 },
      () => equations,
      () => f.order.push("packet"),
    );
    try {
      frame.draw(f.stub.renderer as never, true, 1);
      const packet = f.order.indexOf("packet");
      const counter = f.order.lastIndexOf("compute");
      expect(packet).toBeGreaterThan(counter);
      expect(counter).toBeGreaterThan(f.order.indexOf("resolve"));
      expect(f.order.at(-1)).toBe("copy");
    } finally {
      frame.dispose();
      f.temporal.dispose();
      f.scenePass.dispose();
    }
  });

  it("hands each completed measurement to the chain once and reports its stale age", async () => {
    const { temporal, frame, words, scenePass } = fixture();
    words[0] = 7;
    words[1] = DISPLAY.width * DISPLAY.height;
    temporal.node.updateBefore(frame);
    await temporal.settledRejection();
    expect(temporal.rejectionMeasurement()).toEqual({
      frame: 1,
      rejectionFraction: 7 / (DISPLAY.width * DISPLAY.height),
    });
    // The chain sees it once; a report read must never consume what the chain publishes.
    expect(temporal.rejectionMeasurement()).toBeUndefined();
    expect(temporal.report().rejection?.fraction).toBe(7 / (DISPLAY.width * DISPLAY.height));
    temporal.node.updateBefore(frame);
    expect(temporal.report().rejection?.staleFrames).toBe(1);
    temporal.dispose();
    scenePass.dispose();
  });

  it("fails closed on a copy it cannot trust, then recovers on the next valid sample", async () => {
    const { temporal, frame, words, scenePass } = fixture();
    const pixels = DISPLAY.width * DISPLAY.height;
    words[0] = 3;
    words[1] = 5; // fewer pixels visited than the dispatch asked for: a partial or empty copy
    temporal.node.updateBefore(frame);
    await expect(temporal.settledRejection()).rejects.toThrow(
      new RegExp(`visited 5 of ${pixels} display pixels`),
    );
    // Absent on both readers: the report never claims a fraction and the chain is handed nothing.
    expect(temporal.report().rejection).toBeUndefined();
    expect(temporal.rejectionMeasurement()).toBeUndefined();
    // The next valid sample recovers, so one bad copy does not disable the measurement for good.
    words[0] = 4;
    words[1] = pixels;
    temporal.node.updateBefore(frame);
    await temporal.settledRejection();
    expect(temporal.rejectionMeasurement()).toEqual({ frame: 2, rejectionFraction: 4 / pixels });
    temporal.dispose();
    scenePass.dispose();
  });

  it("withdraws a published measurement when the next copy fails on the device", async () => {
    const { stub, temporal, frame, words, scenePass } = fixture();
    const pixels = DISPLAY.width * DISPLAY.height;
    words[0] = 1;
    words[1] = pixels;
    temporal.node.updateBefore(frame);
    await temporal.settledRejection();
    expect(temporal.report().rejection).toBeDefined();
    // A lost device copy must withdraw the earlier number rather than keep serving it as current.
    stub.setReadback(() => Promise.reject(new Error("device lost")));
    temporal.node.updateBefore(frame);
    await expect(temporal.settledRejection()).rejects.toThrow(/device lost/);
    expect(temporal.report().rejection).toBeUndefined();
    expect(temporal.rejectionMeasurement()).toBeUndefined();
    temporal.dispose();
    scenePass.dispose();
  });

  it("withdraws a measurement whose copy arrived empty, short or impossible", async () => {
    const { stub, temporal, frame, scenePass } = fixture();
    const pixels = DISPLAY.width * DISPLAY.height;
    // An empty copy carries no words at all, and a one-word copy carries no visited count, so
    // neither has a denominator to divide by.
    for (const [words, reason] of [
      [0, /carried 0 of 2 words/],
      [1, /carried 1 of 2 words/],
    ] as const) {
      stub.setReadback(() => Promise.resolve(new Uint32Array(words).buffer));
      temporal.node.updateBefore(frame);
      await expect(temporal.settledRejection()).rejects.toThrow(reason);
    }
    // More rejected than visited cannot come from this kernel, so the copy is not its own.
    stub.setReadback(() => Promise.resolve(new Uint32Array([pixels + 1, pixels]).buffer));
    temporal.node.updateBefore(frame);
    await expect(temporal.settledRejection()).rejects.toThrow(
      new RegExp(`rejected ${pixels + 1} of ${pixels} pixels`),
    );
    expect(temporal.report().rejection).toBeUndefined();
    temporal.dispose();
    scenePass.dispose();
  });

  it("clears its measurement on disposal instead of leaving a stale number behind", async () => {
    const { temporal, frame, words, scenePass } = fixture();
    words[0] = 1;
    words[1] = DISPLAY.width * DISPLAY.height;
    temporal.node.updateBefore(frame);
    await temporal.settledRejection();
    expect(temporal.report().rejection).toBeDefined();
    temporal.dispose();
    expect(temporal.report().rejection).toBeUndefined();
    expect(temporal.rejectionMeasurement()).toBeUndefined();
    scenePass.dispose();
  });

  it("puts each slot back on the owner it held before the first setup", () => {
    const before = (): void => {};
    const after = (): void => {};
    const { builder, temporal, pipeline, scenePass } = fixture({
      renderPipeline: true,
      pipelineCallbacks: { onBeforeRenderPipeline: before, onAfterRenderPipeline: after },
    });
    // Upstream's own setup wrote a pair bound to this node; only the jitter callback is ours.
    const jitter = pipeline.context.onBeforeRenderPipeline;
    expect(jitter).toBeTypeOf("function");
    expect(jitter).not.toBe(before);
    expect(pipeline.context.onAfterRenderPipeline).toBeTypeOf("function");
    expect(pipeline.context.onAfterRenderPipeline).not.toBe(after);
    // A recompile is this node's own pair again, and the jitter callback keeps its identity.
    temporal.node.setup(builder);
    expect(pipeline.context.onBeforeRenderPipeline).toBe(jitter);
    temporal.dispose();
    expect(pipeline.context.onBeforeRenderPipeline).toBe(before);
    expect(pipeline.context.onAfterRenderPipeline).toBe(after);
    scenePass.dispose();
  });

  it("returns the replaced context to its own originals when a recompile makes a new one", () => {
    const before = (): void => {};
    const after = (): void => {};
    const { builder, temporal, pipeline, scenePass } = fixture({
      renderPipeline: true,
      pipelineCallbacks: { onBeforeRenderPipeline: before, onAfterRenderPipeline: after },
    });
    const jitter = pipeline.context.onBeforeRenderPipeline;
    // Three's RenderPipeline._update builds a fresh context object per recompile and `context` is
    // the getter naming the active one, so replacing it here is what a real recompile presents.
    const replaced = pipeline.context;
    const fresh: PipelineCallbacks = {};
    pipeline.context = fresh;
    temporal.node.setup(builder);
    // The jitter callback keeps its identity across the handover.
    expect(fresh.onBeforeRenderPipeline).toBe(jitter);
    expect(fresh.onAfterRenderPipeline).not.toBe(after);
    expect(replaced.onBeforeRenderPipeline).toBe(before);
    expect(replaced.onAfterRenderPipeline).toBe(after);
    scenePass.dispose();
  });

  it("leaves the context a recompile made clean after disposal, whatever it still calls", () => {
    const { builder, camera, temporal, pipeline, scenePass } = fixture({ renderPipeline: true });
    const fresh: PipelineCallbacks = {};
    pipeline.context = fresh;
    temporal.node.setup(builder);
    expect(fresh.onAfterRenderPipeline).toBeTypeOf("function");
    const view = camera.view;
    const projection = camera.projectionMatrix.clone();
    temporal.dispose();
    expect(fresh.onBeforeRenderPipeline).toBeUndefined();
    expect(fresh.onAfterRenderPipeline).toBeUndefined();
    // The pair the disposed node left behind would still jitter and re-project the camera.
    fresh.onBeforeRenderPipeline?.();
    fresh.onAfterRenderPipeline?.();
    expect(camera.view).toBe(view);
    expect(camera.projectionMatrix.equals(projection)).toBe(true);
    scenePass.dispose();
  });

  it("leaves both slots empty when it found none before the first setup", () => {
    const { temporal, pipeline, scenePass } = fixture({ renderPipeline: true });
    temporal.dispose();
    expect(pipeline.context.onBeforeRenderPipeline).toBeUndefined();
    expect(pipeline.context.onAfterRenderPipeline).toBeUndefined();
    scenePass.dispose();
  });

  it("never clears a later owner's replacement callback in either slot", () => {
    const { temporal, pipeline, scenePass } = fixture({ renderPipeline: true });
    const laterBefore = (): void => {};
    const laterAfter = (): void => {};
    pipeline.context.onBeforeRenderPipeline = laterBefore;
    pipeline.context.onAfterRenderPipeline = laterAfter;
    temporal.dispose();
    expect(pipeline.context.onBeforeRenderPipeline).toBe(laterBefore);
    expect(pipeline.context.onAfterRenderPipeline).toBe(laterAfter);
    scenePass.dispose();
  });

  it("leaves the disposed camera alone whatever the pipeline still calls", () => {
    const { camera, temporal, pipeline, scenePass } = fixture({ renderPipeline: true });
    pipeline.context.onBeforeRenderPipeline?.();
    expect(camera.view?.enabled).toBe(true);
    temporal.dispose();
    expect(pipeline.context.onBeforeRenderPipeline).toBeUndefined();
    expect(pipeline.context.onAfterRenderPipeline).toBeUndefined();
    const view = camera.view;
    const projection = camera.projectionMatrix.clone();
    // Upstream's pair belongs to the node being disposed, so restoring it would jitter it again.
    pipeline.context.onBeforeRenderPipeline?.();
    pipeline.context.onAfterRenderPipeline?.();
    expect(camera.view).toBe(view);
    expect(camera.projectionMatrix.equals(projection)).toBe(true);
    scenePass.dispose();
  });
});

describe("input jitter belongs to the same frame as saved depth", () => {
  it("records the unjittered lazy-first input before late synchronization, then actual next jitter", () => {
    const { temporal, node, camera, frame, pipeline, scenePass } = fixture({
      renderPipeline: true,
    });
    const internals = node as unknown as {
      _currentJitterUV: { value: Vector2 };
      _previousJitterUV: { value: Vector2 };
      _cameraProjectionMatrixInverse: { value: { equals(other: unknown): boolean } };
    };
    try {
      const firstInputProjection = camera.projectionMatrixInverse.clone();
      // First lazy setup installs the hook after that frame's onBefore boundary. Its input has
      // already drawn without jitter; temporal.draw's late sync only prepares a later draw.
      temporal.node.updateBefore(frame);
      expect(internals._currentJitterUV?.value.toArray()).toEqual([0, 0]);
      expect(internals._previousJitterUV?.value.toArray()).toEqual([0, 0]);
      expect(internals._cameraProjectionMatrixInverse.value.equals(firstInputProjection)).toBe(
        true,
      );
      pipeline.context.onAfterRenderPipeline?.();
      pipeline.context.onBeforeRenderPipeline?.();
      const view = camera.view;
      expect(view?.enabled).toBe(true);
      const actualInputJitter = new Vector2(
        (view?.offsetX ?? 0) / INPUT.width,
        (view?.offsetY ?? 0) / INPUT.height,
      );
      const nextInputProjection = camera.projectionMatrixInverse.clone();
      temporal.node.updateBefore(frame);
      expect(internals._previousJitterUV.value.toArray()).toEqual([0, 0]);
      expect(internals._currentJitterUV.value.equals(actualInputJitter)).toBe(true);
      expect(internals._cameraProjectionMatrixInverse.value.equals(nextInputProjection)).toBe(true);
      pipeline.context.onAfterRenderPipeline?.();
      pipeline.context.onBeforeRenderPipeline?.();
      temporal.node.updateBefore(frame);
      expect(internals._previousJitterUV.value.equals(actualInputJitter)).toBe(true);
    } finally {
      temporal.dispose();
      scenePass.dispose();
    }
  });
});

describe("reconstruction uses the input camera that actually drew", () => {
  it("records zero jitter for lazy-first input then the real next view offset", () => {
    const { temporal, camera, frame, pipeline, scenePass } = fixture({ renderPipeline: true });
    try {
      expect(camera.view?.enabled ?? false).toBe(false);
      temporal.node.updateBefore(frame);
      expect(temporal.jitterOffset.value.toArray()).toEqual([0, 0]);
      pipeline.context.onAfterRenderPipeline?.();
      pipeline.context.onBeforeRenderPipeline?.();
      const drawn = new Vector2(camera.view?.offsetX ?? 0, camera.view?.offsetY ?? 0);
      temporal.node.updateBefore(frame);
      expect(temporal.jitterOffset.value.toArray()).toEqual(drawn.toArray());
    } finally {
      temporal.dispose();
      scenePass.dispose();
    }
  });
});
