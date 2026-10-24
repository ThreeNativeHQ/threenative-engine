import { describe, expect, it } from "vitest";
import { cubemapToEquirectangular } from "../src/sphere-reflection-capture.js";

describe("HDR reflection capture conversion", () => {
  it("preserves all six directions and radiance above one", () => {
    const size = 16;
    const faces = Array.from({ length: 6 }, (_, f) =>
      new Float32Array(size * size * 3).fill(f + 2),
    );
    const { data, width, height } = cubemapToEquirectangular(faces, size);
    expect([width, height]).toEqual([64, 32]);
    const sample = (x: number, y: number) => data[(y * width + x) * 4];
    expect(sample(0, 16)).toBe(3); // -X
    expect(sample(16, 16)).toBe(7); // -Z
    expect(sample(32, 16)).toBe(2); // +X
    expect(sample(48, 16)).toBe(6); // +Z
    expect(sample(32, 0)).toBe(4); // +Y
    expect(sample(32, 31)).toBe(5); // -Y
    expect(data[3]).toBe(1);
  });
  it("rejects missing, malformed or nonfinite HDR faces", () => {
    expect(() => cubemapToEquirectangular([], 256)).toThrow();
    const faces = Array.from({ length: 6 }, () => new Float32Array(3));
    (faces[0] as Float32Array)[0] = Number.NaN;
    expect(() => cubemapToEquirectangular(faces, 1)).toThrow();
  });
});

it("runs six backend faces, retries pending PMREM, and creates a linear HDR envMap", async () => {
  class TextureStub {
    mapping = 0;
    colorSpace = "";
    flipY = false;
    needsUpdate = false;
    constructor(readonly data: Float32Array) {}
  }
  const { defineSphereReflectionCapture } = await import("../src/sphere-reflection-capture.js");
  const calls: number[] = [];
  let pending = true;
  const scene = {};
  const capture = defineSphereReflectionCapture(async (root, x, y, z, size, face) => {
    expect(root).toBe(scene);
    expect([x, y, z, size]).toEqual([2, 3, 4, 16]);
    if (pending) {
      pending = false;
      return null;
    }
    calls.push(face);
    return new Float32Array(size * size * 3).fill(20);
  }, TextureStub);
  const texture = await capture(scene, { x: 2, y: 3, z: 4 }, 16);
  expect(calls).toEqual([0, 1, 2, 3, 4, 5]);
  expect(texture.mapping).toBe(303);
  expect(texture.colorSpace).toBe("srgb-linear");
  expect(texture.flipY).toBe(true);
  const data = Reflect.get(texture, "data") as Float32Array;
  expect(data[0]).toBe(20);
  await expect(capture(scene, { x: Number.NaN, y: 0, z: 0 }, 16)).rejects.toThrow("INPUT");
});
