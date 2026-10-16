import { PerspectiveCamera } from "three";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { float, vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { createOutdoorTRAA } from "../src/render/sky.js";

describe("Strata temporal AA input", () => {
  it("primes the actual beauty RTT and leaves automatic resizing enabled", () => {
    const camera = new PerspectiveCamera();
    const unprimed = traa(vec4(1), float(1), float(1), camera);
    const unprimedBeauty = Reflect.get(unprimed, "beautyNode");
    expect(unprimedBeauty.width).toBeNull();
    expect(unprimedBeauty.height).toBeNull();

    const renderer = { surface: () => ({ drawingBufferWidth: 640, drawingBufferHeight: 360 }) };
    const node = createOutdoorTRAA(vec4(1), float(1), float(1), camera, renderer as never);
    const beauty = Reflect.get(node, "beautyNode");
    expect(beauty.renderTarget.texture.width).toBe(640);
    expect(beauty.renderTarget.texture.height).toBe(360);
    expect(Number.isFinite(beauty.renderTarget.texture.width)).toBe(true);
    expect(Number.isFinite(beauty.renderTarget.texture.height)).toBe(true);
    expect(beauty.autoResize).toBe(true);

    beauty.setSize(320, 180);
    expect([beauty.renderTarget.width, beauty.renderTarget.height]).toEqual([320, 180]);
    expect(beauty.autoResize).toBe(true);
  });
});
