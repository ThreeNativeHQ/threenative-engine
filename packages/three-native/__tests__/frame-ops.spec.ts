// The frame-op opcode table is an ABI: the JS recorder writes an id and the native host replays it,
// so an op inserted in the middle replays every later op as another with nothing failing at build.
// These checks pin the copies that exist (manifest, C++ header, JS recorder constants, the replay
// switch) and the ids already published, so an append is the only edit that passes.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const MANIFEST = path.join(ROOT, "packages/three-native/api/frame-ops.json");
const HEADER = path.join(ROOT, "packages/runtime-native/src/webgpu/frame_ops.h");
const RECORDER = path.join(ROOT, "packages/runtime-native/src/runtime-scripts/frame-op-stream.js");
const REPLAY = path.join(ROOT, "packages/runtime-native/src/webgpu/bindings_frame_stream.cpp");

interface IOp {
  readonly id: number;
  readonly name: string;
}

function manifestOps(): readonly IOp[] {
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { ops: readonly IOp[] }).ops;
}

/** `render.setPipeline` as `RENDER_SET_PIPELINE`, the spelling both generated copies use. */
function constant(name: string): string {
  return name
    .replace(".", "_")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toUpperCase();
}

/** Every op this stream has published, at the id it published. */
const FROZEN_OPS: Readonly<Record<string, number>> = {
  writeBuffer: 1,
  createCommandEncoder: 2,
  beginRenderPass: 3,
  "render.setPipeline": 4,
  "render.setBindGroup": 5,
  "render.setVertexBuffer": 6,
  "render.setIndexBuffer": 7,
  "render.draw": 8,
  "render.drawIndexed": 9,
  "render.drawIndirect": 10,
  "render.drawIndexedIndirect": 11,
  "render.setViewport": 12,
  "render.setScissorRect": 13,
  "render.setBlendConstant": 14,
  "render.setStencilReference": 15,
  "render.executeBundles": 16,
  "render.end": 17,
  beginComputePass: 18,
  "compute.setPipeline": 19,
  "compute.setBindGroup": 20,
  "compute.dispatchWorkgroups": 21,
  "compute.end": 22,
  copyBufferToBuffer: 23,
  copyBufferToTexture: 24,
  copyTextureToBuffer: 25,
  copyTextureToTexture: 26,
  clearBuffer: 27,
  finish: 28,
  submit: 29,
  writeTexture: 30,
  copyExternalImageToTexture: 31,
  "buffer.destroy": 32,
  "texture.destroy": 33,
  resolveQuerySet: 34,
  "compute.dispatchWorkgroupsIndirect": 35,
};

describe("the frame-op opcode table", () => {
  it("should generate the C++ enum and name table from the manifest", () => {
    const header = readFileSync(HEADER, "utf8");
    const rows = [...header.matchAll(/^\s*TN_FRAME_OP_([A-Z0-9_]+) = (\d+),$/gmu)].map(
      ([, name, id]) => [name, Number(id)] as const,
    );
    expect(rows).toEqual(manifestOps().map((op) => [constant(op.name), op.id] as const));
    const names = [...header.matchAll(/^\s*"([A-Za-z.]*)",$/gmu)].map(([, name]) => name);
    expect(names).toEqual(["", ...manifestOps().map((op) => op.name)]);
  });

  it("should generate the recorder constants from the manifest", () => {
    const source = readFileSync(RECORDER, "utf8");
    const rows = [...source.matchAll(/^ {2}const OP_([A-Z0-9_]+) = (\d+);$/gmu)].map(
      ([, name, id]) => [name, Number(id)] as const,
    );
    expect(rows).toEqual(manifestOps().map((op) => [constant(op.name), op.id] as const));
  });

  it("should leave no bare opcode in the recorder", () => {
    const source = readFileSync(RECORDER, "utf8");
    expect(source.match(/\b(?:emit|reusable)\(\s*\d/gu)).toBeNull();
  });

  it("should replay every op by its generated name and no bare number", () => {
    const replay = readFileSync(REPLAY, "utf8");
    for (const op of manifestOps())
      expect(replay, `${op.name} has a replay case`).toContain(
        `case TN_FRAME_OP_${constant(op.name)}:`,
      );
    expect(replay.match(/^\s*case \d+:/gmu)).toBeNull();
  });

  it("should keep every published op at the id it was published with", () => {
    const current = Object.fromEntries(manifestOps().map((op) => [op.name, op.id]));
    const moved = Object.entries(FROZEN_OPS).filter(([name, id]) => current[name] !== id);
    expect(
      moved.map(([name, id]) => `${name} moved from ${String(id)}`),
      "ids are frozen and append-only: restore the old id, and give a new op the next free one",
    ).toEqual([]);
  });
});
