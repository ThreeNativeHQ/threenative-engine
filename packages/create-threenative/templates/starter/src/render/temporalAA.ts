// Generated user source: opt-in temporal AA using pinned Three.js TRAANode. Colour, depth and velocity
// share the scene pass raster, which may sit below the display raster; resolve and history hold the
// display raster, so presented pixels come from a display-sized resolve, not an upscaled copy.
import { Matrix4, type OrthographicCamera, type PerspectiveCamera, Vector2 } from "three";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { uniform } from "three/tsl";
import type { Node, PassNode, Renderer, TextureNode } from "three/webgpu";
import { type ITemporalAANode, createTemporalAAFrame } from "./temporalAAFrame.js";
import { type PipelineContext, createTemporalAAHooks } from "./temporalAAHooks.js";
import { disposeTemporalAAInput } from "./temporalAAInput.js";
import type { ITemporalAAReport, TemporalResetReason } from "./temporalAAStage.js";
import { createTemporalCurrentProducer } from "./temporalCurrentProducer.js";
import { ownsCurrentInput } from "./temporalCurrentSelection.js";
export type { ITemporalAAReport, TemporalResetReason } from "./temporalAAStage.js";
import { createTemporalAAResolve } from "./temporalAAResolve.js";
import type { TemporalResolveNode } from "./temporalResolveDepth.js";

/** Reuse TRAANode's jitter, depth rejection and variance clipping. In a RenderChain `traa` factory
 * pass context.velocityNode and the scene pass's depth, keep the scene pass single-sampled, reset
 * history on teleports, and dispose with the owning stage. */
