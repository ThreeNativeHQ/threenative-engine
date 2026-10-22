import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessLayer } from "../unreal-look/scaffold/render/harnessLayer.js";

/** The ladder layer a page at `search` reads: the gather starts at layer 7 and the reflections at layer 8 (PRD-646). */
function layerAt(search: string): number {
  vi.stubGlobal("location", { search });
  return harnessLayer();
}

describe("harnessLayer (PRD-646)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the reference scene's ?tnRef=", () => {
    expect(layerAt("?tnRef=L3&sun=60,25")).toBe(3);
  });

  it("reads a calibration scene's ?layer=, with or without a tier suffix", () => {
    expect(layerAt("?tnGi=cornell&layer=L1&tier=high")).toBe(1);
    expect(layerAt("?tnGi=cornell&layer=L7-Low")).toBe(7);
  });

  it("lets ?tnRef= win when a page names both", () => {
    expect(layerAt("?tnRef=L5&layer=L1")).toBe(5);
  });

  it("is layer 9, everything on, when the page names no ladder layer", () => {
    for (const search of ["", "?tnGi=cornell", "?layer=ID", "?tnRef=ID", "?layer=x"])
      expect(layerAt(search)).toBe(9);
  });
});
