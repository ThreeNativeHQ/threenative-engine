import {
  FloatType,
  HalfFloatType,
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
  int,
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
  Node,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  type TextureNode,
} from "three/webgpu";
import { exposureMeter, exposureSettings } from "./exposure-settings.js";

type ColourTexture = TextureNode;

/** The look: change a number here, not the passes below. */
const localExposureSettings = {
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
/** Half resolution logs per log texel: neighbours along a row, so a row sum reads four with one tap. */
const PACK = 4;
/** Gaussian taps either side: the unrolled loop's 32 samples (r.Filter.LoopMode 0) cap the radius. */
const BLUR_RADIUS = 31;
/** PostProcessWeightedSampleSum.cpp LegacyCompatibilityConstant. */
const BLUR_SHAPE = -16.7;
/**
 * The blurred luminance reads SceneDownsampleChain mip 4, a sixteenth of the view (PostProcessing.cpp:1431-1434),
 * and blurs it there: a radius of 31 texels at that size spans a quarter of the view, as Unreal's does.
 */
const BLUR_DOWNSAMPLE = 16;
/** LocalExposureBlurredLuminanceKernelSizePercent (Scene.cpp:531): the kernel's diameter as a share of the width. */
const BLUR_KERNEL_PERCENT = 50;

/** The pass sizes for a drawing buffer, in texels: half for the grid's input, a sixteenth for the blur. */
export function localExposureSizes(
  width: number,
  height: number,
): {
  readonly half: readonly [number, number];
  readonly blur: readonly [number, number];
  readonly cells: readonly [number, number];
  readonly log: readonly [number, number];
  readonly rows: readonly [number, number];
  readonly grid: readonly [number, number];
  readonly blurRadius: number;
  readonly rangeStride: number;
} {
  const half = [Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2))] as const;
  const blur = [
    Math.max(1, Math.ceil(width / BLUR_DOWNSAMPLE)),
    Math.max(1, Math.ceil(height / BLUR_DOWNSAMPLE)),
  ] as const;
  // GetBlurRadius takes the filter width times the percent as a diameter; GetClampedKernelRadius caps it.
  const blurRadius = Math.min(
    BLUR_RADIUS,
    Math.max(1e-4, blur[0] * BLUR_KERNEL_PERCENT * 0.01 * 0.5),
  );
  const cells = [Math.ceil(half[0] / CELL), Math.ceil(half[1] / CELL)] as const;
  // The grid's row sums: one texel per cell, pair of bins and half resolution row, CELL logs each.
  return {
    half,
    blur,
    cells,
    log: [Math.ceil(half[0] / PACK), half[1]],
    rows: [(cells[0] * DEPTH) / 2, cells[1] * CELL],
    grid: [cells[0] * DEPTH, cells[1]],
    blurRadius,
    rangeStride: Math.ceil((cells[0] * half[1]) / (blur[0] * blur[1])),
  };
}

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
export class LocalExposureNode extends Node<"float"> {
  static get type(): string {
    return "LocalExposureNode";
  }
  readonly input: ColourTexture;
  readonly #exposure: Node<"float">;
  readonly #size = new Vector2();
  readonly #full = uniform(new Vector2(1, 1));
  readonly #half = uniform(new Vector2(1, 1));
  readonly #logSize = uniform(new Vector2(1, 1));
  readonly #rows = uniform(new Vector2(1, 1));
  readonly #grid = uniform(new Vector2(1, 1));
  readonly #cells = uniform(new Vector2(1, 1));
  readonly #blurSize = uniform(new Vector2(1, 1));
  readonly #blurRadius = uniform(BLUR_RADIUS);
  readonly #rangeStride = uniform(1);
  readonly #quad: QuadMesh;
  readonly #logMaterial = new NodeMaterial();
  readonly #lumMaterial = new NodeMaterial();
  readonly #blurXMaterial = new NodeMaterial();
  readonly #blurYMaterial = new NodeMaterial();
  readonly #rowMaterial = new NodeMaterial();
  readonly #gridMaterial = new NodeMaterial();
  readonly #logTarget = scratch(FloatType, false);
  readonly #lumTarget = scratch(FloatType, false);
  readonly #blurXTarget = scratch(FloatType, false);
  readonly #blurTarget = scratch(HalfFloatType, true);
  readonly #rowTarget = scratch(FloatType, false);
  readonly #gridTarget = scratch(FloatType, false);
  readonly #logTexture = texture(this.#logTarget.texture);
  readonly #lumTexture = texture(this.#lumTarget.texture);
  readonly #blurXTexture = texture(this.#blurXTarget.texture);
  readonly #blurTexture = texture(this.#blurTarget.texture);
  readonly #rowTexture = texture(this.#rowTarget.texture);
  readonly #gridTexture = texture(this.#gridTarget.texture);
  // Three's runtime accepts undefined on first use, but its declaration requires a state.
  #rendererState: Parameters<typeof RendererUtils.resetRendererState>[1] | undefined;
  #configuredWidth = -1;
  #configuredHeight = -1;
  #disposed = false;

