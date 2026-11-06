import { describe, expect, it, vi } from "vitest";
import { gltfOf } from "../src/browser-abi-types.js";

// gltfOf stages each side file twice: a scratch copy the facade allocates, then the engine's own copy
// (tnw_web_gltf_file). The scratch is dead once that call returns, so it must not pile up across files.
describe("gltfOf side-file scratch", () => {
  const MB = 1024 * 1024;

  function harness() {
    const heap = new Uint8Array(8 * MB);
    let live = 0;
    const stack: number[] = [];
    let next = 8;
    const alloc = (size: number): number => {
      stack.push(size);
      live += size;
      const pointer = next;
      next += 8;
      return pointer;
    };
    const scoped = <T>(work: () => T): T => {
      const mark = stack.length;
      try {
        return work();
      } finally {
        while (stack.length > mark) live -= stack.pop() as number;
      }
    };
    const liveAtFileCall: number[] = [];
    const clear = vi.fn(() => 0);
    const abi = {
      HEAPU8: heap,
      lengthBytesUTF8: (text: string) => text.length,
      stringToUTF8: () => {},
      UTF8ToString: () => "",
      _tnw_web_load_error: () => 0,
      _tnw_web_gltf_files_clear: clear,
      _tnw_web_gltf_file: () => {
        liveAtFileCall.push(live);
        return 0;
      },
      _tnw_web_load_gltf: (
        _c: number,
        _d: number,
        _n: number,
        _o: number,
        _cap: number,
        count: number,
      ) => {
        new DataView(heap.buffer).setUint32(count, 1, true);
        return 0;
      },
    };
    const gltf = gltfOf(abi as never, 1, { scoped, alloc, keyOf: () => ({}) as never });
    return { gltf, liveAtFileCall, clear, live: () => live };
  }

  it("frees each file's scratch right after the engine copies it", () => {
    const { gltf, liveAtFileCall, clear, live } = harness();
    const files = new Map(["a.png", "b.png", "c.png"].map((uri) => [uri, new Uint8Array(4 * MB)]));
    gltf.loadGltf?.(new Uint8Array(16), files);
    expect(liveAtFileCall).toHaveLength(3);
    // One 4 MB file plus its name at a time, not 4, 8 and 12 MB.
    for (const seen of liveAtFileCall) expect(seen).toBeLessThanOrEqual(4 * MB + 64);
    expect(live()).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
