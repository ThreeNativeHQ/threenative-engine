import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nativeDefinition } from "../../../test-support/native-definition.js";

const source = readFileSync(
  join(import.meta.dirname, "..", "src", "runtime-scripts", "frame-op-stream.js"),
  "utf8",
);
// The opcode switch and its per-opcode handle guards live in the record replay walk; the plan
// entry point above it only chooses which layout seeds that walk.
const replay = nativeDefinition("replayFrameRecords").text;
const frameStream = readFileSync(
  join(import.meta.dirname, "..", "src", "webgpu", "bindings_frame_stream.cpp"),
  "utf8",
);
const bindingsState = readFileSync(
  join(import.meta.dirname, "..", "src", "webgpu", "bindings_state.h"),
  "utf8",
);
const factory = Function(`"use strict"; let factory; factory = ${source}\nreturn factory;`)();

function harness() {
  const device = {
    createBuffer() {
      return { _bufferId: 40, destroy() {} };
    },
    createCommandEncoder() {},
    createTexture() {
      return { _textureId: 41, destroy() {} };
    },
  };
  const queue = {
    writeBuffer() {},
    writeTexture() {},
    copyExternalImageToTexture() {},
    submit() {},
  };
  const drain = factory({ device, queue });
  return { device, queue, drain };
}

function records(buffer) {
  const view = new DataView(buffer);
  expect(view.getUint32(0, true)).toBe(0x544e4652);
  expect(view.getUint32(4, true)).toBe(2);
  const declaredBytes = view.getUint32(8, true);
  expect(declaredBytes).toBeLessThanOrEqual(buffer.byteLength);
  const result = [];
  let cursor = 16;
  while (cursor < declaredBytes) {
    const bytes = view.getUint32(cursor + 4, true);
    result.push({ opcode: view.getUint32(cursor, true), cursor, bytes });
    expect(bytes).toBeGreaterThanOrEqual(8);
    expect(bytes % 8).toBe(0);
    cursor += bytes;
  }
  expect(result).toHaveLength(view.getUint32(12, true));
  return { view, result };
}

