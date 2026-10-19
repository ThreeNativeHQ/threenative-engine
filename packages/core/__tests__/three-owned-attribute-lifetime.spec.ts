import Attributes from "three/src/renderers/common/Attributes.js";
import { StorageBufferAttribute, WebGPURenderer } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";

describe("explicit owned storage release", () => {
  it("is harmless before initialization and destroys/accounting-releases an owned attribute once", () => {
    const r = new WebGPURenderer({
      canvas: new EventTarget() as HTMLCanvasElement,
    }) as WebGPURenderer & { deleteAttribute(a: StorageBufferAttribute): unknown };
    const attribute = new StorageBufferAttribute(new Uint32Array(2), 1);
    expect(r.deleteAttribute(attribute)).toBeNull();
    const destroy = vi.fn();
    const attributes = new Attributes({ destroyAttribute: destroy }, r.info);
    attributes.get(attribute).version = 1;
    r.info.createStorageAttribute(attribute);
    Reflect.set(r, "_attributes", attributes);
    expect(r.info.memory.storageAttributes).toBe(1);
    r.deleteAttribute(attribute);
    r.deleteAttribute(attribute);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(attribute);
    expect(r.info.memory.storageAttributes).toBe(0);
    expect(r.info.memory.storageAttributesSize).toBe(0);
  });
});
