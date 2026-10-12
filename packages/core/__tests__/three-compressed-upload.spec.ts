import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CompressedArrayTexture, CompressedTexture, RGBA_BPTC_Format } from "three";
import Renderer from "three/src/renderers/common/Renderer.js";
// @ts-expect-error Three does not declare its internal texture manager.
import Textures from "three/src/renderers/common/Textures.js";
// @ts-expect-error Three does not declare its internal texture uploader.
import WebGPUTextureUtils from "three/src/renderers/webgpu/utils/WebGPUTextureUtils.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe.each(["source", "webgpu bundle", "nodes bundle"])(
  "%s compressed upload lifecycle",
  (mode) => {
    let TextureManager = Textures;
    let TextureUtils = WebGPUTextureUtils;
    let prepareTexture = Reflect.get(Renderer.prototype, "prepareTextureAsync") as (
      texture: CompressedTexture,
      options: { signal?: AbortSignal },
    ) => Promise<void>;
    beforeAll(async () => {
      if (mode === "source") return;
      const root =
        process.env.THREE_UPLOAD_TEST_ROOT ??
        resolve(dirname(createRequire(import.meta.url).resolve("three")), "..");
      const url = pathToFileURL(
        resolve(
          root,
          "build",
          mode === "webgpu bundle" ? "three.webgpu.js" : "three.webgpu.nodes.js",
        ),
      ).href;
      const { WebGPURenderer } = await import(/* @vite-ignore */ url);
      const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } });
      renderer.backend.init = async () => {};
      vi.stubGlobal("self", { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
      try {
        await renderer.init();
        TextureManager = renderer._textures.constructor;
        TextureUtils = renderer.backend.textureUtils.constructor;
        prepareTexture = renderer.prepareTextureAsync;
        renderer._animation.stop();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    function fixture(format = "bc7-rgba-unorm") {
      let clock = 0;
      const writes: Array<{
        bytes: number;
        mip: number;
        origin: { x: number; y: number; z: number };
        extent: { width: number; height: number };
        data: Uint8Array;
        stride: number;
        gpuTexture: object;
      }> = [];
      const gpuData = new WeakMap<object, Record<string, unknown>>();
      const get = (texture: object) => {
        let data = gpuData.get(texture);
        if (!data) {
          data = {};
          gpuData.set(texture, data);
        }
        return data;
      };
      const device = {
        queue: {
          writeTexture: (
            destination: {
              mipLevel: number;
              origin: { x: number; y: number; z: number };
              texture: object;
            },
            data: Uint8Array,
            layout: { bytesPerRow: number },
            extent: { width: number; height: number },
          ) => {
            clock += 0.75;
            writes.push({
              bytes: data.byteLength,
              mip: destination.mipLevel,
              origin: { ...destination.origin },
              extent: { ...extent },
              data: data.slice(),
              stride: layout.bytesPerRow,
              gpuTexture: destination.texture,
            });
          },
        },
      };
      const has = (texture: object) => gpuData.has(texture);
      const utils = new TextureUtils({ device, get, has });
      const create = vi.fn(
        (
          texture: object,
          options: { width: number; height: number; levels: number; depth: number },
        ) => {
          Object.assign(get(texture), {
            texture: { destroy: vi.fn() },
            textureDescriptorGPU: {
              format,
              size: {
                width: options.width,
                height: options.height,
                depthOrArrayLayers: options.depth,
              },
              mipLevelCount: options.levels,
            },
          });
        },
      );
      const backend = {
        device,
        get,
        has,
        createTexture: create,
        createDefaultTexture: (texture: object) =>
          Object.assign(get(texture), { texture: { destroy: vi.fn() } }),
        updateTexture: (texture: object, options: object) => utils.updateTexture(texture, options),
        updateTextureAsync: (texture: object, options: object) =>
          utils.updateTextureAsync(texture, options),
        destroyTexture: vi.fn((texture: object) => {
          const data = gpuData.get(texture);
          if (data) (data.texture as { destroy(): void }).destroy();
          gpuData.delete(texture);
        }),
      };
      const info = { createTexture: vi.fn(), destroyTexture: vi.fn() };
      const manager = new TextureManager({}, backend, info);
      const mipmaps = [2048, 1024, 512].map((size) => ({
        width: size,
        height: size,
        data: new Uint8Array((size / 4) ** 2 * 16),
      }));
      const texture = new CompressedTexture(mipmaps, 2048, 2048, RGBA_BPTC_Format);
      texture.needsUpdate = true;
      texture.onUpdate = vi.fn();
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      return { backend, clock: () => clock, create, get, info, manager, texture, utils, writes };
    }

    it("reproduces whole compressed mip submissions through the real common texture lifecycle", () => {
      const f = fixture();
      f.manager.updateTexture(f.texture);
      expect(f.writes.map((write) => write.bytes)).toEqual([4_194_304, 1_048_576, 262_144]);
      expect(f.manager.get(f.texture).version).toBe(f.texture.version);
      expect(f.get(f.texture).version).toBe(f.texture.version);
      expect(f.texture.onUpdate).toHaveBeenCalledTimes(1);
    });

    async function firstBatch() {
      await Promise.resolve();
      await Promise.resolve();
    }

    function delayedScopes(f: ReturnType<typeof fixture>) {
      const stack: string[] = [];
      const pops: Array<{
        resolve(error: null | { message: string }): void;
        reject(error: Error): void;
      }> = [];
      Object.assign(f.backend.device, {
        pushErrorScope: (filter: string) => stack.push(filter),
        popErrorScope: () => {
          expect(stack.pop()).toBe(pops.length % 2 === 0 ? "validation" : "out-of-memory");
          return new Promise<null | { message: string }>((resolve, reject) => {
            pops.push({ resolve, reject });
          });
        },
      });
      return { stack, pops };
    }

    function prepare(f: ReturnType<typeof fixture>, texture = f.texture, options = {}) {
      return prepareTexture.call({ _initialized: true, _textures: f.manager }, texture, options);
    }

    it("pipelines at most four bounded batches through Renderer and awaits all validation before completion", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        f.texture.mipmaps = [{ width: 1024, height: 1024, data: new Uint8Array(1_048_576) }];
        const scopes = delayedScopes(f);
        let complete = false;
        const pending = prepare(f).then(() => {
          complete = true;
        });
        await firstBatch();
        await vi.runAllTimersAsync();
        expect(f.writes).toHaveLength(12);
        expect(scopes.pops).toHaveLength(8);
        expect(scopes.stack).toEqual([]);
        expect(complete).toBe(false);
        expect(f.writes.every((write) => write.bytes <= 65_536)).toBe(true);
        // The oldest batch releases one slot; later results cannot bypass the cap.
        scopes.pops[0]?.resolve(null);
        scopes.pops[1]?.resolve(null);
        await vi.runAllTimersAsync();
        expect(f.writes).toHaveLength(15);
        expect(scopes.pops).toHaveLength(10);
        scopes.pops[2]?.resolve(null);
        scopes.pops[3]?.resolve(null);
        await vi.runAllTimersAsync();
        expect(f.writes).toHaveLength(16);
        expect(scopes.pops).toHaveLength(12);
        for (const pop of scopes.pops.slice(5)) pop.resolve(null);
        await vi.runAllTimersAsync();
        expect(complete).toBe(false);
        expect(f.get(f.texture).version).not.toBe(f.texture.version);
        expect(f.manager.get(f.texture).version).not.toBe(f.texture.version);
        expect(f.texture.onUpdate).not.toHaveBeenCalled();
        scopes.pops[4]?.resolve(null);
        await pending;
        expect(f.get(f.texture).version).toBe(f.texture.version);
        expect(f.manager.get(f.texture).version).toBe(f.texture.version);
        expect(f.texture.onUpdate).toHaveBeenCalledOnce();
        expect(f.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(1_048_576);
      } finally {
        vi.useRealTimers();
      }
    });

    it("awaits and collects both scope failures before rejecting public preparation", async () => {
      const f = fixture();
      const scopes = delayedScopes(f);
      const texture = smallTexture();
      let settled = false;
      const pending = prepare(f, texture).catch((error: Error) => {
        settled = true;
        return error;
      });
      await firstBatch();
      scopes.pops[0]?.reject(new Error("validation scope rejected"));
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(settled).toBe(false);
      scopes.pops[1]?.resolve({ message: "out of memory" });
      const error = await pending;
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map((failure: Error) => failure.message)).toEqual([
        "validation scope rejected",
        "out of memory",
      ]);
      expect(texture.onUpdate).not.toHaveBeenCalled();
      expect(f.manager.get(texture).version).toBeUndefined();
      expect(f.get(texture).version).toBeUndefined();
    });

    it("drains every issued batch after a late error and keeps the next texture queued", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const scopes = delayedScopes(f);
        let settled = false;
        const pending = prepare(f).catch((error: Error) => {
          settled = true;
          return error;
        });
        const queued = smallTexture();
        const later = prepare(f, queued);
        await firstBatch();
        await vi.runAllTimersAsync();
        expect(scopes.pops).toHaveLength(8);
        const writes = f.writes.length;
        scopes.pops[6]?.resolve({ message: "late validation error" });
        scopes.pops[7]?.reject(new Error("late out of memory"));
        for (const pop of scopes.pops.slice(0, 5)) pop.resolve(null);
        await vi.runAllTimersAsync();
        expect(settled).toBe(false);
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.writes).toHaveLength(writes);
        scopes.pops[5]?.resolve(null);
        const error = await pending;
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toHaveLength(2);
        expect(f.texture.onUpdate).not.toHaveBeenCalled();
        expect(f.get(f.texture).version).toBeUndefined();
        await vi.runAllTimersAsync();
        expect(f.create).toHaveBeenCalledTimes(2);
        for (const pop of scopes.pops.slice(8)) pop.resolve(null);
        await vi.runAllTimersAsync();
        await later;
        expect(queued.onUpdate).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["cancel", "dispose", "version"])(
      "keeps pipelined validation inert after %s",
      async (reason) => {
        vi.useFakeTimers();
        try {
          const f = fixture();
          const scopes = delayedScopes(f);
          const controller = new AbortController();
          const pending = prepare(f, f.texture, { signal: controller.signal });
          const rejected = expect(pending).rejects.toThrow(/cancel|disposed|changed|invalidated/i);
          rejected.catch(() => {});
          await firstBatch();
          await vi.runAllTimersAsync();
          expect(scopes.pops).toHaveLength(8);
          const writes = f.writes.length;
          if (reason === "cancel") controller.abort(new Error("cancelled"));
          if (reason === "dispose") f.texture.dispose();
          if (reason === "version") f.texture.needsUpdate = true;
          for (const pop of scopes.pops) pop.resolve(null);
          await vi.runAllTimersAsync();
          await rejected;
          expect(f.writes).toHaveLength(writes);
          expect(f.texture.onUpdate).not.toHaveBeenCalled();
          if (f.backend.has(f.texture)) expect(f.get(f.texture).version).toBeUndefined();
          expect(scopes.stack).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("keeps the backend lane until cancelled validation drains while rejecting the caller promptly", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const scopes = delayedScopes(f);
        const controller = new AbortController();
        const first = prepare(f, f.texture, { signal: controller.signal });
        const rejected = expect(first).rejects.toThrow("caller cancelled");
        const queued = smallTexture();
        const later = prepare(f, queued);
        await firstBatch();
        await vi.runAllTimersAsync();
        expect(scopes.pops).toHaveLength(8);
        controller.abort(new Error("caller cancelled"));
        await rejected;
        await vi.runAllTimersAsync();
        expect(f.create).toHaveBeenCalledTimes(1);
        const writes = f.writes.length;
        for (const pop of scopes.pops.slice(0, 7)) pop.resolve(null);
        await vi.runAllTimersAsync();
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.writes).toHaveLength(writes);
        scopes.pops[7]?.resolve(null);
        await vi.runAllTimersAsync();
        expect(f.create).toHaveBeenCalledTimes(2);
        expect(f.texture.onUpdate).not.toHaveBeenCalled();
        for (const pop of scopes.pops.slice(8)) pop.resolve(null);
        await vi.runAllTimersAsync();
        await later;
        expect(queued.onUpdate).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ["bc1-rgba-unorm", 4, 4, 8],
      ["bc7-rgba-unorm", 4, 4, 16],
      ["astc-5x4-unorm", 5, 4, 16],
    ])(
      "preserves every block, mip tail and layer for %s with bounded views",
      async (format, bw, bh, bb) => {
        vi.useFakeTimers();
        try {
          const f = fixture(format);
          const sizes: Array<[number, number]> = [
            [320, 64],
            [160, 32],
            [80, 16],
            [40, 8],
            [20, 4],
            [10, 2],
            [5, 1],
          ];
          const mips = sizes.map(([width, height]) => {
            const length = Math.ceil(width / bw) * Math.ceil(height / bh) * bb * 3;
            const backing = new Uint8Array(length + 11);
            const data = backing.subarray(11);
            for (let i = 0; i < data.length; i++) data[i] = (i * 37 + width) % 251;
            return { width, height, data };
          });
          const texture = new CompressedArrayTexture(mips, 320, 64, 3, RGBA_BPTC_Format);
          texture.needsUpdate = true;
          const pending = f.manager.updateTextureAsync(texture, {
            budgetMs: 2,
            maxBytesPerWrite: 48,
          });
          await vi.runAllTimersAsync();
          await pending;
          const rebuilt = mips.map((mip) => new Uint8Array(mip.data.length));
          const coverage = mips.map((mip) => new Uint8Array(mip.data.length));
          for (const write of f.writes) {
            expect(write.bytes).toBeLessThanOrEqual(48);
            expect(write.origin.x % bw).toBe(0);
            expect(write.origin.y % bh).toBe(0);
            expect(write.extent.width % bw).toBe(0);
            expect(write.extent.height % bh).toBe(0);
            const mip = mips[write.mip];
            if (!mip) throw new Error("Unexpected mip index");
            const stride = Math.ceil(mip.width / bw) * bb;
            const rows = Math.ceil(mip.height / bh);
            const widthBytes = (write.extent.width / bw) * bb;
            for (let row = 0; row < write.extent.height / bh; row++) {
              const offset =
                write.origin.z * stride * rows +
                (write.origin.y / bh + row) * stride +
                (write.origin.x / bw) * bb;
              rebuilt[write.mip]?.set(
                write.data.subarray(row * write.stride, row * write.stride + widthBytes),
                offset,
              );
              for (let i = offset; i < offset + widthBytes; i++) {
                const covered = coverage[write.mip];
                if (!covered) throw new Error("Unexpected coverage mip");
                covered[i] = (covered[i] ?? 0) + 1;
              }
            }
          }
          expect(rebuilt).toEqual(mips.map((mip) => mip.data));
          expect(coverage.every((mip) => mip.every((count) => count === 1))).toBe(true);
          expect(new Set(f.writes.map((write) => write.gpuTexture)).size).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("deduplicates one Texture while one caller aborts and another retains the gate", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const controller = new AbortController();
        const first = f.manager.updateTextureAsync(f.texture, { signal: controller.signal });
        const second = f.manager.updateTextureAsync(f.texture);
        const rejected = expect(first).rejects.toThrow("caller cancelled");
        await firstBatch();
        controller.abort(new Error("caller cancelled"));
        await rejected;
        await vi.runAllTimersAsync();
        await second;
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.texture.onUpdate).toHaveBeenCalledTimes(1);
        expect(f.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(5_505_024);
      } finally {
        vi.useRealTimers();
      }
    });

    it("serializes distinct Texture clones sharing a Source and keeps distinct GPU identities", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const clone = f.texture.clone();
        expect(clone.source).toBe(f.texture.source);
        const first = f.manager.updateTextureAsync(f.texture);
        const second = f.manager.updateTextureAsync(clone);
        await firstBatch();
        expect(f.create).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        await Promise.all([first, second]);
        expect(f.create).toHaveBeenCalledTimes(2);
        expect(new Set(f.writes.map((write) => write.gpuTexture)).size).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["last caller", "texture dispose", "manager dispose", "device loss"])(
      "rejects %s promptly without late writes or completion",
      async (reason) => {
        vi.useFakeTimers();
        try {
          const f = fixture();
          let lose = () => {};
          Object.assign(f.backend.device, {
            lost: new Promise<void>((resolve) => {
              lose = resolve;
            }),
          });
          const controller = new AbortController();
          const pending = f.manager.updateTextureAsync(f.texture, { signal: controller.signal });
          const rejected = expect(pending).rejects.toThrow();
          await firstBatch();
          const count = f.writes.length;
          if (reason === "last caller") controller.abort(new Error("last caller"));
          if (reason === "texture dispose") f.texture.dispose();
          if (reason === "manager dispose") f.manager.dispose();
          if (reason === "device loss") lose();
          await rejected;
          await vi.runAllTimersAsync();
          expect(f.writes).toHaveLength(count);
          expect(f.texture.onUpdate).not.toHaveBeenCalled();
          if (reason.includes("dispose")) expect(f.manager.has(f.texture)).toBe(false);
          else expect(f.manager.get(f.texture).version).not.toBe(f.texture.version);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("rejects a version change and never commits the new version from the old upload", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const pending = f.manager.updateTextureAsync(f.texture);
        const rejected = expect(pending).rejects.toThrow(/changed|invalidated/i);
        await firstBatch();
        f.texture.needsUpdate = true;
        await vi.runAllTimersAsync();
        await rejected;
        expect(f.manager.get(f.texture).version).not.toBe(f.texture.version);
        expect(f.get(f.texture).version).not.toBe(f.texture.version);
        expect(f.texture.onUpdate).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not overwrite onUpdate's next version or accept a warm in-place upload", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const version = f.texture.version;
        f.texture.onUpdate = vi.fn(() => {
          f.texture.needsUpdate = true;
        });
        const pending = f.manager.updateTextureAsync(f.texture);
        await vi.runAllTimersAsync();
        await pending;
        expect(f.manager.get(f.texture).version).toBe(version);
        expect(f.get(f.texture).version).toBe(version);
        expect(f.texture.version).toBe(version + 1);
        const count = f.writes.length;
        await expect(f.manager.updateTextureAsync(f.texture)).rejects.toThrow(/cold/i);
        expect(f.writes).toHaveLength(count);
      } finally {
        vi.useRealTimers();
      }
    });

    it("pops validation scopes before yielding and rejects queued validation errors", async () => {
      const f = fixture();
      const scopes: string[] = [];
      const pop = vi.fn(() => {
        scopes.pop();
        return Promise.resolve({ message: "invalid compressed write" });
      });
      Object.assign(f.backend.device, {
        pushErrorScope: (scope: string) => scopes.push(scope),
        popErrorScope: pop,
      });
      await expect(f.manager.updateTextureAsync(f.texture)).rejects.toThrow(
        "invalid compressed write",
      );
      expect(scopes).toEqual([]);
      expect(pop).toHaveBeenCalledTimes(2);
      expect(f.texture.onUpdate).not.toHaveBeenCalled();
      expect(f.manager.get(f.texture).version).not.toBe(f.texture.version);
    });

    it("advances delayed scope results and host yields without a world submission or overlay scope capture", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const scopes: string[] = [];
        const delayed: Array<(error: null) => void> = [];
        let pops = 0;
        let overlayElapsed = 0;
        const submit = vi.fn();
        const copy = vi.fn(() => {
          expect(scopes).toEqual([]);
          overlayElapsed += 40;
        });
        Object.assign(f.backend.device.queue, { submit, copyExternalImageToTexture: copy });
        Object.assign(f.backend.device, {
          pushErrorScope: (filter: string) => scopes.push(filter),
          popErrorScope: () => {
            expect(scopes.pop()).toBe(pops % 2 === 0 ? "validation" : "out-of-memory");
            return pops++ < 2
              ? new Promise<null>((resolve) => delayed.push(resolve))
              : Promise.resolve(null);
          },
        });
        vi.spyOn(performance, "now").mockImplementation(() => f.clock() + overlayElapsed);
        const queued = smallTexture();
        let completed = false;
        const pending = f.manager.updateTextureAsync(f.texture).then(() => {
          completed = true;
        });
        const later = f.manager.updateTextureAsync(queued);
        await firstBatch();
        expect(f.writes).toHaveLength(3);
        expect(scopes).toEqual([]);
        expect(delayed).toHaveLength(2);
        expect(f.create).toHaveBeenCalledTimes(1);
        f.utils._copyImageToTexture(
          { width: 1000, height: 48 },
          {},
          { size: { width: 1000, height: 48 } },
          0,
          false,
          false,
        );
        await vi.runAllTimersAsync();
        expect(completed).toBe(false);
        expect(f.writes).toHaveLength(12);
        for (const resolve of delayed) resolve(null);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        // The actual next boundary is the host yield; no render/submit callback releases it.
        expect(completed).toBe(false);
        expect(f.create).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        await Promise.all([pending, later]);
        expect(f.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(5_505_040);
        expect(f.manager.get(f.texture).version).toBe(f.texture.version);
        expect(f.manager.get(queued).version).toBe(queued.version);
        expect(f.texture.onUpdate).toHaveBeenCalledOnce();
        expect(queued.onUpdate).toHaveBeenCalledOnce();
        expect(copy).toHaveBeenCalledOnce();
        expect(submit).not.toHaveBeenCalled();
        expect(scopes).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects replacement of a mip without committing captured data as current", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const pending = f.manager.updateTextureAsync(f.texture);
        const rejected = expect(pending).rejects.toThrow(/changed/i);
        await firstBatch();
        f.texture.mipmaps[0] = { width: 2048, height: 2048, data: new Uint8Array(4_194_304) };
        await vi.runAllTimersAsync();
        await rejected;
        expect(f.texture.onUpdate).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects new preparation after device loss before any additional write", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        let lose = () => {};
        Object.assign(f.backend.device, {
          lost: new Promise<void>((resolve) => {
            lose = resolve;
          }),
        });
        const first = f.manager.updateTextureAsync(f.texture);
        const rejected = expect(first).rejects.toThrow(/lost/i);
        await firstBatch();
        lose();
        await rejected;
        const count = f.writes.length;
        await expect(f.manager.updateTextureAsync(f.texture.clone())).rejects.toThrow(/lost/i);
        await vi.runAllTimersAsync();
        expect(f.writes).toHaveLength(count);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retains a synchronous write failure while observing rejected scope-pop promises", async () => {
      const f = fixture();
      Object.assign(f.backend.device, {
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(() => Promise.reject(new Error("scope pop failed"))),
      });
      vi.spyOn(f.backend.device.queue, "writeTexture").mockImplementation(() => {
        throw new Error("original write failed");
      });
      await expect(f.manager.updateTextureAsync(f.texture)).rejects.toThrow(
        "original write failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.texture.onUpdate).not.toHaveBeenCalled();
    });

    it("keeps ownership established and completion unpublished at the first bounded host yield", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const pending = f.manager.updateTextureAsync(f.texture, {
          budgetMs: 2,
          maxBytesPerWrite: 65_536,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.info.createTexture).toHaveBeenCalledTimes(1);
        expect(f.manager.get(f.texture).initialized).toBe(true);
        expect(f.manager.get(f.texture).version).not.toBe(f.texture.version);
        expect(f.get(f.texture).version).not.toBe(f.texture.version);
        expect(f.texture.onUpdate).not.toHaveBeenCalled();
        expect(f.writes.length).toBeGreaterThan(0);
        expect(f.writes.every((write) => write.bytes <= 65_536)).toBe(true);
        expect(f.clock()).toBeLessThanOrEqual(2.75);
        const writes = f.writes.length;
        expect(() => f.manager.updateTexture(f.texture)).toThrow(/pending/i);
        expect(f.writes).toHaveLength(writes);
        await vi.runAllTimersAsync();
        await pending;
        expect(f.manager.get(f.texture).version).toBe(f.texture.version);
        expect(f.get(f.texture).version).toBe(f.texture.version);
        expect(f.texture.onUpdate).toHaveBeenCalledTimes(1);
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(5_505_024);
      } finally {
        vi.useRealTimers();
      }
    });

    function smallTexture() {
      const texture = new CompressedTexture(
        [{ width: 4, height: 4, data: new Uint8Array(16) }],
        4,
        4,
        RGBA_BPTC_Format,
      );
      texture.needsUpdate = true;
      texture.onUpdate = vi.fn();
      return texture;
    }

    it("rejects queued readiness changes before allocation or completion", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const first = f.manager.updateTextureAsync(f.texture);
        const queued = smallTexture();
        const pending = f.manager.updateTextureAsync(queued);
        const rejected = expect(pending).rejects.toThrow(/ready|changed|invalidated/i);
        rejected.catch(() => {});
        queued.source.dataReady = false;
        await vi.runAllTimersAsync();
        await first;
        await rejected;
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(queued.onUpdate).not.toHaveBeenCalled();
        expect(f.manager.get(queued).version).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("retires pending allocations and listeners exactly once on manager disposal", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const pending = f.manager.updateTextureAsync(f.texture);
        const rejected = expect(pending).rejects.toThrow(/disposed/i);
        await firstBatch();
        const gpu = f.get(f.texture).texture as { destroy: ReturnType<typeof vi.fn> };
        const remove = vi.spyOn(f.texture, "removeEventListener");
        f.manager.dispose();
        await rejected;
        f.texture.dispose();
        await vi.runAllTimersAsync();
        expect(gpu.destroy).toHaveBeenCalledTimes(1);
        expect(f.backend.destroyTexture).toHaveBeenCalledTimes(1);
        expect(f.info.destroyTexture).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith("dispose", expect.any(Function));
        expect(f.backend.has(f.texture)).toBe(false);
        expect(f.manager.has(f.texture)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects backend deletion during final validation without recreating GPU data", async () => {
      const f = fixture();
      const texture = smallTexture();
      const pops: Array<(error: null) => void> = [];
      Object.assign(f.backend.device, {
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(() => new Promise<null>((resolve) => pops.push(resolve))),
      });
      const pending = f.manager.updateTextureAsync(texture);
      const rejected = expect(pending).rejects.toThrow(/invalidated/i);
      rejected.catch(() => {});
      await firstBatch();
      expect(pops).toHaveLength(2);
      f.backend.destroyTexture(texture);
      for (const resolve of pops) resolve(null);
      await rejected;
      expect(f.backend.has(texture)).toBe(false);
      expect(f.manager.get(texture).version).toBeUndefined();
      expect(texture.onUpdate).not.toHaveBeenCalled();
    });

    it("bounds the aggregate lane across cheap textures using measured host yields", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const timer = vi.spyOn(globalThis, "setTimeout");
        const textures = Array.from({ length: 20 }, smallTexture);
        const pending = textures.map((texture) =>
          f.manager.updateTextureAsync(texture, { budgetMs: 2, maxBytesPerWrite: 65_536 }),
        );
        for (let i = 0; i < 300; i++) await Promise.resolve();
        expect(f.writes).toHaveLength(3);
        expect(f.clock()).toBeLessThanOrEqual(2.75);
        expect(timer).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        await Promise.all(pending);
        expect(f.writes).toHaveLength(20);
        expect(timer).toHaveBeenCalledTimes(6);
        expect(
          textures.every((texture) => f.manager.get(texture).version === texture.version),
        ).toBe(true);
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    });

    it("cancels disposal while queued before allocation and removes its request listener", async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const first = f.manager.updateTextureAsync(f.texture);
        const queued = smallTexture();
        const remove = vi.spyOn(queued, "removeEventListener");
        const pending = f.manager.updateTextureAsync(queued);
        const rejected = expect(pending).rejects.toThrow(/disposed/i);
        rejected.catch(() => {});
        queued.dispose();
        await vi.runAllTimersAsync();
        await first;
        await rejected;
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.backend.has(queued)).toBe(false);
        expect(queued.onUpdate).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledWith("dispose", expect.any(Function));
      } finally {
        vi.useRealTimers();
      }
    });
    it("rejects synchronous initialization that skipped unready content", async () => {
      const f = fixture();
      f.texture.source.dataReady = false;
      f.manager.updateTexture(f.texture);
      expect(f.writes).toHaveLength(0);
      expect(f.manager.get(f.texture).version).toBe(f.texture.version);
      await expect(f.manager.updateTextureAsync(f.texture)).rejects.toThrow(/ready|content/i);
      expect(f.writes).toHaveLength(0);
    });

    it("rejects a current default placeholder as prepared compressed content", async () => {
      const f = fixture();
      const texture = new CompressedTexture(
        [{ width: 4, height: 4, data: new Uint8Array(16) }],
        4,
        4,
        RGBA_BPTC_Format,
      );
      f.manager.updateTexture(texture);
      expect(f.manager.get(texture).isDefaultTexture).toBe(true);
      expect(f.writes).toHaveLength(0);
      await expect(f.manager.updateTextureAsync(texture)).rejects.toThrow(/ready|content/i);
    });

    it("accepts genuinely uploaded current content without allocation or writes", async () => {
      const f = fixture();
      f.manager.updateTexture(f.texture);
      const writes = f.writes.length;
      await f.manager.updateTextureAsync(f.texture);
      expect(f.writes).toHaveLength(writes);
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.texture.onUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not accept restored readiness as proof of a skipped upload", async () => {
      const f = fixture();
      f.texture.source.dataReady = false;
      f.manager.updateTexture(f.texture);
      f.texture.source.dataReady = true;
      await expect(f.manager.updateTextureAsync(f.texture)).rejects.toThrow(/content/i);
      expect(f.writes).toHaveLength(0);
    });
  },
);
