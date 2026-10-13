/**
 * The probe's read-back for a host that draws after the frame callback returns (the engine player). Its
 * `tn.readFrame()` answers with the last frame the player DREW, and inside the callback that stepped frame N
 * that is frame N-1: the probe picture lagged the web arm's, which re-renders frame N into a target, by one
 * step of every cube's rotation. Waiting one frame callback lets the player draw frame N first, and nothing
 * steps the scene in between.
 */
export function drawnFrameReader<T>(
  nextFrame: () => Promise<unknown>,
  read: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    await nextFrame();
    return read();
  };
}

/** Area-weighted box averages, including partial source pixels at non-integer scale ratios. */
export function downscaleFrame(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): Uint8Array {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    pixels.length !== width * height * 4
  )
    throw new Error("TN_BENCH_PROBE_SIZE");
  const output = new Uint8Array(160 * 90 * 4);
  const area = (width / 160) * (height / 90);
  for (let y = 0; y < 90; y++) {
    const top = (y * height) / 90;
    const bottom = ((y + 1) * height) / 90;
    for (let x = 0; x < 160; x++) {
      const left = (x * width) / 160;
      const right = ((x + 1) * width) / 160;
      const sums = [0, 0, 0, 0];
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++)
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weight =
            (Math.min(bottom, sy + 1) - Math.max(top, sy)) *
            (Math.min(right, sx + 1) - Math.max(left, sx));
          for (let channel = 0; channel < 4; channel++)
            sums[channel] =
              (sums[channel] as number) +
              (pixels[(sy * width + sx) * 4 + channel] as number) * weight;
        }
      for (let channel = 0; channel < 4; channel++)
        output[(y * 160 + x) * 4 + channel] = Math.round((sums[channel] as number) / area);
    }
  }
  return output;
}
