// Generated for you: Unreal's standard bloom; the look is the numbers at the top.
//
// The model is Unreal Engine 5.8.3's sum-of-Gaussians bloom with the default quality (all six
// stages), with no threshold:
//   Engine/Source/Runtime/Engine/Private/Scene.cpp (BloomIntensity, BloomGaussianIntensity,
//     BloomSizeScale, Bloom1..6 Size and Tint; BloomThreshold -1 turns the threshold off),
//   Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessBloomSetup.cpp
//     (AddGaussianBloomPasses: stage sizes, tints, the 1/6 tint scale, the chain index of each stage),
//   Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessWeightedSampleSum.cpp
//     (the Gaussian: radius, the 31 texel cap of the unrolled loop, the weight shape),
//   Engine/Shaders/Private/PostProcessTonemap.usf (the bloom is added to the exposed scene).
// The whole frame blooms, linearly. A bright source only spreads as much light as it carries.
//
// Each stage blurs one level of the downsample chain (stage 6 the 1/64 level, stage 1 the 1/2 level)
// and adds the stage below it, upsampled, so the result is at half resolution.
//
// The cost follows Unreal's: PostProcessWeightedSampleSum.cpp (Compute1DGaussianFilterKernel, the
// bilinear optimisation) reads two texels with one tap, so a radius of R texels takes R + 1 taps per
// axis, and the loop runs only that many. A fixed 63 tap loop cost about 10 ms of GPU at 1080p.
import { HalfFloatType, LinearFilter, RenderTarget, Vector2 } from "three";
import { Fn, Loop, float, nodeObject, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import {
  type Node,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  TempNode,
} from "three/webgpu";

type ColourTexture = ReturnType<typeof texture>;

/** The look: Scene.cpp defaults. Stage 1 is the tightest, stage 6 the widest. */
const unrealBloomSettings = {
  intensity: 0.675,
  gaussianIntensity: 1,
  /** Every stage size is multiplied by this (a percent of the stage's own image width). */
  sizeScale: 4,
  sizes: [0.3, 1, 2, 10, 30, 64],
  tints: [0.3465, 0.138, 0.1176, 0.066, 0.066, 0.061],
} as const;

/** PostProcessWeightedSampleSum.cpp: MAX_FILTER_COMPILE_TIME_SAMPLES 32 caps the radius at 31 texels. */
const MAX_RADIUS = 31;
/** The same file's LegacyCompatibilityConstant. */
const SHAPE = -16.7;
const STAGES = 6;

function scratch(): RenderTarget {
  return new RenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
}

/** The radius in texels of one stage's Gaussian on an image `width` texels wide (GetBlurRadius). */
function bloomRadius(width: number, size: number): number {
  const radius = width * size * unrealBloomSettings.sizeScale * 0.01 * 0.5;
  return Math.min(Math.max(radius, 1e-4), MAX_RADIUS);
}

/** The chain level (1 = half resolution) of the stage with this size index. Stage 1 is level 1. */
const levelSize = (extent: number, level: number): number =>
  Math.max(1, Math.ceil(extent / 2 ** level));

export interface IBloomStageSize {
  /** Chain level this stage blurs. */
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  /** Bilinear taps per axis: the loop count. */
  readonly taps: number;
}

/** The six stages, widest (level 6) first, for a drawing buffer of `width` by `height`. */
function bloomSchedule(width: number, height: number): IBloomStageSize[] {
  const { sizes } = unrealBloomSettings;
  return Array.from({ length: STAGES }, (_, order) => {
    const index = STAGES - 1 - order;
    const level = index + 1;
    const w = levelSize(width, level);
    const radius = bloomRadius(w, sizes[index] ?? 0);
    return {
      level,
      width: w,
      height: levelSize(height, level),
      radius,
      taps: Math.min(Math.ceil(radius), MAX_RADIUS) + 1,
    };
  });
}

interface IStage {
  readonly size: number;
  readonly tint: number;
  /** Chain level (1 = half resolution) this stage blurs. */
  readonly level: number;
  readonly source: ColourTexture;
  readonly across: RenderTarget;
  readonly out: RenderTarget;
  readonly acrossMaterial: NodeMaterial;
  readonly outMaterial: NodeMaterial;
  readonly radius: ReturnType<typeof uniform<"float">>;
  /** ceil(radius), the kernel's integer reach. */
  readonly reach: ReturnType<typeof uniform<"float">>;
  readonly taps: ReturnType<typeof uniform<"int">>;
  readonly norm: ReturnType<typeof uniform<"float">>;
  readonly texel: ReturnType<typeof uniform<"vec2">>;
}

/** Owns scratch targets only. Never draws the world or installs another output transform. */
export class UnrealBloomNode extends TempNode<"vec3"> {
  static get type(): string {
    return "UnrealBloomNode";
  }
  /** The stages for a drawing buffer of `width` by `height`: the raster each blurs and the taps it loops. */
  static readonly schedule = bloomSchedule;
  readonly input: ColourTexture;
  readonly #size = new Vector2();
  readonly #quad = new QuadMesh();
  readonly #downMaterials: NodeMaterial[] = [];
  readonly #downTargets: RenderTarget[] = [];
  readonly #downTextures: ColourTexture[] = [];
  readonly #downTexel = Array.from({ length: STAGES }, () => uniform(new Vector2(1, 1)));
  readonly #stages: IStage[] = [];
  readonly #result: ColourTexture;
  // Three's runtime accepts undefined on first use, but its declaration requires a state.
  #rendererState: Parameters<typeof RendererUtils.resetRendererState>[1] | undefined;
  #disposed = false;

  constructor(input: ColourTexture) {
    super("vec3");
    this.input = input;
    this.updateBeforeType = NodeUpdateType.FRAME;
    // Downsample chain: each level is a 2x reduction with four bilinear taps (a 4x4 tent).
    for (let level = 1; level <= STAGES; level++) {
      const target = scratch();
      this.#downTargets.push(target);
      this.#downTextures.push(texture(target.texture));
      const source = level === 1 ? input : (this.#downTextures[level - 2] as ColourTexture);
      const step = this.#downTexel[level - 1] as ReturnType<typeof uniform<"vec2">>;
      const material = new NodeMaterial();
      material.fragmentNode = Fn(() => {
        const c = uv();
        const sum = vec3(0).toVar();
        for (const [x, y] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const)
          sum.addAssign(source.sample(c.add(step.mul(vec2(x, y)))).rgb);
        return vec4(sum.div(4), 1);
      })();
      this.#downMaterials.push(material);
    }
    // Stage 1 is Bloom1 (tightest, level 1); stage 6 is Bloom6 (widest, level 6). Unreal runs them
    // widest first, each adding the one before it.
    const { sizes, tints, intensity, gaussianIntensity } = unrealBloomSettings;
    const tintScale = (1 / STAGES) * intensity * gaussianIntensity;
    let previous: ColourTexture | undefined;
    for (let order = 0; order < STAGES; order++) {
      const stageIndex = STAGES - 1 - order;
      const level = stageIndex + 1;
      const across = scratch();
      const out = scratch();
      const radius = uniform(1);
      const reach = uniform(1);
      const taps = uniform(1, "int");
      const norm = uniform(1);
      const texel = uniform(new Vector2(1, 1));
      const downSource = this.#downTextures[level - 1] as ColourTexture;
      const acrossTexture = texture(across.texture);
      const additive = previous;
      const blur = (source: ColourTexture, axis: 0 | 1, tint: number, add?: ColourTexture) =>
        Fn(() => {
          const c = uv();
          const sum = vec3(0).toVar();
          // Tap k pairs texels at -reach + 2k and one further (Compute1DGaussianFilterKernel).
          Loop({ start: 0, end: taps, type: "int" }, ({ i }) => {
            const first = float(i).mul(2).sub(reach);
            const w0 = first.div(radius).pow(2).mul(SHAPE).exp();
            const w1 = first
              .lessThan(reach)
              .select(first.add(1).div(radius).pow(2).mul(SHAPE).exp(), float(0));
            const weight = w0.add(w1);
            const offset = first.add(w1.div(weight));
            const at =
              axis === 0
                ? c.add(vec2(offset.mul(texel.x), 0))
                : c.add(vec2(0, offset.mul(texel.y)));
            sum.addAssign(source.sample(at).level(float(0)).rgb.mul(weight));
          });
          const blurred = sum.mul(norm.mul(tint));
          return vec4(
            add === undefined ? blurred : blurred.add(add.sample(c).level(float(0)).rgb),
            1,
          );
        })();
      const acrossMaterial = new NodeMaterial();
      acrossMaterial.fragmentNode = blur(downSource, 0, 1);
      const outMaterial = new NodeMaterial();
      outMaterial.fragmentNode = blur(
        acrossTexture,
        1,
        (tints[stageIndex] ?? 0) * tintScale,
        additive,
      );
      this.#stages.push({
        size: sizes[stageIndex] ?? 0,
        tint: tints[stageIndex] ?? 0,
        level,
        source: downSource,
        across,
        out,
        acrossMaterial,
        outMaterial,
        radius,
        reach,
        taps,
        norm,
        texel,
      });
      previous = texture(out.texture);
    }
    this.#result = previous as ColourTexture;
  }

  override setup(builder: NodeBuilder): Node<"vec3"> {
    // Force the existing pass dependency, as the exposure node does. The input must be in the graph
    // so its own render runs before this node's passes (a zero weight keeps it out of the image).
    super.setup(builder);
    return this.#result.sample(uv()).rgb.add(this.input.rgb.mul(0));
  }

  get bloomNode(): Node<"vec3"> {
    return nodeObject(this);
  }

  override updateBefore(frame: NodeFrame): undefined {
    if (this.#disposed) throw new Error("Bloom node is disposed.");
    const renderer = frame.renderer;
    if (renderer === null) throw new Error("Bloom requires a renderer.");
    renderer.getDrawingBufferSize(this.#size);
    const sizeAt = (level: number): [number, number] => [
      levelSize(this.#size.x, level),
      levelSize(this.#size.y, level),
    ];
    for (const [i, target] of this.#downTargets.entries()) {
      const [w, h] = sizeAt(i + 1);
      target.setSize(w, h);
      const [pw, ph] = i === 0 ? [this.#size.x, this.#size.y] : sizeAt(i);
      this.#downTexel[i]?.value.set(0.5 / pw, 0.5 / ph);
    }
    const schedule = bloomSchedule(this.#size.x, this.#size.y);
    for (const [order, stage] of this.#stages.entries()) {
      const { width: w, height: h, radius, taps } = schedule[order] as IBloomStageSize;
      stage.across.setSize(w, h);
      stage.out.setSize(w, h);
      stage.radius.value = Math.max(radius, 1e-4);
      stage.reach.value = taps - 1;
      stage.taps.value = taps;
      stage.texel.value.set(1 / w, 1 / h);
      let total = 0;
      for (let o = -(taps - 1); o <= taps - 1; o++)
        total += Math.exp(SHAPE * (o / stage.radius.value) ** 2);
      stage.norm.value = 1 / total;
    }
    this.#rendererState ??= RendererUtils.saveRendererState(renderer);
    this.#rendererState = RendererUtils.resetRendererState(renderer, this.#rendererState);
    try {
      for (const [i, target] of this.#downTargets.entries()) {
        this.#quad.material = this.#downMaterials[i] as NodeMaterial;
        renderer.setRenderTarget(target);
        this.#quad.render(renderer);
      }
      for (const stage of this.#stages) {
        this.#quad.material = stage.acrossMaterial;
        renderer.setRenderTarget(stage.across);
        this.#quad.render(renderer);
        this.#quad.material = stage.outMaterial;
        renderer.setRenderTarget(stage.out);
        this.#quad.render(renderer);
      }
    } finally {
      RendererUtils.restoreRendererState(renderer, this.#rendererState);
    }
  }

  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const target of this.#downTargets) target.dispose();
    for (const material of this.#downMaterials) material.dispose();
    for (const stage of this.#stages) {
      stage.across.dispose();
      stage.out.dispose();
      stage.acrossMaterial.dispose();
      stage.outMaterial.dispose();
    }
    super.dispose();
  }
}