export function createTemporalAA(
  colour: Node,
  depthInput: TextureNode,
  velocityInput: TextureNode,
  camera: PerspectiveCamera | OrthographicCamera,
  currentPass?: PassNode,
) {
  const currentProducer = ownsCurrentInput(colour, depthInput, velocityInput, camera, currentPass)
    ? createTemporalCurrentProducer(currentPass)
    : undefined;
  const depth = currentProducer?.depth ?? depthInput;
  const velocity = currentProducer?.motion ?? velocityInput;
  const node = traa(colour, depth, velocity, camera);
  // Three 0.185.1 exposes no reset API, so its pinned seams are isolated here instead.
  const historyValid = uniform(1);
  // The reconstruction gathers around the exact jittered sample Three applied this frame.
  const jitterOffset = uniform(new Vector2());
  const internals = node as unknown as ITemporalAANode;
  internals._historyValidUniform = historyValid;
  internals._reconstructionJitterOffset = jitterOffset;
  internals._currentJitterUV = uniform(new Vector2());
  internals._previousJitterUV = uniform(new Vector2());
  // One instance of the depth-rejection equations, shared by the resolve, the counter and every
  // recompile, so a measured fraction cannot describe a different decision than the one drawn.
  const resolve = createTemporalAAResolve(
    node as TemporalResolveNode,
    jitterOffset,
    currentProducer,
  );
  const frames = createTemporalAAFrame(
    internals,
    camera,
    depth,
    historyValid,
    resolve.equations,
    currentProducer?.publishDepth,
  );
  const hooks = createTemporalAAHooks(frames.jitterInput);
  let ownedViewOffset: { width: number; height: number } | null = null;
  const projection = new Matrix4().copy(camera.projectionMatrix);
  const setViewOffset = internals.setViewOffset.bind(node);
  const clearViewOffset = internals.clearViewOffset.bind(node);
  let pending: TemporalResetReason | null = "initial";
  currentProducer?.onFailure(() => {
    pending = "scene-reset";
  });
  let disposed = false;
  let report: ITemporalAAReport = {
    frame: 0,
    historyValid: false,
    resetReason: "initial",
    inputWidth: 0,
    inputHeight: 0,
    outputWidth: 0,
    outputHeight: 0,
  };
  currentProducer?.onModeChange((renderer) => {
    pending = "resize";
    resolve.invalidate(renderer);
  });
  internals.clearViewOffset = () => {
    try {
      clearViewOffset();
    } finally {
      ownedViewOffset = null;
    }
  };
  internals.setViewOffset = (width: number, height: number) => {
    if (ownedViewOffset?.width === width && ownedViewOffset?.height === height) return;
    const aspect = (camera as PerspectiveCamera).aspect;
    if (ownedViewOffset !== null) camera.clearViewOffset();
    camera.updateProjectionMatrix();
    if (!camera.projectionMatrix.equals(projection)) pending ??= "projection-change";
    projection.copy(camera.projectionMatrix);
    setViewOffset(width, height);
    if ((camera as PerspectiveCamera).aspect !== aspect) {
      (camera as PerspectiveCamera).aspect = aspect;
      camera.updateProjectionMatrix();
    }
    ownedViewOffset = { width, height };
  };
  const setup = node.setup.bind(node);
  node.setup = (builder) => {
    // NodeBuilder schedules child passes only when setup declares them; upstream finds them too late.
    const properties = (
      builder as unknown as { getNodeProperties(node: Node): Record<string, Node> }
    ).getNodeProperties(node);
    properties.temporalColour = node.beautyNode;
    properties.temporalDepth = depth;
    properties.temporalVelocity = velocity;
    const pipeline = (builder.context as { renderPipeline?: { context: PipelineContext } })
      .renderPipeline;
    // The originals are read before upstream's setup writes the node's own pair over them.
    if (pipeline !== undefined) hooks.captureBeforeSetup(pipeline.context);
    const output = setup(builder);
    resolve.configure(builder.renderer);
    // Upstream's resolve is what this replaces, so the reset kernel runs by default.
    if (pipeline !== undefined) hooks.installAfterSetup(pipeline.context, builder.renderer);
    // VelocityNode keeps whichever projection source that input pass first compiles: prime ours.
    if (ownedViewOffset === null) {
      camera.updateProjectionMatrix();
      internals._originalProjectionMatrix.copy(camera.projectionMatrix);
    }
    if (internals._velocityNode === null)
      throw new Error("Temporal AA requires a velocity accessor.");
    internals._velocityNode.setProjectionMatrix(internals._originalProjectionMatrix);
    return output;
  };
  node.updateBefore = (frame) => {
    if (disposed) throw new Error("Temporal AA is disposed.");
    try {
      if (frame.renderer === null) throw new Error("Temporal AA requires a renderer.");
      const source = frames.measure(frame.renderer);
      if (source === undefined)
        throw new Error("Temporal AA requires a materialized colour input.");
      const { x: width, y: height } = frames.input;
      for (const texture of [depth.value, velocity.value]) {
        if (texture.width !== width || texture.height !== height)
          throw new Error(
            "Temporal AA colour, depth and velocity must share the same raster size.",
          );
      }
      // Either raster moving invalidates history: UVs and depth no longer name the same samples.
      if (
        report.frame > 0 &&
        (width !== report.inputWidth ||
          height !== report.inputHeight ||
          frames.display.x !== report.outputWidth ||
          frames.display.y !== report.outputHeight)
      )
        pending = "resize";
      const reason = pending;
      frames.draw(frame.renderer, reason !== null, report.frame + 1);
      if (reason !== null && width === frames.display.x && height === frames.display.y) {
        frame.renderer.copyTextureToTexture(source.texture, internals._resolveRenderTarget.texture);
        frame.renderer.copyTextureToTexture(source.texture, internals._historyRenderTarget.texture);
      }
      report = {
        frame: report.frame + 1,
        historyValid: reason === null,
        resetReason: reason,
        inputWidth: width,
        inputHeight: height,
        outputWidth: frames.display.x,
        outputHeight: frames.display.y,
      };
      pending = null;
      return undefined;
    } catch (error) {
      pending = "scene-reset";
      throw error;
    }
  };
  return {
    node,
    jitterOffset,
    // Omitted rather than undefined, so a report carrying none stays JSON-safe for a bridge.
    report: (): ITemporalAAReport => {
      const measured = frames.rejection();
      return { ...report, ...(measured === undefined ? {} : { rejection: measured }) };
    },
    rejectionMeasurement: frames.drainRejection,
    settledRejection: frames.settledRejection,
    resetHistory: (reason: TemporalResetReason = "scene-reset"): void => {
      if (disposed) throw new Error("Temporal AA is disposed.");
      pending = reason;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      hooks.dispose();
      currentProducer?.dispose();
      frames.dispose();
      disposeTemporalAAInput(internals, colour, ownedViewOffset !== null, () => node.dispose());
    },
  };
}
