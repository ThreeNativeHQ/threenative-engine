// Core's compressed upload lane writes through a browser WebGPU device. The engine uploads its own
// textures and exposes no such device, so the lane behaves as core's does with none: it owns
// nothing, and a compressed texture is refused with the same message.
export class CompressedTextureUploads {
  resolveOriginal(texture) {
    return texture;
  }

  upload() {
    return Promise.reject(
      new Error("WebGPU renderer lacks bounded compressed texture preparation."),
    );
  }

  dispose() {}
}
