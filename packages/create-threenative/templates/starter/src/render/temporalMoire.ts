// Generated user source: Unreal TSR's flicker-aware shading rejection (PRD-539 lever 4). A pixel whose
// output luma keeps changing direction against what plain ghosting would give is moire, not new
// shading, so its clip box widens by a bounded luma error and its history survives instead of resetting.
// UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRShadingAnalysis.ush:225-229,263-271,
// 381-455,477-490,586-593; the 2-frame period and the 0.95 decay come from
// Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp:177-193,3005-3007.
import { HalfFloatType, NearestFilter, type Vector2 } from "three";
import {
  Fn,
  abs,
  float,
  int,
  ivec2,
  max,
  min,
  mix,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  type Node,
  NodeMaterial,
  type QuadMesh,
  RenderTarget,
  type Renderer,
  type TextureNode,
} from "three/webgpu";
import type { TemporalDepthRejection, TemporalResolveNode } from "./temporalResolveDepth.js";

const DECAY = 0.95;
const PERIOD = 2;
const MIN_GRADIENT = 1 / 127;
const LUMA_TO_CHANNEL = 3;
// Unreal's r.TSR.ShadingRejection.Flickering.MaxParallaxVelocity, in pixels of a 1920-wide output.
const MAX_PARALLAX_PX = 10;

/** Perceptual luma: the mean of the square-root channels (Unreal stores flicker luma in gamma space). */
const luma = (colour: Node<"vec4">) =>
  colour.rgb
    .max(0)
    .sqrt()
    .dot(vec3(1 / 3));

/** 1 where the pixel holds still, 0 where it moves. Unreal separates parallax from rotation; this
 * counts every motion, so a rotating camera widens fewer boxes than Unreal does. */
function stillness(speedPx: Node<"float">, displayWidth: Node<"float">) {
  const limit = displayWidth.mul(MAX_PARALLAX_PX / 1920);
  return float(1).sub(speedPx.div(limit).sub(0.5).saturate());
}

