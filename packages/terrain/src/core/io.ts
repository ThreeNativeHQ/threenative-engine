import { validateBakedMesh } from "./bake.js";
import { MATERIAL_IDS } from "./masks.js";
import { clamp } from "./math.js";
import type {
  IBakedMesh,
  IDecodeHeightPngOptions,
  IDecodeRaw16Options,
  IExportFile,
  IHeightPngMetadata,
  IHeightRange,
  IRaw16Options,
  ITerrainState,
} from "./types.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, initial) => {
  let n = initial;
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const join = (arrays: readonly Uint8Array[]) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};
function heightRange(
  values: ArrayLike<number> & Iterable<number>,
  { min, max }: Partial<IHeightRange> = {},
) {
  for (const v of values) if (!Number.isFinite(v)) throw TypeError("Height data must be finite");
  if (min === undefined || max === undefined) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of values) {
      if (!Number.isFinite(v)) throw TypeError("Height data must be finite");
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    min ??= lo;
    max ??= hi > lo ? hi : lo + 1;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
    throw RangeError("Height range must be finite and max > min");
  return { min, max };
}
/**
 * Encodes finite metre elevations as an explicit-range RAW16 buffer.
 * @requires npm i @threenative/terrain
 * @situation export terrain heights with a numerical range sidecar
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const raw = encodeRAW16(new Float32Array([0, 1]), { min: 0, max: 1 });
 */
export function encodeRAW16(
  values: ArrayLike<number> & Iterable<number>,
  options: IRaw16Options = {},
) {
  const { min, max } = heightRange(values, options);
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++)
    view.setUint16(
      i * 2,
      Math.round(clamp(((values[i] as number) - min) / (max - min)) * 65535),
      options.littleEndian !== false,
    );
  return bytes;
}
/**
 * Validates dimensions and range before decoding numerical height samples.
 * @requires npm i @threenative/terrain
 * @situation import a RAW16 terrain height buffer with explicit dimensions
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const decoded = decodeRAW16(new Uint8Array(8), { width: 2, height: 2, min: 0, max: 1 });
 */
