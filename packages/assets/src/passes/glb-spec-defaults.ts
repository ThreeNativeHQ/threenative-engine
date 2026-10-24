import type { GLTF } from "@gltf-transform/core";

/**
 * Removes the fields the glTF specification defines as the default from a GLB's JSON chunk.
 *
 * gltf-transform writes `"normalized":false` and `"byteOffset":0` on every accessor and
 * `"interpolation":"LINEAR"` on every animation sampler. A reader fills each one back in, so the
 * file means the same thing; the animated mannequins carried about 100 KB of them. Only those
 * three fields are touched, and only when they hold the default. The binary chunk is copied
 * byte for byte.
 */

const JSON_CHUNK = 0x4e4f534a;
const HEADER = 12;

export function withoutSpecDefaults(glb: Buffer): Buffer {
  if (glb.readUInt32LE(16) !== JSON_CHUNK) return glb;
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as GLTF.IGLTF;
  for (const accessor of json.accessors ?? []) {
    if (accessor.normalized === false) accessor.normalized = undefined;
    if (accessor.byteOffset === 0) accessor.byteOffset = undefined;
  }
  for (const view of json.bufferViews ?? []) if (view.byteOffset === 0) view.byteOffset = undefined;
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers)
      if (sampler.interpolation === "LINEAR") sampler.interpolation = undefined;
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const rest = glb.subarray(HEADER + 8 + jsonLength);
  const head = Buffer.alloc(HEADER + 8);
  glb.copy(head, 0, 0, HEADER);
  head.writeUInt32LE(HEADER + 8 + padded.length + rest.length, 8);
  head.writeUInt32LE(padded.length, 12);
  head.writeUInt32LE(JSON_CHUNK, 16);
  return Buffer.concat([head, padded, rest]);
}
