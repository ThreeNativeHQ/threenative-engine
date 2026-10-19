import { DynamicDrawUsage, InterleavedBuffer, InterleavedBufferAttribute } from "three";
import Attributes from "three/src/renderers/common/Attributes.js";
import Bindings from "three/src/renderers/common/Bindings.js";
import { AttributeType } from "three/src/renderers/common/Constants.js";
import Geometries from "three/src/renderers/common/Geometries.js";
import StorageBuffer from "three/src/renderers/common/StorageBuffer.js";
import StorageBufferAttribute from "three/src/renderers/common/StorageBufferAttribute.js";
// @ts-expect-error Three's private renderer module has no public declaration; this test must exercise it directly.
import WebGPUAttributeUtils from "three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js";
import { describe, expect, it } from "vitest";

/**
 * Disposing a geometry whose attributes are interleaved — every cooked world GLB is — must forget
 * the destroyed GPU buffer, not only the attribute that named it. An interleaved attribute's buffer
 * lives on its `InterleavedBuffer` and several attributes share it, so without the forget the entry
 * stays in the backend's map: the next `createAttribute()` for that buffer finds the destroyed
 * `GPUBuffer` and the renderer submits a dead buffer every frame, which is a canvas that stops
 * updating after a world re-streams. The WebGL backend has always deleted it; this is the same
 * rule. The fix lives in `patches/three@0.185.1.patch`.
 */
interface IBackendLike {
  readonly get: (object: object) => { buffer?: { destroy: () => void } };
  readonly delete: (object: object) => boolean;
}

interface IBackendStub {
  readonly backend: IBackendLike;
  count: number;
}

function backendStub(): IBackendStub {
  const store = new WeakMap<object, { buffer?: { destroy: () => void } }>();
  const stub: IBackendStub = {
    backend: {
      get: (object) => {
        const found = store.get(object);
        if (found !== undefined) return found;
        const fresh: { buffer?: { destroy: () => void } } = {};
        store.set(object, fresh);
        return fresh;
      },
      delete: (object) => store.delete(object),
    },
    count: 0,
  };
  return stub;
}

describe("WebGPUAttributeUtils interleaved dispose", () => {
  it("destroys the shared GPU buffer once and forgets it, so createAttribute cannot find it", () => {
    const stub = backendStub();
    const { backend } = stub;
    const utils = new WebGPUAttributeUtils(backend);
    const interleaved = new InterleavedBuffer(new Float32Array(6 * 4), 6);
    const position = new InterleavedBufferAttribute(interleaved, 3, 0);
    const normal = new InterleavedBufferAttribute(interleaved, 3, 3);
    const destroyed = (): void => {
      stub.count += 1;
    };
    backend.get(interleaved).buffer = { destroy: destroyed };

    utils.destroyAttribute(position);
    utils.destroyAttribute(normal);

    expect(stub.count, "the shared GPU buffer is destroyed once, not once per attribute").toBe(1);
    expect(
      backend.get(interleaved).buffer,
      "the destroyed buffer is still in the backend",
    ).toBeUndefined();
  });
});

