/**
 * three's `HDRLoader.parse` (r185, MIT) as plain JS: Radiance RGBE bytes to the RGBA texels three
 * uploads, shared by both engine back ends. Only the byte source differs per target, so each back
 * end's `HDRLoader` reads the file and hands the bytes here.
 *
 * The decode is three's: `2^(e-128)/255` per channel, alpha 1, rows as stored (three sets `flipY`),
 * and `HalfFloatType` (the default) through three's own truncating binary16 conversion.
 */
import { toHalfFloat } from "./data-utils.js";

export const FLOAT_TYPE = 1015;
export const HALF_FLOAT_TYPE = 1016;

export interface IHDRImage {
  readonly width: number;
  readonly height: number;
  /** RGBA: binary16 bits for HalfFloatType, float32 for FloatType. */
  readonly data: Uint16Array | Float32Array;
  readonly type: typeof FLOAT_TYPE | typeof HALF_FLOAT_TYPE;
  readonly gamma: number;
  readonly exposure: number;
}

function fail(message: string): never {
  throw new Error(`TN_HDR_INVALID: ${message}`);
}

/** The header lines, as three's `RGBE_ReadHeader` reads them; returns the pixel offset. */
function readHeader(bytes: Uint8Array) {
  let pos = 0;
  const line = (): string | undefined => {
    const end = bytes.indexOf(0x0a, pos);
    if (end < 0 || end - pos > 1024) return undefined;
    const text = String.fromCharCode(...bytes.subarray(pos, end));
    pos = end + 1;
    return text;
  };
  if (!/^#\?(\S+)/.test(line() ?? "")) fail("bad initial token");
  let format = false;
  let width = 0;
  let height = 0;
  let gamma = 1;
  let exposure = 1;
  for (let text = line(); text !== undefined; text = line()) {
    if (text.startsWith("#")) continue;
    let match = /^\s*GAMMA\s*=\s*(\d+(\.\d+)?)\s*$/.exec(text);
    if (match) gamma = Number.parseFloat(match[1] ?? "1");
    match = /^\s*EXPOSURE\s*=\s*(\d+(\.\d+)?)\s*$/.exec(text);
    if (match) exposure = Number.parseFloat(match[1] ?? "1");
    if (/^\s*FORMAT=(\S+)\s*$/.test(text)) format = true;
    match = /^\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/.exec(text);
    if (match) {
      height = Number.parseInt(match[1] ?? "0", 10);
      width = Number.parseInt(match[2] ?? "0", 10);
    }
    if (format && width > 0) break;
  }
  if (!format) fail("missing format specifier");
  if (!(width > 0 && height > 0)) fail("missing image size specifier");
  return { pos, width, height, gamma, exposure };
}

/** RGBE pixels, run-length decoded per scanline (three's `RGBE_ReadPixels_RLE`). */
function readPixels(bytes: Uint8Array, width: number, height: number): Uint8Array {
  if (
    width < 8 ||
    width > 0x7fff ||
    bytes[0] !== 2 ||
    bytes[1] !== 2 ||
    ((bytes[2] ?? 0) & 0x80) !== 0
  )
    return bytes;
  if (width !== (((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0))) fail("wrong scanline width");
  const rgba = new Uint8Array(4 * width * height);
  const scanline = new Uint8Array(4 * width);
  let offset = 0;
  let pos = 0;
  for (let row = 0; row < height && pos < bytes.length; ++row) {
    if (pos + 4 > bytes.length) fail("read error");
    if (
      bytes[pos] !== 2 ||
      bytes[pos + 1] !== 2 ||
      (((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0)) !== width
    )
      fail("bad rgbe scanline format");
    pos += 4;
    let ptr = 0;
    while (ptr < scanline.length && pos < bytes.length) {
      let count = bytes[pos++] ?? 0;
      const run = count > 128;
      if (run) count -= 128;
      if (count === 0 || ptr + count > scanline.length) fail("bad scanline data");
      if (run) {
        scanline.fill(bytes[pos++] ?? 0, ptr, ptr + count);
      } else {
        scanline.set(bytes.subarray(pos, pos + count), ptr);
        pos += count;
      }
      ptr += count;
    }
    for (let i = 0; i < width; ++i, offset += 4) {
      rgba[offset] = scanline[i] ?? 0;
      rgba[offset + 1] = scanline[i + width] ?? 0;
      rgba[offset + 2] = scanline[i + 2 * width] ?? 0;
      rgba[offset + 3] = scanline[i + 3 * width] ?? 0;
    }
  }
  return rgba;
}

/** Decodes a Radiance `.hdr` file to the texels three's HDRLoader produces for `type`. */
export function parseHDR(buffer: ArrayBuffer, type: number = HALF_FLOAT_TYPE): IHDRImage {
  if (type !== HALF_FLOAT_TYPE && type !== FLOAT_TYPE) fail(`unsupported type ${type}`);
  const bytes = new Uint8Array(buffer);
  const header = readHeader(bytes);
  const rgbe = readPixels(bytes.subarray(header.pos), header.width, header.height);
  // three keeps whatever length a flat file has; the engine needs exactly width * height texels.
  if (rgbe.length !== 4 * header.width * header.height)
    fail("pixel data does not match the image size");
  const texels = header.width * header.height;
  const data = type === FLOAT_TYPE ? new Float32Array(texels * 4) : new Uint16Array(texels * 4);
  const one = type === FLOAT_TYPE ? 1 : toHalfFloat(1);
  for (let j = 0; j < texels * 4; j += 4) {
    const scale = 2 ** ((rgbe[j + 3] ?? 0) - 128) / 255;
    for (let c = 0; c < 3; ++c) {
      const value = (rgbe[j + c] ?? 0) * scale;
      data[j + c] = type === FLOAT_TYPE ? value : toHalfFloat(Math.min(value, 65504));
    }
    data[j + 3] = one;
  }
  return {
    width: header.width,
    height: header.height,
    data,
    type: type as IHDRImage["type"],
    gamma: header.gamma,
    exposure: header.exposure,
  };
}