export function decodeRAW16(
  input: Uint8Array | ArrayBuffer,
  { width, height, min = 0, max = 1, littleEndian = true }: IDecodeRaw16Options,
) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4097 ** 2 ||
    bytes.length !== width * height * 2
  )
    throw RangeError("RAW byte length must match width × height × 2");
  heightRange([min, max], { min, max });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++)
    values[i] = min + (view.getUint16(i * 2, littleEndian) / 65535) * (max - min);
  return { width, height, values, min, max };
}
function chunk(type: string, content: Uint8Array) {
  const bytes = new Uint8Array(content.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, content.length);
  bytes.set(encoder.encode(type), 4);
  bytes.set(content, 8);
  view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
  return bytes;
}
async function compress(bytes: Uint8Array) {
  if (typeof CompressionStream === "undefined")
    throw Error("PNG export requires CompressionStream (modern browser or Node 22+)");
  return new Uint8Array(
    await new Response(
      new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
}
async function inflate(bytes: Uint8Array, expected: number) {
  if (typeof DecompressionStream === "undefined")
    throw Error("PNG import requires DecompressionStream");
  const reader = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > expected) {
        await reader.cancel();
        throw Error("PNG decompressed size exceeds declared dimensions");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== expected) throw Error("PNG decompressed byte length mismatch");
  return join(parts);
}
async function encodePNG(
  width: number,
  height: number,
  bytes: Uint8Array,
  bitDepth: number,
  colorType: number,
  metadata?: IHeightPngMetadata,
) {
  const channels = colorType === 6 ? 4 : 1;
  const rowBytes = width * channels * (bitDepth / 8);
  if (bytes.length !== rowBytes * height) throw RangeError("PNG pixel byte count mismatch");
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (metadata)
    parts.push(chunk("tEXt", encoder.encode(`StrataHeightRange\0${JSON.stringify(metadata)}`)));
  parts.push(chunk("IDAT", await compress(raw)), chunk("IEND", new Uint8Array()));
  return join(parts);
}
/**
 * Encodes numerical grayscale PNG16 with embedded elevation range.
 * @requires npm i @threenative/terrain
 * @situation export a terrain heightmap without an eight-bit colour conversion
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const png = await encodeHeightPNG(new Terrain({ resolution: 17 }).evaluate());
 */
export async function encodeHeightPNG(state: ITerrainState, options: Partial<IHeightRange> = {}) {
  const values = state.height;
  const range = heightRange(values, options);
  const bytes = encodeRAW16(values, { ...range, littleEndian: false });
  return encodePNG(state.resolution, state.resolution, bytes, 16, 0, range);
}
/**
 * Encodes the eight linear material-weight channels as two RGBA images.
 * @requires npm i @threenative/terrain
 * @situation export terrain splat weights as linear data
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const maps = await encodeSplatPNGs(new Terrain({ resolution: 17 }).evaluate());
 */
export async function encodeSplatPNGs(state: ITerrainState) {
  const maps = [];
  for (let pack = 0; pack < 2; pack++) {
    const bytes = new Uint8Array(state.height.length * 4);
    for (let i = 0; i < state.height.length; i++)
      for (let c = 0; c < 4; c++)
        bytes[i * 4 + c] = Math.round(clamp(state.splat[i * 8 + pack * 4 + c] as number) * 255);
    maps.push({
      channels: MATERIAL_IDS.slice(pack * 4, pack * 4 + 4),
      bytes: await encodePNG(state.resolution, state.resolution, bytes, 8, 6),
    });
  }
  return maps;
}
const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
/**
 * CRC-checked bounded non-interlaced grayscale PNG height decoder.
 * @requires npm i @threenative/terrain
 * @situation import numerical PNG8 or PNG16 terrain elevations
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const png = await encodeHeightPNG(new Terrain({ resolution: 17 }).evaluate()); const heights = await decodeHeightPNG(png);
 */
export async function decodeHeightPNG(
  input: Uint8Array | ArrayBuffer,
  options: IDecodeHeightPngOptions = {},
) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((v, i) => bytes[i] === v))
    throw Error("Not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: Uint8Array[] = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let metadata: Partial<IHeightRange> = {};
  let ended = false;
  let seenHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (length > 64 * 1024 * 1024 || end > bytes.length)
      throw Error("Truncated or oversized PNG chunk");
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4))
      throw Error(`PNG CRC mismatch in ${type}`);
    const data = bytes.subarray(offset + 8, end - 4);
    if (!seenHeader && type !== "IHDR") throw Error("PNG IHDR must be first");
    if (type === "IHDR") {
      if (seenHeader || length !== 13) throw Error("Invalid PNG IHDR");
      seenHeader = true;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = data[8] as number;
      colorType = data[9] as number;
      if (!width || !height || width > 4097 || height > 4097)
        throw Error("PNG dimensions must be 1..4097");
      if (
        colorType !== 0 ||
        ![8, 16].includes(bitDepth) ||
        (data[12] as number) !== 0 ||
        (data[10] as number) !== 0 ||
        (data[11] as number) !== 0
      )
        throw Error("Heightmap import supports non-interlaced 8/16-bit grayscale PNG only");
    }
    if (type === "tEXt") {
      const text = decoder.decode(data);
      if (text.startsWith("StrataHeightRange\0")) {
        try {
          metadata = JSON.parse(text.slice(18));
        } catch {
          throw Error("Invalid PNG height range metadata");
        }
      }
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") {
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || !idat.length) throw Error("Incomplete PNG chunks");
  const bpp = bitDepth / 8;
  const row = width * bpp;
  const raw = await inflate(join(idat), (row + 1) * height);
  const pixels = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (row + 1)] as number;
    if (filter > 4) throw Error("Unsupported PNG row filter");
    for (let x = 0; x < row; x++) {
      const v = raw[y * (row + 1) + 1 + x] as number;
      const i = y * row + x;
      const a = x >= bpp ? (pixels[i - bpp] as number) : 0;
      const b = y > 0 ? (pixels[i - row] as number) : 0;
      const c = y > 0 && x >= bpp ? (pixels[i - row - bpp] as number) : 0;
      pixels[i] =
        (v +
          (filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : filter === 4
                  ? paeth(a, b, c)
                  : 0)) &
        255;
    }
  }
  const { min, max } = heightRange([0, 1], {
    min: options.min ?? metadata.min ?? 0,
    max: options.max ?? metadata.max ?? 1,
  });
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) {
    const v =
      bpp === 2
        ? ((pixels[i * 2] as number) << 8) | (pixels[i * 2 + 1] as number)
        : (pixels[i] as number);
    values[i] = min + (v / (bpp === 2 ? 65535 : 255)) * (max - min);
  }
  return {
    width,
    height,
    values,
    min,
    max,
    bitDepth,
    hasEmbeddedRange: Number.isFinite(metadata.min) && Number.isFinite(metadata.max),
  };
}
/** Engine-independent GLB 2.0: static colored terrain geometry, no hidden external resources. */
/**
 * Legacy terrain-only GLB encoding with embedded mesh arrays and no chosen material.
 * @requires npm i @threenative/terrain
 * @situation export baked terrain geometry without engine extensions
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const glb = encodeGLB(bakeMesh(new Terrain({ resolution: 17 }).evaluate()));
 */
