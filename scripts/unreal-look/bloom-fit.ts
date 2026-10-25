/**
 * `tsx scripts/unreal-look/bloom-fit.ts` — can three's five-mip `BloomNode` reach Unreal's bloom? (PRD-636 Phase 1)
 *
 * Both blooms are sums of isotropic Gaussians, so the inner product of two of them has a closed form and the best
 * non-negative weights for stock's five mips are a small least-squares fit. No frame is needed. The residual is
 * the relative L2 error of the point spread function: the share of Unreal's bloom that no weighting of the stock
 * mips can place. The stock weights are free here, which is the best case for the stock node.
 *
 * Unreal side: sizes, size scale, tints and intensity are the Scene.cpp defaults; the Gaussian shape and the
 * 31 texel cap are PostProcessWeightedSampleSum.cpp (see unrealBloom.ts for both paths). Stock side:
 * `BloomNode` blurs mip i (1/2^(i+1) of the frame) with kernel radius 3, 5, 7, 9, 11, which is its sigma in texels.
 */
import { pathToFileURL } from "node:url";

/** Scene.cpp defaults, stage 1 (tightest) to stage 6 (widest). */
export const UNREAL_BLOOM = {
  intensity: 0.675,
  sizeScale: 4,
  sizes: [0.3, 1, 2, 10, 30, 64],
  tints: [0.3465, 0.138, 0.1176, 0.066, 0.066, 0.061],
} as const;

/** PostProcessWeightedSampleSum.cpp: the weight shape and the radius cap. */
const SHAPE = 16.7;
const MAX_RADIUS = 31;
/** Kernel radius of each stock mip, which is the sigma of its Gaussian in that mip's texels. */
const STOCK_KERNELS = [3, 5, 7, 9, 11];

export interface IGaussian {
  /** Sigma in full resolution pixels. */
  readonly sigma: number;
  readonly weight: number;
}

/** The six stages of Unreal's bloom for a frame `width` pixels wide, as Gaussians in full resolution pixels. */
export function unrealStages(width: number): IGaussian[] {
  const { sizes, tints, sizeScale, intensity } = UNREAL_BLOOM;
  return sizes.map((size, index) => {
    const level = index + 1;
    const texels = Math.max(1, Math.ceil(width / 2 ** level));
    const radius = Math.min(Math.max(texels * size * sizeScale * 0.01 * 0.5, 1e-4), MAX_RADIUS);
    return {
      sigma: (radius / Math.sqrt(2 * SHAPE)) * 2 ** level,
      weight: ((tints[index] ?? 0) / sizes.length) * intensity,
    };
  });
}

/** The five stock mips as Gaussians in full resolution pixels, weights still to fit. */
export const stockSigmas = (): number[] =>
  STOCK_KERNELS.map((kernel, mip) => kernel * 2 ** (mip + 1));

/** Integral of the product of two normalised 2D Gaussians. */
export const gaussianInner = (a: number, b: number): number => 1 / (2 * Math.PI * (a * a + b * b));

const norm2 = (g: readonly IGaussian[]): number =>
  g.reduce(
    (sum, a) =>
      sum + g.reduce((q, b) => q + a.weight * b.weight * gaussianInner(a.sigma, b.sigma), 0),
    0,
  );

export interface IBloomFit {
  readonly weights: number[];
  /** Relative L2 error of the fitted point spread function against the target. */
  readonly residual: number;
}

/** Best non-negative weights for Gaussians of the given sigmas against `target` (coordinate descent). */
export function fitBloom(sigmas: readonly number[], target: readonly IGaussian[]): IBloomFit {
  if (target.length === 0) throw new Error("BLOOM_FIT_EMPTY: no target Gaussians");
  const gram = sigmas.map((a) => sigmas.map((b) => gaussianInner(a, b)));
  const rhs = sigmas.map((a) =>
    target.reduce((s, t) => s + t.weight * gaussianInner(a, t.sigma), 0),
  );
  const weights = sigmas.map(() => 0);
  for (let pass = 0; pass < 20_000; pass++)
    for (let i = 0; i < sigmas.length; i++) {
      let r = rhs[i] ?? 0;
      for (let j = 0; j < sigmas.length; j++)
        if (j !== i) r -= (gram[i]?.[j] ?? 0) * (weights[j] ?? 0);
      weights[i] = Math.max(0, r / (gram[i]?.[i] ?? 1));
    }
  const fitted = sigmas.map((sigma, i) => ({ sigma, weight: weights[i] ?? 0 }));
  const cross = fitted.reduce(
    (s, a) =>
      s + target.reduce((q, t) => q + a.weight * t.weight * gaussianInner(a.sigma, t.sigma), 0),
    0,
  );
  const tt = norm2(target);
  return { weights, residual: Math.sqrt(Math.max(0, tt - 2 * cross + norm2(fitted)) / tt) };
}

export function main(): void {
  for (const [width, height] of [
    [1280, 720],
    [1920, 1080],
  ] as const) {
    const target = unrealStages(width);
    const fit = fitBloom(stockSigmas(), target);
    // Stock has no mip finer than sigma 6 px, so the target mass tighter than 14 px has nowhere to go.
    const fine = target.filter((t) => t.sigma <= 14).reduce((s, t) => s + t.weight, 0);
    const total = target.reduce((s, t) => s + t.weight, 0);
    console.log(
      `${width}x${height}: Unreal sigmas ${target.map((t) => t.sigma.toFixed(1)).join(", ")} px`,
    );
    console.log(
      `  stock sigmas ${stockSigmas().join(", ")} px, fitted weights ${fit.weights.map((w) => w.toFixed(4)).join(", ")}`,
    );
    console.log(
      `  relative L2 error of the point spread ${(fit.residual * 100).toFixed(1)} percent; ${((fine / total) * 100).toFixed(0)} percent of Unreal's bloom lies inside sigma 14 px`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