/** Only the GPU allocation and queue are modeled; Three owns wrapper and upload decisions. */
function uploadedInterleavedFixture(dynamic = false, storage = false) {
  const store = new WeakMap<object, { buffer?: IByteBuffer }>();
  let writes = 0;
  let allocations = 0;
  const backend = {
    renderer: { info: { calls: 0, render: { calls: 0 }, compute: { calls: 0 } } },
    get(object: object) {
      let data = store.get(object);
      if (data === undefined) {
        data = {};
        store.set(object, data);
      }
      return data;
    },
    delete: (object: object) => store.delete(object),
    device: {
      createBuffer({ size }: { size: number }): IByteBuffer {
        allocations += 1;
        const bytes = new ArrayBuffer(size);
        return { bytes, getMappedRange: () => bytes, unmap() {}, destroy() {} };
      },
      queue: {
        writeBuffer(
          buffer: IByteBuffer,
          offset: number,
          source: Float32Array,
          start = 0,
          count = source.length - start,
        ) {
          new Float32Array(buffer.bytes, offset).set(source.subarray(start, start + count));
          writes += 1;
        },
      },
    },
    createAttribute(attribute: InterleavedBufferAttribute | StorageBufferAttribute) {
      utils.createAttribute(attribute, 0);
    },
    createStorageAttribute(attribute: InterleavedBufferAttribute | StorageBufferAttribute) {
      utils.createAttribute(attribute, 0);
    },
    createBindings() {},
    updateBindings() {},
    updateAttribute(attribute: InterleavedBufferAttribute | StorageBufferAttribute) {
      utils.updateAttribute(attribute);
    },
  };
  const utils = new WebGPUAttributeUtils(backend);
  const manager = new Attributes(backend, { createAttribute() {}, createStorageAttribute() {} });
  const geometries = new Geometries(manager, backend.renderer.info);
  const matrix = storage
    ? new StorageBufferAttribute(new Float32Array(16), 4)
    : new InterleavedBuffer(new Float32Array(16), 16);
  if (dynamic) matrix.setUsage(DynamicDrawUsage);
  matrix.array[13] = 1;
  const wrapper = () =>
    matrix instanceof InterleavedBuffer ? new InterleavedBufferAttribute(matrix, 4, 12) : matrix;
  const first = wrapper();
  const upload = (attribute = first) => manager.update(attribute, AttributeType.VERTEX);
  const geometryUpload = (attribute = first) =>
    geometries.updateAttribute(attribute, AttributeType.VERTEX);
  const groups = [{ bindings: [new StorageBuffer("motion", first)] }];
  const bindings = new Bindings(
    backend,
    { getForCompute: () => ({ bindings: groups }), updateGroup: () => true },
    {},
    manager,
    {},
    backend.renderer.info,
  );
  const computeNode = {};
  const computeUpload = () => bindings.updateForCompute(computeNode);
  const gpuValues = () => {
    const buffer = backend.get(matrix).buffer;
    if (buffer === undefined) throw new Error("GPU matrix was not allocated");
    return new Float32Array(buffer.bytes);
  };
  if (storage) bindings.getForCompute(computeNode);
  else geometryUpload();
  return {
    matrix,
    first,
    wrapper,
    upload,
    geometryUpload,
    computeUpload,
    gpuValues,
    utils,
    nextRender: () => {
      backend.renderer.info.calls += 1;
      backend.renderer.info.render.calls += 1;
    },
    nextCompute: () => {
      backend.renderer.info.calls += 1;
      backend.renderer.info.compute.calls += 1;
    },
    info: backend.renderer.info,
    stats: () => ({ writes, allocations }),
  };
}

