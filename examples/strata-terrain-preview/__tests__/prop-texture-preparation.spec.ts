import type { ICtx } from "@threenative/core";
import {
  CompressedTexture,
  ExternalTexture,
  MeshStandardMaterial,
  RGBA_BPTC_Format,
  Texture,
} from "three";
import { texture } from "three/tsl";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { preparePropTextures } from "../src/render/texturePreparation.js";

function compressed() {
  const value = new CompressedTexture(
    [{ width: 4, height: 4, data: new Uint8Array(16) }],
    4,
    4,
    RGBA_BPTC_Format,
  );
  value.needsUpdate = true;
  return value;
}

function replacement() {
  return new ExternalTexture({} as never);
}

it("gates actual ordinary and TSL texture identities without taking their ownership", async () => {
  const map = compressed();
  const normal = compressed();
  const nodeMap = compressed();
  const ordinary = new MeshStandardMaterial({ map, normalMap: normal });
  const nodes = new MeshPhysicalNodeMaterial({ map });
  nodes.colorNode = texture(nodeMap).rgb;
  const disposed = vi.spyOn(map, "dispose");
  let release = () => {};
  const gate = new Promise<number>((resolve) => {
    release = () => resolve(3);
  });
  const prepare = vi.fn((_textures: Iterable<unknown>, _signal?: AbortSignal) => gate);
  let completed = false;
  const pending = preparePropTextures({ prepareTextures: prepare } as unknown as ICtx["renderer"], [
    ordinary,
    nodes,
    ordinary,
  ]).then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(new Set(prepare.mock.calls[0]?.[0])).toEqual(new Set([map, normal, nodeMap]));
  expect(completed).toBe(false);
  release();
  await pending;
  expect(disposed).not.toHaveBeenCalled();
});

it("forwards scene cancellation and preserves preparation failure", async () => {
  const controller = new AbortController();
  const prepare = vi.fn((_textures: Iterable<unknown>, signal: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    return Promise.reject(new Error("upload failed"));
  });
  await expect(
    preparePropTextures(
      { prepareTextures: prepare } as unknown as ICtx["renderer"],
      [new MeshStandardMaterial({ map: compressed() })],
      controller.signal,
    ),
  ).rejects.toThrow("upload failed");
});

it("snapshots a generator once and replaces every material map and TSL node", async () => {
  const map = compressed();
  const normal = compressed();
  const nodeMap = compressed();
  const ordinary = new MeshStandardMaterial({ map, normalMap: normal });
  const nodes = new MeshPhysicalNodeMaterial({ map });
  const tslNode = texture(nodeMap);
  nodes.colorNode = tslNode.rgb;
  const prepared = new Map([
    [map, replacement()],
    [normal, replacement()],
    [nodeMap, replacement()],
  ]);
  function* materials() {
    yield ordinary;
    yield nodes;
    yield ordinary;
  }
  const prepare = vi.fn(
    (
      textures: Iterable<never>,
      _signal?: AbortSignal,
      _onProgress?: (completed: number) => void,
      replacements?: Map<never, never>,
    ) => {
      for (const value of textures) replacements?.set(value, prepared.get(value) as never);
      return Promise.resolve(prepared.size);
    },
  );
  const completed = await preparePropTextures(
    { prepareTextures: prepare } as unknown as ICtx["renderer"],
    materials(),
  );
  expect(completed).toBe(3);
  expect(ordinary.map).toBe(prepared.get(map));
  expect(ordinary.normalMap).toBe(prepared.get(normal));
  expect(nodes.map).toBe(prepared.get(map));
  expect(tslNode.value).toBe(prepared.get(nodeMap));
});

it("reports only distinct compressed replacements applied after successful preparation", async () => {
  const original = compressed();
  const unchanged = compressed();
  const invalid = compressed();
  const unused = compressed();
  const jpeg = new Texture();
  const ready = replacement();
  const material = new MeshStandardMaterial({
    map: original,
    normalMap: unchanged,
    alphaMap: invalid,
    aoMap: jpeg,
  });
  const nodes = new MeshPhysicalNodeMaterial();
  const sampled = texture(original);
  nodes.colorNode = sampled.rgb;
  const reported = vi.fn();
  let finish = () => {};
  const prepare = vi.fn(
    async (
      _textures: Iterable<Texture>,
      _signal?: AbortSignal,
      _progress?: (completed: number) => void,
      replacements?: Map<Texture, Texture>,
    ) => {
      replacements?.set(original, ready);
      replacements?.set(unchanged, unchanged);
      replacements?.set(invalid, {} as Texture);
      replacements?.set(unused, replacement());
      replacements?.set(jpeg, replacement());
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return 5;
    },
  );
  const pending = preparePropTextures(
    { prepareTextures: prepare } as unknown as ICtx["renderer"],
    [material, nodes],
    undefined,
    undefined,
    reported,
  );
  expect(reported).not.toHaveBeenCalled();
  finish();
  expect(await pending).toBe(5);
  expect(material.map).toBe(ready);
  expect(sampled.value).toBe(ready);
  expect(material.alphaMap).toBe(invalid);
  expect(reported).toHaveBeenCalledExactlyOnceWith(1);
});

it("does not report compressed completion when preparation rejects", async () => {
  const reported = vi.fn();
  await expect(
    preparePropTextures(
      {
        prepareTextures: async () => {
          throw new Error("upload failed");
        },
      } as unknown as ICtx["renderer"],
      [new MeshStandardMaterial({ map: compressed() })],
      undefined,
      undefined,
      reported,
    ),
  ).rejects.toThrow("upload failed");
  expect(reported).not.toHaveBeenCalled();
});
