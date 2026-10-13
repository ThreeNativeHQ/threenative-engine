import type { IPlacement } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { decodePlacements, encodePlacements } from "../src/render/placements.js";

const placements: IPlacement[] = [
  {
    id: "temperate-spruce:0",
    layer: "temperate-spruce",
    asset: "spruce",
    position: [1, 2, 3],
    rotation: 0.5,
    scale: 1.25,
    normal: [0, 1, 0],
    alignToNormal: true,
  },
  {
    id: "temperate-mountain:0:outcrop",
    layer: "temperate-mountain",
    asset: "mountain",
    position: [4, 5, 6],
    rotation: 1,
    scale: 2,
    normal: [0, 1, 0],
    alignToNormal: false,
  },
  {
    id: "temperate-spruce:1",
    layer: "temperate-spruce",
    asset: "spruce",
    position: [7, 8, 9],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: true,
  },
];
const counts = { spruce: 2, mountain: 1, grass: 0 };
const canopy = new Float32Array([0, 0.25, 1, 0.5]);
const encode = () => encodePlacements({ placements, counts }, canopy);

describe("baked placement table", () => {
  it("preserves order, identities, alignment, counts and baked canopy", () => {
    const loaded = decodePlacements(encode());
    expect(loaded.placements).toEqual(placements);
    expect(loaded.counts).toEqual(counts);
    expect(loaded.canopy).toEqual(canopy);
  });
  it("rejects a truncated header or record", () => {
    const bytes = encode();
    for (const length of [0, 3, 8, bytes.byteLength - 1, bytes.byteLength - 4]) {
      expect(() => decodePlacements(bytes.slice(0, length))).toThrow();
    }
  });
  it("rejects duplicate or out-of-range placement order indices", () => {
    const bytes = encode();
    const view = new DataView(bytes);
    const metadata = 4 + view.getUint32(0, true) + placements.length * 32;
    view.setUint32(metadata + 4, view.getUint32(metadata, true), true);
    expect(() => decodePlacements(bytes)).toThrow();
    view.setUint32(metadata + 4, placements.length, true);
    expect(() => decodePlacements(bytes)).toThrow();
  });
  it("rejects nonfinite records and inconsistent counts", () => {
    const bytes = encode();
    const view = new DataView(bytes);
    const offset = 4 + view.getUint32(0, true);
    view.setFloat32(offset, Number.NaN, true);
    expect(() => decodePlacements(bytes)).toThrow();
    expect(() =>
      encodePlacements({ placements, counts: { ...counts, spruce: 3 } }, canopy),
    ).toThrow();
  });
});
