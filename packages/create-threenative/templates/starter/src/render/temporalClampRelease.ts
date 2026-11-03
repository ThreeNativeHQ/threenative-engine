// Generated user source: Unreal TSR's low-frequency clamp release (PRD-539 lever 6). The per-pixel clip
// to the input's 3x3 box erases detail finer than an input texel. Unreal compares input and history only
// after a 3x3 blur, and where they agree it lerps the clamped history back to the unclamped one, so
// sub-texel detail the history gathered survives; disocclusion still forces the clamp.
// UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRShadingAnalysis.ush:25,509-525,563-566,
// 589-620,632-636; TSRRejectShading.usf:863; TSRUpdateHistory.usf:1256-1257; TSRColorSpace.ush:244-248.
import { HalfFloatType, NearestFilter } from "three";
import { Fn, float, int, ivec2, max, min, mix, texture, uv, vec2, vec3, vec4 } from "three/tsl";
import {
  type Node,
  NodeMaterial,
  type QuadMesh,
  RenderTarget,
  type Renderer,
  type TextureNode,
} from "three/webgpu";
import type { TemporalMoire } from "./temporalMoire.js";
import type { TemporalDepthRejection, TemporalResolveNode } from "./temporalResolveDepth.js";

// Unreal's 3x3 blur: centre 1, edges 0.5, corners 0.25, normalised by their sum.
const FILTERING_WEIGHT = 1 / (1 + 4 * 0.5 + 4 * 0.25);
// A 10-bit backbuffer's half step.
const QUANTIZATION = 0.5 / 1024;
const TAPS = [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => [x, y] as const));

type Load = (at: Node<"ivec2">) => Node<"vec4">;

/** Clamped integer taps around this fragment's input pixel. */
function taps(size: Node<"vec2">, load: Load): Node<"vec4">[] {
  const centre = ivec2(uv().mul(size));
  return TAPS.map(([x, y]) =>
    load(ivec2(vec2(centre.add(ivec2(x, y))).clamp(vec2(0), size.sub(1)))),
  );
}

const blur = (values: Node<"vec4">[]) =>
  values.reduce<Node<"vec4">>((sum, value, index) => {
    const [x, y] = TAPS[index] ?? [0, 0];
    return sum.add(value.mul(FILTERING_WEIGHT * 0.5 ** (Math.abs(x) + Math.abs(y))));
  }, vec4(0));

/** Median of nine by the 19-exchange network; every step is a min/max pair. */
function median(values: Node<"float">[]): Node<"float"> {
  const v = [...values];
  const sort = (a: number, b: number) => {
    const low = min(v[a] as Node<"float">, v[b] as Node<"float">);
    v[b] = max(v[a] as Node<"float">, v[b] as Node<"float">);
    v[a] = low;
  };
  for (const [a, b] of "12 45 78 01 34 67 12 45 78 03 58 47 36 14 25 47 42 64 42".split(" "))
    sort(Number(a), Number(b));
  return v[4] as Node<"float">;
}

function quad(name: string, fragment: () => Node<"vec4">): NodeMaterial {
  const material = new NodeMaterial();
  material.name = `Temporal AA clamp release ${name}`;
  material.fragmentNode = Fn(fragment)();
  return material;
}

