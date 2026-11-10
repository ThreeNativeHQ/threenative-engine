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

// PRD-762: a cooked model keeps each LOD level as a named scene (`fir_lod1`). The engine hands back the
// default scene, the clips, then every scene; reading only the first handle as a scene lost every
// level, and the forest drew 202 M triangles at LOD0 on the default engine.
describe("gltfOf scenes", () => {
  it("splits the default scene, the clips and every scene", () => {
    const heap = new Uint8Array(1024);
    const abi = {
      HEAPU8: heap,
      UTF8ToString: () => "",
      _tnw_web_load_error: () => 0,
      _tnw_web_load_gltf: (...args: number[]) => {
        const view = new DataView(heap.buffer);
        view.setUint32(args[5] as number, 4, true);
        view.setUint32(args[6] as number, 2, true);
        return 0;
      },
    };
    let next = 16;
    const alloc = (size: number): number => {
      const pointer = next;
      next += Math.max(8, size);
      return pointer;
    };
    const gltf = gltfOf(abi as never, 1, {
      scoped: (work) => work(),
      alloc,
      keyOf: (pointer: number) => ({ key: String(pointer) }) as never,
    });
    const loaded = gltf.loadGltf?.(new Uint8Array(16), undefined);
    const out = Number((loaded?.scene as unknown as { key: string }).key);
    const at = (i: number) => String(out + i * 12);
    expect(
      (loaded?.animations ?? []).map((ref) => (ref as unknown as { key: string }).key),
    ).toEqual([at(1)]);
    expect((loaded?.scenes ?? []).map((ref) => (ref as unknown as { key: string }).key)).toEqual([
      at(2),
      at(3),
    ]);
  });
});

// PRD-860: with the loader-thread exports, the load returns at once and hands the model over once the
// engine reports the ticket done; the main thread never waits inside the parse.
describe("gltfOf loader thread", () => {
  it("polls the ticket and shares the model only once the engine is done", async () => {
    const heap = new Uint8Array(1024);
    let next = 8;
    let finished = false;
    const calls: string[] = [];
    const abi = {
      HEAPU8: heap,
      lengthBytesUTF8: (text: string) => text.length,
      stringToUTF8: () => {},
      UTF8ToString: () => "",
      _tnw_web_load_error: () => 0,
      _tnw_web_gltf_files_clear: () => 0,
      _tnw_web_gltf_file: () => 0,
      _tnw_web_load_gltf: () => {
        calls.push("sync");
        return 1;
      },
      _tnw_web_load_gltf_begin: (_data: number, size: number) => {
        calls.push(`begin:${String(size)}`);
        return 7;
      },
      _tnw_web_load_gltf_done: (ticket: number) => (ticket === 7 && finished ? 1 : 0),
      _tnw_web_load_gltf_finish: (
        _c: number,
        ticket: number,
        out: number,
        _cap: number,
        count: number,
        scenes: number,
      ) => {
        calls.push(`finish:${String(ticket)}`);
        // The default scene, one clip, then the file's two scenes.
        new DataView(heap.buffer).setUint32(count, 4, true);
        new DataView(heap.buffer).setUint32(scenes, 2, true);
        return out > 0 ? 0 : 1;
      },
    };
    const alloc = (size: number): number => {
      const pointer = next;
      next += Math.max(8, size);
      return pointer;
    };
    const gltf = gltfOf(abi as never, 1, {
      alloc,
      keyOf: (pointer) => ({ pointer }) as never,
      scoped: (work) => work(),
    });

    const loading = gltf.loadGltfAsync?.(new Uint8Array(16));
    expect(loading).toBeInstanceOf(Promise);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["begin:16"]);
    finished = true;
    const model = await loading;
    expect(calls).toEqual(["begin:16", "finish:7"]);
    expect(model?.animations).toHaveLength(1);
    expect(model?.scenes).toHaveLength(2);
  });
});
