import { describe, expect, it } from "vitest";
import { resolveLayout } from "../src/compile-layout.js";

// PRD-861: the owned web engine decodes KTX2 inside its glTF loader but loads no standalone `.ktx2`,
// so its cook keeps model textures in KTX2 and standalone textures in their authored format.
describe("runtime decoder capabilities", () => {
  const kinds = (runtimeDecoders: Parameters<typeof resolveLayout>[1]["runtimeDecoders"]) => {
    const layout = resolveLayout("/project", {
      config: { models: {}, textures: { maxSize: 1024 } },
      platform: "web",
      runtimeDecoders,
    });
    return {
      kinds: layout.passSpecs.map((spec) => spec.kind),
      texturesActive: layout.texturesActive,
      textureReason: layout.textureCompressionReason,
      modelReason: layout.modelCompressionReason,
    };
  };

  it("keeps KTX2 in models and standalone textures uncompressed when ktx2Files is false", () => {
    const owned = kinds({ ktx2: true, meshopt: true, ktx2Files: false });
    expect(owned.kinds).toContain("model");
    expect(owned.kinds).not.toContain("texture");
    expect(owned.kinds).toContain("texture-resize");
    expect(owned.texturesActive).toBe(false);
    expect(owned.textureReason).toBe("platform");
    expect(owned.modelReason).toBeUndefined();
  });

  it("compresses standalone textures too when ktx2Files is absent", () => {
    const three = kinds({ ktx2: true, meshopt: true });
    expect(three.kinds).toContain("texture");
    expect(three.kinds).not.toContain("texture-resize");
    expect(three.texturesActive).toBe(true);
  });
});
