// Generated user source: who owns the pipeline callbacks a temporal AA compile borrows. Three 0.187
// keeps one callback list per pipeline boundary in the node builder's context, and its TRAANode only
// registers its own pair while nothing owns the view offset. The provider claims that ownership, so
// this pair is the one the pipeline drives: the jitter before the pass draws, the clear after it.
import type { Matrix4 } from "three";
import type { Node, NodeMaterial, RenderTarget, Renderer, TextureNode } from "three/webgpu";
import type { ITemporalResolvePinned } from "./temporalResolveDepth.js";

export interface ITemporalAANode extends ITemporalResolvePinned {
  _resolveMaterial: NodeMaterial;
  _needsPostProcessingSync: boolean;
  _historyValidUniform: Node<"float"> & { value: number };
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

/** The pipeline's context in a node builder: three keeps one callback list per boundary. */
export type PipelineContext = {
  onBeforePipelineCallbacks?: (() => void)[];
  onAfterPipelineCallbacks?: (() => void)[];
};

/** Who owns the pipeline's view offset; three's own TRAANode registers its pair while it is null. */
export type ITemporalAARenderPipelineState = {
  renderPipelineState?: { viewOffsetOwner: unknown };
};

export function createTemporalAAHooks(jitter: (renderer: Renderer) => void, clear: () => void) {
  let context: PipelineContext | undefined;
  let ownedBefore: (() => void) | undefined;
  let ownedAfter: (() => void) | undefined;

  /** Only this compile's pair goes back: a later owner's callbacks keep their place. */
  function restore(): void {
    if (context === undefined) return;
    const before = context.onBeforePipelineCallbacks;
    const after = context.onAfterPipelineCallbacks;
    if (before !== undefined && ownedBefore !== undefined) {
      const at = before.indexOf(ownedBefore);
      if (at !== -1) before.splice(at, 1);
    }
    if (after !== undefined && ownedAfter !== undefined) {
      const at = after.indexOf(ownedAfter);
      if (at !== -1) after.splice(at, 1);
    }
    context = undefined;
  }

  return {
    /**
     * Three 0.187 keeps a pipeline's callbacks in the builder context and registers its own pair
     * only while nothing owns the view offset. The provider owns it: upstream's pair would ask
     * for the whole drawing buffer rather than the raster the input draws on.
     */
    claim(builderContext: unknown, owner: unknown): void {
      const state = (builderContext as ITemporalAARenderPipelineState).renderPipelineState;
      if (state === undefined)
        throw new Error("Temporal AA requires the render pipeline state of Three 0.187.0.");
      state.viewOffsetOwner = owner;
      this.captureBeforeSetup(builderContext as PipelineContext);
    },
    /**
     * The context this compile pushes into, read before upstream's setup runs. A recompile into a
     * fresh context object hands the previous one back first, so the context three stops calling
     * keeps nothing it borrowed.
     */
    captureBeforeSetup(next: PipelineContext): void {
      if (context === next) return;
      restore();
      context = next;
    },
    /**
     * The pair the claimed view offset owes the pipeline. The jitter keeps its identity across
     * recompiles, so a second setup into the same context finds its callbacks instead of adding
     * them twice, and the clear stays with it so the jitter index advances once per frame.
     */
    installAfterSetup(next: PipelineContext, renderer: Renderer): void {
      ownedBefore ??= () => jitter(renderer);
      ownedAfter ??= clear;
      if (next.onBeforePipelineCallbacks === undefined) next.onBeforePipelineCallbacks = [];
      if (next.onAfterPipelineCallbacks === undefined) next.onAfterPipelineCallbacks = [];
      const before = next.onBeforePipelineCallbacks;
      const after = next.onAfterPipelineCallbacks;
      if (!before.includes(ownedBefore)) before.push(ownedBefore);
      if (!after.includes(ownedAfter)) after.push(ownedAfter);
      context = next;
    },
    dispose(): void {
      restore();
      ownedBefore = undefined;
      ownedAfter = undefined;
    },
  };
}