export function createTemporalMoire(node: TemporalResolveNode) {
  const targets = [0, 1, 2].map(() => {
    const target = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    target.texture.minFilter = NearestFilter;
    target.texture.magFilter = NearestFilter;
    return target;
  });
  const [first, , scratch] = targets as [RenderTarget, RenderTarget, RenderTarget];
  let read = 0;
  // x: last luma gradient, y: total flicker variation, z: flicker count. Both decay by 0.95 a frame.
  const previous: TextureNode = texture(first.texture);
  let passes: { materials: NodeMaterial[]; equations: TemporalDepthRejection } | undefined;

  /** The moire luma error the history has measured at this pixel. `speedPx` counts history pixels,
   * so the parallax limit scales with the history raster. */
  function error(historyUV: Node<"vec2">, speedPx: Node<"float">): Node<"float"> {
    const state = previous.sample(historyUV);
    const count = state.z;
    const ramp = count
      .mul(1 - DECAY ** PERIOD)
      .sub(0.5)
      .saturate();
    return abs(state.y.div(max(count, 1e-4)))
      .add(count.div(127))
      .mul(ramp)
      .mul(stillness(speedPx, vec2(previous.size(int(0)) as Node<"uvec2">).x))
      .saturate();
  }

  /** The clip box widened by that error. */
  function widen(
    low: Node<"vec4">,
    high: Node<"vec4">,
    historyUV: Node<"vec2">,
    speedPx: Node<"float">,
  ) {
    const size = vec4(vec3(error(historyUV, speedPx).mul(LUMA_TO_CHANNEL)), 0);
    return { low: min(low, high.sub(size)), high: max(high, low.add(size)) };
  }

  /** Pass 1, per pixel: this frame's gradient, and whether it turned against the last one. */
  function detect(equations: TemporalDepthRejection): NodeMaterial {
    const resolved = texture(node._resolveRenderTarget.texture);
    const history = texture(node._historyRenderTarget.texture);
    const result = new NodeMaterial();
    result.name = "Temporal AA moire detect";
    result.fragmentNode = Fn(() => {
      const pixel = uv();
      const validity = equations.historyValidity(pixel);
      const historyUV = validity.get("historyUV") as Node<"vec2">;
      const last = previous.sample(historyUV).x;
      // What the output did against pure ghosting (5% current), clamped like Unreal's gradient.
      const ghost = mix(
        luma(history.sample(historyUV)),
        luma((node.beautyNode as TextureNode).sample(pixel)),
        0.05,
      );
      const gradient = luma(resolved.sample(pixel)).sub(ghost).clamp(-1, 1);
      const turned = gradient.mul(last).lessThan(0);
      const strong = min(abs(gradient), abs(last)).greaterThanEqual(MIN_GRADIENT);
      const flicker = turned
        .and(strong)
        .select(float(1), float(0))
        .mul(validity.get("hasValidHistory") as Node<"float">);
      return vec4(gradient, min(abs(gradient), abs(last)).mul(flicker), flicker, 1);
    })();
    return result;
  }

  /** Pass 2: the flicker and its variation dilated over 5x5 (Unreal's max3x3 of max3x3), then
   * accumulated into the decayed state of still, valid pixels. */
  function accumulate(equations: TemporalDepthRejection): NodeMaterial {
    const detected = texture(scratch.texture);
    const result = new NodeMaterial();
    result.name = "Temporal AA moire accumulate";
    result.fragmentNode = Fn(() => {
      const pixel = uv();
      const validity = equations.historyValidity(pixel);
      const historyUV = validity.get("historyUV") as Node<"vec2">;
      const size = vec2(previous.size(int(0)) as Node<"uvec2">);
      const centre = ivec2(pixel.mul(size));
      let peak: Node<"vec4"> = detected.load(centre) as Node<"vec4">;
      for (let y = -2; y <= 2; y++)
        for (let x = -2; x <= 2; x++)
          if (x !== 0 || y !== 0) {
            const at = ivec2(vec2(centre.add(ivec2(x, y))).clamp(vec2(0), size.sub(1)));
            peak = max(peak, detected.load(at) as Node<"vec4">);
          }
      const state = previous.sample(historyUV);
      const speed = pixel.sub(historyUV).mul(size).length();
      const valid = validity.get("hasValidHistory") as Node<"float">;
      const keep = stillness(speed, size.x).mul(valid).mul(DECAY);
      const own = detected.load(centre) as Node<"vec4">;
      return vec4(own.x, state.y.mul(keep).add(peak.y), state.z.mul(keep).add(peak.z), 1);
    })();
    return result;
  }

  return {
    error,
    widen,
    /** After the resolve, before the history copy: it reads last frame's history at this frame's UVs. */
    update(
      renderer: Renderer,
      quadMesh: QuadMesh,
      equations: TemporalDepthRejection,
      history: Vector2,
    ) {
      for (const target of targets)
        if (target.width !== history.x || target.height !== history.y) {
          target.setSize(history.x, history.y);
          renderer.initRenderTarget(target);
        }
      if (passes?.equations !== equations) {
        for (const material of passes?.materials ?? []) material.dispose();
        passes = { materials: [detect(equations), accumulate(equations)], equations };
      }
      const write = targets[1 - read];
      const [detection, accumulation] = passes.materials;
      if (write === undefined || detection === undefined || accumulation === undefined) return;
      renderer.setRenderTarget(scratch);
      quadMesh.material = detection;
      quadMesh.render(renderer);
      renderer.setRenderTarget(write);
      quadMesh.material = accumulation;
      quadMesh.render(renderer);
      read = 1 - read;
      previous.value = write.texture;
    },
    dispose() {
      for (const target of targets) target.dispose();
      for (const material of passes?.materials ?? []) material.dispose();
    },
  };
}

export type TemporalMoire = ReturnType<typeof createTemporalMoire>;
