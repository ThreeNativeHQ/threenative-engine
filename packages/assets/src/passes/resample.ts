/** sRGB decode table; averaging in sRGB space darkens a downsampled colour map. */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let value = 0; value < 256; value += 1) {
  const channel = value / 255;
  SRGB_TO_LINEAR[value] = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const encoded = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

/**
 * Box-resamples tight RGBA down to the target size, averaging over the exact source area each
 * destination texel covers. Colour channels of an sRGB image are averaged in linear light —
 * the naive average of encoded values is visibly darker — while alpha is always linear.
 */
export function resampleRgba(
  data: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  srgb: boolean,
): Uint8Array {
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  const scaleX = width / targetWidth;
  const scaleY = height / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = ty * scaleY;
    const y1 = (ty + 1) * scaleY;
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = tx * scaleX;
      const x1 = (tx + 1) * scaleX;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let total = 0;
      for (let sy = Math.floor(y0); sy < Math.min(height, Math.ceil(y1)); sy += 1) {
        const weightY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (weightY <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(width, Math.ceil(x1)); sx += 1) {
          const weightX = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (weightX <= 0) continue;
          const weight = weightX * weightY;
          const offset = (sy * width + sx) * 4;
          const r = data[offset] ?? 0;
          const g = data[offset + 1] ?? 0;
          const b = data[offset + 2] ?? 0;
          red += (srgb ? (SRGB_TO_LINEAR[r] ?? 0) : r) * weight;
          green += (srgb ? (SRGB_TO_LINEAR[g] ?? 0) : g) * weight;
          blue += (srgb ? (SRGB_TO_LINEAR[b] ?? 0) : b) * weight;
          alpha += (data[offset + 3] ?? 255) * weight;
          total += weight;
        }
      }
      const divisor = total === 0 ? 1 : total;
      const target = (ty * targetWidth + tx) * 4;
      output[target] = srgb ? linearToSrgb(red / divisor) : Math.round(red / divisor);
      output[target + 1] = srgb ? linearToSrgb(green / divisor) : Math.round(green / divisor);
      output[target + 2] = srgb ? linearToSrgb(blue / divisor) : Math.round(blue / divisor);
      output[target + 3] = Math.round(alpha / divisor);
    }
  }
  return output;
}
