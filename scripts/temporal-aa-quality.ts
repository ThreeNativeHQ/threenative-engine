import assert from "node:assert/strict";

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, "Missing sequence component");
  return value;
}

export interface ILinearFrame {
  width: number;
  height: number;
  rgb: Float64Array;
}

/** Diagnostic profile: column-mean linear blue, summed above a supplied reference background. */
export function measureBlueProfile(
  frame: ILinearFrame,
  region: { x: number; y: number; width: number; height: number },
  backgroundBlue: number,
) {
  const { x, y, width, height } = region;
  assert.ok(
    [x, y, width, height].every(Number.isInteger) &&
      x >= 0 &&
      y >= 0 &&
      width > 0 &&
      height > 0 &&
      x + width <= frame.width &&
      y + height <= frame.height &&
      Number.isFinite(backgroundBlue),
    "Invalid profile bounds or background",
  );
  const columnMeans = Array.from({ length: width }, (_, column) => {
    let sum = 0;
    for (let row = y; row < y + height; row++)
      sum += at(frame.rgb, (row * frame.width + x + column) * 3 + 2);
    assert.ok(Number.isFinite(sum), "Nonfinite profile pixels");
    return sum / height;
  });
  return {
    columnMeans,
    backgroundBlue,
    integratedContrast: columnMeans.reduce((sum, blue) => sum + blue - backgroundBlue, 0),
  };
}

/** Integrate a higher-raster reference over each display pixel, in linear RGB. */
export function linearFrame(
  image: { width: number; height: number; data: Uint8Array },
  width: number,
  height: number,
): ILinearFrame {
  const scale = image.width / width;
  assert.ok(
    Number.isInteger(scale) && scale >= 1 && image.height / height === scale,
    "Reference reduction requires an equal integer scale on both axes",
  );
  assert.equal(image.data.length, image.width * image.height * 4, "Incomplete RGBA image");
  const rgb = new Float64Array(width * height * 3);
  const linear = Array.from({ length: 256 }, (_, byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const input = (y * image.width + x) * 4;
      const output = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 3;
      assert.equal(image.data[input + 3], 255, "Reference requires opaque pixels");
      for (let channel = 0; channel < 3; channel++)
        rgb[output + channel] =
          at(rgb, output + channel) + at(linear, at(image.data, input + channel)) / (scale * scale);
    }
  }
  return { width, height, rgb };
}

function edges(frame: ILinearFrame): Uint8Array {
  const { width, height, rgb } = frame;
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixel = y * width + x;
      for (const neighbour of [pixel - 1, pixel + 1, pixel - width, pixel + width]) {
        if (
          [0, 1, 2].some(
            (channel) =>
              Math.abs(at(rgb, pixel * 3 + channel) - at(rgb, neighbour * 3 + channel)) > 0.08,
          )
        )
          mask[pixel] = 1;
      }
    }
  }
  return mask;
}

function revealMask(reference: ILinearFrame[], revealIndex: number): number[] {
  const before = at(reference, revealIndex - 1);
  const { width, height } = before;
  const red = (frame: ILinearFrame, pixel: number) =>
    at(frame.rgb, pixel * 3) > 0.7 &&
    at(frame.rgb, pixel * 3 + 1) < 0.08 &&
    at(frame.rgb, pixel * 3 + 2) < 0.08;
  const revealed = Array.from(
    { length: width * height },
    (_, pixel) =>
      red(before, pixel) && reference.slice(revealIndex).every((frame) => !red(frame, pixel)),
  );
  // Exclude coverage boundaries: a two-pixel inset avoids treating ordinary AA as a ghost.
  const interior = [];
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      let valid = true;
      for (let dy = -2; dy <= 2 && valid; dy++)
        for (let dx = -2; dx <= 2; dx++) if (!revealed[(y + dy) * width + x + dx]) valid = false;
      if (valid) interior.push(y * width + x);
    }
  assert.ok(interior.length > 0, "Missing newly revealed interior pixels");
  return interior;
}

function validateSequence(
  reference: ILinearFrame[],
  candidate: ILinearFrame[],
  revealIndex: number,
) {
  assert.ok(
    reference.length >= 4 &&
      candidate.length === reference.length &&
      revealIndex >= 2 &&
      revealIndex < reference.length,
    "Incomplete matched sequence",
  );
  const first = at(reference, 0);
  for (const frame of [...reference, ...candidate]) {
    assert.ok(
      frame.width === first.width &&
        frame.height === first.height &&
        frame.rgb.length === first.width * first.height * 3,
      "Sequence raster mismatch",
    );
    assert.ok(frame.rgb.every(Number.isFinite), "Nonfinite sequence pixels");
  }
  return first;
}

