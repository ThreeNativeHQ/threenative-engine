import { BufferGeometry, DirectionalLight, Mesh, Scene } from "three";
import { describe, expect, it, vi } from "vitest";
import { type IBrowserRuntime, defineBrowserClasses } from "../src/browser-backend.js";
import { bindUpstreamExports } from "../src/browser-entry.js";

import {
  ShadowBaseNode,
  detachVirtualShadow,
  shadowFilterOptions,
  syncVirtualShadowLods,
  virtualShadowOptions,
} from "../src/shadow-node.js";

vi.mock("three/webgpu", async (original) => ({
  ...(await original<typeof import("three/webgpu")>()),
  ShadowBaseNode: (await import("../src/shadow-node.js")).ShadowBaseNode,
}));

describe("native virtual shadow binding", () => {
  it("binds the base used by core's subclass and translates resolved guards once", () => {
    const bound = bindUpstreamExports(["ShadowBaseNode"], { entries: [] }, { ShadowBaseNode });
    expect(bound.ShadowBaseNode).toBe(ShadowBaseNode);
    class VirtualShadowNode extends ShadowBaseNode {
      static override get type() {
        return "VirtualShadowNode";
      }
      options = {
        clipExtents: [8, 24],
        mapSize: 256,
        selectionGuard: [0.775, 0.65],
        refreshStep: [0.125, 0.25],
        lightDistance: 20,
        depthRange: 40,
      };
    }
    const light = { shadow: {} };
    const node = new VirtualShadowNode(light);
    expect(node.light).toBe(light);
    expect(node.updateBeforeType).toBe("render");
    expect(virtualShadowOptions(node)).toMatchObject({
      clipExtents: [8, 24],
      selectionGuard: [0.9, 0.9],
      refreshStep: [0.125, 0.25],
    });
    node.dispose();
    expect(() => virtualShadowOptions(node)).toThrow("TN_NATIVE_SHADOW_NODE_DISPOSED");
  });
  it("refuses unknown shadow subclasses instead of substituting a built-in map", () => {
    expect(() => virtualShadowOptions(new ShadowBaseNode({}))).toThrow(
      "TN_NATIVE_SHADOW_NODE_UNSUPPORTED",
    );
  });
});

it("constructs core's automatic-depth node and installs through the facade setter", async () => {
  // Runtime import keeps core typed by its own upstream declarations, not this facade's narrower catalog.
  const source = "../../core/src/render/virtual-shadow.ts";
  const { VirtualShadowNode: CoreVirtualShadowNode } = await import(source);
  const writes: unknown[] = [];
  const runtime = {
    typeId: () => 1,
    set: (...args: unknown[]) => {
      writes.push(args);
    },
    setCallback: () => {},
    release: () => {},
  } as unknown as IBrowserRuntime;
  const { wrap } = defineBrowserClasses(
    {
      classes: {
        DirectionalLightShadow: {
          constructor: false,
          methods: [],
          getters: [],
          setters: ["shadowNode", "filterNode"],
          members: [],
          callbacks: [],
        },
      },
    },
    runtime,
  );
  const shadow = wrap({ key: "sun-shadow", type: 1 }) as {
    shadowNode: unknown;
    filterNode: unknown;
  };
  const sun = new DirectionalLight();
  const node = new CoreVirtualShadowNode(sun, {
    clipExtents: [8, 24],
    marker: false,
  });
  shadow.shadowNode = node;
  expect(shadow.shadowNode).toBe(node);
  const installedWrites = writes.length;
  shadow.shadowNode = node;
  expect(writes).toHaveLength(installedWrites);
  expect(writes).toContainEqual([
    expect.any(Object),
    "shadowNode",
    expect.objectContaining({
      autoDepth: true,
      adaptiveRefresh: true,
      followViewFocus: true,
      clipExtents: [8, 24],
    }),
  ]);
  const caster = new Mesh(new BufferGeometry());
  const scene = new Scene();
  scene.add(sun, caster);
  node.trackCaster(caster);
  expect(writes.at(-1)).toEqual([
    expect.any(Object),
    "shadowNode",
    { command: "track", id: caster.id },
  ]);
  node.pinStatic(caster);
  expect(writes.at(-1)).toEqual([
    expect.any(Object),
    "shadowNode",
    { command: "pin", id: caster.id },
  ]);
  node.untrackCaster(caster);
  expect(writes.at(-1)).toEqual([
    expect.any(Object),
    "shadowNode",
    { command: "untrack", id: caster.id },
  ]);
  node.invalidateAll();
  expect(writes.at(-1)).toEqual([expect.any(Object), "shadowNode", { command: "invalidateAll" }]);
  node.invalidateRegion({ min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } });
  expect(writes.at(-1)).toEqual([
    expect.any(Object),
    "shadowNode",
    { command: "invalidateRegion", bounds: [-1, 0, -1, 1, 2, 1] },
  ]);
  const filterSource = "../../core/src/render/soft-shadow.ts";
  const { sourceAngleShadowFilter } = await import(filterSource);
  const filter = sourceAngleShadowFilter({
    sourceAngleRad: 0.01,
    blockerSamples: 8,
    filterSamples: 12,
    minPenumbraPixels: 1.5,
  });
  shadow.filterNode = filter;
  expect(shadow.filterNode).toBe(filter);
  expect(writes.at(-1)).toEqual([
    expect.any(Object),
    "filterNode",
    {
      sourceAngleRad: 0.01,
      blockerSamples: 8,
      filterSamples: 12,
      minPenumbraPixels: 1.5,
    },
  ]);
  shadow.filterNode = null;
  expect(shadow.filterNode).toBeNull();
  expect(() => {
    shadow.filterNode = () => 0;
  }).toThrow("TN_VIRTUAL_SHADOW_UNSUPPORTED: filterNode");
  shadow.shadowNode = null;
  expect(writes.at(-1)).toEqual([expect.any(Object), "shadowNode", null]);
  node.dispose();
});

