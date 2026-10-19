function assertRgba(data: Float32Array, width: number, height: number): void {
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 1)
    throw new Error("Velocity readback requires positive image dimensions.");
  if (data.length !== width * height * 4)
    throw new Error("Velocity readback must contain one RGBA value per pixel.");
  if (!data.every(Number.isFinite)) throw new Error("Readback contains non-finite pixels.");
}

/** Summarize actual RGBA velocity pixels: the static sub-draw occupies the left half. */
export function summarizeVelocityPixels(
  data: Float32Array,
  width: number,
  height: number,
  movingBounds = { left: width / 2, right: width, top: 0, bottom: height },
) {
  assertRgba(data, width, height);
  let staticMax = 0;
  let stationaryMax = 0;
  let movingMax = 0;
  let movingPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const x = data[pixel * 4];
    const y = data[pixel * 4 + 1];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
      throw new Error("Velocity readback contains non-finite motion.");
    const speed = Math.hypot(x, y);
    const px = pixel % width;
    const py = Math.floor(pixel / width);
    if (
      px < movingBounds.left ||
      px >= movingBounds.right ||
      py < movingBounds.top ||
      py >= movingBounds.bottom
    )
      stationaryMax = Math.max(stationaryMax, speed);
    if (px < width / 2) staticMax = Math.max(staticMax, speed);
    else {
      movingMax = Math.max(movingMax, speed);
      if (speed > 0.001) movingPixels += 1;
    }
  }
  return { staticMax, stationaryMax, movingMax, movingPixels };
}

/** The fixture's blue moving geometry is distinct from its dark background and neutral wall. */
export function measureMovingColourFootprint(data: Float32Array, width: number, height: number) {
  assertRgba(data, width, height);
  let pixels = 0;
  let totalX = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const red = data[pixel * 4];
    const blue = data[pixel * 4 + 2];
    if (red === undefined || blue === undefined || !Number.isFinite(red) || !Number.isFinite(blue))
      throw new Error("Colour readback contains non-finite pixels.");
    const x = pixel % width;
    if (x < width / 2 || blue < 0.09 || blue - red < 0.06) continue;
    totalX += x + 0.5;
    pixels += 1;
  }
  if (pixels === 0) throw new Error("Missing moving colour footprint.");
  return { pixels, centroidX: totalX / pixels };
}

/** Check the independent binary MRT coverage and its complement, including exposed wall edges. */
export function summarizeCoveredVelocity(
  velocity: Float32Array,
  colour: Float32Array,
  width: number,
  height: number,
  expectedX: number,
  coverage: Float32Array,
) {
  assertRgba(velocity, width, height);
  assertRgba(colour, width, height);
  assertRgba(coverage, width, height);
  if (!Number.isFinite(expectedX)) throw new Error("Expected motion must be finite.");
  let footprintPixels = 0;
  let footprintMaxErrorPixels = 0;
  let outsideFootprintMax = 0;
  let darkFootprintPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const red = colour[pixel * 4];
    const blue = colour[pixel * 4 + 2];
    const x = velocity[pixel * 4];
    const y = velocity[pixel * 4 + 1];
    const id = coverage[pixel * 4];
    if (red === undefined || blue === undefined || x === undefined || y === undefined)
      throw new Error("Missing masked RGBA pixel.");
    if (id !== 0 && id !== 1) throw new Error("Coverage MRT must contain exact binary IDs.");
    if (id === 1) {
      footprintPixels += 1;
      darkFootprintPixels += Number(blue < 0.09 || blue - red < 0.06);
      footprintMaxErrorPixels = Math.max(
        footprintMaxErrorPixels,
        Math.hypot(((x - expectedX) * width) / 2, (y * height) / 2),
      );
    } else outsideFootprintMax = Math.max(outsideFootprintMax, Math.hypot(x, y));
  }
  if (footprintPixels === 0) throw new Error("Missing moving coverage footprint.");
  return { footprintPixels, footprintMaxErrorPixels, outsideFootprintMax, darkFootprintPixels };
}
