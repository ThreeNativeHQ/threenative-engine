import { TSL_NODE } from "./browser-backend.js";

// three r185: src/nodes/core/{TempNode,Node,NodeFrame}.js; shader temporaries stay in the engine.
export const NodeUpdateType = Object.freeze({
  // quality-allow: three r185 fixes this public enum key
  // biome-ignore lint/style/useNamingConvention: three r185 public enum key.
  NONE: "none",
  // quality-allow: three r185 fixes this public enum key
  // biome-ignore lint/style/useNamingConvention: three r185 public enum key.
  FRAME: "frame",
  // quality-allow: three r185 fixes this public enum key
  // biome-ignore lint/style/useNamingConvention: three r185 public enum key.
  RENDER: "render",
  // quality-allow: three r185 fixes this public enum key
  // biome-ignore lint/style/useNamingConvention: three r185 public enum key.
  OBJECT: "object",
});
export interface INodeFrame {
  renderer?: object;
  frameId?: number;
  camera?: unknown;
  scene?: unknown;
}

/**
 * three's TempNode over a back end's node `prototype`. `key` is the property the back end reads a
 * node through and `read` answers it from the setup output: the Wasm runtime's integer handle by
 * default, the engine node itself on the V8 player (its TSL adapter reads `threenative.tslNode`).
 */
export function defineTempNode(
  prototype: object,
  key: symbol = TSL_NODE,
  read: (output: object) => unknown = (output) => {
    const id = (output as { readonly [TSL_NODE]?: unknown })[TSL_NODE];
    return Number.isInteger(id) ? id : undefined;
  },
) {
  // Consumed graphs live in C++; retain their hooks until the owner disposes them.
  const active = new Set<TempNode>();
  const frames = new WeakMap<
    object,
    { frameId: number; time: number; deltaTime: number; last: number; updating: boolean }
  >();
  class TempNode {
    readonly isNode = true;
    readonly isTempNode = true;
    updateBeforeType: string = NodeUpdateType.NONE;
    #output?: object;
    #building = false;
    #disposed = false;
    #frames = new WeakMap<object, number>();
    constructor(readonly nodeType: string | null = null) {}
    setup(_builder: unknown): unknown {
      return null;
    }
    updateBefore(_frame: unknown): unknown {
      return undefined;
    }
    get [key](): unknown {
      if (this.#disposed)
        throw new Error("TN_NATIVE_TEMPNODE_DISPOSED: a disposed node cannot be consumed");
      if (this.#building) throw new Error("TN_NATIVE_TEMPNODE_SETUP: cyclic setup output");
      if (this.#output === undefined) {
        this.#building = true;
        try {
          const properties = new WeakMap<object, object>();
          const output = this.setup({
            getNodeProperties(node: object) {
              if (!properties.has(node)) properties.set(node, {});
              return properties.get(node);
            },
          });
          // Resolve while building to diagnose cycles instead of overflowing the JS stack.
          if (typeof output !== "object" || output === null || read(output) === undefined)
            throw new Error("TN_NATIVE_TEMPNODE_SETUP: setup(builder) must return a TSL node");
          this.#output = output;
          active.add(this);
        } finally {
          this.#building = false;
        }
      }
      return read(this.#output);
    }
    run(
      frame: INodeFrame & { renderer: object; frameId: number; time: number; deltaTime: number },
    ): void {
      const type = this.updateBeforeType;
      if (type === NodeUpdateType.NONE) return;
      if (type !== NodeUpdateType.FRAME)
        throw new Error(
          `TN_NATIVE_TEMPNODE_UPDATE_TYPE: '${type}' is unsupported; use NodeUpdateType.FRAME or NONE`,
        );
      if (this.#frames.get(frame.renderer) === frame.frameId) return;
      const previous = this.#frames.get(frame.renderer);
      this.#frames.set(frame.renderer, frame.frameId);
      if (this.updateBefore(frame) === false) {
        if (previous === undefined) this.#frames.delete(frame.renderer);
        else this.#frames.set(frame.renderer, previous);
      }
    }
    dispose(): void {
      this.#disposed = true;
      active.delete(this);
      this.#output = undefined;
    }
  }
  Object.setPrototypeOf(TempNode.prototype, prototype);
  return {
    TempNode,
    update(frame?: INodeFrame) {
      if (!frame?.renderer || frame.frameId === undefined) return;
      const renderer = frame.renderer;
      let state = frames.get(renderer);
      if (state?.updating) return;
      const now = performance.now() / 1000;
      if (!state) {
        state = { frameId: frame.frameId, time: 0, deltaTime: 0, last: now, updating: false };
        frames.set(renderer, state);
      }
      if (state.frameId !== frame.frameId) {
        state.deltaTime = now - state.last;
        state.time += state.deltaTime;
        state.last = now;
        state.frameId = frame.frameId;
      }
      state.updating = true;
      try {
        for (const node of active)
          node.run({
            ...frame,
            renderer,
            frameId: frame.frameId,
            time: state.time,
            deltaTime: state.deltaTime,
          });
      } finally {
        state.updating = false;
      }
    },
  };
}