export function encodeGLB(input: IBakedMesh | readonly IBakedMesh[]) {
  const meshes: readonly IBakedMesh[] = Array.isArray(input) ? input : [input as IBakedMesh];
  if (!meshes.length) throw new RangeError("GLB requires at least one baked mesh");
  for (const mesh of meshes) validateBakedMesh(mesh);
  const chunks: Uint8Array[] = [];
  const bufferViews: IBufferView[] = [];
  const accessors: IAccessor[] = [];
  const gltfMeshes: {
    name: string;
    primitives: { attributes: Record<string, number>; indices: number; mode: number }[];
  }[] = [];
  let offset = 0;
  const add = (
    array: Float32Array | Uint32Array,
    type: string,
    componentType: number,
    target: number,
    minMax = false,
  ) => {
    const aligned = (offset + 3) & ~3;
    if (aligned > offset) {
      chunks.push(new Uint8Array(aligned - offset));
      offset = aligned;
    }
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice();
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    offset += bytes.length;
    const size = type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1;
    const accessor: IAccessor = {
      bufferView: view,
      componentType,
      count: array.length / size,
      type,
    };
    if (minMax) {
      accessor.min = Array(size).fill(Number.POSITIVE_INFINITY);
      accessor.max = Array(size).fill(Number.NEGATIVE_INFINITY);
      for (let i = 0; i < array.length; i++) {
        const c = i % size;
        accessor.min[c] = Math.min(accessor.min[c] as number, array[i] as number);
        accessor.max[c] = Math.max(accessor.max[c] as number, array[i] as number);
      }
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  for (const m of meshes) {
    const attributes: Record<string, number> = {
      POSITION: add(m.positions, "VEC3", 5126, 34962, true),
      NORMAL: add(m.normals, "VEC3", 5126, 34962),
      TEXCOORD_0: add(m.uvs, "VEC2", 5126, 34962),
    };
    if (m.colors) attributes.COLOR_0 = add(m.colors, "VEC3", 5126, 34962);
    gltfMeshes.push({
      name: m.name ?? "Terrain",
      primitives: [{ attributes, indices: add(m.indices, "SCALAR", 5125, 34963), mode: 4 }],
    });
  }
  const binary = join(chunks);
  const doc = {
    asset: { version: "2.0", generator: "Strata Terrain 0.1.0" },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((m, i) => ({ mesh: i, name: m.name ?? `Terrain ${i}` })),
    meshes: gltfMeshes,
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
  };
  const json = encoder.encode(JSON.stringify(doc));
  const jsonLength = (json.length + 3) & ~3;
  const binLength = (binary.length + 3) & ~3;
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, jsonLength, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + jsonLength);
  out.set(json, 20);
  const start = 20 + jsonLength;
  v.setUint32(start, binLength, true);
  v.setUint32(start + 4, 0x004e4942, true);
  out.set(binary, start + 8);
  return out;
}

interface IBufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target: number;
}
interface IAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
