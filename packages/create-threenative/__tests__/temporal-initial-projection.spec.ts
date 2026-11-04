import { Object3D, PerspectiveCamera, Scene } from "three";
import { pass } from "three/tsl";
import type { NodeBuilder } from "three/webgpu";
import { VelocityNode, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { createTemporalAA } from "../templates/starter/src/render/temporalAA.js";

/** The part of a real builder these tests drive; the pinned declarations omit it. */
type ISetupBuilder = WGSLNodeBuilder & {
  context: Record<string, unknown>;
  setBuildStage(stage: string): void;
};

/**
 * The real builder in its setup stage, under the pipeline context a pipeline hands a node: three
 * 0.187's TRAANode.setup builds its three input nodes before anything is set up.
 */
function setupBuilder(accessor: VelocityNode): ISetupBuilder {
  const renderer = {
    reversedDepthBuffer: false,
    logarithmicDepthBuffer: false,
    samples: 0,
    // Three 0.187's PassNode.setup asks the renderer for the buffer type it renders into.
    getOutputBufferType: () => 1016,
    getRenderTarget: () => null,
  };
  const builder = new WGSLNodeBuilder(null as never, renderer as never) as ISetupBuilder;
  builder.setBuildStage("setup");
  builder.context.velocity = accessor;
  builder.context.renderPipeline = {};
  builder.context.renderPipelineState = { viewOffsetOwner: null };
  builder.context.onBeforePipelineCallbacks = [];
  builder.context.onAfterPipelineCallbacks = [];
  return builder;
}

describe("temporal AA first world-material compile", () => {
  it("preserves the unjittered matrix when setup repeats inside an active pipeline frame", () => {
    const camera = new PerspectiveCamera(50, 16 / 9);
    const original = camera.projectionMatrix.clone();
    const scenePass = pass(new Scene(), camera);
    const accessor = new VelocityNode();
    const temporal = createTemporalAA(
      scenePass.getTextureNode(),
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    const builder = setupBuilder(accessor);
    temporal.node.setup(builder);
    const node = temporal.node as unknown as {
      setViewOffset(width: number, height: number): void;
      clearViewOffset(): void;
    };
    node.setViewOffset(640, 360);
    expect(camera.projectionMatrix.equals(original)).toBe(false);
    temporal.node.setup(builder);
    expect(accessor.projectionMatrix?.equals(original)).toBe(true);
    // Upstream requests another initial sync after each setup; it must not compound jitter.
    const jittered = camera.projectionMatrix.clone();
    node.setViewOffset(640, 360);
    expect(camera.projectionMatrix.equals(jittered)).toBe(true);
    expect(accessor.projectionMatrix?.equals(original)).toBe(true);
    node.clearViewOffset();
    expect(camera.projectionMatrix.equals(original)).toBe(true);
    temporal.dispose();
    scenePass.dispose();
  });
  it("selects the explicit unjittered velocity uniform before the input pass compiles", () => {
    const camera = new PerspectiveCamera(50, 16 / 9);
    const scenePass = pass(new Scene(), camera);
    const accessor = new VelocityNode();
    const temporal = createTemporalAA(
      scenePass.getTextureNode(),
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("velocity"),
      camera,
    );
    temporal.node.setup(setupBuilder(accessor));
    // The input-pass dependency executes before temporal.updateBefore. VelocityNode.setup
    // permanently selects the current-projection source while that first material compiles.
    const motion = accessor.setup({} as NodeBuilder);
    if (motion === null || motion === undefined)
      throw new Error("Velocity accessor returned no graph");
    // Three 0.187's motion graph reads one current-projection uniform (nodes/accessors/
    // VelocityNode.js:166-180) instead of baking the chosen matrix in as a uniform at setup.
    const graphNodes: unknown[] = [];
    motion.traverse((node) => graphNodes.push(node));
    const explicit = accessor.projectionMatrix;
    if (explicit === null) throw new Error("Velocity accessor selected no projection matrix");
    expect(graphNodes).toContain(accessor.currentProjectionMatrix);
    expect(explicit.equals(camera.projectionMatrix)).toBe(true);
    expect(camera.view?.enabled ?? false).toBe(false);
    // A jittered camera projection must not reach that uniform: the explicit matrix is copied in.
    camera.setViewOffset(640, 360, 0.25, 0.25, 640, 360);
    accessor.update({ frameId: 1, camera, object: new Object3D() } as never);
    expect(camera.projectionMatrix.equals(explicit)).toBe(false);
    expect(accessor.currentProjectionMatrix.value.equals(explicit)).toBe(true);
    temporal.dispose();
    expect(accessor.projectionMatrix).toBeNull();
    scenePass.dispose();
  });
});
