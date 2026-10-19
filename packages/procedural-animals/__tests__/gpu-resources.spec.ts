import { describe, expect, it } from "vitest";
import { observeGPUResources } from "../../../examples/procedural-animals/src/gpu-resources.js";

// CPU substitutes only the WebGPU allocation boundary; the observer is production game source.
class Resource {
  destroyed = 0;
  fail = false;
  destroy() {
    if (this.fail) throw new Error("device refused destroy");
    this.destroyed++;
  }
}
class Device {
  resources: Resource[] = [];
  createBuffer(_descriptor: { size: number }) {
    const resource = new Resource();
    this.resources.push(resource);
    return resource;
  }
  createTexture(_descriptor: object) {
    const resource = new Resource();
    this.resources.push(resource);
    return resource;
  }
}

describe("qualification live WebGPU allocation census", () => {
  it("observes creation and successful destruction rather than upload bytes", () => {
    const device = new Device();
    const census = observeGPUResources(device);
    const shared = device.createBuffer({ size: 16 });
    const before = census.snapshot();
    const owned = device.createBuffer({ size: 112 });
    const texture = device.createTexture({ size: [8, 1], format: "rgba32float" });
    expect(census.snapshot()).toMatchObject({ buffers: 2, bufferBytes: 128, textures: 1 });
    expect(census.snapshot().bufferIds).not.toEqual(before.bufferIds);
    owned.destroy();
    texture.destroy();
    expect(census.snapshot()).toMatchObject({ buffers: 1, bufferBytes: 16, textures: 0 });
    expect(census.snapshot().bufferIds).toEqual(before.bufferIds);
    owned.destroy();
    expect(census.snapshot().destroyedBuffers).toBe(1);
    shared.destroy();
    census.dispose();
  });
  it("keeps a resource live when actual destruction throws", () => {
    const device = new Device();
    const census = observeGPUResources(device);
    const resource = device.createBuffer({ size: 64 });
    resource.fail = true;
    expect(() => resource.destroy()).toThrow("device refused destroy");
    expect(census.snapshot()).toMatchObject({ buffers: 1, bufferBytes: 64, destroyedBuffers: 0 });
    resource.fail = false;
    resource.destroy();
    census.dispose();
  });
  it("restores exact inherited methods without replacing the device or handles", () => {
    const device = new Device();
    const create = device.createBuffer;
    const census = observeGPUResources(device);
    const resource = device.createBuffer({ size: 4 });
    expect(resource).toBe(device.resources[0]);
    expect(Object.hasOwn(device, "createBuffer")).toBe(true);
    resource.destroy();
    expect(Object.hasOwn(resource, "destroy")).toBe(false);
    census.dispose();
    expect(device.createBuffer).toBe(create);
    expect(Object.hasOwn(device, "createBuffer")).toBe(false);
    expect(() => census.snapshot()).toThrow("TN_ANIMAL_GPU_CENSUS_CLOSED");
  });
  it("fails closed for a missing or unpatchable resource channel", () => {
    expect(() => observeGPUResources({})).toThrow("TN_ANIMAL_GPU_CENSUS_UNAVAILABLE");
    const device = new Device();
    Object.preventExtensions(device);
    expect(() => observeGPUResources(device)).toThrow("TN_ANIMAL_GPU_CENSUS_UNAVAILABLE");
    expect(Object.hasOwn(device, "createTexture")).toBe(false);
  });
  it("does not count an allocation rejected by the actual device", () => {
    const device = new Device();
    device.createBuffer = () => {
      throw new Error("out of memory");
    };
    const original = device.createBuffer;
    const census = observeGPUResources(device);
    expect(() => device.createBuffer({ size: 8 })).toThrow("out of memory");
    expect(census.snapshot()).toMatchObject({ buffers: 0, createdBuffers: 0 });
    census.dispose();
    expect(device.createBuffer).toBe(original);
  });
  it("retains leaked identity even if another resource is destroyed to match the count", () => {
    const device = new Device();
    const census = observeGPUResources(device);
    const shared = device.createBuffer({ size: 8 });
    const baseline = census.snapshot();
    device.createBuffer({ size: 8 });
    shared.destroy();
    const after = census.snapshot();
    expect(after.buffers).toBe(baseline.buffers);
    expect(after.bufferBytes).toBe(baseline.bufferBytes);
    expect(after.bufferIds).not.toEqual(baseline.bufferIds);
    census.dispose();
  });
});
