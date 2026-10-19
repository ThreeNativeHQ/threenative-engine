import { describe, expect, it, vi } from "vitest";
import { createTemporalRejectionCounter } from "../templates/starter/src/render/temporalRejectionCounter.js";

describe("owned rejection dispatch/storage lifetime", () => {
  it("releases replaced/final dispatches and defers owned storage release until its readback settles", async () => {
    let complete: (v: ArrayBuffer) => void = () => {};
    const disposed: unknown[] = [];
    const nodes: { addEventListener(type: string, callback: () => void): void }[] = [];
    const storage: unknown[] = [];
    const renderer = {
      compute: (node: (typeof nodes)[number]) => {
        if (!nodes.includes(node)) {
          nodes.push(node);
          node.addEventListener("dispose", () => disposed.push(node));
        }
      },
      getArrayBufferAsync: vi.fn((attribute) => {
        storage.push(attribute);
        return new Promise<ArrayBuffer>((resolve) => {
          complete = resolve;
        });
      }),
      deleteAttribute: vi.fn(),
    };
    const counter = createTemporalRejectionCounter({} as never);
    counter.sample(renderer as never, 1, 2, 2);
    counter.sample(renderer as never, 2, 3, 2);
    expect(nodes).toHaveLength(3);
    expect(disposed).toEqual([nodes[1]]);
    counter.dispose();
    counter.dispose();
    expect(new Set(disposed).size).toBe(3);
    expect(disposed).toHaveLength(3);
    expect(renderer.deleteAttribute).not.toHaveBeenCalled();
    complete(new Uint32Array([1, 4]).buffer);
    await counter.settled();
    expect(renderer.deleteAttribute).toHaveBeenCalledExactlyOnceWith(storage[0]);
    expect(counter.report(2)).toBeUndefined();
  });
});
