/**
 * How much one frame changes against the same frame without local exposure, by brightness, for
 * `pnpm unreal-look:compare --metric curve --layer L8,L9` (PRD-632, PRD-636).
 *
 * Unreal's L8 has no local exposure and a fixed exposure; L9 adds both automatic and local
 * exposure. The global exposure scales every pixel alike, so the spread of the log ratio across
 * brightness is the local exposure: bright pixels fall and dark ones rise. The pixels are sorted by
 * the L8 value and cut into five equal groups; each group's median log2(L9 / L8) is one entry,
 * darkest first. Both arms run the same cut on their own frames, so the comparison is the curve,
 * not the scene.
 */

/** Pixels darker than this in either frame (black sky, the clear colour) carry no ratio. */
const FLOOR = 1e-3;
export const CURVE_GROUPS = 5;

/** Median log2 ratio per brightness group, dark to bright. Empty when fewer than 5 pixels count. */
export function exposureCurve(before: ArrayLike<number>, after: ArrayLike<number>): number[] {
  if (before.length !== after.length) throw new Error("TN_EXPOSURE_CURVE: frames differ in size");
  const pairs: [number, number][] = [];
  for (let i = 0; i < before.length; i++) {
    const b = before[i] ?? 0;
    const a = after[i] ?? 0;
    if (b > FLOOR && a > FLOOR) pairs.push([b, Math.log2(a / b)]);
  }
  if (pairs.length < CURVE_GROUPS) return [];
  pairs.sort((x, y) => x[0] - y[0]);
  return Array.from({ length: CURVE_GROUPS }, (_, group) => {
    const slice = pairs
      .slice(
        Math.floor((group * pairs.length) / CURVE_GROUPS),
        Math.floor(((group + 1) * pairs.length) / CURVE_GROUPS),
      )
      .map((pair) => pair[1])
      .sort((x, y) => x - y);
    return slice[Math.floor(slice.length / 2)] ?? 0;
  });
}

/**
 * The mean offset between two curves, and the largest entry difference left once that offset is
 * removed. The offset is the global exposure and the scene; the remainder is the local exposure.
 */
export function curveShape(
  unreal: readonly number[],
  other: readonly number[],
): { level: number; shape: number } {
  if (unreal.length !== other.length || unreal.length === 0)
    return { level: Number.NaN, shape: Number.NaN };
  const level = other.reduce((sum, v, i) => sum + v - (unreal[i] ?? 0), 0) / other.length;
  return {
    level,
    shape: Math.max(...other.map((v, i) => Math.abs(v - (unreal[i] ?? 0) - level))),
  };
}
