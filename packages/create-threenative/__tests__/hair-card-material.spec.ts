import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DoubleSide, Texture } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { createHairCardMaterial } from "../templates/starter/src/render/hair.js";

// The R coverage channel of the strand atlas examples/character-dynamics/src/hair-atlas.ts builds:
// anti-aliased lines that taper and fade, packed so the roots cover the card.
function strandAtlasCoverage(strands = 40, width = 128, height = 256): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const hash = (n: number): number => Math.abs((Math.sin(n * 12.9898) * 43758.5453) % 1);
  for (let y = 0; y < height; y++) {
    const along = y / (height - 1);
    for (let x = 0; x < width; x++) {
      let coverage = 0;
      for (let lane = 0; lane < strands; lane++) {
        const own = hash(lane + 1);
        const tip = 0.7 + 0.3 * hash(lane + 101);
        if (along > tip) continue;
        const centre = ((lane + 0.5 + 0.6 * Math.sin(along * 4 + own * 6.28)) / strands) * width;
        const half = 1.8 - 1.2 * (along / tip);
        const edge = Math.min(1, Math.max(0, half + 0.5 - Math.abs(x + 0.5 - centre)));
        const fade = Math.min(1, (tip - along) / 0.12);
        const c = edge * fade;
        if (c > coverage) coverage = c;
      }
      data[(y * width + x) * 4] = Math.round(coverage * 255);
    }
  }
  return data;
}

// SHA-256 of threejs-hair-shader/src/hair-shader.js as vendored on 2026-11-23.
const UPSTREAM_SHA256 = "947cff0ec4ccd55f5f812c1ff5223759d83119a0e9d8071c2f9e56b074819ed6";
const UPSTREAM_START = Buffer.from("// Created by Sander Mørch-Jensen");
const COPYRIGHT = "Copyright (c) 2026 Sander Mørch-Jensen — creategamecharacters.com";
const vendored = (): Buffer =>
  readFileSync(new URL("../templates/starter/src/render/vendor/hair-shader.js", import.meta.url));

// The owned engine's `three/webgpu` also exports `WebGLRenderer`, which upstream's detector reads as
// "GLSL patches". Every test here runs against that namespace: a ThreeNative game renders with WebGPU.
vi.mock("three/webgpu", async (original) => ({
  ...(await original<typeof import("three/webgpu")>()),
  WebGLRenderer: class {},
}));

