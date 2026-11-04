// A software adapter spent 114 s baking a 64 x 32 sky: the patched PMREMGenerator fenced every cube face
// of a small environment, and each fence waits behind the frame queued before it (about 3 s on
// SwiftShader). The fence budget has a floor, so a small environment bakes behind one fence.
// three 0.187 bakes every environment into a cube of at least 256 (`MIN_SIZE`,
// src/renderers/common/extras/PMREMGenerator.js), so a 64 x 32 sky and a 1k sky are the same bake
// there and the floor changes no fence. These cases pin that bake's fence count instead.
import {
  DataTexture,
  EquirectangularReflectionMapping,
  RGBAFormat,
  UnsignedByteType,
  WebGPUCoordinateSystem,
} from "three";
import { PMREMGenerator } from "three/webgpu";
import { describe, expect, it } from "vitest";

/** A renderer that draws nothing and counts the queue fences the generator asks for. */
function fencedRenderer() {
  const fences = { count: 0 };
  const target = { value: null as unknown };
  const renderer = {
    autoClear: true,
    // three 0.187's generator renders its faces through a CubeCamera and toggles XR around it.
    coordinateSystem: WebGPUCoordinateSystem,
    reversedDepthBuffer: false,
    xr: { enabled: false },
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
  it("fences a 64 x 32 environment like the 256 cube it bakes, at most once per face per pass", async () => {
    const small = await bakeFences(64, 32);
    expect(small).toBe(await bakeFences(1024, 512));
    expect(small).toBeLessThanOrEqual(15);
  });
});
