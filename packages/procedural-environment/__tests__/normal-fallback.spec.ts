import { describe, expect, it } from "vitest";
import Arbor, { type IArborPart, type IArborTree } from "../vendor/arbor.js";

const part = (normal: number[]): IArborPart => ({
  color: new Float32Array(9).fill(1),
  index: new Uint32Array([0, 1, 2]),
  normal: new Float32Array(normal),
  position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
  uv: new Float32Array(6),
  wind: new Float32Array(12),
});

/** The NORMAL accessor of the first primitive, read back from the GLB bytes. */
function normalsOf(glb: Uint8Array): number[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const json = JSON.parse(
    new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))),
  ) as {
    accessors: { bufferView: number; count: number }[];
    bufferViews: { byteOffset: number }[];
    meshes: { primitives: { attributes: { NORMAL: number } }[] }[];
  };
  const [primitive] = json.meshes[0]?.primitives ?? [];
  const accessor = json.accessors[primitive?.attributes.NORMAL ?? -1];
  const view0 = json.bufferViews[accessor?.bufferView ?? -1];
  if (accessor === undefined || view0 === undefined) throw new Error("no NORMAL accessor");
  const start = 20 + view.getUint32(12, true) + 8 + view0.byteOffset;
  return Array.from({ length: accessor.count * 3 }, (_, i) => view.getFloat32(start + i * 4, true));
}

describe("toGLB NORMAL fallback", () => {
  it("writes [0, 1, 0] for a zero or NaN normal, and unit length for the rest", () => {
    const tree = {
      bark: part([0, 0, 0, Number.NaN, Number.NaN, Number.NaN, 0, 3, 4]),
      leaves: { ...part([0, 1, 0, 0, 1, 0, 0, 1, 0]), index: new Uint32Array(0) },
      preset: { id: "t", name: "t" },
    } as unknown as IArborTree;
    expect(normalsOf(Arbor.toGLB(tree))).toEqual([
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      Math.fround(0.6),
      Math.fround(0.8),
    ]);
  });
});
