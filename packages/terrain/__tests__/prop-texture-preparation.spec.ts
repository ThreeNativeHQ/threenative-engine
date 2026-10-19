import type { ICtx } from "@threenative/core";
import { CompressedTexture, MeshStandardMaterial, RGBA_BPTC_Format } from "three";
import { texture } from "three/tsl";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { preparePropTextures } from "../../../examples/strata-terrain-preview/src/render/texturePreparation.js";

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
