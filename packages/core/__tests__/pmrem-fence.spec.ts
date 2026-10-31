// A software adapter spent 114 s baking a 64 x 32 sky: the patched PMREMGenerator fenced every cube face
// of a small environment, and each fence waits behind the frame queued before it (about 3 s on
// SwiftShader). The fence budget has a floor, so a small environment bakes behind one fence.
import { DataTexture, EquirectangularReflectionMapping, RGBAFormat, UnsignedByteType } from "three";
import { PMREMGenerator } from "three/webgpu";
import { describe, expect, it } from "vitest";

/** A renderer that draws nothing and counts the queue fences the generator asks for. */
function fencedRenderer() {
  const fences = { count: 0 };
  const target = { value: null as unknown };
  const renderer = {
    autoClear: true,
    backend: {
      isWebGPUBackend: true,
      device: {
        queue: {
          onSubmittedWorkDone: () => {
            fences.count++;
            return Promise.resolve();
          },
        },
      },
    },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearColor: () => undefined,
    getMRT: () => null,
    getRenderTarget: () => target.value,
    hasInitialized: () => true,
    init: () => Promise.resolve(),
    render: () => undefined,
    setMRT: () => undefined,
    setRenderTarget: () => undefined,
  };
  return { fences, renderer };
}

async function bakeFences(width: number, height: number): Promise<number> {
  const { fences, renderer } = fencedRenderer();
  const texture = new DataTexture(
    new Uint8Array(width * height * 4),
    width,
    height,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.mapping = EquirectangularReflectionMapping;
  const generator = new PMREMGenerator(renderer as never);
  const result = await generator.fromEquirectangularAsync(texture);
  result.dispose();
  generator.dispose();
  return fences.count;
}

describe("PMREM bake fences", () => {
  it("fences a 64 x 32 environment once, not once per cube face", async () => {
    // Before the floor this was 42 fences: six faces for each of seven filter passes.
    expect(await bakeFences(64, 32)).toBeLessThanOrEqual(2);
  });

  it("keeps the fence cadence of a 1k equirect that the budget was sized for", async () => {
    expect(await bakeFences(1024, 512)).toBeGreaterThan(6);
  });
});
