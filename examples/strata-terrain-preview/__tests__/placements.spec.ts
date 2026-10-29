import type { IPlacement } from "@threenative/terrain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePlacements, encodePlacements, loadPlacements } from "../src/render/placements.js";

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

describe("load baked placement table", () => {
  afterEach(() => vi.unstubAllGlobals());

  const urls = ["world/forest.placements.bin", "assets/world/forest.placements.bin"];
  const assets = { resolve: async () => urls };

  it("continues to the staged source path when native fetch rejects the verbatim path", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === urls[0]) throw new Error(`Failed to open file: ${url}`);
      return new Response(encode());
    });
    vi.stubGlobal("fetch", fetch);

    const loaded = await loadPlacements(assets, "forest");

    expect(loaded.placements).toEqual(placements);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(urls);
  });

  it("rejects when every candidate fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`Failed to open file: ${url}`);
      }),
    );

    await expect(loadPlacements(assets, "forest")).rejects.toThrow(
      "Missing baked placement table: world/forest.placements.bin",
    );
  });

  it("does not fall through after a successful response contains malformed data", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 0])));
    vi.stubGlobal("fetch", fetch);

    await expect(loadPlacements(assets, "forest")).rejects.toThrow("Invalid baked placement table");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
