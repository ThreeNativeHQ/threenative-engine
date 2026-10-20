import { describe, expect, it, vi } from "vitest";
import { TSL_NODE } from "../src/browser-backend.js";
import { bindUpstreamExports } from "../src/browser-entry.js";
import { type ITslRuntime, defineTsl } from "../src/browser-tsl.js";
import { loadCatalog } from "../src/catalog.js";

function facade() {
  let next = 0;
  const runtime: ITslRuntime = {
    call: vi.fn(() => ++next),
    release: vi.fn(),
    set: vi.fn(),
    setUniform: vi.fn(),
    effectParameter: vi.fn(() => 0),
    setPost: vi.fn(),
    compute: vi.fn(),
    readStorage: vi.fn(),
    deleteStorage: vi.fn(),
  };
  const tsl = defineTsl(runtime);
  const bound = bindUpstreamExports(
    ["TempNode", "NodeUpdateType", "float", "nodeObject"],
    loadCatalog(process.cwd()),
    tsl.exports,
  ) as unknown as {
    TempNode: new (
      type: string,
    ) => {
      updateBeforeType: string;
      setup(builder: unknown): unknown;
      updateBefore(frame: unknown): unknown;
      dispose(): void;
      readonly [TSL_NODE]: number;
    };
    NodeUpdateType: { FRAME: string; RENDER: string; OBJECT: string };
    float(value: unknown): { readonly [TSL_NODE]: number };
    nodeObject(value: unknown): unknown;
  };
  return { ...tsl, bound, runtime };
}

describe("Wasm TempNode subclass", () => {
  it("substitutes setup once and updates once per frame through the facade renderer", () => {
    const { bound, sync, runtime } = facade();
    const setup = vi.fn();
    const update = vi.fn();
    const result = bound.float(3);
    const renderer = {};
    class Exposure extends bound.TempNode {
      constructor() {
        super("float");
        this.updateBeforeType = bound.NodeUpdateType.FRAME;
      }
      override setup(builder: unknown) {
        super.setup(builder);
        setup(builder);
        return result;
      }
      override updateBefore(frame: unknown) {
        update(frame);
        // A target draw made by QuadMesh re-enters the renderer's pre-render hook.
        sync({ renderer, frameId: 0 } as never);
      }
    }
    const exposure = new Exposure();
    expect(setup).not.toHaveBeenCalled();
    expect(bound.nodeObject(exposure)).toBe(exposure);
    bound.float(exposure);
    bound.float(exposure);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(runtime.call).toHaveBeenLastCalledWith("float", null, [
      { kind: "node", node: result[TSL_NODE] },
    ]);
    sync({ renderer, frameId: 0 } as never);
    sync({ renderer, frameId: 0 } as never);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        renderer,
        frameId: 0,
        time: expect.any(Number),
        deltaTime: expect.any(Number),
      }),
    );
    sync({ renderer, frameId: 1 } as never);
    expect(update).toHaveBeenCalledTimes(2);
    exposure.dispose();
    exposure.dispose();
    sync({ renderer, frameId: 2 } as never);
    expect(update).toHaveBeenCalledTimes(2);
    expect(() => bound.float(exposure)).toThrow("TN_NATIVE_TEMPNODE_DISPOSED");
  });

  it("rejects missing and cyclic setup outputs without registering an updater", () => {
    const { bound, sync } = facade();
    const empty = new bound.TempNode("float");
    expect(() => bound.float(empty)).toThrow("TN_NATIVE_TEMPNODE_SETUP");
    class Cyclic extends bound.TempNode {
      override setup() {
        return this;
      }
    }
    expect(() => bound.float(new Cyclic("float"))).toThrow("TN_NATIVE_TEMPNODE_SETUP: cyclic");
    expect(() => sync({ renderer: {}, frameId: 0 })).not.toThrow();
  });

  it("retries a FRAME hook that returns false, as NodeFrame does", () => {
    const { bound, sync } = facade();
    const update = vi.fn(() => false);
    class Retry extends bound.TempNode {
      constructor() {
        super("float");
        this.updateBeforeType = "frame";
      }
      override setup() {
        return bound.float(1);
      }
      override updateBefore() {
        return update();
      }
    }
    const node = new Retry();
    bound.float(node);
    const frame = { renderer: {}, frameId: 0 };
    sync(frame);
    sync(frame);
    expect(update).toHaveBeenCalledTimes(2);
    node.dispose();
  });

  it.each(["RENDER", "OBJECT"] as const)("refuses %s update frequency precisely", (type) => {
    const { bound, sync } = facade();
    class Custom extends bound.TempNode {
      override setup() {
        return bound.float(1);
      }
    }
    const node = new Custom("float");
    node.updateBeforeType = bound.NodeUpdateType[type];
    bound.float(node);
    expect(() => sync({ renderer: {}, frameId: 0 } as never)).toThrow(
      "TN_NATIVE_TEMPNODE_UPDATE_TYPE",
    );
  });
});

describe("Wasm exposure boolean uniform", () => {
  it("keeps boolean .value live while giving select a boolean engine node", () => {
    const { exports, runtime } = facade();
    const uniform = exports.uniform as (value: boolean) => {
      value: boolean;
      readonly [TSL_NODE]: number;
    };
    const enabled = uniform(false);
    expect(enabled.value).toBe(false);
    expect(runtime.call).toHaveBeenCalledWith("notEqual", expect.any(Number), [
      { kind: "number", number: 0 },
    ]);
    enabled.value = true;
    expect(enabled.value).toBe(true);
    expect(runtime.setUniform).toHaveBeenLastCalledWith(expect.any(Number), [1]);
  });
});

describe("Wasm mutable texture boundary", () => {
  it("preserves the previous value when the engine refuses an invalid replacement", () => {
    const { exports, runtime } = facade();
    const texture = exports.texture as (value: unknown) => { value: unknown };
    const source = { name: "output" };
    const node = texture(source);
    expect(node.value).toBe(source);
    vi.mocked(runtime.call).mockImplementationOnce(() => {
      throw new Error("TN_NATIVE_TEXTURE_VALUE_TYPE: expected an engine Texture");
    });
    expect(() => {
      node.value = {};
    }).toThrow("TN_NATIVE_TEXTURE_VALUE_TYPE");
    expect(node.value).toBe(source);
  });
});
