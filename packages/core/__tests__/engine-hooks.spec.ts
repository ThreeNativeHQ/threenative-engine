import { readFileSync } from "node:fs";
import path from "node:path";

import { Matrix4, Object3D } from "three";
import { describe, expect, it } from "vitest";

import {
  BILLBOARD_FACE_HOOK,
  COPY_MATRIX_WORLD_HOOK,
  billboardFace,
  copyMatrixWorld,
  hasCopyMatrixWorldHook,
} from "../src/engine-hooks.js";

const RUNTIME = path.resolve(import.meta.dirname, "..", "..", "runtime-native", "src");

describe("the engine's world-matrix hook", () => {
  it("should be defined by the host and probed by its adapter under the name core reads", () => {
    const definition = readFileSync(path.join(RUNTIME, "engine/abi/bindings_scene.cpp"), "utf8");
    expect(definition).toContain(`b.methods["${COPY_MATRIX_WORLD_HOOK}"]`);
    expect(definition).toContain(`b.methods["${BILLBOARD_FACE_HOOK}"]`);
    const adapter = readFileSync(path.join(RUNTIME, "adapters/v8/math/entry.js"), "utf8");
    expect(adapter).toContain(`prototype?.${COPY_MATRIX_WORLD_HOOK}`);
  });

  it("should leave an object without the hook to read matrixWorld itself", () => {
    const plain = new Object3D();
    expect(hasCopyMatrixWorldHook(plain)).toBe(false);
    expect(copyMatrixWorld(plain, new Matrix4())).toBe(false);
    expect(billboardFace(plain, new Object3D(), 0)).toBe(false);
  });

  it("should call the hook with the object as receiver", () => {
    const owner = new Object3D();
    let receiver: unknown;
    Object.assign(owner, {
      [COPY_MATRIX_WORLD_HOOK](this: unknown, target: Matrix4) {
        receiver = this;
        target.makeTranslation(1, 2, 3);
      },
    });
    const target = new Matrix4();
    expect(hasCopyMatrixWorldHook(owner)).toBe(true);
    expect(copyMatrixWorld(owner, target)).toBe(true);
    expect(receiver).toBe(owner);
    expect(target.elements.slice(12, 15)).toEqual([1, 2, 3]);
  });

  it("should invoke __tnBillboardFace with receiver, camera, and lock axis", () => {
    const label = new Object3D();
    const camera = new Object3D();
    const seen: unknown[] = [];
    Object.assign(label, {
      [BILLBOARD_FACE_HOOK](this: unknown, cam: unknown, lock: number) {
        seen.push(this, cam, lock);
      },
    });
    expect(billboardFace(label, camera, 2)).toBe(true);
    expect(seen).toEqual([label, camera, 2]);
  });
});