/** With `moire` (lever 4), the moire error widens the comparison, as in Unreal (TSRShadingAnalysis.ush:569-613). */
export function createTemporalClampRelease(node: TemporalResolveNode, moire?: TemporalMoire) {
  const [guide, filteredInput, filteredHistory, raw, filtered, release] = [0, 1, 2, 3, 4, 5].map(
    () => {
      const target = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
      target.texture.minFilter = NearestFilter;
      target.texture.magFilter = NearestFilter;
      return target;
    },
  ) as [RenderTarget, RenderTarget, RenderTarget, RenderTarget, RenderTarget, RenderTarget];
  const targets = [guide, filteredInput, filteredHistory, raw, filtered, release];
  const released: TextureNode = texture(release.texture);
  let passes:
    | { materials: [RenderTarget, NodeMaterial][]; equations: TemporalDepthRejection }
    | undefined;

  function build(equations: TemporalDepthRejection): [RenderTarget, NodeMaterial][] {
    const input = node.beautyNode as TextureNode;
    const history = texture(node._historyRenderTarget.texture);
    const size = () => vec2(input.size(int(0)) as Node<"uvec2">);
    const loader = (target: RenderTarget): Load => {
      const source = texture(target.texture);
      return (at) => source.load(at) as Node<"vec4">;
    };
    return [
      // Last frame's history at this frame's input pixels; alpha 0 where depth says disoccluded.
      [
        guide,
        quad("guide", () => {
          const validity = equations.historyValidity(uv());
          const colour = history.sample(validity.get("historyUV") as Node<"vec2">);
          return vec4(colour.rgb, validity.get("hasValidHistory") as Node<"float">);
        }),
      ],
      [
        filteredInput,
        quad("input blur", () => blur(taps(size(), (at) => input.load(at) as Node<"vec4">))),
      ],
      [filteredHistory, quad("history blur", () => blur(taps(size(), loader(guide))))],
      [
        raw,
        quad("rejection", () => {
          const s = size();
          const inputs = taps(s, (at) => input.load(at) as Node<"vec4">);
          const box = inputs.reduce((a, b) => max(a, b)).sub(inputs.reduce((a, b) => min(a, b)));
          const blurred = taps(s, loader(filteredInput));
          const historyBlur = taps(s, loader(filteredHistory))[4] as Node<"vec4">;
          const inputBlur = blurred[4] as Node<"vec4">;
          // ponytail: Unreal also widens by the blurred total variation of the input; add it if edges flip.
          const error = max(box.mul(FILTERING_WEIGHT * 0.25), QUANTIZATION).add(QUANTIZATION);
          let low = blurred.reduce((a, b) => min(a, b)).sub(error);
          let high = blurred.reduce((a, b) => max(a, b)).add(error);
          let boxSize = box.mul(FILTERING_WEIGHT).add(QUANTIZATION * 2 * FILTERING_WEIGHT);
          if (moire !== undefined) {
            const historyUV = equations.historyValidity(uv()).get("historyUV") as Node<"vec2">;
            const historySize = vec2(history.size(int(0)) as Node<"uvec2">);
            const moireError = moire.error(
              historyUV,
              uv().sub(historyUV).mul(historySize).length(),
            );
            const size = vec4(vec3(moireError.mul(3)), 0);
            [low, high] = [min(low, high.sub(size)), max(high, low.add(size))];
            const energy = historyBlur.clamp(low, high).sub(historyBlur).abs();
            const share = energy.div(max(energy.r.add(energy.g).add(energy.b), 1e-6));
            boxSize = max(boxSize, share.mul(moireError.mul(FILTERING_WEIGHT * 3)));
          }
          const delta = max(inputBlur.sub(historyBlur).abs(), boxSize);
          const factor = float(1)
            .sub(historyBlur.clamp(low, high).sub(historyBlur).abs().div(delta))
            .saturate();
          return vec4(min(factor.r, factor.g, factor.b));
        }),
      ],
      [filtered, quad("median", () => vec4(median(taps(size(), loader(raw)).map((v) => v.x))))],
      // ponytail: no velocity-edge term (Unreal's InputUncertainty); add it if edges of movers ghost.
      [
        release,
        quad("min", () => {
          const guideValid = (texture(guide.texture).load(ivec2(uv().mul(size()))) as Node<"vec4">)
            .a;
          const lowest = taps(size(), loader(filtered)).reduce((a, b) => min(a, b)).x;
          return vec4(lowest.mul(guideValid.greaterThan(0.5).select(float(1), float(0))));
        }),
      ],
    ];
  }

  return {
    /** The clipped history lerped back towards the unclipped one where input and history agree. */
    apply(clipped: Node<"vec4">, history: Node<"vec4">, pixel: Node<"vec2">): Node<"vec4"> {
      return mix(clipped, history, released.sample(pixel).x);
    },
    /** Before the resolve: it reads this frame's input against last frame's history. */
    update(
      renderer: Renderer,
      quadMesh: QuadMesh,
      equations: TemporalDepthRejection,
      input: { x: number; y: number },
    ) {
      for (const target of targets)
        if (target.width !== input.x || target.height !== input.y) {
          target.setSize(input.x, input.y);
          renderer.initRenderTarget(target);
        }
      if (passes?.equations !== equations) {
        for (const [, material] of passes?.materials ?? []) material.dispose();
        passes = { materials: build(equations), equations };
      }
      for (const [target, material] of passes.materials) {
        renderer.setRenderTarget(target);
        quadMesh.material = material;
        quadMesh.render(renderer);
      }
    },
    dispose() {
      for (const target of targets) target.dispose();
      for (const [, material] of passes?.materials ?? []) material.dispose();
    },
  };
}

export type TemporalClampRelease = ReturnType<typeof createTemporalClampRelease>;
