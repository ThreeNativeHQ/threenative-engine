/** three's loader API over the engine's native decoders; unsupported codecs refuse at use. */
// quality-allow: __tnLoadAsset is injected into the strict Perry three module.
// @ts-expect-error -- only the strict native facade exports this transport hook.
import { __tnLoadAsset } from "three";
import type { IGltfResult } from "./gltf-loader-web.js";

const load = __tnLoadAsset as (
  kind: number,
  source: string | Uint8Array,
  type?: number,
) => object[];

export class GLTFLoader {
  path = "";
  setPath(path: string): this {
    this.path = path;
    return this;
  }
  private result(source: string | Uint8Array): IGltfResult {
    const [scene, ...animations] = load(0, source);
    if (!scene) throw new Error("TN_NATIVE_GLTF_SCENE_MISSING");
    return {
      scene,
      scenes: [scene],
      animations,
      cameras: [],
      asset: { version: "2.0" },
      parser: undefined,
      userData: {},
    };
  }
  async loadAsync(url: string): Promise<IGltfResult> {
    return this.result(this.path + url);
  }
  load(
    url: string,
    onLoad: (result: IGltfResult) => void,
    _onProgress?: unknown,
    onError?: (error: unknown) => void,
  ): void {
    this.loadAsync(url).then(onLoad, (error) => {
      if (onError) onError(error);
      else throw error;
    });
  }
  async parseAsync(data: ArrayBuffer | string, _path = ""): Promise<IGltfResult> {
    return this.result(
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
    );
  }
  parse(
    data: ArrayBuffer | string,
    path: string,
    onLoad: (result: IGltfResult) => void,
    onError?: (error: unknown) => void,
  ): void {
    this.parseAsync(data, path).then(onLoad, (error) => {
      if (onError) onError(error);
      else throw error;
    });
  }
  setKTX2Loader(): never {
    throw new Error("TN_NATIVE_KTX2_UNSUPPORTED");
  }
  setDRACOLoader(): never {
    throw new Error("TN_NATIVE_DRACO_UNSUPPORTED");
  }
  setMeshoptDecoder(): never {
    throw new Error("TN_NATIVE_MESHOPT_UNSUPPORTED");
  }
  register(): never {
    throw new Error("TN_NATIVE_GLTF_PLUGIN_UNSUPPORTED");
  }
}

export class HDRLoader {
  path = "";
  type = 1016;
  setPath(path: string): this {
    this.path = path;
    return this;
  }
  setDataType(type: number): this {
    this.type = type;
    return this;
  }
  async loadAsync(url: string): Promise<object> {
    const texture = load(1, this.path + url, this.type)[0];
    if (!texture) throw new Error("TN_HDR_INVALID: no texture");
    return texture;
  }
  load(
    url: string,
    onLoad: (texture: object) => void,
    _onProgress?: unknown,
    onError?: (error: unknown) => void,
  ): void {
    this.loadAsync(url).then(onLoad, (error) => {
      if (onError) onError(error);
      else throw error;
    });
  }
}

export class KTX2Loader {
  setTranscoderPath(): this {
    return this;
  }
  setWorkerLimit(): this {
    return this;
  }
  detectSupport(): never {
    throw new Error("TN_NATIVE_KTX2_UNSUPPORTED");
  }
  load(): never {
    throw new Error("TN_NATIVE_KTX2_UNSUPPORTED");
  }
  dispose(): void {}
}
export class DRACOLoader {
  setDecoderPath(): this {
    return this;
  }
  decodeDracoFile(): never {
    throw new Error("TN_NATIVE_DRACO_UNSUPPORTED");
  }
  dispose(): void {}
}
export const MeshoptDecoder = {
  supported: false,
  decodeGltfBuffer(): never {
    throw new Error("TN_NATIVE_MESHOPT_UNSUPPORTED");
  },
};
