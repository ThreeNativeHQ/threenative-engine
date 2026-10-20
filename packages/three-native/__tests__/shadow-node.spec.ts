import { DirectionalLight } from "three";
import { describe, expect, it, vi } from "vitest";
import { type IBrowserRuntime, defineBrowserClasses } from "../src/browser-backend.js";
import { bindUpstreamExports } from "../src/browser-entry.js";

import { ShadowBaseNode, virtualShadowOptions } from "../src/shadow-node.js";

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

it("constructs core's fixed-depth node and installs through the facade setter", async () => {
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
    lightDistance: 20,
    depthRange: 40,
    adaptiveRefresh: false,
    adaptiveCasterGate: false,
    followViewFocus: false,
    shadowLodBias: false,
    minCasterTexels: 0,
    invalidationDelay: 0,
  });
  shadow.shadowNode = node;
  expect(shadow.shadowNode).toBe(node);
  expect(writes).toContainEqual([
    expect.any(Object),
    "shadowNode",
    expect.objectContaining({ autoDepth: false, clipExtents: [8, 24] }),
  ]);
  expect(() => {
    shadow.filterNode = () => 0;
  }).toThrow("TN_VIRTUAL_SHADOW_UNSUPPORTED: filterNode");
  shadow.shadowNode = null;
  expect(writes.at(-1)).toEqual([expect.any(Object), "shadowNode", null]);
  node.dispose();
});
