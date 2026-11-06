// Generated user source: Unreal TSR's history resolve for a history stored above the display raster.
// The chain reads its display-sized output in place of the history, so later post stages pay
// display pixels, not history pixels.
import { HalfFloatType, type Vector2 } from "three";
import { Fn, float, int, ivec2, max, min, texture, uv, vec2, vec4 } from "three/tsl";
import {
  type Node,
  NodeMaterial,
  type QuadMesh,
  RenderTarget,
  type Renderer,
  type TextureNode,
} from "three/webgpu";
import type { ITemporalAANode } from "./temporalResolveDepth.js";

/** Mitchell–Netravali, B = C = 1/3, at distance x (UE 5.8.3: Engine/Shaders/Private/
 * TemporalSuperResolution/TSRResolveHistory.usf:82-83). */
function mitchell(x: number): number {
  const b = 1 / 3;
  const c = 1 / 3;
  const ax = Math.abs(x);
  if (ax < 1)
    return ((12 - 9 * b - 6 * c) * ax ** 3 + (-18 + 12 * b + 6 * c) * ax ** 2 + (6 - 2 * b)) / 6;
  if (ax < 2)
    return (
      ((-b - 6 * c) * ax ** 3 +
        (6 * b + 30 * c) * ax ** 2 +
        (-12 * b - 48 * c) * ax +
        (8 * b + 24 * c)) /
      6
    );
  return 0;
}

/**
 * Unreal TSR's history resolve (UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/
 * TSRResolveHistory.usf:312-357): a display pixel takes the 4×4 history pixels around its centre,
 * Mitchell-weighted by their distance in history pixels and by Unreal's HDR weight 1 / (R + 2G + B + 4)
 * (TSRColorSpace.ush:167-195), then clamped to those samples' range. At a 2x history the centre sits
 * between pixels, so the taps lie at ±0.5 and ±1.5 history pixels.
 */
function createHistoryResolve(resolve: TextureNode): NodeMaterial {
  const weights = [1.5, 0.5, 0.5, 1.5].map(mitchell);
  const material = new NodeMaterial();
  material.name = "Temporal AA history resolve";
  material.fragmentNode = Fn(() => {
    const size = vec2(resolve.size(int(0)) as Node<"uvec2">);
    const base = ivec2(uv().mul(size).sub(1.5).floor());
    const sum = vec4(0).toVar();
    const weightSum = float(0).toVar();
    const samples: Node<"vec4">[] = [];
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const at = ivec2(vec2(base.add(ivec2(x, y))).clamp(vec2(0), size.sub(1)));
        const colour = (resolve.load(at).max(0) as Node<"vec4">).toVar();
        const hdr = float(1).div(colour.r.add(colour.g.mul(2)).add(colour.b).add(4));
        const weight = hdr.mul((weights[x] ?? 0) * (weights[y] ?? 0));
        sum.addAssign(colour.mul(weight));
        weightSum.addAssign(weight);
        samples.push(colour);
      }
    // The range starts from a real sample: WGSL has no infinity literal.
    const low = samples.reduce((a, b) => min(a, b));
    const high = samples.reduce((a, b) => max(a, b));
    return sum.div(weightSum).clamp(low, high);
  })();
  return material;
}

/** The display-sized target the chain reads in place of a 2x history, and its resolve draw. */
export function createHistoryPresent(internals: ITemporalAANode, quadMesh: QuadMesh) {
  const target = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
  const material = createHistoryResolve(texture(internals._resolveRenderTarget.texture));
  return {
    draw(renderer: Renderer, display: Vector2): void {
      if (target.width !== display.x || target.height !== display.y) {
        target.setSize(display.x, display.y);
        renderer.initRenderTarget(target);
      }
      internals._textureNode.value = target.texture;
      renderer.setRenderTarget(target);
      quadMesh.material = material;
      quadMesh.render(renderer);
    },
    dispose(): void {
      target.dispose();
      material.dispose();
    },
  };
}
