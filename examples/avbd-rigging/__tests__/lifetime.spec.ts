import { ComputeDrivenRegistry, type IComputeDriven } from "@threenative/core";
import { Group } from "three";
import { describe, expect, it, vi } from "vitest";
import { RiggingRegistrations, observeStorage } from "../src/physics/lifetime.js";

const emptyMemory = () => ({
  memory: {
    attributes: 0,
    attributesSize: 0,
    geometries: 0,
    indexAttributes: 0,
    indexAttributesSize: 0,
    indirectStorageAttributes: 0,
    indirectStorageAttributesSize: 0,
    programs: 0,
    programsSize: 0,
    readbackBuffers: 0,
    readbackBuffersSize: 0,
    renderTargets: 0,
    storageAttributes: 0,
    storageAttributesSize: 0,
    textures: 0,
    texturesSize: 0,
    uniformBuffers: 0,
    uniformBuffersSize: 0,
    total: 0,
  },
});

class Driven extends Group implements IComputeDriven {
  readonly warmupNodes = [];
  released = false;
  attachRenderer = vi.fn();
  process = vi.fn();
  detach = vi.fn(() => {
    this.released = true;
  });
}

describe("actual registry and public memory lifecycle observations", () => {
  it("observes the real registry without stepping it and returns to the existing registration baseline", () => {
    const registry = new ComputeDrivenRegistry();
    const renderer = {} as Parameters<ComputeDrivenRegistry["add"]>[1];
    const existing = new Driven();
    registry.add(existing, renderer);
    const candidate = new Driven();
    const observer = new RiggingRegistrations((object) => object === candidate);
    observer.install();
    try {
      registry.add(candidate, renderer);
      registry.add(candidate, renderer);
      expect(observer.snapshot).toEqual({ registrations: 2, baseline: 1 });
      expect(candidate.attachRenderer).toHaveBeenCalledOnce();
      expect(candidate.process).not.toHaveBeenCalled();
      registry.remove(candidate);
      expect(observer.snapshot).toEqual({ registrations: 1, baseline: 1 });
      expect(candidate.detach).toHaveBeenCalledOnce();
      expect(existing.released).toBe(false);
    } finally {
      observer.dispose();
      registry.clear();
    }
    expect(observer.snapshot.registrations).toBe(0);
  });

  it("fails before an observation exists, on a second real registry, and on overlapping observers", () => {
    const candidate = new Driven();
    const renderer = {} as Parameters<ComputeDrivenRegistry["add"]>[1];
    const observer = new RiggingRegistrations((object) => object === candidate);
    expect(() => observer.snapshot).toThrow("TN_RIGGING_REGISTRY");
    observer.install();
    const registry = new ComputeDrivenRegistry();
    try {
      const other = new RiggingRegistrations(() => true);
      expect(() => other.install()).toThrow("TN_RIGGING_REGISTRY");
      registry.add(candidate, renderer);
      expect(() => new ComputeDrivenRegistry().add(candidate, renderer)).toThrow(
        "TN_RIGGING_REGISTRY",
      );
    } finally {
      observer.dispose();
      registry.clear();
    }
  });

  it("makes ordinary draw and uniform allocations visible even when solver storage is fully released", () => {
    const baseline = observeStorage(emptyMemory());
    const leaked = emptyMemory();
    leaked.memory.geometries = 1;
    leaked.memory.attributes = 2;
    leaked.memory.attributesSize = 96;
    leaked.memory.uniformBuffers = 1;
    leaked.memory.uniformBuffersSize = 256;
    leaked.memory.total = 352;
    const after = observeStorage(leaked);
    expect(after.storageAttributes).toBe(0);
    expect(after).not.toEqual(baseline);
    expect(after.geometries).toBe(1);
    expect(after.attributesSize).toBe(96);
    expect(after.uniformBuffersSize).toBe(256);
  });

  it("rejects missing or malformed ordinary draw observations instead of assuming zero", () => {
    const missing = emptyMemory();
    Reflect.deleteProperty(missing.memory, "geometries");
    expect(() => observeStorage(missing)).toThrow("TN_RIGGING_RESOURCES: geometries");
    const malformed = emptyMemory();
    malformed.memory.uniformBuffersSize = Number.NaN;
    expect(() => observeStorage(malformed)).toThrow("TN_RIGGING_RESOURCES: uniformBuffersSize");
  });
});
