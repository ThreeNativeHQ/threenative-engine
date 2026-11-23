import {
  DataTexture,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from "three";

/**
 * A strand data atlas in the layout `createHairCardMaterial` reads: R coverage, G root (0) to tip
 * (1), B a per-strand seed. `strands` hair strands run root to tip along the card's V, each an
 * anti-aliased line that tapers and fades at its own length, packed so the roots cover the card. The atlas is data, so it carries no colour space.
 */
export function strandAtlas(strands = 40, width = 128, height = 256): DataTexture {
  const data = new Uint8Array(width * height * 4);
  // A fixed hash per strand: its seed, its length and its sideways wander.
  const hash = (n: number): number => Math.abs((Math.sin(n * 12.9898) * 43758.5453) % 1);
  for (let y = 0; y < height; y++) {
    const along = y / (height - 1);
    for (let x = 0; x < width; x++) {
      let coverage = 0;
      let seed = 0;
      for (let lane = 0; lane < strands; lane++) {
        const own = hash(lane + 1);
        const tip = 0.7 + 0.3 * hash(lane + 101);
        if (along > tip) continue;
        const centre = ((lane + 0.5 + 0.6 * Math.sin(along * 4 + own * 6.28)) / strands) * width;
        // Half a texel of anti-aliased edge on a strand that tapers from 1.8 px to 0.6 px.
        const half = 1.8 - 1.2 * (along / tip);
        const edge = Math.min(1, Math.max(0, half + 0.5 - Math.abs(x + 0.5 - centre)));
        const fade = Math.min(1, (tip - along) / 0.12);
        const c = edge * fade;
        if (c > coverage) {
          coverage = c;
          seed = own;
        }
      }
      const i = (y * width + x) * 4;
      data[i] = Math.round(coverage * 255);
      data[i + 1] = Math.round(along * 255);
      data[i + 2] = Math.round(seed * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  // Card layers read the atlas at their own U offset.
  texture.wrapS = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The strand direction for three's `anisotropyMap`: RG the tangent-space direction in [0, 1]
 * (0.5 is zero), B the strength. A strand runs along V, so the direction is +V everywhere.
 */
export function strandTangents(width = 4, height = 4): DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([128, 255, 255, 255], i);
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
