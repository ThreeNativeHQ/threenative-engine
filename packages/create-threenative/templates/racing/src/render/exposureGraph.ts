// Generated for you: GPU reduction and adaptation; exposure.ts owns the game's look.
import { FloatType, NearestFilter, RenderTarget } from "three";
import {
  Fn,
  If,
  Loop,
  float,
  int,
  ivec2,
  mix,
  screenCoordinate,
  smoothstep,
  type texture,
  textureLoad,
  vec2,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { IExposureSettings } from "./exposure.js";

export type ColourTexture = ReturnType<typeof texture>;
export type Meter = (colour: Node<"vec4">, uv: Node<"vec2">) => Node<"vec2">;
export type Decode = (mean: Node<"float">) => Node<"float">;

export function exposureTarget(): RenderTarget {
  return new RenderTarget(1, 1, {
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  });
}

/** Sum/16 at each level keeps values bounded. Mask partial blocks; never replicate edge texels. */
export function reduceExposure(
  input: ColourTexture,
  size: Node<"vec2">,
  meter?: Meter,
): Node<"vec4"> {
  return Fn(() => {
    const sum = vec2(0).toVar();
    const origin = screenCoordinate.xy.floor().mul(4);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const pixel = origin.add(vec2(x, y));
        If(pixel.x.lessThan(size.x).and(pixel.y.lessThan(size.y)), () => {
          const colour = textureLoad(input, ivec2(pixel));
          sum.addAssign(meter === undefined ? colour.rg : meter(colour, pixel.add(0.5).div(size)));
        });
      }
    return vec4(sum.div(16), 0, 1);
  })();
}

/** The histogram has 64 bins. Each bin spans (maxStops - minStops) / 64 stops of scene luminance. */
export const exposureBins = 64;
/** The gather splits the blocks over 64 tiles, so a bin is summed by 64 short loops, not one long. */
export const exposureTiles = 64;

/**
 * Stage one of the histogram, drawn as a 64 (bins) x 64 (tiles) target. Texel (bin, tile) gathers
 * its tile of the block means of `blocks` (the second reduction level, about 8 000 texels at
 * 1080p, so about 130 per tile) that fall in its bin.
 * r = summed weight, g = summed weight * log2 luminance, so a bin keeps its exact mean.
 */
export function histogramTiles(
  blocks: ColourTexture,
  size: Node<"vec2">,
  policy: Readonly<IExposureSettings>,
): Node<"vec4"> {
  // Range follows the authored stops: goal = log2(key) - log2(L), clamped to [min, max].
  const low = Math.log2(policy.key) - policy.maxStops;
  const span = policy.maxStops - policy.minStops;
  return Fn(() => {
    const bin = screenCoordinate.x.floor();
    const weight = float(0).toVar();
    const logSum = float(0).toVar();
    const width = int(size.x);
    const total = int(size.x.mul(size.y));
    const perTile = total.add(exposureTiles - 1).div(exposureTiles);
    const first = int(screenCoordinate.y.floor()).mul(perTile);
    Loop({ start: 0, end: perTile }, ({ i: offset }) => {
      const i = first.add(offset);
      If(i.lessThan(total), () => {
        const block = textureLoad(blocks, ivec2(i.mod(width), i.div(width)));
        const log = block.r
          .div(block.g.max(1e-20))
          .max(1e-20)
          .log2()
          .clamp(low, low + span);
        const index = log
          .sub(low)
          .mul(exposureBins / span)
          .floor()
          .min(exposureBins - 1);
        If(block.g.greaterThan(0).and(index.equal(bin)), () => {
          weight.addAssign(block.g);
          logSum.addAssign(block.g.mul(log));
        });
      });
    });
    return vec4(weight, logSum, 0, 1);
  })();
}

/** Stage two, drawn as a 64x1 target: one texel per bin, summing that bin over every tile. */
export function histogramExposure(tiles: ColourTexture): Node<"vec4"> {
  return Fn(() => {
    const bin = int(screenCoordinate.x.floor());
    const sum = vec2(0).toVar();
    Loop(exposureTiles, ({ i }) => {
      sum.addAssign(textureLoad(tiles, ivec2(bin, i)).rg);
    });
    return vec4(sum, 0, 1);
  })();
}

/**
 * UE's average without outliers: drop the darkest lowPercent of the weight, stop at
 * highPercent, take the weighted log2 mean of what is left. Returns (log2 mean, kept weight).
 */
function clippedLog2Mean(
  histogram: ColourTexture,
  policy: Readonly<IExposureSettings>,
): Node<"vec2"> {
  const total = float(0).toVar();
  Loop(exposureBins, ({ i }) => {
    total.addAssign(textureLoad(histogram, ivec2(i, 0)).r);
  });
  const dropLow = total.mul(policy.lowPercent / 100).toVar();
  const keepUpTo = total.mul(policy.highPercent / 100).toVar();
  const kept = float(0).toVar();
  const logSum = float(0).toVar();
  Loop(exposureBins, ({ i }) => {
    const bin = textureLoad(histogram, ivec2(i, 0));
    const removed = bin.r.min(dropLow);
    dropLow.subAssign(removed);
    keepUpTo.subAssign(removed);
    const keep = bin.r.sub(removed).min(keepUpTo);
    keepUpTo.subAssign(keep);
    kept.addAssign(keep);
    logSum.addAssign(bin.g.mul(keep.div(bin.r.max(1e-20))));
  });
  return vec2(logSum.div(kept.max(1e-20)), kept);
}

export function adaptExposure(
  histogram: ColourTexture,
  previous: ColourTexture,
  resetMode: Node<"float">,
  seed: Node<"float">,
  delta: Node<"float">,
  policy: Readonly<IExposureSettings>,
  decode: Decode,
): Node<"vec4"> {
  return Fn(() => {
    const measure = clippedLog2Mean(histogram, policy);
    const luminance = decode(measure.x.exp2());
    const valid = measure.y
      .greaterThan(0)
      .and(luminance.greaterThan(0))
      .and(luminance.lessThan(3.4e38));
    const goal = float(Math.log2(policy.key))
      .sub(luminance.max(1e-20).log2())
      .clamp(policy.minStops, policy.maxStops);
    const old = resetMode.equal(1).select(seed, textureLoad(previous, ivec2(0)).r);
    const error = goal.sub(old);
    const rate = error.greaterThan(0).select(float(policy.rateUp), float(policy.rateDown));
    const normal = float(1).sub(delta.mul(rate).negate().exp());
    const cut = smoothstep(policy.snapLo, policy.snapHi, error.abs()).mul(policy.snapGain);
    const adapted = valid.select(
      resetMode.equal(2).select(goal, mix(old, goal, mix(normal, float(1), cut))),
      old,
    );
    const settled = goal.sub(adapted).abs().lessThanEqual(policy.settleStops).select(1, 0);
    return vec4(adapted, valid.select(luminance, -1), goal, settled);
  })();
}
