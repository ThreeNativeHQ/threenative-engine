import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const resources = readFileSync(
  fileURLToPath(new URL("../src/webgpu/bindings_resources.cpp", import.meta.url)),
  "utf8",
);

test("should map every BC compressed format Three can select on desktop adapters", () => {
  const required = {
    "bc1-rgba-unorm": "WGPUTextureFormat_BC1RGBAUnorm",
    "bc1-rgba-unorm-srgb": "WGPUTextureFormat_BC1RGBAUnormSrgb",
    "bc2-rgba-unorm": "WGPUTextureFormat_BC2RGBAUnorm",
    "bc2-rgba-unorm-srgb": "WGPUTextureFormat_BC2RGBAUnormSrgb",
    "bc3-rgba-unorm": "WGPUTextureFormat_BC3RGBAUnorm",
    "bc3-rgba-unorm-srgb": "WGPUTextureFormat_BC3RGBAUnormSrgb",
    "bc4-r-unorm": "WGPUTextureFormat_BC4RUnorm",
    "bc4-r-snorm": "WGPUTextureFormat_BC4RSnorm",
    "bc5-rg-unorm": "WGPUTextureFormat_BC5RGUnorm",
    "bc5-rg-snorm": "WGPUTextureFormat_BC5RGSnorm",
    "bc6h-rgb-ufloat": "WGPUTextureFormat_BC6HRGBUfloat",
    "bc6h-rgb-float": "WGPUTextureFormat_BC6HRGBFloat",
    "bc7-rgba-unorm": "WGPUTextureFormat_BC7RGBAUnorm",
    "bc7-rgba-unorm-srgb": "WGPUTextureFormat_BC7RGBAUnormSrgb",
  };

  for (const [name, native] of Object.entries(required)) {
    expect(resources).toContain(`if (format == "${name}") return ${native};`);
  }
});

// Three's KTX2Loader picks ASTC or ETC2 on mobile adapters (texture-compression-astc/-etc2). An
// unmapped name became BGRA8 and every compressed upload failed `wgpuQueueWriteTexture` on the
// Android emulator (PRD-485 Phase 3).
test("should map every ETC2, EAC and ASTC 4x4 format Three can select on mobile adapters", () => {
  const required = {
    "etc2-rgb8unorm": "WGPUTextureFormat_ETC2RGB8Unorm",
    "etc2-rgb8unorm-srgb": "WGPUTextureFormat_ETC2RGB8UnormSrgb",
    "etc2-rgb8a1unorm": "WGPUTextureFormat_ETC2RGB8A1Unorm",
    "etc2-rgb8a1unorm-srgb": "WGPUTextureFormat_ETC2RGB8A1UnormSrgb",
    "etc2-rgba8unorm": "WGPUTextureFormat_ETC2RGBA8Unorm",
    "etc2-rgba8unorm-srgb": "WGPUTextureFormat_ETC2RGBA8UnormSrgb",
    "eac-r11unorm": "WGPUTextureFormat_EACR11Unorm",
    "eac-r11snorm": "WGPUTextureFormat_EACR11Snorm",
    "eac-rg11unorm": "WGPUTextureFormat_EACRG11Unorm",
    "eac-rg11snorm": "WGPUTextureFormat_EACRG11Snorm",
    "astc-4x4-unorm": "WGPUTextureFormat_ASTC4x4Unorm",
    "astc-4x4-unorm-srgb": "WGPUTextureFormat_ASTC4x4UnormSrgb",
  };

  for (const [name, native] of Object.entries(required)) {
    expect(resources).toContain(`if (format == "${name}") return ${native};`);
  }
});