describe("packed frame op stream", () => {
  it("eagerly snapshots a Canvas2D source before later drawing changes its pixels", () => {
    const { queue, drain } = harness();
    const pixels = new Uint8ClampedArray([19, 39, 28, 255, 230, 217, 183, 255]);
    const canvas = { width: 2, height: 1, getContext(type) {
      expect(type).toBe("2d");
      return { getImageData(x, y, width, height) {
        expect([x, y, width, height]).toEqual([0, 0, 2, 1]);
        return { data: pixels };
      } };
    } };
    queue.copyExternalImageToTexture({ source: canvas, flipY: true }, { texture: { _textureId: 41 } }, [2, 1, 1]);
    pixels.fill(0);
    const frame = drain();
    const { view, result } = records(frame);
    expect(result).toHaveLength(1);
    expect(result[0].opcode).toBe(31);
    expect(view.getUint32(result[0].cursor + 24, true)).toBe(1);
    expect(Array.from(new Uint8Array(frame, result[0].cursor + 68, 8))).toEqual([19, 39, 28, 255, 230, 217, 183, 255]);
  });
  // PRD-229 Phase 5. This used to slice bindings.cpp by indexOf; once PRD-230 moves the definition
  // out of that file indexOf returns -1, the slice is empty, and the assertion passes on nothing.
  // Looking the definition up by symbol survives the move and still reds on the regression.
  it("keeps native replay compatible with the runtime's C++17 toolchains", () => {
    expect(frameStream).not.toMatch(/\b[A-Za-z][A-Za-z0-9_]*\.contains\(/u);
  });

  // Every native handle lookup has to stop its own record before the first backend call that uses
  // that handle. A later, unrelated `if (!r.ok)` is not enough: it lets a malformed record parse
  // arbitrary counts and descriptors first, and a future edit can move the later guard below the
  // FFI call. Keep this table explicit so the contract reds when one guard is removed.
  const replayLookupGuards = [
    [3, "auto e = encoder(eid);", "wgpuCommandEncoderBeginRenderPass", "render encoder"],
    [3, "c.view = viewFor(r.u32());", "wgpuCommandEncoderBeginRenderPass", "color attachment view"],
    [3, "c.resolveTarget = resolve ? viewFor(resolve) : nullptr;", "wgpuCommandEncoderBeginRenderPass", "resolve view"],
    [3, "depth.view = viewFor(r.u32());", "wgpuCommandEncoderBeginRenderPass", "depth view"],
    [3, "rtw.querySet = querySetFor(r.u32());", "wgpuCommandEncoderBeginRenderPass", "render timestamp query set"],
    [4, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetPipeline", "render pipeline pass"],
    [5, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetBindGroup", "render bind group pass"],
    [6, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetVertexBuffer", "vertex pass"],
    [6, "auto b = buffer(r.u32());", "wgpuRenderPassEncoderSetVertexBuffer", "vertex buffer"],
    [7, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetIndexBuffer", "index pass"],
    [7, "auto b = buffer(r.u32());", "wgpuRenderPassEncoderSetIndexBuffer", "index buffer"],
    [8, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderDraw", "draw pass"],
    [9, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderDrawIndexed", "indexed draw pass"],
    [10, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderDrawIndirect", "indirect draw pass"],
    [10, "auto b = buffer(r.u32());", "wgpuRenderPassEncoderDrawIndirect", "indirect draw buffer"],
    [11, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderDrawIndexedIndirect", "indexed indirect draw pass"],
    [11, "auto b = buffer(r.u32());", "wgpuRenderPassEncoderDrawIndexedIndirect", "indexed indirect draw buffer"],
    [12, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetViewport", "viewport pass"],
    [13, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetScissorRect", "scissor pass"],
    [14, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetBlendConstant", "blend pass"],
    [15, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderSetStencilReference", "stencil pass"],
    [16, "auto p = renderPass(r.u32());", "wgpuRenderPassEncoderExecuteBundles", "bundle pass"],
    [17, "auto p = renderPass(id);", "wgpuRenderPassEncoderEnd", "end pass"],
    [18, "auto e = encoder(eid);", "wgpuCommandEncoderBeginComputePass", "compute encoder"],
    [19, "auto p = computePass(r.u32());", "wgpuComputePassEncoderSetPipeline", "compute pipeline pass"],
    [20, "auto p = computePass(r.u32());", "wgpuComputePassEncoderSetBindGroup", "compute bind group pass"],
    [21, "auto p = computePass(r.u32());", "wgpuComputePassEncoderDispatchWorkgroups", "dispatch pass"],
    [22, "auto p = computePass(id);", "wgpuComputePassEncoderEnd", "compute end pass"],
    [23, "auto e = encoder(r.u32());", "wgpuCommandEncoderCopyBufferToBuffer", "buffer copy encoder"],
    [23, "auto s = buffer(r.u32());", "wgpuCommandEncoderCopyBufferToBuffer", "buffer copy source"],
    [23, "auto d = buffer(r.u32());", "wgpuCommandEncoderCopyBufferToBuffer", "buffer copy destination"],
    [24, "auto e = encoder(r.u32());", "wgpuCommandEncoderCopyBufferToTexture", "buffer-texture copy encoder"],
    [24, "s.buffer = buffer(r.u32());", "wgpuCommandEncoderCopyBufferToTexture", "buffer-texture source"],
    [24, "readTextureCopy(d);", "wgpuCommandEncoderCopyBufferToTexture", "buffer-texture destination"],
    [25, "auto e = encoder(r.u32());", "wgpuCommandEncoderCopyTextureToBuffer", "texture-buffer copy encoder"],
    [25, "readTextureCopy(s);", "wgpuCommandEncoderCopyTextureToBuffer", "texture-buffer source"],
    [25, "d.buffer = buffer(r.u32());", "wgpuCommandEncoderCopyTextureToBuffer", "texture-buffer destination"],
    [26, "auto e = encoder(r.u32());", "wgpuCommandEncoderCopyTextureToTexture", "texture copy encoder"],
    [26, "readTextureCopy(s);", "wgpuCommandEncoderCopyTextureToTexture", "texture copy source"],
    [26, "readTextureCopy(d);", "wgpuCommandEncoderCopyTextureToTexture", "texture copy destination"],
    [27, "auto e = encoder(r.u32());", "wgpuCommandEncoderClearBuffer", "clear encoder"],
    [27, "auto b = buffer(r.u32());", "wgpuCommandEncoderClearBuffer", "clear buffer"],
    [28, "auto e = encoder(eid);", "wgpuCommandEncoderFinish", "finish encoder"],
    [30, "readTextureCopy(d);", "wgpuQueueWriteTexture", "texture upload destination"],
    [31, "readTextureCopy(d);", "wgpuQueueWriteTexture", "external texture destination"],
    [34, "auto e = encoder(r.u32());", "wgpuCommandEncoderResolveQuerySet", "resolve encoder"],
    [34, "auto q = querySetFor(r.u32());", "wgpuCommandEncoderResolveQuerySet", "resolve query set"],
    [34, "auto dst = buffer(r.u32());", "wgpuCommandEncoderResolveQuerySet", "resolve destination"],
    [35, "auto p = computePass(r.u32());", "wgpuComputePassEncoderDispatchWorkgroupsIndirect", "indirect dispatch pass"],
    [35, "auto b = buffer(r.u32());", "wgpuComputePassEncoderDispatchWorkgroupsIndirect", "indirect dispatch buffer"],
  ];

  function assertReplayLookupGuards(replaySource) {
    for (const [opcode, lookup, nativeCall, label] of replayLookupGuards) {
      const start = replaySource.indexOf(`case ${opcode}:`);
      expect(start, `native replay case ${opcode} exists`).toBeGreaterThanOrEqual(0);
      const remainder = replaySource.slice(start + `case ${opcode}:`.length);
      const nextCase = remainder.search(/\n\s*case \d+:/u);
      const body = nextCase < 0 ? remainder : remainder.slice(0, nextCase);
      const lookupIndex = body.indexOf(lookup);
      expect(lookupIndex, `opcode ${opcode} has ${label} lookup`).toBeGreaterThanOrEqual(0);
      const guardIndex = body.indexOf("if (!r.ok)", lookupIndex + lookup.length);
      const nativeIndex = body.indexOf(nativeCall, lookupIndex + lookup.length);
      expect(guardIndex, `opcode ${opcode} guards its ${label} lookup`).toBeGreaterThan(lookupIndex);
      const betweenLookupAndGuard = body.slice(lookupIndex + lookup.length, guardIndex);
      expect(
        betweenLookupAndGuard,
        `opcode ${opcode} does not defer its ${label} guard past another lookup`,
      ).not.toMatch(/(?:encoder|renderPass|computePass|buffer|viewFor|querySetFor|readTextureCopy)\(/u);
      expect(
        guardIndex - lookupIndex,
        `opcode ${opcode} guards its ${label} lookup promptly`,
      ).toBeLessThan(160);
      expect(nativeIndex, `opcode ${opcode} uses its ${label} lookup`).toBeGreaterThan(guardIndex);
    }
  }

  it("guards every replay handle lookup in its own opcode before the backend call", () => {
    assertReplayLookupGuards(replay);
  });

  it("rejects a replay source when an own native-handle guard is removed", () => {
    const guardedLookup = "auto e = encoder(eid);\n                if (!r.ok)\n                    break;";
    expect(replay).toContain(guardedLookup);
    const withoutGuard = replay.replace(guardedLookup, "auto e = encoder(eid);");
    expect(withoutGuard).not.toBe(replay);
    expect(() => assertReplayLookupGuards(withoutGuard)).toThrow(/opcode 3 .*render encoder/u);
  });

  it("keeps frame replay registries and scratch vectors on the bindings state", () => {
    expect(replay).not.toMatch(/std::unordered_map<uint32_t, WGPUCommandEncoder> encoders/u);
    expect(replay).toMatch(/auto& encoders = state->frameReplay\.encoders/u);
    expect(replay).toMatch(/state->frameReplay\.dynamicOffsets\.resize\(n\)/u);
    expect(bindingsState).toMatch(/struct FrameReplayState[\s\S]*std::unordered_map<uint32_t, WGPUCommandEncoder> encoders/u);
    expect(bindingsState).toMatch(/std::vector<uint32_t> dynamicOffsets;/u);
  });

  it("keeps resource id loads class-specific so V8 inline caches stay polymorphic", () => {
    expect(source).not.toMatch(/v\?\.\[field\]|v\[field\]/u);
    expect(source).toMatch(/const bufferId = \(v\) => resourceId\(v, v\?\._bufferId/u);
    expect(source).toMatch(/const textureId = \(v\) => resourceId\(v, v\?\._textureId/u);
    expect(source).toMatch(/const pipelineId = \(v/u);
  });

  it("bounds upload property loads by typed-array width", () => {
    expect(source).not.toMatch(/data\.BYTES_PER_ELEMENT/u);
    expect(source).toMatch(/const uploadView4 =/u);
    expect(source).toMatch(/data instanceof Float32Array/u);
    expect(source).toMatch(/data instanceof Uint16Array/u);
  });

  it("reuses its arena after the host synchronously drains a frame", () => {
    const { queue, drain } = harness();
    queue.writeBuffer({ _bufferId: 1 }, 0, new Uint32Array(1));
    const first = drain();
    queue.writeBuffer({ _bufferId: 1 }, 0, new Uint32Array(1));

    expect(drain()).toBe(first);
  });

  it("returns one packed buffer with eager upload bytes and ordered frame ops", () => {
    const { device, queue, drain } = harness();
    const source = new Uint32Array([1, 2, 3, 4]);
    queue.writeBuffer({ _bufferId: 7 }, 0, source);
    source.fill(99);
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer({ _bufferId: 8 }, 0, 16);
    queue.submit([encoder.finish()]);
    const frame = drain();
    expect(frame).toBeInstanceOf(ArrayBuffer);
    const { view, result } = records(frame);
    expect(result.map(({ opcode }) => opcode)).toEqual([1, 2, 27, 28, 29]);
    const upload = result[0].cursor;
    expect(Array.from(new Uint32Array(frame, upload + 24, 4))).toEqual([1, 2, 3, 4]);
    expect(drain()).toBeNull();
  });

  // `buffer.mapAsync` drains partially, mid-frame: WebGPU completes a map only after the work
  // already submitted, and a recorded `queue.submit` has not reached the GPU yet.
  it("drains everything already submitted when the host asks for a partial frame", () => {
    const { device, queue, drain } = harness();
    queue.writeBuffer({ _bufferId: 1 }, 0, new Uint32Array(1));
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer({ _bufferId: 2 }, 0, 4);
    queue.submit([encoder.finish()]);

    const flushed = drain(1);
    expect(records(flushed).result.map(({ opcode }) => opcode)).toEqual([1, 2, 27, 28, 29]);
    expect(drain(1)).toBeNull();
    expect(drain()).toBeNull();
  });

  it("reports pending readback work behind an outer render encoder", () => {
    const { device, queue, drain } = harness();
    const outer = device.createCommandEncoder();
    const pass = outer.beginRenderPass({ colorAttachments: [] });
    const readback = device.createCommandEncoder();
    readback.copyBufferToBuffer({ _bufferId: 1 }, 0, { _bufferId: 2 }, 0, 4);
    queue.submit([readback.finish()]);
    expect(drain(1)).toBeNull();
    expect(drain.pendingOps).toBe(true);
    pass.end();
    queue.submit([outer.finish()]);
    expect(records(drain()).result.map(({ opcode }) => opcode)).toEqual([
      2, 3, 2, 23, 28, 29, 17, 28, 29,
    ]);
    expect(drain.pendingOps).toBe(false);
  });

  // The cut has to land before a half-recorded encoder: replaying a stream whose encoder is never
  // finished fails closed on the native side with "frame ended with unfinished GPU objects".
  it("leaves a half-recorded encoder behind and drains it whole at the frame boundary", () => {
    const { device, queue, drain } = harness();
    const first = device.createCommandEncoder();
    first.clearBuffer({ _bufferId: 2 }, 0, 4);
    queue.submit([first.finish()]);
    const second = device.createCommandEncoder();
    const pass = second.beginRenderPass({ colorAttachments: [] });

    const flushed = drain(1);
    expect(records(flushed).result.map(({ opcode }) => opcode)).toEqual([2, 27, 28, 29]);
    expect(drain(1)).toBeNull();

    pass.end();
    queue.submit([second.finish()]);
    const tail = drain();
    expect(tail).not.toBe(flushed);
    expect(records(tail).result.map(({ opcode }) => opcode)).toEqual([2, 3, 17, 28, 29]);
    expect(drain()).toBeNull();
  });

  it("keeps render and compute pass methods on shared receiver-aware prototypes", () => {
    const { device, drain } = harness();
    const encoderA = device.createCommandEncoder();
    const encoderB = device.createCommandEncoder();
    const renderA = encoderA.beginRenderPass({ colorAttachments: [] });
    const renderB = encoderB.beginRenderPass({ colorAttachments: [] });
    const computeA = encoderA.beginComputePass();
    const computeB = encoderB.beginComputePass();
    const buffer = { _bufferId: 40 };
    const group = { _bindGroupId: 41 };
    const renderPipeline = { _pipelineId: 42 };
    const computePipeline = { _pipelineId: 43 };
    const bundle = { _renderBundleId: 44 };
    const renderMethods = [
      ["setPipeline", 4, [renderPipeline]],
      ["setBindGroup", 5, [0, group]],
      ["setVertexBuffer", 6, [0, buffer]],
      ["setIndexBuffer", 7, [buffer, "uint32"]],
      ["draw", 8, [3]],
      ["drawIndexed", 9, [3]],
      ["drawIndirect", 10, [buffer, 0]],
      ["drawIndexedIndirect", 11, [buffer, 0]],
      ["setViewport", 12, [0, 0, 1, 1, 0, 1]],
      ["setScissorRect", 13, [0, 0, 1, 1]],
      ["setBlendConstant", 14, [[0, 0, 0, 1]]],
      ["setStencilReference", 15, [1]],
      ["executeBundles", 16, [[bundle]]],
      ["end", 17, []],
    ];
    const computeMethods = [
      ["setPipeline", 19, [computePipeline]],
      ["setBindGroup", 20, [0, group]],
      ["dispatchWorkgroups", 21, [1]],
      ["dispatchWorkgroupsIndirect", 35, [buffer, 0]],
      ["end", 22, []],
    ];

    expect(Object.getPrototypeOf(renderA)).toBe(Object.getPrototypeOf(renderB));
    for (const [name, , args] of renderMethods) {
      expect(Object.hasOwn(renderA, name), name).toBe(false);
      expect(renderA[name], name).toBe(renderB[name]);
      expect(() => renderA[name].call(undefined, ...args), name).toThrow(
        /no render pass receiver/u,
      );
      renderA[name](...args);
      renderB[name](...args);
    }

    expect(Object.getPrototypeOf(computeA)).toBe(Object.getPrototypeOf(computeB));
    for (const [name, , args] of computeMethods) {
      expect(Object.hasOwn(computeA, name), name).toBe(false);
      expect(computeA[name], name).toBe(computeB[name]);
      expect(() => computeA[name].call(undefined, ...args), name).toThrow(
        /no compute pass receiver/u,
      );
      computeA[name](...args);
      computeB[name](...args);
    }

    const frameRecords = records(drain());
    for (const [, opcode] of renderMethods) {
      const calls = frameRecords.result.filter((record) => record.opcode === opcode);
      expect(calls, `render opcode ${opcode}`).toHaveLength(2);
      expect(calls.map((record) => frameRecords.view.getUint32(record.cursor + 8, true))).toEqual([
        3, 4,
      ]);
    }
    for (const [, opcode] of computeMethods) {
      const calls = frameRecords.result.filter((record) => record.opcode === opcode);
      expect(calls, `compute opcode ${opcode}`).toHaveLength(2);
      expect(calls.map((record) => frameRecords.view.getUint32(record.cursor + 8, true))).toEqual([
        5, 6,
      ]);
    }
  });

  it("records only the layer an offset writeTexture reads out of a whole array", () => {
    // three uploads layer k of an array texture as the whole array plus `offset`. Recording the
    // whole source per layer made an 821-layer morph texture copy the array 821 times.
    const { device, queue, drain } = harness();
    const texture = device.createTexture({});
    texture.format = "rgba8unorm";
    const layerBytes = 2 * 2 * 4;
    const layers = new Uint8Array(layerBytes * 4);
    for (let layer = 0; layer < 4; layer += 1)
      layers.fill(layer + 1, layer * layerBytes, (layer + 1) * layerBytes);
    queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z: 2 } },
      layers,
      { offset: 2 * layerBytes, bytesPerRow: 8, rowsPerImage: 2 },
      { width: 2, height: 2, depthOrArrayLayers: 1 },
    );
    const frame = drain();
    const { view, result } = records(frame);
    const record = result.find(({ opcode }) => opcode === 30);
    expect(record).toBeDefined();
    expect(view.getUint32(record.cursor + 24, true), "destination layer").toBe(2);
    expect(view.getFloat64(record.cursor + 32, true), "recorded offset").toBe(0);
    expect(view.getUint32(record.cursor + 60, true), "payload bytes").toBe(layerBytes);
    expect(Array.from(new Uint8Array(frame, record.cursor + 64, layerBytes))).toEqual(
      new Array(layerBytes).fill(3),
    );
  });

  it("counts block rows for a compressed writeTexture slice", () => {
    const { device, queue, drain } = harness();
    const texture = device.createTexture({});
    texture.format = "bc7-rgba-unorm";
    // An 8x8 BC7 image is 2 block rows of 2 blocks (16 bytes each): 64 bytes per layer.
    const source = new Uint8Array(64 * 3).fill(7);
    queue.writeTexture(
      { texture, origin: [0, 0, 1] },
      source,
      { offset: 64, bytesPerRow: 32, rowsPerImage: 2 },
      [8, 8, 1],
    );
    const { view, result } = records(drain());
    const record = result.find(({ opcode }) => opcode === 30);
    expect(view.getUint32(record.cursor + 60, true)).toBe(64);
  });

  it("fails synchronously on invalid upload ranges, offsets, and resource ids", () => {
    const { device, queue, drain } = harness();
    const buffer = { _bufferId: 1 };
    expect(() => queue.writeBuffer(buffer, 2, new Uint32Array(1))).toThrow(/multiple of 4/);
    expect(() => queue.writeBuffer(buffer, 0, new Uint32Array(1), -1)).toThrow(/range/);
    expect(() => queue.writeBuffer({}, 0, new Uint32Array(1))).toThrow(/numeric id/);
    queue.writeBuffer(buffer, 0, new Uint32Array(1));
    expect(() => device.createCommandEncoder().clearBuffer({}, 0, 4)).toThrow(/numeric id/);
    queue.writeBuffer(buffer, 0, new Uint32Array(1));
    const frame = drain();
    expect(() => records(frame)).not.toThrow();
    expect(records(frame).result.map(({ opcode }) => opcode)).toEqual([1, 2, 1]);
  });

  it("serializes every steady-state command family without a native fallback", () => {
    const { device, queue, drain } = harness();
    const buffer = { _bufferId: 1 };
    const texture = { _textureId: 2 };
    const view = { _textureViewId: 3 };
    const group = { _bindGroupId: 4 };
    const pipeline = { _pipelineId: 5 };
    const bundle = { _renderBundleId: 6 };
    const encoder = device.createCommandEncoder();
    const render = encoder.beginRenderPass({
      colorAttachments: [
        { view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1], depthSlice: 7 },
      ],
    });
    render.setPipeline(pipeline);
    render.setBindGroup(0, group, [4]);
    render.setVertexBuffer(0, buffer);
    render.setIndexBuffer(buffer, "uint32");
    render.draw(3);
    render.drawIndexed(3, 1, 0, -1, 0);
    render.drawIndirect(buffer, 0);
    render.drawIndexedIndirect(buffer, 0);
    render.setViewport(0, 0, 1, 1, 0, 1);
    render.setScissorRect(0, 0, 1, 1);
    render.setBlendConstant([0, 0, 0, 1]);
    render.setStencilReference(1);
    render.executeBundles([bundle]);
    render.end();
    const compute = encoder.beginComputePass();
    compute.setPipeline(pipeline);
    compute.setBindGroup(0, group);
    compute.dispatchWorkgroups(1);
    compute.dispatchWorkgroupsIndirect(buffer, 0);
    compute.end();
    encoder.copyBufferToBuffer(buffer, 0, buffer, 0, 4);
    encoder.copyBufferToTexture({ buffer }, { texture }, [1, 1, 1]);
    encoder.copyTextureToBuffer({ texture }, { buffer }, [1, 1, 1]);
    encoder.copyTextureToTexture({ texture }, { texture }, [1, 1, 1]);
    encoder.clearBuffer(buffer);
    const textureUpload = new Uint8Array([1, 2, 3, 4]);
    queue.writeTexture({ texture }, textureUpload, { bytesPerRow: 4 }, [1, 1, 1]);
    textureUpload.fill(99);
    const external = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12]);
    queue.copyExternalImageToTexture(
      { source: { width: 2, height: 1, data: external }, origin: [1, 0], flipY: true },
      { texture },
      [1, 1, 1],
    );
    external.fill(99);
    queue.submit([encoder.finish()]);
    device.createBuffer({}).destroy();
    device.createTexture({}).destroy();
    const frame = drain();
    const { view: packed, result } = records(frame);
    const opcodes = result.map(({ opcode }) => opcode);
    expect(opcodes).toEqual(
      expect.arrayContaining(Array.from({ length: 32 }, (_, index) => index + 2)),
    );
    const beginRenderPass = result.find(({ opcode }) => opcode === 3);
    expect(beginRenderPass).toBeDefined();
    expect(packed.getUint32(beginRenderPass.cursor + 68, true)).toBe(7);
    const writeTexture = result.find(({ opcode }) => opcode === 30);
    expect(writeTexture).toBeDefined();
    expect(Array.from(new Uint8Array(frame, writeTexture.cursor + 64, 4))).toEqual([1, 2, 3, 4]);
    const externalCopy = result.find(({ opcode }) => opcode === 31);
    expect(externalCopy).toBeDefined();
    expect(packed.getUint32(externalCopy.cursor + 16, true)).toBe(1);
    expect(packed.getUint32(externalCopy.cursor + 20, true)).toBe(0);
    expect(packed.getUint32(externalCopy.cursor + 24, true)).toBe(1);
    expect(Array.from(new Uint8Array(frame, externalCopy.cursor + 68, 8))).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});
