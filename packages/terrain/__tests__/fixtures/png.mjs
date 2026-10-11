import { deflateSync } from "node:zlib";

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
};

/** An RGBA8 PNG whose pixel (x, y) is `pixel(x, y)`, generated here so no art is committed. */
export function buildPng(width, height, pixel) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A solid-colour PNG: every pixel the same RGBA bytes. */
export const solidPng = (width, height, rgba) => buildPng(width, height, () => rgba);

/**
 * Header-only stand-ins for the formats a browser decodes itself. They carry real, parseable
 * containers for the size and damage checks; they are not pictures.
 */
export function jpegHeader(width, height) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}
export function webpLossless(width, height) {
  const bits = (width - 1) | ((height - 1) << 14);
  const body = new Uint8Array(5);
  body[0] = 0x2f;
  new DataView(body.buffer).setUint32(1, bits, true);
  const out = new Uint8Array(12 + 8 + 12);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, out.length - 8, true);
  out.set(new TextEncoder().encode("WEBPVP8L"), 8);
  view.setUint32(16, 12, true);
  out.set(body, 20);
  return out;
}
export function radianceHdr(width, height) {
  const head = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const out = new Uint8Array(head.length + width * height * 4);
  out.set(new TextEncoder().encode(head));
  return out;
}
export function openExr(width, height, compression = 3) {
  const encoder = new TextEncoder();
  const attribute = (name, type, value) => {
    const bytes = [...encoder.encode(`${name}\0${type}\0`)];
    const size = new Uint8Array(4);
    new DataView(size.buffer).setInt32(0, value.length, true);
    return [...bytes, ...size, ...value];
  };
  const box = new Uint8Array(16);
  const view = new DataView(box.buffer);
  view.setInt32(8, width - 1, true);
  view.setInt32(12, height - 1, true);
  return new Uint8Array([
    0x76,
    0x2f,
    0x31,
    0x01,
    2,
    0,
    0,
    0,
    ...attribute("compression", "compression", [compression]),
    ...attribute("dataWindow", "box2i", [...box]),
    0,
  ]);
}

/**
 * A decodable Radiance HDR: `pixel(x, y)` returns linear RGB radiance, which may exceed 1. Scanlines
 * use the format's run-length framing with literal runs only, which three's HDR loader reads.
 */
export function buildHdr(width, height, pixel) {
  const head = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const bytes = [...new TextEncoder().encode(head)];
  for (let y = 0; y < height; y += 1) {
    const line = [[], [], [], []];
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const peak = Math.max(r, g, b);
      if (peak < 1e-32) {
        for (const channel of line) channel.push(0);
        continue;
      }
      const exponent = Math.floor(Math.log2(peak)) + 1;
      const scale = 256 / 2 ** exponent;
      line[0].push(Math.floor(r * scale));
      line[1].push(Math.floor(g * scale));
      line[2].push(Math.floor(b * scale));
      line[3].push(exponent + 128);
    }
    bytes.push(2, 2, width >> 8, width & 255);
    for (const channel of line)
      for (let at = 0; at < width; at += 128) {
        const run = channel.slice(at, at + 128);
        bytes.push(run.length, ...run);
      }
  }
  return new Uint8Array(bytes);
}

/**
 * A PNG whose container is whole (every chunk checksum is right) but whose image data is not a zlib
 * stream: registered, because registration reads headers, then refused by the decoder that draws it.
 */
export function undecodablePng(width, height) {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
