// The actual input raster and its pre-draw jitter; independent of display history storage.
import { Vector2 } from "three";
import type { Node, RenderTarget, Renderer } from "three/webgpu";
import type { ITemporalAANode } from "./temporalAAFrame.js";
export function createTemporalAAInput(internals: ITemporalAANode, isDisposed: () => boolean) {
  const input = new Vector2();
  /** The scene pass raster, from its real GPU target and never from a canvas label. */
  function measureInput(): RenderTarget | undefined {
    const target = internals.beautyNode.isRTTNode
      ? internals.beautyNode.renderTarget
      : internals.beautyNode.passNode?.renderTarget;
    if (target === undefined) return undefined;
    if (!Number.isFinite(target.width) || target.width < 1) return undefined;
    if (!Number.isFinite(target.height) || target.height < 1) return undefined;
    input.set(target.width, target.height);
    return target;
  }

  /** Establish jitter before the pass sizes and draws its raster in updateBefore. Its raster is
   * the drawing buffer scaled by the pass's own resolution scale, rather than the canvas alone. */
  function jitterInput(renderer: Renderer): void {
    if (isDisposed()) return;
    const colour = internals.beautyNode;
    // A fixed RTT owns its raster; an automatic RTT and a pass size themselves from the buffer.
    if (colour.isRTTNode && colour.autoResize === false) {
      if (measureInput() !== undefined) internals.setViewOffset(input.x, input.y);
      return;
    }
    const scale = (colour.isRTTNode ? colour : colour.passNode)?.getResolutionScale?.() ?? 1;
    renderer.getDrawingBufferSize(input);
    if (scale !== 1) input.set(Math.floor(input.x * scale), Math.floor(input.y * scale));
    internals.setViewOffset(input.x, input.y);
  }

  return { input, measureInput, jitterInput };
}

/** Release the upstream input conversion and restore only the projection this helper owns. */
export function disposeTemporalAAInput(
  internals: ITemporalAANode,
  colour: Node,
  ownsView: boolean,
  dispose: () => void,
) {
  if (internals._velocityNode?.projectionMatrix === internals._originalProjectionMatrix) {
    if (ownsView) internals.clearViewOffset();
    else internals._velocityNode.setProjectionMatrix(null);
  }
  dispose();
  if (internals.beautyNode !== colour && internals.beautyNode.isRTTNode) {
    internals.beautyNode.renderTarget?.dispose();
    (
      internals.beautyNode as unknown as { _quadMesh: { material: { dispose(): void } } }
    )._quadMesh.material.dispose();
  }
}
