import { DataTexture, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { materialKey } from "../src/render/material-key.js";

describe("materialKey", () => {
  it("gives equal keys for equal content", () => {
    const first = new MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
    first.color.setHex(0x336699);
    const second = new MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
    second.color.setHex(0x336699);
    expect(materialKey(first)).toBe(materialKey(second));
  });

  it("changes the key when side, alphaTest or a map size changes", () => {
    const base = new MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
    base.color.setHex(0x336699);
    const key = materialKey(base);

    const flipped = new MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
    flipped.color.setHex(0x336699);
    flipped.side = 2;
    expect(materialKey(flipped)).not.toBe(key);

    const cutout = new MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
    cutout.color.setHex(0x336699);
    cutout.alphaTest = 0.5;
    expect(materialKey(cutout)).not.toBe(key);

    const small = new MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
    small.color.setHex(0x336699);
    const smallMap = new DataTexture(new Uint8Array(4 * 4 * 4), 2, 2);
    smallMap.name = "bark";
    small.map = smallMap;
    const large = new MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
    large.color.setHex(0x336699);
    const largeMap = new DataTexture(new Uint8Array(16 * 16 * 4), 4, 4);
    largeMap.name = "bark";
    large.map = largeMap;
    expect(materialKey(small)).not.toBe(materialKey(large));
  });
});