interface IByteBuffer {
  bytes: ArrayBuffer;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

describe("WebGPU shared-buffer uploads across attribute rebuilds", () => {
  it("refreshes dynamic storage bytes on compute-only calls without version bumps", () => {
    const fixture = uploadedInterleavedFixture(true, true);
    for (const value of [2, 3, 4]) {
      fixture.nextCompute();
      fixture.matrix.array[13] = value;
      fixture.computeUpload();
      fixture.computeUpload();
      expect(fixture.gpuValues()[13]).toBe(value);
      expect(fixture.matrix.version).toBe(0);
      expect(fixture.info.render.calls).toBe(0);
      expect(fixture.stats()).toEqual({ writes: value - 1, allocations: 1 });
    }
  });

  it.each([true, false])(
    "keeps partial ranges across alternating compute/render calls (storage=%s)",
    (storage) => {
      const fixture = uploadedInterleavedFixture(true, storage);
      for (const [index, kind] of ["compute", "render", "compute", "render"].entries()) {
        if (kind === "compute") fixture.nextCompute();
        else fixture.nextRender();
        fixture.matrix.array[12] = 99;
        fixture.matrix.array[13] = index + 2;
        fixture.matrix.addUpdateRange(13, 1);
        if (kind === "compute") {
          fixture.computeUpload();
          fixture.computeUpload();
        } else {
          fixture.geometryUpload(fixture.wrapper());
          fixture.geometryUpload();
        }
        expect(Array.from(fixture.gpuValues().slice(12, 14))).toEqual([0, index + 2]);
        expect(fixture.matrix.version).toBe(0);
        expect(fixture.stats()).toEqual({ writes: index + 1, allocations: 1 });
      }
    },
  );

  describe.each([true, false])("mixed wrapper order (fresh first=%s)", (freshFirst) => {
    it.each([
      { dynamic: false, bumpVersion: true, expected: 2, writes: 1 },
      { dynamic: false, bumpVersion: false, expected: 1, writes: 0 },
      { dynamic: true, bumpVersion: true, expected: 2, writes: 1 },
      { dynamic: true, bumpVersion: false, expected: 2, writes: 1 },
    ])("preserves partial ranges (dynamic=$dynamic, bump=$bumpVersion)", (mode) => {
      const fixture = uploadedInterleavedFixture(mode.dynamic);
      fixture.nextRender();
      fixture.matrix.array[12] = 99;
      fixture.matrix.array[13] = 2;
      fixture.matrix.addUpdateRange(13, 1);
      if (mode.bumpVersion) fixture.matrix.needsUpdate = true;
      const fresh = fixture.wrapper();
      for (const attribute of freshFirst ? [fresh, fixture.first] : [fixture.first, fresh])
        fixture.geometryUpload(attribute);
      expect(Array.from(fixture.gpuValues().slice(12, 14))).toEqual([0, mode.expected]);
      expect(fixture.stats()).toEqual({ writes: mode.writes, allocations: 1 });
    });
  });

  it("uploads a genuinely newer static version in the same render call", () => {
    const fixture = uploadedInterleavedFixture();
    fixture.nextRender();
    for (const value of [2, 3]) {
      fixture.matrix.array[12] = 99;
      fixture.matrix.array[13] = value;
      fixture.matrix.addUpdateRange(13, 1);
      fixture.matrix.needsUpdate = true;
      fixture.geometryUpload(fixture.wrapper());
      expect(Array.from(fixture.gpuValues().slice(12, 14))).toEqual([0, value]);
      expect(fixture.stats()).toEqual({ writes: value - 1, allocations: 1 });
    }
  });

  it("refreshes dynamic bytes without a version bump once per render call", () => {
    const fixture = uploadedInterleavedFixture(true);
    for (const value of [2, 3]) {
      fixture.nextRender();
      fixture.matrix.array[13] = value;
      for (let column = 0; column < 4; column += 1) fixture.upload(fixture.wrapper());
      expect(fixture.matrix.version).toBe(0);
      expect(fixture.gpuValues()[13]).toBe(value);
      expect(fixture.stats()).toEqual({ writes: value - 1, allocations: 1 });
    }
    fixture.nextRender();
    fixture.matrix.array[13] = 4;
    fixture.upload();
    for (let column = 0; column < 4; column += 1) fixture.upload(fixture.wrapper());
    expect(fixture.gpuValues()[13]).toBe(4);
    expect(fixture.stats()).toEqual({ writes: 3, allocations: 1 });
  });

  it("uploads the dirty current matrix before a fresh shader wrapper draws", () => {
    const fixture = uploadedInterleavedFixture();
    fixture.matrix.array[13] = 2;
    fixture.matrix.needsUpdate = true;
    for (let column = 0; column < 4; column += 1) fixture.upload(fixture.wrapper());
    expect(fixture.gpuValues()[13]).toBe(2);
    expect(fixture.stats()).toEqual({ writes: 1, allocations: 1 });
  });

  it("does not upload unchanged wrappers or upload each rebuilt matrix column", () => {
    const fixture = uploadedInterleavedFixture();
    for (let column = 0; column < 4; column += 1) fixture.upload(fixture.wrapper());
    expect(fixture.stats()).toEqual({ writes: 0, allocations: 1 });
    fixture.matrix.array[13] = 2;
    fixture.matrix.needsUpdate = true;
    fixture.upload();
    for (let column = 0; column < 4; column += 1) fixture.upload(fixture.wrapper());
    expect(fixture.gpuValues()[13]).toBe(2);
    expect(fixture.stats()).toEqual({ writes: 1, allocations: 1 });
  });

  it("honours dirty update ranges when the first consumer is a rebuilt wrapper", () => {
    const fixture = uploadedInterleavedFixture();
    fixture.matrix.array[12] = 99;
    fixture.matrix.array[13] = 2;
    fixture.matrix.addUpdateRange(13, 1);
    fixture.matrix.needsUpdate = true;
    fixture.upload(fixture.wrapper());
    expect(Array.from(fixture.gpuValues().slice(12, 14))).toEqual([0, 2]);
    expect(fixture.matrix.updateRanges).toEqual([]);
    expect(fixture.stats()).toEqual({ writes: 1, allocations: 1 });
  });

  it("recreates disposed shared buffers from the current bytes", () => {
    const fixture = uploadedInterleavedFixture();
    fixture.utils.destroyAttribute(fixture.first);
    fixture.matrix.array[13] = 3;
    fixture.matrix.needsUpdate = true;
    fixture.upload(fixture.wrapper());
    expect(fixture.gpuValues()[13]).toBe(3);
    expect(fixture.stats()).toEqual({ writes: 0, allocations: 2 });
  });
});
