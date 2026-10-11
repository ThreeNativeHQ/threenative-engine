/**
 * Image header inspection for registered files: the real format, the real pixel size and whether the
 * container is whole. It reads headers, never pixels, and never decodes into a texture: the project's
 * render source loads the image through `ctx.assets` with the colour space its channel needs.
 */

export interface IImageReport {
  readonly format: "png" | "jpeg" | "webp" | "hdr" | "exr";
  readonly width: number;
  readonly height: number;
  readonly diagnostics: string[];
}

/**
 * What an image's pixels mean once a game binds them. Colour is stored in sRGB and decoded to linear
 * when sampled; every other channel is a number and must never be decoded.
 */
/**
 * The colour space of each surface channel.
 * @summary Map a PBR channel name to the colour space its pixels are read in
 * @requires npm i -D @threenative/terrain
 * @situation load an imported albedo as sRGB and a normal, roughness, ao, height, opacity or metalness map as linear data
 * @constraint a table only; the project's render source loads and binds the texture
 * @example const space = SURFACE_CHANNELS.normal;
 * @override the project owns which surface inputs exist and what they draw
 */
export const SURFACE_CHANNELS = {
  albedo: "srgb",
  ao: "linear",
  height: "linear",
  metalness: "linear",
  normal: "linear",
  opacity: "linear",
  roughness: "linear",
} as const;
export type ISurfaceChannel = keyof typeof SURFACE_CHANNELS;

function fail(message: string): never {
  throw new Error(message);
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(bytes: Uint8Array): IImageReport {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let sawData = false;
  let sawEnd = false;
  const diagnostics: string[] = [];
  for (let offset = 8; offset < bytes.byteLength; ) {
    if (offset + 12 > bytes.byteLength) fail("PNG chunk is truncated");
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > bytes.byteLength) fail(`PNG ${type} chunk runs past the end`);
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(body) !== view.getUint32(offset + 8 + length))
      fail(`PNG ${type} chunk fails its checksum; the file is damaged`);
    if (type === "IHDR") {
      if (length !== 13) fail("PNG header is malformed");
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = bytes[offset + 16] as number;
    } else if (type === "IDAT") sawData = true;
    else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height) fail("PNG has no header");
  if (!sawData || !sawEnd) fail("PNG is missing its image data or end marker");
  if (depth === 16) diagnostics.push("16-bit PNG: browsers decode it to 8 bits per channel");
  return { format: "png", width, height, diagnostics };
}

function jpeg(bytes: Uint8Array): IImageReport {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) fail("JPEG has a damaged marker");
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (offset + 9 > bytes.byteLength) fail("JPEG frame header is truncated");
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (!width || !height) fail("JPEG has no size");
      const ended = bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9;
      if (!ended) fail("JPEG is truncated: it has no end marker");
      return { format: "jpeg", width, height, diagnostics: [] };
    }
    offset += 2 + length;
  }
  return fail("JPEG has no frame header");
}

function webp(bytes: Uint8Array): IImageReport {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength)
    fail("WebP length header disagrees with the file");
  const kind = String.fromCharCode(...bytes.subarray(12, 16));
  if (bytes.byteLength < 30) fail("WebP header is truncated");
  if (kind === "VP8X")
    return {
      format: "webp",
      width:
        1 + (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16),
      height:
        1 + (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16),
      diagnostics: [],
    };
  if (kind === "VP8 ")
    return {
      format: "webp",
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
      diagnostics: [],
    };
  if (kind === "VP8L") {
    const bits = view.getUint32(21, true);
    return {
      format: "webp",
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
      diagnostics: [],
    };
  }
  return fail(`WebP chunk '${kind}' is not supported`);
}

function hdr(bytes: Uint8Array): IImageReport {
  const head = new TextDecoder("latin1").decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 4096)),
  );
  const end = head.indexOf("\n\n");
  if (end < 0) fail("Radiance HDR header is not terminated");
  if (!/FORMAT=32-bit_rle_rgbe/u.test(head.slice(0, end)))
    fail("Radiance HDR must be 32-bit_rle_rgbe");
  const size = /^([-+])Y (\d+) ([-+])X (\d+)/mu.exec(head.slice(end + 2));
  if (!size) fail("Radiance HDR has no resolution line");
  return { format: "hdr", width: Number(size[4]), height: Number(size[2]), diagnostics: [] };
}

function exr(bytes: Uint8Array): IImageReport {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder("latin1");
  let offset = 8;
  let window: [number, number, number, number] | undefined;
  let compression: number | undefined;
  while (offset < bytes.byteLength && bytes[offset] !== 0) {
    const nameEnd = bytes.indexOf(0, offset);
    const typeEnd = bytes.indexOf(0, nameEnd + 1);
    if (nameEnd < 0 || typeEnd < 0 || typeEnd + 5 > bytes.byteLength)
      fail("EXR header is truncated");
    const name = text.decode(bytes.subarray(offset, nameEnd));
    const size = view.getInt32(typeEnd + 1, true);
    const value = typeEnd + 5;
    if (size < 0 || value + size > bytes.byteLength) fail("EXR attribute runs past the file");
    if (name === "dataWindow" && size === 16)
      window = [
        view.getInt32(value, true),
        view.getInt32(value + 4, true),
        view.getInt32(value + 8, true),
        view.getInt32(value + 12, true),
      ];
    if (name === "compression") compression = bytes[value];
    offset = value + size;
  }
  if (!window) fail("EXR has no data window");
  const diagnostics: string[] = [];
  // Three's EXRLoader reads none, RLE, ZIPS, ZIP, PIZ, PXR24 and DWAA/DWAB lossy blocks; B44 is not.
  if (compression === 6 || compression === 7)
    diagnostics.push("EXR B44 compression is not read by the loader");
  return {
    format: "exr",
    width: window[2] - window[0] + 1,
    height: window[3] - window[1] + 1,
    diagnostics,
  };
}

/**
 * Validate a PNG, JPEG, WebP, Radiance HDR or OpenEXR container and read its pixel size.
 * @summary Inspect an image file's container and pixel size without decoding it
 * @requires npm i -D @threenative/terrain
 * @situation check an imported surface or environment image for damage and for the project's size limit
 * @constraint headers and checksums only; throws by name for a damaged, truncated or oversize file
 * @example const report = inspectImage(bytes, "png", { maxDimension: 8192 });
 * @override the project sets the dimension limit
 */
export function inspectImage(
  bytes: Uint8Array,
  format: string,
  limits: { maxDimension: number },
): IImageReport {
  const report =
    format === "png"
      ? png(bytes)
      : format === "jpeg"
        ? jpeg(bytes)
        : format === "webp"
          ? webp(bytes)
          : format === "hdr"
            ? hdr(bytes)
            : format === "exr"
              ? exr(bytes)
              : fail(`'${format}' is not a supported image format`);
  if (report.width > limits.maxDimension || report.height > limits.maxDimension)
    fail(
      `Image is ${report.width}x${report.height}; this project's limit is ${limits.maxDimension} pixels`,
    );
  // The asset pipeline's block-compressed targets need whole 4x4 blocks; a file that is not would be
  // rejected at draw time, so it is reported here while the file is still in hand.
  if (report.width % 4 || report.height % 4)
    report.diagnostics.push(
      "Size is not a multiple of 4: block compression of this image would fail",
    );
  return report;
}