describe("authored hair-card material", () => {
  it("vendors the upstream node graph byte for byte below its MIT header", () => {
    const bytes = vendored();
    const start = bytes.indexOf(UPSTREAM_START);
    expect(start).toBeGreaterThan(0);
    const header = bytes.subarray(0, start).toString("utf8");
    expect(header).toContain("MIT License");
    expect(header).toContain(COPYRIGHT);
    expect(header).toContain("threejs-hair-shader/src/hair-shader.js");
    expect(createHash("sha256").update(bytes.subarray(start)).digest("hex")).toBe(UPSTREAM_SHA256);
  });

  it("builds node materials with the upstream defaults on both pass sets", () => {
    const blend = createHairCardMaterial();
    expect(blend.outer.isNodeMaterial).toBe(true);
    expect(blend.useA2C).toBe(false);
    expect(blend.mode).toBe("blend");
    expect(blend.density).toBeCloseTo(1.0);
    expect(blend.inner?.isNodeMaterial).toBe(true);
    expect(blend.blend).toBeNull();
    expect(blend.outer.color.getHexString()).toBe("3a2a1e");
    expect(blend.outer.roughness).toBeCloseTo(0.5);
    expect(blend.outer.side).toBe(DoubleSide);
    expect(blend.outer.alphaTest).toBeCloseTo(0.06);
    expect(blend.outer.transparent).toBe(true);
    expect(blend.outer.depthWrite).toBe(true);
    expect(blend.outer.polygonOffsetUnits).toBe(-2);
    expect(blend.inner?.alphaTest).toBeCloseTo(0.5);
    expect(blend.inner?.transparent).toBe(false);
    const units = blend.outer.userData.hairUniforms;
    expect(units.uHairRootDark.value).toBe(0);
    expect(units.uHairRootMode.value).toBe(0);
    expect(units.uHairRootColor.value.getHexString()).toBe("1a1008");
    expect(units.uHairRootStr.value).toBeCloseTo(1);
    expect(units.uHairSeedAmp.value).toBeCloseTo(0.36);
    expect(units.uHairRoughFlr.value).toBeCloseTo(0.55);
    expect(units.uHairRoughSeed.value).toBeCloseTo(0.08);
    expect(units.uHairDensity.value).toBeCloseTo(1.0);

    const a2c = createHairCardMaterial({ alphaToCoverage: true });
    expect(a2c.outer.isNodeMaterial).toBe(true);
    expect(a2c.useA2C).toBe(true);
    expect(a2c.mode).toBe("both");
    expect(a2c.density).toBeCloseTo(2.5);
    expect(a2c.outer.alphaToCoverage).toBe(true);
    expect(a2c.outer.transparent).toBe(false);
    expect(a2c.outer.alphaTest).toBe(0);
    expect(a2c.inner).toBeNull();
    expect(a2c.blend?.isNodeMaterial).toBe(true);
    expect(a2c.blend?.opacity).toBeCloseTo(0.4);
    expect(a2c.blend?.roughness).toBeCloseTo(0.6);
    expect(a2c.blend?.userData.hairUniforms.uHairRootColor.value.getHexString()).toBe("1a1008");
  });

  it("carries a named root colour, tip colour, density and anisotropy to the material", () => {
    const atlas = new Texture();
    const tangent = new Texture();
    const mats = createHairCardMaterial({
      atlas,
      tangent,
      alphaToCoverage: true,
      rootMode: "multi",
      rootColor: "#c03010",
      color: "#ffcc00",
      density: 1.7,
      anisotropy: 0.9,
      anisotropyRotation: -0.4,
      materialName: "ponytail",
    });
    const units = mats.outer.userData.hairUniforms;
    expect(units.uHairRootColor.value.getHexString()).toBe("c03010");
    expect(units.uHairRootMode.value).toBe(1);
    expect(units.uHairDensity.value).toBeCloseTo(1.7);
    expect(mats.outer.color.getHexString()).toBe("ffcc00");
    expect(mats.outer.alphaMap).toBe(atlas);
    expect(mats.outer.anisotropyMap).toBe(tangent);
    expect(mats.outer.anisotropy).toBeCloseTo(0.9);
    expect(mats.outer.anisotropyRotation).toBeCloseTo(-0.4);
    expect(mats.outer.name).toBe("ponytail__a2c");
    expect(mats.blend?.userData.hairUniforms.uHairRootColor.value.getHexString()).toBe("c03010");
    expect(mats.blend?.userData.hairUniforms.uBlendDensity.value).toBeCloseTo(2.5);
  });

  it("casts shadows with the visible pass's own coverage threshold", () => {
    // Upstream sets no shadow threshold: the visible outer pass is also the shadow-casting
    // material, so the depth pass reads the same alphaTest and the same coverage alphaMap.
    const blend = createHairCardMaterial();
    expect(blend.outer.userData.hairPass).toBe("outer");
    expect(blend.outer.alphaTest).toBeCloseTo(0.06);

    const a2c = createHairCardMaterial({ alphaToCoverage: true });
    expect(a2c.outer.userData.hairPass).toBe("a2c");
    expect(a2c.outer.alphaToCoverage).toBe(true);
    expect(a2c.outer.alphaTest).toBe(0);
  });

  it("masks every shadow-casting pass to half coverage of the atlas", () => {
    const atlas = new Texture();
    const blend = createHairCardMaterial({ atlas });
    expect(blend.outer.maskShadowNode?.isNode).toBe(true);
    expect(blend.inner?.maskShadowNode?.isNode).toBe(true);

    const a2c = createHairCardMaterial({ atlas, alphaToCoverage: true });
    expect(a2c.outer.maskShadowNode?.isNode).toBe(true);
    expect(a2c.blend?.maskShadowNode?.isNode).toBe(true);
  });

  it("matches the visible coverage within 5% under the 0.5 shadow rule", () => {
    const data = strandAtlasCoverage();
    const texels = data.length / 4;
    let sum = 0;
    let kept = 0;
    for (let i = 0; i < data.length; i += 4) {
      const coverage = (data[i] ?? 0) / 255;
      sum += coverage;
      if (coverage >= 0.5) kept++;
    }
    const visible = sum / texels;
    const shadow = kept / texels;
    expect(visible).toBeGreaterThan(0);
    expect(Math.abs(shadow - visible)).toBeLessThanOrEqual(0.05 * visible);
    // The old behaviour — no mask, alphaTest 0 — keeps every texel, so the shadow is the card.
    expect(Math.abs(1 - visible)).toBeGreaterThan(0.05 * visible);
  });
});
