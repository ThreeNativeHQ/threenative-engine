import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { expect, it } from "vitest";

// renderer-texture-preparation.spec.ts proves prepareTextures with real transcoded mip data.
// This guard pins that proof to an installed Three.js and generated patches without the old lane.
it("keeps the private compressed upload lane out of generated patches and installed Three.js", () => {
  const patchRoot = new URL("../patches/", import.meta.url);
  const base = readFileSync(new URL("three@0.185.1.patch", patchRoot), "utf8");
  const upgrade = readFileSync(new URL("three@0.185.1-prd269-upgrade.patch", patchRoot), "utf8");
  const targetTexts = brotliDecompressSync(
    Buffer.from(JSON.parse(upgrade).bundleBrotliBase64, "base64"),
  ).toString("utf8");
  const root = resolve(dirname(createRequire(import.meta.url).resolve("three")), "..");
  const installed = [
    "src/renderers/common/Renderer.js",
    "src/renderers/common/Textures.js",
    "src/renderers/webgpu/WebGPUBackend.js",
    "src/renderers/webgpu/utils/WebGPUTextureUtils.js",
    "build/three.webgpu.js",
    "build/three.webgpu.nodes.js",
  ].map((file) => readFileSync(resolve(root, file), "utf8"));
  for (const text of [base, upgrade, targetTexts, ...installed])
    expect(
      text.match(
        /prepareTextureAsync|updateTextureAsync|_uploadTail|_pendingUploads|uploadError|_waitForUpload|_uploadSlice|_uploadDisposed/,
      )?.[0],
    ).toBeUndefined();
});
