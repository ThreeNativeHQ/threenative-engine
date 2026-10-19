// Generated user source: who owns the two pipeline callbacks a temporal AA compile borrows. Upstream
// TRAANode's setup writes its own pair bound to that node, so the originals are the slots as they
// stand before the first setup — a recompile must never capture them again as the originals.
import type { Matrix4 } from "three";
import type { NodeMaterial, RenderTarget, Renderer, TextureNode } from "three/webgpu";
import type { ITemporalResolvePinned } from "./temporalResolveDepth.js";

export interface ITemporalAANode extends ITemporalResolvePinned {
  _resolveMaterial: NodeMaterial;
  _needsPostProcessingSync: boolean;
  _historyValidUniform: { value: number };
  _originalProjectionMatrix: Matrix4;
  _velocityNode: {
    projectionMatrix: Matrix4 | null;
    setProjectionMatrix(matrix: Matrix4 | null): void;
  } | null;
  beautyNode: TextureNode & {
    isRTTNode?: boolean;
    autoResize?: boolean;
    getResolutionScale?: () => number;
    renderTarget?: RenderTarget;
    passNode?: { renderTarget: RenderTarget; getResolutionScale?: () => number };
  };
  setSize(width: number, height: number): void;
  setViewOffset(width: number, height: number): void;
  clearViewOffset(): void;
}

/** Fail closed rather than half-drive a pinned seam whose shape this version does not have: a
 * missing uniform reads as `undefined` in a shader and comes back as a black frame. */
export function guardTemporalAASeams(node: ITemporalAANode): void {
  if (
    typeof node.setSize !== "function" ||
    typeof node.setViewOffset !== "function" ||
    typeof node.clearViewOffset !== "function" ||
    node._resolveMaterial === undefined ||
    node._previousDepthNode === undefined ||
    node._cameraNearFar?.value === undefined ||
    node._cameraWorldMatrix?.value === undefined ||
    !Number.isFinite(node._resolveRenderTarget?.width) ||
    !Number.isFinite(node._historyRenderTarget?.height)
  )
    throw new Error("Temporal AA requires the pinned TRAANode resolve seams of Three 0.185.1.");
}

export type PipelineContext = {
  onBeforeRenderPipeline?: () => void;
  onAfterRenderPipeline?: () => void;
};

export function createTemporalAAHooks(jitter: (renderer: Renderer) => void) {
  let context: PipelineContext | undefined;
  let previousBefore: (() => void) | undefined;
  let previousAfter: (() => void) | undefined;
  let ownedBefore: (() => void) | undefined;
  let ownedAfter: (() => void) | undefined;

  /**
   * Each borrowed slot goes back to the original its own context held, and only while it is still
   * this node's: a later owner keeps the slot, and upstream's pair belongs to the node.
   */
  function restore(): void {
    if (context === undefined) return;
    if (context.onBeforeRenderPipeline === ownedBefore)
      context.onBeforeRenderPipeline = previousBefore;
    if (context.onAfterRenderPipeline === ownedAfter) context.onAfterRenderPipeline = previousAfter;
  }

  return {
    /**
     * The originals, read once per context and before upstream's setup has written the node's own
     * pair. A recompile into a fresh context object hands this one back, so the context three stops
     * calling keeps nothing it borrowed.
     */
    captureBeforeSetup(next: PipelineContext): void {
      if (context === next) return;
      restore();
      context = next;
      previousBefore = next.onBeforeRenderPipeline;
      previousAfter = next.onAfterRenderPipeline;
    },
    /**
     * The node's own after-callback is ours to give back, since this compile is what installed it.
     * The jitter callback keeps its identity across recompiles, so a second setup finds the slot
     * already claimed instead of recording this provider's own callback as the previous owner.
     */
    installAfterSetup(next: PipelineContext, renderer: Renderer): void {
      ownedBefore ??= () => jitter(renderer);
      ownedAfter = next.onAfterRenderPipeline;
      next.onBeforeRenderPipeline = ownedBefore;
    },
    dispose(): void {
      restore();
      context = undefined;
      previousBefore = undefined;
      previousAfter = undefined;
      ownedBefore = undefined;
      ownedAfter = undefined;
    },
  };
}
