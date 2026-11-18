import sharp from "sharp";

/**
 * RGBA8 pixels (row 0 at the bottom, as Arbor and three DataTextures store them) as a WebP.
 * `lossless` keeps every byte, colour under zero alpha included (`exact`): Outcrop keeps height and
 * roughness in alpha, so its maps need it. Otherwise q80 with lossless alpha, the smallest setting
 * whose texture still reads the same (PRD-900 compression study); a cutout edge stays exact.
 */
export function rgbaWebp(
  width: number,
  height: number,
  bottomUp: Uint8Array,
  lossless = false,
  outWidth = width,
): Promise<Buffer> {
  const stride = width * 4;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    rows.set(bottomUp.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  return sharp(rows, { raw: { channels: 4, height, width } })
    .resize(outWidth)
    .webp(
      lossless
        ? { effort: 4, exact: true, lossless: true }
        : { alphaQuality: 100, effort: 4, quality: 80 },
    )
    .toBuffer();
}

/** One box-blur pass along a line of `length` samples, `stride` apart, edges clamped. */
function boxLine(
  src: Float32Array,
  out: Float32Array,
  start: number,
  stride: number,
  length: number,
  r: number,
): void {
  const at = (k: number) => start + Math.min(length - 1, Math.max(0, k)) * stride;
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += src[at(k)] as number;
  for (let k = 0; k < length; k++) {
    out[start + k * stride] = sum / (2 * r + 1);
    sum += (src[at(k + r + 1)] as number) - (src[at(k - r)] as number);
  }
}

/** Two box-blur passes over one channel, radius r: close to a Gaussian of sigma about r. */
function blur(src: Float32Array, width: number, height: number, r: number): Float32Array {
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    const rows = new Float32Array(a.length);
    for (let y = 0; y < height; y++) boxLine(a, rows, y * width, 1, width, r);
    const cols = new Float32Array(a.length);
    for (let x = 0; x < width; x++) boxLine(rows, cols, x, width, height, r);
    a = cols;
  }
  return a;
}

/**
 * A tangent-space normal map (bottom-up RGBA8, OpenGL +Y) cooked from a leaf atlas's own coverage
 * and veins: each leaf domes up from its edge, and a vein (a stroke lighter than its surroundings)
 * is a groove. A cutout card otherwise has one flat normal and reads as a sticker.
 */
export function leafNormal(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const n = width * height;
  const alpha = new Float32Array(n);
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    alpha[i] = (rgba[i * 4 + 3] as number) / 255;
    luma[i] =
      (0.3 * (rgba[i * 4] as number) +
        0.59 * (rgba[i * 4 + 1] as number) +
        0.11 * (rgba[i * 4 + 2] as number)) /
      255;
  }
  const r = Math.max(2, Math.round(width / 160));
  const dome = blur(alpha, width, height, r);
  const around = blur(luma, width, height, Math.max(1, r >> 1));
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++)
    h[i] =
      (dome[i] as number) -
      2 * Math.max(0, (luma[i] as number) - (around[i] as number)) * (alpha[i] as number);
  const at = (x: number, y: number) =>
    h[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))] as number;
  const out = new Uint8Array(n * 4);
  const k = width / 64;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * width + x) * 4;
      out[i] = Math.round((0.5 - dx / l / 2) * 255);
      out[i + 1] = Math.round((0.5 - dy / l / 2) * 255);
      out[i + 2] = Math.round((0.5 + 0.5 / l) * 255);
      out[i + 3] = 255;
    }
  return out;
}

interface IGlbJson {
  bufferViews?: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
  }[];
  buffers?: { byteLength: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
  textures?: { source?: number; sampler?: number; extensions?: Record<string, unknown> }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

/**
 * A binary glTF with every embedded PNG and JPEG re-encoded as WebP q80 (lossless alpha) through
 * EXT_texture_webp, the buffer repacked. Apex's exporter writes PNG and JPEG: 5.6 MB of distinct
 * city maps become 1.2 MB (PRD-900 compression study). A WebP image is kept as it is.
 */
export async function webpImages(glb: Uint8Array): Promise<Uint8Array> {
  const bytes = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as IGlbJson;
  const bin = bytes.subarray(
    28 + jsonLength,
    28 + jsonLength + bytes.readUInt32LE(20 + jsonLength),
  );
  const recoded = await recodeImages(json, bin);
  if (recoded.size === 0) return glb;
  for (const texture of json.textures ?? [])
    if (texture.source !== undefined && json.images?.[texture.source]?.mimeType === "image/webp") {
      texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: texture.source } };
      texture.source = undefined;
    }
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "EXT_texture_webp"])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), "EXT_texture_webp"])];
  return packGlb(json, bin, recoded);
}

/** Each PNG or JPEG image's buffer view index and its WebP bytes; the images' mimeType is set. */
async function recodeImages(json: IGlbJson, bin: Buffer): Promise<Map<number, Buffer>> {
  const recoded = new Map<number, Buffer>();
  for (const image of json.images ?? []) {
    const view = image.bufferView === undefined ? undefined : json.bufferViews?.[image.bufferView];
    if (view === undefined || image.mimeType === "image/webp") continue;
    const start = view.byteOffset ?? 0;
    const webp = await sharp(bin.subarray(start, start + view.byteLength))
      .webp({ alphaQuality: 100, effort: 4, quality: 80 })
      .toBuffer();
    recoded.set(image.bufferView as number, webp);
    image.mimeType = "image/webp";
  }
  return recoded;
}

/** The GLB with every buffer view laid out again, 4-byte aligned, `replaced` views swapped in. */
function packGlb(json: IGlbJson, bin: Buffer, replaced: Map<number, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  (json.bufferViews ?? []).forEach((view, index) => {
    const start = view.byteOffset ?? 0;
    const data = replaced.get(index) ?? bin.subarray(start, start + view.byteLength);
    view.byteOffset = offset;
    view.byteLength = data.length;
    const pad = (4 - (data.length % 4)) % 4;
    chunks.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
  });
  if (json.buffers?.[0]) json.buffers[0].byteLength = offset;
  let text = Buffer.from(JSON.stringify(json), "utf8");
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + text.length + offset, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(offset, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, text, binHeader, ...chunks]);
}
