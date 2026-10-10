import { Terrain } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { decodeHeightPNG, encodeHeightPNG } from "../src/core/io.js";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, initial) => {
  let n = initial;
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function replaceMetadata(png: Uint8Array, rawJson: string): Uint8Array {
  const needle = new TextEncoder().encode("StrataHeightRange\0");
  let pos = -1;
  for (let i = 0; i <= png.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (png[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      pos = i;
      break;
    }
  }
  if (pos < 8) throw new Error("Metadata chunk not found in PNG");
  const chunkOffset = pos - 8;
  const oldLength = new DataView(png.buffer, png.byteOffset).getUint32(chunkOffset);
  const payload = new TextEncoder().encode(`StrataHeightRange\0${rawJson}`);
  const typeAndData = new Uint8Array(4 + payload.length);
  typeAndData.set(new TextEncoder().encode("tEXt"), 0);
  typeAndData.set(payload, 4);

  const chunk = new Uint8Array(12 + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  chunk.set(typeAndData, 4);
  view.setUint32(8 + payload.length, crc32(typeAndData));

  const afterOffset = chunkOffset + 12 + oldLength;
  const corrupted = new Uint8Array(chunkOffset + chunk.length + (png.length - afterOffset));
  corrupted.set(png.subarray(0, chunkOffset), 0);
  corrupted.set(chunk, chunkOffset);
  corrupted.set(png.subarray(afterOffset), chunkOffset + chunk.length);
  return corrupted;
}

describe("decodeHeightPNG error handling", () => {
  it.each([
    ["null", "null"],
    ["numeric", " 12345"],
  ])("rejects %s metadata with documented error", async (_, invalidJson) => {
    const state = new Terrain({ resolution: 17 }).evaluate();
    const validPng = await encodeHeightPNG(state);
    const corrupted = replaceMetadata(validPng, invalidJson);
    await expect(decodeHeightPNG(corrupted)).rejects.toThrow("Invalid PNG height range metadata");
  });

  it("rejects truncated chunk with documented error", async () => {
    const state = new Terrain({ resolution: 17 }).evaluate();
    const validPng = await encodeHeightPNG(state);
    const truncated = validPng.subarray(0, 45);
    await expect(decodeHeightPNG(truncated)).rejects.toThrow("Truncated or oversized PNG chunk");
  });

  it("rejects bad CRC with documented error", async () => {
    const state = new Terrain({ resolution: 17 }).evaluate();
    const validPng = await encodeHeightPNG(state);
    const corrupted = new Uint8Array(validPng);
    const byte = corrupted[16];
    if (byte !== undefined) corrupted[16] = byte ^ 0xff;
    await expect(decodeHeightPNG(corrupted)).rejects.toThrow(/PNG CRC mismatch/);
  });
});
