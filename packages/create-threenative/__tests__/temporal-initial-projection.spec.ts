import { PerspectiveCamera, Scene } from "three";
import { pass } from "three/tsl";
import { type NodeBuilder, VelocityNode } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { createTemporalAA } from "../templates/starter/src/render/temporalAA.js";

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
    const builder = {
      context: { velocity: accessor, renderPipeline: { context: {} } },
      renderer: {},
      getNodeProperties: () => ({}),
    } as unknown as NodeBuilder;
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
    temporal.node.setup({
      context: { velocity: accessor, renderPipeline: { context: {} } },
      renderer: {},
      getNodeProperties: () => ({}),
    } as unknown as NodeBuilder);
    // The input-pass dependency executes before temporal.updateBefore. VelocityNode.setup
    // permanently selects the current-projection source while that first material compiles.
    const motion = accessor.setup({} as NodeBuilder);
    if (motion === null || motion === undefined)
      throw new Error("Velocity accessor returned no graph");
    const explicitMatrices: unknown[] = [];
    motion.traverse((node) => {
      if ("value" in node) explicitMatrices.push(node.value);
    });
    expect(accessor.projectionMatrix).not.toBeNull();
    expect(explicitMatrices).toContain(accessor.projectionMatrix);
    expect(accessor.projectionMatrix?.equals(camera.projectionMatrix)).toBe(true);
    expect(camera.view?.enabled ?? false).toBe(false);
    temporal.dispose();
    expect(accessor.projectionMatrix).toBeNull();
    scenePass.dispose();
  });
});