it("validates branded source-angle parameters before either engine ABI sees them", () => {
  expect(shadowFilterOptions(null)).toBeNull();
  for (const options of [
    { sourceAngleRad: Number.NaN, blockerSamples: 16, filterSamples: 16 },
    { sourceAngleRad: Math.PI / 2, blockerSamples: 16, filterSamples: 16 },
    { sourceAngleRad: 0, blockerSamples: 0, filterSamples: 16 },
    { sourceAngleRad: 0, blockerSamples: 16, filterSamples: 65 },
    { sourceAngleRad: 0, blockerSamples: 1.5, filterSamples: 16 },
    { sourceAngleRad: 0, blockerSamples: 16, filterSamples: 16, minPenumbraPixels: -1 },
    { sourceAngleRad: 0, blockerSamples: 16, filterSamples: 16, minPenumbraPixels: 17 },
    { sourceAngleRad: 0, blockerSamples: 16, filterSamples: 16, minPenumbraPixels: "1" },
  ]) {
    const callback = Object.assign(() => {}, {
      [Symbol.for("threenative.sourceAngleShadowFilter")]: options,
    });
    expect(() => shadowFilterOptions(callback)).toThrow("TN_VIRTUAL_SHADOW_INVALID");
  }
});

it("passes a sun's pixel floor to the engine only when the filter names one", () => {
  const tag = Symbol.for("threenative.sourceAngleShadowFilter");
  const sun = (options: object) => Object.assign(() => {}, { [tag]: options });
  expect(
    shadowFilterOptions(
      sun({ sourceAngleRad: 0.01, blockerSamples: 8, filterSamples: 12, minPenumbraPixels: 2 }),
    ),
  ).toEqual({ sourceAngleRad: 0.01, blockerSamples: 8, filterSamples: 12, minPenumbraPixels: 2 });
  expect(
    shadowFilterOptions(sun({ sourceAngleRad: 0.01, blockerSamples: 8, filterSamples: 12 })),
  ).toEqual({ sourceAngleRad: 0.01, blockerSamples: 8, filterSamples: 12 });
});

it("passes a lamp's source-radius filter and refuses a bad radius", () => {
  const tag = Symbol.for("threenative.sourceRadiusShadowFilter");
  const lamp = (options: object) => Object.assign(() => {}, { [tag]: options });
  expect(
    shadowFilterOptions(
      lamp({ sourceRadius: 0.05, blockerSamples: 16, filterSamples: 8, penumbraScale: 0.6 }),
    ),
  ).toEqual({
    sourceRadius: 0.05,
    blockerSamples: 16,
    filterSamples: 8,
    penumbraScale: 0.6,
  });
  for (const sourceRadius of [-0.1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() =>
      shadowFilterOptions(
        lamp({ sourceRadius, blockerSamples: 16, filterSamples: 16, penumbraScale: 1 }),
      ),
    ).toThrow("TN_VIRTUAL_SHADOW_INVALID: source-radius filter");
  // The share of the geometric penumbra is required and bounded; a missing one is not guessed.
  for (const penumbraScale of [undefined, 0, -1, Number.NaN, 4.5])
    expect(() =>
      shadowFilterOptions(
        lamp({ sourceRadius: 0.05, blockerSamples: 16, filterSamples: 16, penumbraScale }),
      ),
    ).toThrow("TN_VIRTUAL_SHADOW_INVALID: source-radius filter");
  expect(() => shadowFilterOptions(() => {})).toThrow("TN_VIRTUAL_SHADOW_UNSUPPORTED");
});

it("transfers registered LOD chain data once and clears its dispatch on disposal", () => {
  class VirtualShadowNode extends ShadowBaseNode {
    static override get type() {
      return "VirtualShadowNode";
    }
    options = { selectionGuard: [0.775], refreshStep: [0.125] };
  }
  const sun = new DirectionalLight();
  const scene = new Scene();
  const mesh = new Mesh(new BufferGeometry());
  scene.add(sun, mesh);
  const node = new VirtualShadowNode(sun);
  const dispatch = vi.fn();
  virtualShadowOptions(node, dispatch);
  const key = Symbol.for("threenative.discreteLodChains");
  const previous = (globalThis as Record<symbol, unknown>)[key];
  const coarse = new BufferGeometry();
  (globalThis as Record<symbol, unknown>)[key] = new WeakMap([
    [mesh.geometry, { chain: { levels: [mesh.geometry, coarse], errors: [0, 0.25] } }],
  ]);
  try {
    syncVirtualShadowLods();
    syncVirtualShadowLods();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      command: "lod",
      id: mesh.id,
      geometries: [coarse],
      errors: [0.25],
    });
    detachVirtualShadow(node);
    expect(node.lods.size).toBe(0);
    virtualShadowOptions(node, dispatch);
    syncVirtualShadowLods();
    expect(dispatch).toHaveBeenCalledTimes(2);
    node.dispose();
    expect(node.dispatch).toBeUndefined();
  } finally {
    (globalThis as Record<symbol, unknown>)[key] = previous;
    node.dispose();
  }
});