/** Error changes are measured relative to the matching reference, so real motion is not flicker. */
export function measureSequence(
  reference: ILinearFrame[],
  candidate: ILinearFrame[],
  revealIndex: number,
) {
  const first = validateSequence(reference, candidate, revealIndex);
  let error = 0;
  let change = 0;
  let edgeSamples = 0;
  let neighbourhoodPixels = 0;
  let neighbourhoodOvershoot = 0;
  let movingError = 0;
  let movingEdgeSamples = 0;
  let changeSamples = 0;
  const masks = reference.map(edges);
  for (let index = 0; index < revealIndex; index++) {
    const target = at(reference, index);
    const actual = at(candidate, index);
    for (let pixel = 0; pixel < first.width * first.height; pixel++) {
      const x = pixel % first.width;
      const y = Math.floor(pixel / first.width);
      if (x > 0 && y > 0 && x < first.width - 1 && y < first.height - 1) {
        let outside = false;
        for (let channel = 0; channel < 3; channel++) {
          let low = Number.POSITIVE_INFINITY;
          let high = Number.NEGATIVE_INFINITY;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const value = at(target.rgb, ((y + dy) * first.width + x + dx) * 3 + channel);
              low = Math.min(low, value);
              high = Math.max(high, value);
            }
          const value = at(actual.rgb, pixel * 3 + channel);
          outside ||= value < low - 0.01 || value > high + 0.01;
        }
        neighbourhoodPixels++;
        if (outside) neighbourhoodOvershoot++;
      }
      if (at(masks, index)[pixel])
        for (let channel = 0; channel < 3; channel++) {
          const offset = pixel * 3 + channel;
          const delta = Math.abs(at(actual.rgb, offset) - at(target.rgb, offset));
          error += delta;
          edgeSamples++;
          const colour: [number, number, number] = [
            at(target.rgb, pixel * 3),
            at(target.rgb, pixel * 3 + 1),
            at(target.rgb, pixel * 3 + 2),
          ];
          // The fixture's moving orange/purple/cyan objects are saturated. Exclude the red
          // disocclusion marker; this region prevents the static fence dominating velocity QA.
          if (
            Math.max(...colour) - Math.min(...colour) > 0.25 &&
            !(colour[0] > 0.7 && colour[1] < 0.08 && colour[2] < 0.08)
          ) {
            movingError += delta;
            movingEdgeSamples++;
          }
        }
      if (index > 0 && (at(masks, index)[pixel] || at(masks, index - 1)[pixel]))
        for (let channel = 0; channel < 3; channel++) {
          const offset = pixel * 3 + channel;
          change += Math.abs(
            at(actual.rgb, offset) -
              at(target.rgb, offset) -
              (at(at(candidate, index - 1).rgb, offset) - at(at(reference, index - 1).rgb, offset)),
          );
          changeSamples++;
        }
    }
  }
  assert.ok(edgeSamples > 0 && changeSamples > 0, "No measurable reference edges");
  const pixels = revealMask(reference, revealIndex);
  const before = at(reference, revealIndex - 1);
  const reveal = reference.slice(revealIndex).map((target, afterReveal) => {
    const actual = at(candidate, revealIndex + afterReveal);
    let error = 0;
    let stale = 0;
    let weight = 0;
    for (const pixel of pixels) {
      let dot = 0;
      let length = 0;
      for (let channel = 0; channel < 3; channel++) {
        const offset = pixel * 3 + channel;
        const residual = at(actual.rgb, offset) - at(target.rgb, offset);
        const oldColour = at(before.rgb, offset) - at(target.rgb, offset);
        error += Math.abs(residual);
        dot += residual * oldColour;
        length += oldColour * oldColour;
      }
      const residue = Math.max(0, dot / Math.max(length, 1e-8));
      if (residue > 0.1) stale++;
      weight += residue;
    }
    return {
      afterReveal,
      meanAbsoluteError: error / (pixels.length * 3),
      meanStaleWeight: weight / pixels.length,
      staleFraction: stale / pixels.length,
    };
  });
  return {
    edgeError: error / edgeSamples,
    // Local-reference excursion proxy, not a causal classification of ringing.
    neighbourhoodOvershootFraction: neighbourhoodOvershoot / neighbourhoodPixels,
    residualInstability: change / changeSamples,
    edgeSamples,
    movingEdgeError: movingEdgeSamples === 0 ? null : movingError / movingEdgeSamples,
    movingEdgeSamples,
    revealedPixels: pixels.length,
    reveal,
  };
}

/**
 * Fixture-specific causal diagnostic: same temporal policy/pose, but the pure-red marker was
 * never present in `open`. Neutral brightening/darkening is not evidence of added red history.
 * This supplements the original conservative projection score; it does not replace its gate.
 */
export function measureCausalReveal(
  reference: ILinearFrame[],
  candidate: ILinearFrame[],
  open: ILinearFrame[],
  revealIndex: number,
) {
  validateSequence(reference, candidate, revealIndex);
  validateSequence(reference, open, revealIndex);
  const pixels = revealMask(reference, revealIndex);
  const before = at(reference, revealIndex - 1);
  return candidate.slice(revealIndex).map((actual, afterReveal) => {
    const control = at(open, revealIndex + afterReveal);
    let changed = 0;
    let weight = 0;
    let absolute = 0;
    for (const pixel of pixels) {
      const offset = pixel * 3;
      const dr = at(actual.rgb, offset) - at(control.rgb, offset);
      const dg = at(actual.rgb, offset + 1) - at(control.rgb, offset + 1);
      const db = at(actual.rgb, offset + 2) - at(control.rgb, offset + 2);
      const redRoom = at(before.rgb, offset) - at(control.rgb, offset);
      assert.ok(redRoom > 0.05, "Red marker must be distinguishable from the open control");
      const residue = Math.max(0, dr - Math.max(0, dg, db)) / redRoom;
      weight += residue;
      if (residue > 0.1) changed++;
      absolute += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
    }
    return {
      afterReveal,
      redTintFraction: changed / pixels.length,
      meanRedHistoryWeight: weight / pixels.length,
      meanAbsoluteDifference: absolute / (pixels.length * 3),
    };
  });
}
