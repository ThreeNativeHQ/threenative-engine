import { DataTexture, LinearFilter, NoColorSpace, RGBAFormat, UnsignedByteType } from "three";

/**
 * A strand data atlas in the layout `createHairCardMaterial` reads: R coverage, G root (0) to tip
 * (1), B a per-strand seed. `strands` hair strands run root to tip across the card's U, each a soft
 * line that thins toward the tip. The atlas is data, so it carries no colour space.
 */
export function strandAtlas(strands = 7, width = 64, height = 128): DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const along = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const lane = Math.min(strands - 1, Math.floor(u * strands));
      // A fixed hash per strand: its seed, a sideways wander and a length.
      const hash = (Math.sin((lane + 1) * 12.9898) * 43758.5453) % 1;
      const seed = Math.abs(hash);
      const centre = (lane + 0.5 + 0.25 * Math.sin(along * 5 + seed * 6.28)) / strands;
      const halfWidth = (0.42 / strands) * (1 - 0.6 * along);
      const distance = Math.abs(u - centre) / halfWidth;
      const tipFade = along > 0.75 + 0.2 * seed ? 0 : 1;
      const coverage = Math.max(0, 1 - distance * distance) * tipFade;
      const i = (y * width + x) * 4;
      data[i] = Math.round(coverage * 255);
      data[i + 1] = Math.round(along * 255);
      data[i + 2] = Math.round(seed * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
