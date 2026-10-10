import { afterEach, describe, expect, it, vi } from "vitest";

const load = vi.fn((_kind: number, _source: string | Uint8Array, _type?: number) => [{}]);
vi.mock("three", () => ({ __tnLoadAsset: load }));
const { GLTFLoader, HDRLoader } = await import("../src/addons/perry-loaders.js");

afterEach(() => {
  load.mockClear();
  vi.unstubAllGlobals();
});

describe("Perry loaders", () => {
  it("open a page-relative URL as a file under public/", async () => {
    await new HDRLoader().loadAsync("/assets/dawn-sky.hdr?v=1");
    await new GLTFLoader().setPath("./models/").loadAsync("ship.glb");
    expect(load.mock.calls.map((call) => call[1])).toEqual([
      "public/assets/dawn-sky.hdr",
      "public/models/ship.glb",
    ]);
  });

  it("hand a network URL to the decoder as bytes", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3])));
    await new HDRLoader().loadAsync("https://cdn.example/sky.hdr");
    expect(load.mock.calls[0]?.[1]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuse a URL that leaves the asset root", async () => {
    await expect(new HDRLoader().loadAsync("/../secret.hdr")).rejects.toThrow(
      "TN_PERRY_ASSET_PATH",
    );
    expect(load).not.toHaveBeenCalled();
  });
});
