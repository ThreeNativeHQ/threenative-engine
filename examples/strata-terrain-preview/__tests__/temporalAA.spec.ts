import assert from "node:assert/strict";
import { DataTexture, FloatType, PerspectiveCamera, RedFormat } from "three";
import TRAANode, { traa } from "three/addons/tsl/display/TRAANode.js";
import type RTTNode from "three/src/nodes/utils/RTTNode.js";
import { texture, vec4 } from "three/tsl";
import type { TextureNode } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { createOutdoorTRAA } from "../src/render/sky.js";

describe("Strata temporal AA input", () => {
  it("primes the actual beauty RTT and leaves automatic resizing enabled", () => {
    const camera = new PerspectiveCamera();
    const depthVelocity = texture(
      new DataTexture(new Float32Array([1]), 1, 1, RedFormat, FloatType),
    );
    const input = vec4(1).mul(0.5);
    const unprimed = traa(input, depthVelocity, depthVelocity, camera);
    assert(unprimed instanceof TRAANode);
    const unprimedBeauty = unprimed.beautyNode;
    assert(isRTTNode(unprimedBeauty));
    assert(unprimedBeauty.renderTarget);
    expect(unprimedBeauty.width).toBeNull();
    expect(unprimedBeauty.height).toBeNull();
    expect(unprimedBeauty.renderTarget?.width).toBeNull();
    expect(unprimedBeauty.renderTarget?.height).toBeNull();

    const renderer = {
      surface: () => ({
        resolutionScale: 1,
        scaleSource: "pinned" as const,
        sampleCount: 1,
        drawingBufferWidth: 640,
        drawingBufferHeight: 360,
        atFloor: false,
      }),
    };
    const node = createOutdoorTRAA(input, depthVelocity, depthVelocity, camera, renderer);
    assert(node instanceof TRAANode);
    const beauty = node.beautyNode;
    assert(isRTTNode(beauty));
    assert(beauty.renderTarget);
    const target = beauty.renderTarget;
    expect(target.texture.width).toBe(640);
    expect(target.texture.height).toBe(360);
    expect(Number.isFinite(target.texture.width)).toBe(true);
    expect(Number.isFinite(target.texture.height)).toBe(true);
    expect(beauty.autoResize).toBe(true);

    beauty.setSize(320, 180);
    expect([target.width, target.height]).toEqual([320, 180]);
    expect(beauty.autoResize).toBe(true);
  });
});

function isRTTNode(node: TextureNode): node is RTTNode {
  return "isRTTNode" in node && Reflect.get(node, "isRTTNode") === true;
}
