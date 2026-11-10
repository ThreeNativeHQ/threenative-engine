/**
 * The share of the sky each heightfield vertex sees past the terrain around it: 1 on open ground,
 * lower on a valley floor, at a cliff foot or in a crater.
 *
 * The logic follows TerraForge3D's horizon ambient pass (MIT, `heightfield/ambient/compute.glsl`):
 * march outward along evenly spaced azimuths, keep the highest horizon each one meets, and integrate
 * the cosine-weighted sky above it, which is `cos²` of the horizon angle per azimuth. Only ground
 * that rises over both the vertex's tangent plane and the horizontal occludes, so a straight slope
 * and a steep face over a flat floor stay open: the lighting already counts the slope's own tilt.
 *
 * Heights are row-major Z then X, centred on the origin, as the baked world stores them. Every node
 * marches: a strided march filled bilinearly erred by 0.13 at p99 on the alpine survey's creases.
 * About 0.4 s of CPU a world, so `scripts/bake.mjs` runs it and the game loads `<world>.sky.bin`.
 */
export function skyVisibility(
  heights: ArrayLike<number>,
  resolution: number,
  size: number,
  { azimuths = 16, reach = 160 }: { azimuths?: number; reach?: number } = {},
): Float32Array {
  if (resolution < 2 || heights.length !== resolution * resolution)
    throw new RangeError(
      `skyVisibility: ${heights.length} heights do not fill a ${resolution}² grid`,
    );
  const spacing = size / (resolution - 1);
  const last = resolution - 1;
  const grid = Float32Array.from(heights);
  // One cell at a time near the vertex, then 10 % further each step: ~32 samples reach 160 m.
  const radii: number[] = [];
  for (let r = spacing; r <= reach; r += Math.max(spacing, r * 0.1)) radii.push(r);
  // Per azimuth and step: the offset in grid cells and 1/r, so the inner loop only adds.
  const steps = radii.length;
  const offsetColumn = new Float32Array(azimuths * steps);
  const offsetRow = new Float32Array(azimuths * steps);
  const directionX = new Float32Array(azimuths);
  const directionZ = new Float32Array(azimuths);
  for (let a = 0; a < azimuths; a++) {
    const angle = (a / azimuths) * Math.PI * 2;
    directionX[a] = Math.cos(angle);
    directionZ[a] = Math.sin(angle);
    for (let k = 0; k < steps; k++) {
      offsetColumn[a * steps + k] = (Math.cos(angle) * (radii[k] as number)) / spacing;
      offsetRow[a * steps + k] = (Math.sin(angle) * (radii[k] as number)) / spacing;
    }
  }
  const march: IMarch = {
    grid,
    resolution,
    steps,
    offsetColumn,
    offsetRow,
    inverseRadius: Float32Array.from(radii, (r) => 1 / r),
  };
  const visibility = new Float32Array(resolution * resolution);
  for (let row = 0; row < resolution; row++) {
    const up = Math.min(row + 1, last);
    const down = Math.max(row - 1, 0);
    for (let column = 0; column < resolution; column++) {
      const right = Math.min(column + 1, last);
      const left = Math.max(column - 1, 0);
      const gradientX =
        ((grid[row * resolution + right] as number) - (grid[row * resolution + left] as number)) /
        ((right - left) * spacing);
      const gradientZ =
        ((grid[up * resolution + column] as number) -
          (grid[down * resolution + column] as number)) /
        ((up - down) * spacing);
      let sky = 0;
      for (let a = 0; a < azimuths; a++) {
        // Above the tangent plane and above the horizon both: downhill, the plane dips under the
        // valley floor, and that ground already darkens a tilted normal through the lighting.
        const plane = Math.max(
          0,
          gradientX * (directionX[a] as number) + gradientZ * (directionZ[a] as number),
        );
        const horizon = horizonTangent(march, row, column, a, plane);
        sky += 1 / (1 + horizon * horizon);
      }
      visibility[row * resolution + column] = sky / azimuths;
    }
  }
  return visibility;
}

interface IMarch {
  readonly grid: Float32Array;
  readonly resolution: number;
  readonly steps: number;
  readonly offsetColumn: Float32Array;
  readonly offsetRow: Float32Array;
  readonly inverseRadius: Float32Array;
}

/** The highest ground over `plane` along one azimuth, as a tangent; 0 when nothing rises over it. */
function horizonTangent(
  { grid, resolution, steps, offsetColumn, offsetRow, inverseRadius }: IMarch,
  row: number,
  column: number,
  azimuth: number,
  plane: number,
): number {
  const last = resolution - 1;
  const h0 = grid[row * resolution + column] as number;
  let horizon = 0;
  for (let k = 0; k < steps; k++) {
    const c = column + (offsetColumn[azimuth * steps + k] as number);
    const w = row + (offsetRow[azimuth * steps + k] as number);
    if (c < 0 || c > last || w < 0 || w > last) break;
    // Bilinear between the four cells around the sample.
    const c0 = c < last ? c | 0 : last - 1;
    const w0 = w < last ? w | 0 : last - 1;
    const i = w0 * resolution + c0;
    const top = (grid[i] as number) + ((grid[i + 1] as number) - (grid[i] as number)) * (c - c0);
    const bottom =
      (grid[i + resolution] as number) +
      ((grid[i + resolution + 1] as number) - (grid[i + resolution] as number)) * (c - c0);
    const tangent = (top + (bottom - top) * (w - w0) - h0) * (inverseRadius[k] as number) - plane;
    if (tangent > horizon) horizon = tangent;
  }
  return horizon;
}
