// Generated for you: Unreal's bilateral local exposure; exposure.ts owns the metering, this file
// owns how much each pixel departs from the global exposure.
//
// The model follows Unreal Engine 5.8.3, the default `Bilateral` local exposure method:
//   Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessLocalExposure.cpp (the passes),
//   Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessHistogram.cpp (the grid),
//   Engine/Shaders/Private/PostProcessHistogram.usf (BILATERAL_GRID: weight and log luminance per
//     grid cell and bin),
//   Engine/Shaders/Private/PostProcessHistogramCommon.ush (CalculateBaseLogLuminance,
//     CalculateLogLocalExposure) and Engine/Shaders/Private/PostProcessTonemap.usf (where the
//     gain multiplies the exposed colour).
// Defaults: Engine/Source/Runtime/Engine/Private/Scene.cpp (LocalExposure*). The reference
// project sets the highlight and shadow contrast scales to 0.8
// (tools/unreal-reference/Config/DefaultEngine.ini), the others stay at the engine default.
//
// Per pixel: the base luminance is a blend of a depth-aware grid lookup and a blurred copy of
// the log luminance; the gain pulls the base toward middle grey by the contrast scale and
// keeps the detail above the base.
import {
  HalfFloatType,
  FloatType,
  LinearFilter,
  NearestFilter,
  RenderTarget,
  Vector2,
} from "three";
import {
  Fn,
  If,
  Loop,
  float,
  mix,
  nodeObject,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
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
import { exposureMeter, exposureSettings } from "./exposure.js";

type ColourTexture = ReturnType<typeof texture>;

/** The look: change a number here, not the passes below. */
export const localExposureSettings = {
  /** Scale on how far a bright base sits above middle grey; 1 leaves the global exposure alone. */
  highlightContrastScale: 0.8,
  /** The same for a dark base. */
  shadowContrastScale: 0.8,
  /** 1 keeps all the detail above the local base. */
  detailStrength: 1,
  /** 0 uses only the depth-aware grid for the base, 1 only the blurred luminance. */
  blurredLuminanceBlend: 0.6,
  /** Middle grey after the global exposure bias; the global key is the same number. */
  middleGrey: exposureSettings.key,
} as const;

/** Unreal's histogram range, in log2 luminance: Scene.cpp extended default luminance range. */
const LOG_MIN = -10;
const LOG_SPAN = 30;
/** BILATERAL_GRID_DEPTH in PostProcessHistogramCommon.ush: bins of log luminance per cell. */
const DEPTH = 32;
/** A grid cell is 8x8 threads times 8x8 texels each of the half resolution image. */
const CELL = 64;
/** Gaussian taps either side: the unrolled loop's 32 samples (r.Filter.LoopMode 0) cap the radius. */
const BLUR_RADIUS = 31;
/** PostProcessWeightedSampleSum.cpp LegacyCompatibilityConstant. */
const BLUR_SHAPE = -16.7;

function scratch(type: typeof FloatType | typeof HalfFloatType, linear: boolean): RenderTarget {
  return new RenderTarget(1, 1, {
    type,
    minFilter: linear ? LinearFilter : NearestFilter,
    magFilter: linear ? LinearFilter : NearestFilter,
    depthBuffer: false,
  });
}

/** The unit-interval coordinate mirrored back inside [0, 1] (the blur's mirror address mode). */
function mirror(u: Node<"float">): Node<"float"> {
  return u.mod(2).sub(1).abs().oneMinus();
}

/** Owns scratch targets only. Never draws the world or installs another output transform. */
export class LocalExposureNode extends TempNode<"float"> {
  static get type(): string {
    return "LocalExposureNode";
  }
  readonly input: ColourTexture;
  readonly #exposure: Node<"float">;
  readonly #size = new Vector2();
  readonly #full = uniform(new Vector2(1, 1));
  readonly #half = uniform(new Vector2(1, 1));
  readonly #grid = uniform(new Vector2(1, 1));
  readonly #cells = uniform(new Vector2(1, 1));
  readonly #quad = new QuadMesh();
  readonly #logMaterial = new NodeMaterial();
  readonly #blurXMaterial = new NodeMaterial();
  readonly #blurYMaterial = new NodeMaterial();
  readonly #gridMaterial = new NodeMaterial();
  readonly #logTarget = scratch(FloatType, false);
  readonly #blurXTarget = scratch(FloatType, false);
  readonly #blurTarget = scratch(HalfFloatType, true);
  readonly #gridTarget = scratch(FloatType, false);
  readonly #logTexture = texture(this.#logTarget.texture);
  readonly #blurXTexture = texture(this.#blurXTarget.texture);
  readonly #blurTexture = texture(this.#blurTarget.texture);
  readonly #gridTexture = texture(this.#gridTarget.texture);
  // Three's runtime accepts undefined on first use, but its declaration requires a state.
  #rendererState: Parameters<typeof RendererUtils.resetRendererState>[1] | undefined;
  #disposed = false;

  constructor(input: ColourTexture, exposure: Node<"float">) {
    super("float");
    this.input = input;
    this.#exposure = exposure;
    this.updateBeforeType = NodeUpdateType.FRAME;
    const half = this.#half;
    const kernel = Array.from({ length: 2 * BLUR_RADIUS + 1 }, (_, i) =>
      Math.exp(BLUR_SHAPE * ((i - BLUR_RADIUS) / BLUR_RADIUS) ** 2),
    );
    const kernelSum = kernel.reduce((sum, value) => sum + value, 0);

    // Pass 1: log2 luminance of the half resolution image (a 2x2 average of colour).
    this.#logMaterial.fragmentNode = Fn(() => {
      const c = uv();
      const texel = vec2(0.5).div(this.#full);
      const sum = vec3(0).toVar();
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const)
        sum.addAssign(input.sample(c.add(texel.mul(vec2(x, y)))).rgb);
      const luminance = exposureMeter(vec4(sum.div(4), 1), c).x.max(2 ** LOG_MIN);
      return vec4(luminance.log2(), 0, 0, 1);
    })();

    // Passes 2 and 3: the Gaussian of the log luminance, one axis each, mirror addressed.
    const blur = (source: ColourTexture, axis: 0 | 1): Node<"vec4"> =>
      Fn(() => {
        const c = uv();
        const step = float(1).div(axis === 0 ? half.x : half.y);
        const sum = float(0).toVar();
        Loop(2 * BLUR_RADIUS + 1, ({ i }) => {
          const offset = float(i).sub(BLUR_RADIUS);
          const t = offset.div(BLUR_RADIUS);
          const weight = t.mul(t).mul(BLUR_SHAPE).exp();
          const along = mirror((axis === 0 ? c.x : c.y).add(offset.mul(step)));
          const at = axis === 0 ? vec2(along, c.y) : vec2(c.x, along);
          sum.addAssign(source.sample(at).level(0).r.mul(weight));
        });
        return vec4(sum.div(kernelSum), 0, 0, 1);
      })();
    this.#blurXMaterial.fragmentNode = blur(this.#logTexture, 0);
    this.#blurYMaterial.fragmentNode = blur(this.#blurXTexture, 1);

    // Pass 4: the bilateral grid. Texel (cell x * DEPTH + bin, cell y) holds the summed weight
    // and weighted log luminance of the half resolution texels in that cell, each texel shared
    // between its two nearest bins by linear weights (PostProcessHistogram.usf).
    this.#gridMaterial.fragmentNode = Fn(() => {
      const c = uv();
      const column = c.x.mul(this.#grid.x).floor();
      const row = c.y.mul(this.#grid.y).floor();
      const cell = column.div(DEPTH).floor();
      const bin = column.sub(cell.mul(DEPTH));
      const weight = float(0).toVar();
      const logSum = float(0).toVar();
      Loop(CELL * CELL, ({ i }) => {
        const x = cell.mul(CELL).add(float(i).mod(CELL));
        const y = row.mul(CELL).add(float(i).div(CELL).floor());
        If(x.lessThan(half.x).and(y.lessThan(half.y)), () => {
          const log = this.#logTexture
            .sample(vec2(x.add(0.5).div(half.x), y.add(0.5).div(half.y)))
            .level(0).r;
          const position = log
            .sub(LOG_MIN)
            .div(LOG_SPAN)
            .clamp(0, 1)
            .mul(DEPTH - 1);
          const share = position.sub(bin).abs().oneMinus().max(0);
          weight.addAssign(share);
          logSum.addAssign(share.mul(log));
        });
      });
      return vec4(logSum, weight, 0, 1);
    })();
  }

  override setup(builder: NodeBuilder): Node<"float"> {
    // Force the existing pass dependency, as the exposure node does.
    super.setup(builder);
    const settings = localExposureSettings;
    const c = uv();
    const rgb = this.input.rgb;
    const log = exposureMeter(vec4(rgb, 1), c)
      .x.max(2 ** LOG_MIN)
      .log2();
    const logExposure = this.#exposure.log2();

    // Trilinear lookup of the grid at this pixel and this pixel's luminance bin.
    const cells = this.#cells;
    const gridSize = this.#grid;
    const gx = c.x.mul(this.#half.x.div(CELL)).sub(0.5).clamp(0, cells.x.sub(1));
    const gy = c.y.mul(this.#half.y.div(CELL)).sub(0.5).clamp(0, cells.y.sub(1));
    const gz = log
      .sub(LOG_MIN)
      .div(LOG_SPAN)
      .clamp(0, 1)
      .mul(DEPTH - 1);
    const x0 = gx.floor();
    const y0 = gy.floor();
    const z0 = gz.floor();
    const fx = gx.sub(x0);
    const fy = gy.sub(y0);
    const fz = gz.sub(z0);
    const fetch = (dx: number, dy: number, dz: number): Node<"vec2"> => {
      const x = x0.add(dx).min(cells.x.sub(1));
      const y = y0.add(dy).min(cells.y.sub(1));
      const z = z0.add(dz).min(DEPTH - 1);
      return this.#gridTexture
        .sample(vec2(x.mul(DEPTH).add(z).add(0.5).div(gridSize.x), y.add(0.5).div(gridSize.y)))
        .level(0).rg;
    };
    let grid: Node<"vec2"> = vec2(0);
    for (const dz of [0, 1])
      for (const dy of [0, 1])
        for (const dx of [0, 1]) {
          const weight = (dx ? fx : fx.oneMinus())
            .mul(dy ? fy : fy.oneMinus())
            .mul(dz ? fz : fz.oneMinus());
          grid = grid.add(fetch(dx, dy, dz).mul(weight));
        }
    const blurred = this.#blurTexture.sample(c).level(0).r;
    // A cell with no samples (the grid is built from the half resolution image) uses the blur.
    const bilateral = grid.y.lessThan(0.001).select(blurred, grid.x.div(grid.y.max(0.001)));
    const base = mix(bilateral, blurred, settings.blurredLuminanceBlend).add(logExposure);

    const middleGrey = Math.log2(settings.middleGrey);
    const centred = base.sub(middleGrey);
    const contrast = centred
      .greaterThan(0)
      .select(settings.highlightContrastScale, settings.shadowContrastScale);
    // The highlight and shadow thresholds are off at their defaults (strength 1 in Scene.cpp), so
    // the gain is the contrast pull plus the detail above the base, minus the pixel itself.
    const logGain = centred
      .mul(contrast)
      .add(log.add(logExposure).sub(base).mul(settings.detailStrength))
      .add(middleGrey)
      .sub(log.add(logExposure));
    return logGain.exp2();
  }

  get gainNode(): Node<"float"> {
    return nodeObject(this);
  }

  override updateBefore(frame: NodeFrame): undefined {
    if (this.#disposed) throw new Error("Local exposure node is disposed.");
    const renderer = frame.renderer;
    if (renderer === null) throw new Error("Local exposure requires a renderer.");
    renderer.getDrawingBufferSize(this.#size);
    this.#full.value.copy(this.#size);
    const halfWidth = Math.max(1, Math.ceil(this.#size.x / 2));
    const halfHeight = Math.max(1, Math.ceil(this.#size.y / 2));
    const cellsX = Math.ceil(halfWidth / CELL);
    const cellsY = Math.ceil(halfHeight / CELL);
    this.#half.value.set(halfWidth, halfHeight);
    this.#cells.value.set(cellsX, cellsY);
    this.#grid.value.set(cellsX * DEPTH, cellsY);
    this.#logTarget.setSize(halfWidth, halfHeight);
    this.#blurXTarget.setSize(halfWidth, halfHeight);
    this.#blurTarget.setSize(halfWidth, halfHeight);
    this.#gridTarget.setSize(cellsX * DEPTH, cellsY);
    this.#rendererState ??= RendererUtils.saveRendererState(renderer);
    this.#rendererState = RendererUtils.resetRendererState(renderer, this.#rendererState);
    try {
      for (const [material, target] of [
        [this.#logMaterial, this.#logTarget],
        [this.#blurXMaterial, this.#blurXTarget],
        [this.#blurYMaterial, this.#blurTarget],
        [this.#gridMaterial, this.#gridTarget],
      ] as const) {
        this.#quad.material = material;
        renderer.setRenderTarget(target);
        this.#quad.render(renderer);
      }
    } finally {
      RendererUtils.restoreRendererState(renderer, this.#rendererState);
    }
  }

  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const target of [this.#logTarget, this.#blurXTarget, this.#blurTarget, this.#gridTarget])
      target.dispose();
    for (const material of [
      this.#logMaterial,
      this.#blurXMaterial,
      this.#blurYMaterial,
      this.#gridMaterial,
    ])
      material.dispose();
    super.dispose();
  }
}