  constructor(input: ColourTexture, exposure: Node<"float">) {
    super("float");
    this.input = input;
    this.#exposure = exposure;
    this.updateBeforeType = NodeUpdateType.FRAME;
    const half = this.#half;
    const blurSize = this.#blurSize;
    const radius = this.#blurRadius;

    // Pass 1: log2 luminance of the half resolution image (a 2x2 average of colour), PACK neighbouring
    // half resolution texels of a row per texel, so the row sums read four logs with one tap.
    this.#logMaterial.fragmentNode = Fn(() => {
      const c = uv();
      const texel = vec2(0.5).div(this.#full);
      const first = c.x.mul(this.#logSize.x).floor().mul(PACK);
      const logAt = (k: number): Node<"float"> => {
        const at = vec2(first.add(k + 0.5).div(half.x), c.y);
        const sum = vec3(0).toVar();
        for (const [x, y] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const)
          sum.addAssign(input.sample(at.add(texel.mul(vec2(x, y)))).rgb);
        return exposureMeter(vec4(sum.div(4), 1), at)
          .x.max(2 ** LOG_MIN)
          .log2();
      };
      return vec4(logAt(0), logAt(1), logAt(2), logAt(3));
    })();

    // Pass 2: log2 luminance of the colour averaged over each 16x16 block, the downsample chain's mip 4
    // (SetupLogLuminanceCS takes the log after the downsample). Point taps at texel centres, so the
    // input's filter does not matter.
    this.#lumMaterial.fragmentNode = Fn(() => {
      const c = uv();
      const texel = float(1).div(this.#full);
      const sum = vec3(0).toVar();
      Loop(BLUR_DOWNSAMPLE * BLUR_DOWNSAMPLE, ({ i }) => {
        const x = float(i)
          .mod(BLUR_DOWNSAMPLE)
          .sub((BLUR_DOWNSAMPLE - 1) / 2);
        const y = float(i)
          .div(BLUR_DOWNSAMPLE)
          .floor()
          .sub((BLUR_DOWNSAMPLE - 1) / 2);
        sum.addAssign(input.sample(c.add(texel.mul(vec2(x, y)))).rgb);
      });
      const luminance = exposureMeter(vec4(sum.div(BLUR_DOWNSAMPLE * BLUR_DOWNSAMPLE), 1), c).x.max(
        2 ** LOG_MIN,
      );
      // Reuse G/B for conservative row-bin bounds; the blur reads only the unchanged R.
      const group = c.y.mul(blurSize.y).floor().mul(blurSize.x).add(c.x.mul(blurSize.x).floor());
      const minimum = float(DEPTH - 1).toVar();
      const maximum = float(0).toVar();
      // 1 while every sampled raw log is finite in range, so invalid input widens instead of pruning.
      // Two rows is the maximum this pass proves; a larger stride widens to the full range.
      const finite = this.#rangeStride.lessThanEqual(2).select(1, 0).toVar();
      Loop(2 * (CELL / PACK), ({ i }) => {
        const row = group.mul(this.#rangeStride).add(
          float(i)
            .div(CELL / PACK)
            .floor(),
        );
        const packed = row
          .mod(this.#cells.x)
          .mul(CELL / PACK)
          .add(float(i).mod(CELL / PACK));
        const y = row.div(this.#cells.x).floor();
        // Clamp to the real texels: a partial last cell or short row must not sample outside them.
        const px = packed.min(this.#logSize.x.sub(1));
        const py = y.min(half.y.sub(1));
        const logs = this.#logTexture
          .sample(vec2(px.add(0.5).div(this.#logSize.x), py.add(0.5).div(half.y)))
          .level(float(0));
        // 128 bounds log2 of finite f32 luminance. Invalid samples disable pruning, preserving propagation.
        const inRange = logs
          .greaterThanEqual(vec4(LOG_MIN))
          .all()
          .and(logs.lessThanEqual(vec4(128)).all());
        finite.assign(finite.mul(inRange.select(1, 0)));
        const position = logs
          .sub(LOG_MIN)
          .div(LOG_SPAN)
          .clamp(0, 1)
          .mul(DEPTH - 1);
        minimum.assign(minimum.min(position.x).min(position.y).min(position.z).min(position.w));
        maximum.assign(maximum.max(position.x).max(position.y).max(position.z).max(position.w));
      });
      return vec4(
        luminance.log2(),
        mix(float(0), minimum, finite),
        mix(float(DEPTH - 1), maximum, finite),
        1,
      );
    })();

    // Passes 3 and 4: the Gaussian of that log luminance, one axis each, mirror addressed, with the
    // radius Compute1DGaussianFilterKernel takes from the width (both axes use it).
    const blur = (source: ColourTexture, axis: 0 | 1): Node<"vec4"> =>
      Fn(() => {
        const c = uv();
        const step = float(1).div(axis === 0 ? blurSize.x : blurSize.y);
        const reach = radius.ceil();
        const sum = float(0).toVar();
        const weights = float(0).toVar();
        Loop(2 * BLUR_RADIUS + 1, ({ i }) => {
          const offset = float(i).sub(BLUR_RADIUS);
          const t = offset.div(radius);
          const weight = offset
            .abs()
            .lessThanEqual(reach)
            .select(t.mul(t).mul(BLUR_SHAPE).exp(), 0);
          const along = mirror((axis === 0 ? c.x : c.y).add(offset.mul(step)));
          const at = axis === 0 ? vec2(along, c.y) : vec2(c.x, along);
          sum.addAssign(source.sample(at).level(float(0)).r.mul(weight));
          weights.addAssign(weight);
        });
        return vec4(sum.div(weights), 0, 0, 1);
      })();
    this.#blurXMaterial.fragmentNode = blur(this.#lumTexture, 0);
    this.#blurYMaterial.fragmentNode = blur(this.#blurXTexture, 1);

    // Passes 5 and 6: the bilateral grid. Each half resolution texel of a cell is shared between its
    // two nearest bins of log luminance by linear weights (PostProcessHistogram.usf), and the grid
    // sums the weight and the weighted log per cell and bin. Pass 5 sums each cell row, pass 6 sums
    // the rows: one fragment looping over the whole cell ran 7,680 threads of 4,096 serial taps at
    // 2560x1440, 1.3 ms on an RTX 2080. Unreal also spreads a cell over 64 threads and reduces their
    // histograms after (UE 5.8.3: Engine/Shaders/Private/PostProcessHistogram.usf:99-102,209-224).
    // A row sum texel (cell x * DEPTH / 2 + pair, cell y * CELL + row) holds bins 2 pair and 2 pair + 1
    // as (log sum, weight, log sum, weight), reading the row's logs PACK at a time: one bin a texel
    // read each log once per bin, 17.7M taps and 1.25 ms at 1920x1080 on Iris Xe.
    this.#rowMaterial.fragmentNode = Fn(() => {
      const c = uv();
      const column = c.x.mul(this.#rows.x).floor();
      const y = c.y.mul(this.#rows.y).floor();
      const cell = column.div(DEPTH / 2).floor();
      const bin = column.sub(cell.mul(DEPTH / 2)).mul(2);
      const sums = vec4(0).toVar();
      If(y.lessThan(half.y), () => {
        // +0.5 keeps float division from rounding an exact multiple down to the previous slot.
        const group = y.mul(this.#cells.x).add(cell).add(0.5).div(this.#rangeStride).floor();
        const lumY = group.add(0.5).div(blurSize.x).floor();
        const lumX = group.sub(lumY.mul(blurSize.x));
        const bounds = this.#lumTexture
          .sample(vec2(lumX.add(0.5).div(blurSize.x), lumY.add(0.5).div(blurSize.y)))
          .level(float(0)).gb;
        // A pair has nonzero triangular weight only inside (bin - 1, bin + 2).
        If(bounds.y.greaterThan(bin.sub(1)).and(bounds.x.lessThan(bin.add(2))), () => {
          Loop(CELL / PACK, ({ i }) => {
            const packed = cell.mul(CELL / PACK).add(float(i));
            const logs = this.#logTexture
              .sample(vec2(packed.add(0.5).div(this.#logSize.x), y.add(0.5).div(half.y)))
              .level(float(0));
            for (const [k, lane] of (["x", "y", "z", "w"] as const).entries()) {
              If(packed.mul(PACK).add(k).lessThan(half.x).and(y.lessThan(half.y)), () => {
                const log = logs[lane];
                const position = log
                  .sub(LOG_MIN)
                  .div(LOG_SPAN)
                  .clamp(0, 1)
                  .mul(DEPTH - 1);
                const low = position.sub(bin).abs().oneMinus().max(0);
                const high = position.sub(bin.add(1)).abs().oneMinus().max(0);
                sums.addAssign(vec4(low.mul(log), low, high.mul(log), high));
              });
            }
          });
        });
      });
      return sums;
    })();
    // Grid texel (cell x * DEPTH + bin, cell y) holds bin and bin + 1 (the last bin twice) as
    // (log sum, weight, log sum, weight), so the trilinear lookup reads both bins with one tap.
    this.#gridMaterial.fragmentNode = Fn(() => {
      const c = uv();
      const column = c.x.mul(this.#grid.x).floor();
      const row = c.y.mul(this.#grid.y).floor();
      const cell = column.div(DEPTH).floor();
      const bin = column.sub(cell.mul(DEPTH));
      const next = bin.add(1).min(DEPTH - 1);
      const at = (b: Node<"float">): Node<"float"> =>
        cell
          .mul(DEPTH / 2)
          .add(b.div(2).floor())
          .add(0.5)
          .div(this.#rows.x);
      const odd = (b: Node<"float">): Node<"bool"> => b.mod(2).greaterThan(0.5);
      const sum = vec4(0).toVar();
      Loop(CELL, ({ i }) => {
        const v = row.mul(CELL).add(float(i)).add(0.5).div(this.#rows.y);
        const own = this.#rowTexture.sample(vec2(at(bin), v)).level(float(0));
        const above = this.#rowTexture.sample(vec2(at(next), v)).level(float(0));
        sum.addAssign(vec4(odd(bin).select(own.zw, own.xy), odd(next).select(above.zw, above.xy)));
      });
      return sum;
    })();
    // Three 0.187's QuadMesh takes its material in the constructor; each pass replaces it before drawing.
    this.#quad = new QuadMesh(this.#logMaterial);
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
    // One tap holds bin z0 and the next (the last bin twice), so the eight corners take four taps.
    const fetch = (dx: number, dy: number): Node<"vec4"> => {
      const x = x0.add(dx).min(cells.x.sub(1));
      const y = y0.add(dy).min(cells.y.sub(1));
      return this.#gridTexture
        .sample(vec2(x.mul(DEPTH).add(z0).add(0.5).div(gridSize.x), y.add(0.5).div(gridSize.y)))
        .level(float(0));
    };
    let grid: Node<"vec2"> = vec2(0);
    for (const dy of [0, 1])
      for (const dx of [0, 1]) {
        const corner = fetch(dx, dy);
        const weight = (dx ? fx : fx.oneMinus()).mul(dy ? fy : fy.oneMinus());
        grid = grid.add(mix(corner.xy, corner.zw, fz).mul(weight));
      }
    const blurred = this.#blurTexture.sample(c).level(float(0)).r;
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
    if (this.#configuredWidth !== this.#size.x || this.#configuredHeight !== this.#size.y) {
      this.#full.value.copy(this.#size);
      const sizes = localExposureSizes(this.#size.x, this.#size.y);
      const [halfWidth, halfHeight] = sizes.half;
      const [blurWidth, blurHeight] = sizes.blur;
      const [cellsX, cellsY] = sizes.cells;
      const [logWidth, logHeight] = sizes.log;
      const [rowsWidth, rowsHeight] = sizes.rows;
      const [gridWidth, gridHeight] = sizes.grid;
      this.#half.value.set(halfWidth, halfHeight);
      this.#logSize.value.set(logWidth, logHeight);
      this.#rows.value.set(rowsWidth, rowsHeight);
      this.#blurSize.value.set(blurWidth, blurHeight);
      this.#blurRadius.value = sizes.blurRadius;
      this.#rangeStride.value = sizes.rangeStride;
      this.#cells.value.set(cellsX, cellsY);
      this.#grid.value.set(gridWidth, gridHeight);
      this.#logTarget.setSize(logWidth, logHeight);
      this.#lumTarget.setSize(blurWidth, blurHeight);
      this.#blurXTarget.setSize(blurWidth, blurHeight);
      this.#blurTarget.setSize(blurWidth, blurHeight);
      this.#rowTarget.setSize(rowsWidth, rowsHeight);
      this.#gridTarget.setSize(gridWidth, gridHeight);
      this.#configuredWidth = this.#size.x;
      this.#configuredHeight = this.#size.y;
    }
    this.#rendererState ??= RendererUtils.saveRendererState(renderer);
    this.#rendererState = RendererUtils.resetRendererState(renderer, this.#rendererState);
    try {
      for (const [material, target] of [
        [this.#logMaterial, this.#logTarget],
        [this.#lumMaterial, this.#lumTarget],
        [this.#blurXMaterial, this.#blurXTarget],
        [this.#blurYMaterial, this.#blurTarget],
        [this.#rowMaterial, this.#rowTarget],
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
    for (const target of [
      this.#logTarget,
      this.#lumTarget,
      this.#blurXTarget,
      this.#blurTarget,
      this.#rowTarget,
      this.#gridTarget,
    ])
      target.dispose();
    for (const material of [
      this.#logMaterial,
      this.#lumMaterial,
      this.#blurXMaterial,
      this.#blurYMaterial,
      this.#rowMaterial,
      this.#gridMaterial,
    ])
      material.dispose();
    super.dispose();
  }
}
