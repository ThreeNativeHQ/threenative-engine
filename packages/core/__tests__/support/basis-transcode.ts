import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { basisTranscoderPaths } from "../../../../test-support/three-basis.js";

// Official KTX2Loader.TranscoderFormat.BC7_M5. Pinned here so the CPU helper never imports the
// loader's private worker source; the enum value is part of the loader's public constants.
const BC7_M5 = 7;

interface IBasisKTX2File {
  isValid(): boolean;
  isUASTC(): boolean;
  isETC1S(): boolean;
  isHDR(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLayers(): number;
  getLevels(): number;
  getFaces(): number;
  getImageLevelInfo(
    mip: number,
    layer: number,
    face: number,
  ): { origWidth: number; origHeight: number; width: number; height: number };
  getImageTranscodedSizeInBytes(mip: number, layer: number, face: number, format: number): number;
  startTranscoding(): boolean;
  transcodeImage(
    dst: Uint8Array,
    mip: number,
    layer: number,
    face: number,
    format: number,
    quality: number,
    r: number,
    g: number,
  ): boolean;
  close(): void;
  delete(): void;
}

interface IBasisModule {
  KTX2File: new (data: Uint8Array) => IBasisKTX2File;
  initializeBasis(): void;
}

export interface ITranscodedMip {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface ITranscodedTexture {
  readonly mipmaps: ITranscodedMip[];
  readonly width: number;
  readonly height: number;
}

let modulePromise: Promise<IBasisModule> | undefined;

/**
 * Loads the installed Basis transcoder with its real WASM binary through the public Emscripten
 * factory. The transcoder JavaScript ships as a CommonJS-compatible module, so a scoped
 * `new Function` evaluation gives the factory without a Worker or a bundled copy.
 */
function loadBasis(): Promise<IBasisModule> {
  modulePromise ??= (async () => {
    const { javascriptPath, wasmPath } = basisTranscoderPaths();
    const source = readFileSync(javascriptPath, "utf8");
    const evaluate = new Function(
      "module",
      "exports",
      "require",
      "__filename",
      "__dirname",
      source,
    );
    const shell: { exports: unknown } = { exports: {} };
    evaluate(
      shell,
      shell.exports,
      createRequire(import.meta.url),
      javascriptPath,
      dirname(javascriptPath),
    );
    const factory = shell.exports as (config: {
      wasmBinary: Uint8Array;
      onRuntimeInitialized?: () => void;
    }) => void;
    const wasmBinary = readFileSync(wasmPath);
    const module: IBasisModule & { wasmBinary: Uint8Array; onRuntimeInitialized?: () => void } = {
      wasmBinary,
    } as unknown as IBasisModule & { wasmBinary: Uint8Array };
    await new Promise<void>((resolve) => {
      module.onRuntimeInitialized = resolve;
      factory(module);
    });
    module.initializeBasis();
    return module;
  })();
  return modulePromise;
}

/**
 * Transcodes a Basis-compressed KTX2 container to BC7 through the installed official transcoder.
 * Every mip level is transcoded; the caller gets the real compressed bytes, not a stub.
 */
export async function transcodeKtx2ToBc7(bytes: Uint8Array): Promise<ITranscodedTexture> {
  const basis = await loadBasis();
  const file = new basis.KTX2File(bytes);
  try {
    if (!file.isValid()) throw new Error("Basis transcode: invalid or unsupported .ktx2 file.");
    if (!file.isUASTC()) throw new Error("Basis transcode: fixture is not UASTC.");
    const width = file.getWidth();
    const height = file.getHeight();
    const levels = file.getLevels();
    if (!width || !height || !levels) throw new Error("Basis transcode: invalid texture.");
    if (!file.startTranscoding()) throw new Error("Basis transcode: startTranscoding failed.");
    const mipmaps: ITranscodedMip[] = [];
    for (let mip = 0; mip < levels; mip++) {
      const levelInfo = file.getImageLevelInfo(mip, 0, 0);
      const size = file.getImageTranscodedSizeInBytes(mip, 0, 0, BC7_M5);
      const data = new Uint8Array(size);
      const status = file.transcodeImage(data, mip, 0, 0, BC7_M5, 0, -1, -1);
      if (!status) throw new Error(`Basis transcode: transcodeImage failed at mip ${mip}.`);
      mipmaps.push({
        data,
        width: levels > 1 ? levelInfo.origWidth : levelInfo.width,
        height: levels > 1 ? levelInfo.origHeight : levelInfo.height,
      });
    }
    return { mipmaps, width, height };
  } finally {
    file.close();
    file.delete();
  }
}
