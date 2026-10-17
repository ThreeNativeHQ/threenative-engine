import {
  ColorManagement,
  type CompressedArrayTexture,
  type CompressedTexture,
  ExternalTexture,
  R11_EAC_Format,
  RED_GREEN_RGTC2_Format,
  RED_RGTC1_Format,
  RG11_EAC_Format,
  RGBA_ASTC_4x4_Format,
  RGBA_ASTC_5x4_Format,
  RGBA_ASTC_5x5_Format,
  RGBA_ASTC_6x5_Format,
  RGBA_ASTC_6x6_Format,
  RGBA_ASTC_8x5_Format,
  RGBA_ASTC_8x6_Format,
  RGBA_ASTC_8x8_Format,
  RGBA_ASTC_10x5_Format,
  RGBA_ASTC_10x6_Format,
  RGBA_ASTC_10x8_Format,
  RGBA_ASTC_10x10_Format,
  RGBA_ASTC_12x10_Format,
  RGBA_ASTC_12x12_Format,
  RGBA_BPTC_Format,
  RGBA_ETC2_EAC_Format,
  RGBA_S3TC_DXT1_Format,
  RGBA_S3TC_DXT3_Format,
  RGBA_S3TC_DXT5_Format,
  RGB_BPTC_SIGNED_Format,
  RGB_BPTC_UNSIGNED_Format,
  RGB_ETC1_Format,
  RGB_ETC2_Format,
  RGB_S3TC_DXT1_Format,
  SIGNED_R11_EAC_Format,
  SIGNED_RED_GREEN_RGTC2_Format,
  SIGNED_RED_RGTC1_Format,
  SIGNED_RG11_EAC_Format,
  SRGBTransfer,
  Source,
  type Texture,
} from "three";

/**
 * One compressed GPU format and the block geometry a bounded write must respect. The table is
 * pinned to the installed Three release (see `three-patch/pin.json`); the GPU format strings are
 * the WebGPU enum values Three maps its public texture constants to. `feature` is the WebGPU
 * `device.features` name the format needs, checked before any allocation.
 */
export interface ICompressedFormatEntry {
  readonly gpuFormat: string;
  readonly feature: string;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly blockBytes: number;
}

type IFormatRow = Omit<ICompressedFormatEntry, "gpuFormat"> & {
  readonly base: string;
  readonly srgb?: true;
};

const BC = "texture-compression-bc";
const ETC2 = "texture-compression-etc2";
const ASTC = "texture-compression-astc";

// Public Three constants -> WebGPU compressed format, required device feature, block size and
// bytes per block. Kept local so the framework never imports Three's internal texture utils.
const FORMAT_ROWS: ReadonlyArray<readonly [number, IFormatRow]> = [
  [
    RGB_S3TC_DXT1_Format,
    {
      base: "bc1-rgba-unorm",
      srgb: true,
      feature: BC,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 8,
    },
  ],
  [
    RGBA_S3TC_DXT1_Format,
    {
      base: "bc1-rgba-unorm",
      srgb: true,
      feature: BC,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 8,
    },
  ],
  [
    RGBA_S3TC_DXT3_Format,
    {
      base: "bc2-rgba-unorm",
      srgb: true,
      feature: BC,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 16,
    },
  ],
  [
    RGBA_S3TC_DXT5_Format,
    {
      base: "bc3-rgba-unorm",
      srgb: true,
      feature: BC,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 16,
    },
  ],
  [
    RED_RGTC1_Format,
    { base: "bc4-r-unorm", feature: BC, blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  ],
  [
    SIGNED_RED_RGTC1_Format,
    { base: "bc4-r-snorm", feature: BC, blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  ],
  [
    RED_GREEN_RGTC2_Format,
    { base: "bc5-rg-unorm", feature: BC, blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  ],
  [
    SIGNED_RED_GREEN_RGTC2_Format,
    { base: "bc5-rg-snorm", feature: BC, blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  ],
  [
    RGBA_BPTC_Format,
    {
      base: "bc7-rgba-unorm",
      srgb: true,
      feature: BC,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 16,
    },
  ],
  [
    RGB_BPTC_SIGNED_Format,
    { base: "bc6h-rgb-float", feature: BC, blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  ],
  [
    RGB_BPTC_UNSIGNED_Format,
    { base: "bc6h-rgb-ufloat", feature: BC, blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  ],
  [
    RGB_ETC2_Format,
    {
      base: "etc2-rgb8unorm",
      srgb: true,
      feature: ETC2,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 8,
    },
  ],
  [
    RGB_ETC1_Format,
    {
      base: "etc2-rgb8unorm",
      srgb: true,
      feature: ETC2,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 8,
    },
  ],
  [
    RGBA_ETC2_EAC_Format,
    {
      base: "etc2-rgba8unorm",
      srgb: true,
      feature: ETC2,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 16,
    },
  ],
  [
    R11_EAC_Format,
    { base: "eac-r11unorm", feature: ETC2, blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  ],
  [
    SIGNED_R11_EAC_Format,
    { base: "eac-r11snorm", feature: ETC2, blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  ],
  [
    RG11_EAC_Format,
    { base: "eac-rg11unorm", feature: ETC2, blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  ],
  [
    SIGNED_RG11_EAC_Format,
    { base: "eac-rg11snorm", feature: ETC2, blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  ],
  [
    RGBA_ASTC_4x4_Format,
    {
      base: "astc-4x4-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_5x4_Format,
    {
      base: "astc-5x4-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 5,
      blockHeight: 4,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_5x5_Format,
    {
      base: "astc-5x5-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 5,
      blockHeight: 5,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_6x5_Format,
    {
      base: "astc-6x5-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 6,
      blockHeight: 5,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_6x6_Format,
    {
      base: "astc-6x6-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 6,
      blockHeight: 6,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_8x5_Format,
    {
      base: "astc-8x5-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 8,
      blockHeight: 5,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_8x6_Format,
    {
      base: "astc-8x6-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 8,
      blockHeight: 6,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_8x8_Format,
    {
      base: "astc-8x8-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 8,
      blockHeight: 8,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_10x5_Format,
    {
      base: "astc-10x5-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 10,
      blockHeight: 5,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_10x6_Format,
    {
      base: "astc-10x6-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 10,
      blockHeight: 6,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_10x8_Format,
    {
      base: "astc-10x8-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 10,
      blockHeight: 8,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_10x10_Format,
    {
      base: "astc-10x10-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 10,
      blockHeight: 10,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_12x10_Format,
    {
      base: "astc-12x10-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 12,
      blockHeight: 10,
      blockBytes: 16,
    },
  ],
  [
    RGBA_ASTC_12x12_Format,
    {
      base: "astc-12x12-unorm",
      srgb: true,
      feature: ASTC,
      blockWidth: 12,
      blockHeight: 12,
      blockBytes: 16,
    },
  ],
];

const FORMATS = new Map<number, IFormatRow>(FORMAT_ROWS);

/**
 * Resolves the GPU format for a compressed texture, or `undefined` when it is unsupported. The
 * sRGB suffix follows the texture's color-space transfer, so any transfer that maps to sRGB is
 * treated as sRGB rather than only the literal `SRGBColorSpace` string.
 */
export function compressedFormatFor(texture: Texture): ICompressedFormatEntry | undefined {
  const row = FORMATS.get(texture.format);
  if (row === undefined) return undefined;
  const srgb =
    row.srgb === true && ColorManagement.getTransfer(texture.colorSpace) === SRGBTransfer;
  return {
    gpuFormat: srgb ? `${row.base}-srgb` : row.base,
    feature: row.feature,
    blockWidth: row.blockWidth,
    blockHeight: row.blockHeight,
    blockBytes: row.blockBytes,
  };
}

type CompressedLike = Texture &
  Pick<CompressedTexture, "mipmaps"> & {
    isCompressedTexture?: boolean;
    isCompressedArrayTexture?: boolean;
  };

/** One bounded GPU write: at most `maxBytesPerWrite` payload bytes, block-aligned. */
export interface ICompressedUploadTile {
  readonly mipLevel: number;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly data: Uint8Array;
  readonly layout: {
    readonly offset: number;
    readonly bytesPerRow: number;
    readonly rowsPerImage: number;
  };
  readonly extent: {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
  };
}

export interface ICompressedUploadPlan {
  readonly tiles: ReadonlyArray<ICompressedUploadTile>;
  readonly totalBytes: number;
  readonly layers: number;
  readonly width: number;
  readonly height: number;
}

function compressedLayers(source: CompressedLike): number {
  const depth = (source.image as { depth?: number } | null)?.depth;
  if (!source.isCompressedArrayTexture) {
    // A 2D texture has one layer. Reject any other declared depth instead of dropping layers.
    if (depth !== undefined && depth !== 1) {
      if (depth > 1)
        throw new Error(
          "Compressed 2D texture cannot carry image depth above 1. Use CompressedArrayTexture.",
        );
      throw new Error("Invalid compressed 2D texture depth. Only undefined or 1 is valid.");
    }
    return 1;
  }
  if (!Number.isSafeInteger(depth) || (depth ?? 0) <= 0)
    throw new Error("Invalid compressed texture layer count.");
  return depth as number;
}

/**
 * Validates a compressed source and plans whole-texture coverage as block-aligned writes that
 * never exceed `maxBytesPerWrite` and never exceed one mip tail or one array layer per write.
 * Fails closed on a block budget smaller than one block, an invalid dimension, a base mip that
 * differs from the image, or data too short for the declared layers. Each mip must match the
 * halved base size, and the chain cannot be longer than the base allows. Called before any GPU
 * allocation.
 */
export function planCompressedUpload(
  source: CompressedLike,
  block: ICompressedFormatEntry,
  maxBytesPerWrite: number,
): ICompressedUploadPlan {
  const mipmaps = source.mipmaps;
  if (!Number.isSafeInteger(maxBytesPerWrite) || maxBytesPerWrite < block.blockBytes)
    throw new Error("Compressed texture block budget is unsupported.");
  if (!Array.isArray(mipmaps) || mipmaps.length === 0)
    throw new Error("Bounded texture preparation requires ready compressed mip data.");
  const image = source.image as { width?: number; height?: number } | null;
  const width = image?.width;
  const height = image?.height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width ?? 0) <= 0 ||
    (height ?? 0) <= 0
  )
    throw new Error("Invalid compressed texture dimensions.");
  if (mipmaps[0]?.width !== width || mipmaps[0]?.height !== height)
    throw new Error("Invalid compressed texture dimensions.");
  const baseWidth = width as number;
  const baseHeight = height as number;
  const maxLevels = Math.floor(Math.log2(Math.max(baseWidth, baseHeight))) + 1;
  if (mipmaps.length > maxLevels) throw new Error("Invalid compressed texture mip chain.");
  const layers = compressedLayers(source);
  const tiles: ICompressedUploadTile[] = [];
  let totalBytes = 0;
  for (let mipLevel = 0; mipLevel < mipmaps.length; mipLevel++) {
    const mip = mipmaps[mipLevel];
    if (mip === undefined) throw new Error("Compressed texture mip map is missing.");
    const expectedWidth = Math.max(1, Math.floor(baseWidth / 2 ** mipLevel));
    const expectedHeight = Math.max(1, Math.floor(baseHeight / 2 ** mipLevel));
    if (mip.width !== expectedWidth || mip.height !== expectedHeight)
      throw new Error("Invalid compressed texture dimensions.");
    const columns = Math.ceil(mip.width / block.blockWidth);
    const rows = Math.ceil(mip.height / block.blockHeight);
    const stride = columns * block.blockBytes;
    const imageBytes = stride * rows;
    if (!Number.isSafeInteger(imageBytes))
      throw new Error("Invalid compressed texture layer data.");
    const bytes = new Uint8Array(mip.data.buffer, mip.data.byteOffset, mip.data.byteLength);
    const tileColumns = Math.min(columns, Math.floor(maxBytesPerWrite / block.blockBytes));
    const tileRows =
      stride <= maxBytesPerWrite ? Math.max(1, Math.floor(maxBytesPerWrite / stride)) : 1;
    for (let layer = 0; layer < layers; layer++) {
      if ((layer + 1) * imageBytes > bytes.byteLength)
        throw new Error("Invalid compressed texture layer data.");
      for (let y = 0; y < rows; y += tileRows) {
        for (let x = 0; x < columns; x += tileColumns) {
          const tileWidth = Math.min(tileColumns, columns - x);
          const tileHeight = Math.min(tileRows, rows - y);
          const offset = layer * imageBytes + y * stride + x * block.blockBytes;
          const length = (tileHeight - 1) * stride + tileWidth * block.blockBytes;
          tiles.push({
            mipLevel,
            origin: { x: x * block.blockWidth, y: y * block.blockHeight, z: layer },
            data: bytes.subarray(offset, offset + length),
            layout: { offset: 0, bytesPerRow: stride, rowsPerImage: rows },
            extent: {
              width: tileWidth * block.blockWidth,
              height: tileHeight * block.blockHeight,
              depthOrArrayLayers: 1,
            },
          });
          totalBytes += length;
        }
      }
    }
  }
  return { tiles, totalBytes, layers, width: width as number, height: height as number };
}

/** The public slice of a WebGPU device this lane needs; the rest of `GPUDevice` is unused. */
export interface ICompressedUploadDevice {
  readonly queue: {
    writeTexture(
      destination: {
        readonly texture: unknown;
        readonly mipLevel: number;
        readonly origin: { readonly x: number; readonly y: number; readonly z: number };
      },
      data: Uint8Array,
      layout: ICompressedUploadTile["layout"],
      extent: ICompressedUploadTile["extent"],
    ): void;
  };
  readonly features?: { has(name: string): boolean };
  createTexture(descriptor: {
    readonly size: {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers: number;
    };
    readonly format: string;
    readonly mipLevelCount: number;
    readonly dimension?: string;
    readonly usage?: number;
  }): { destroy(): void };
  readonly lost?: Promise<unknown>;
  pushErrorScope?(filter: "validation" | "out-of-memory"): void;
  popErrorScope?(): Promise<unknown>;
}

interface ICacheEntry {
  device: ICompressedUploadDevice;
  snapshot: readonly unknown[];
  prepared: ExternalTexture;
  listener: () => void;
}

function destroyPrepared(prepared: ExternalTexture): void {
  (prepared.sourceTexture as { destroy?: () => void } | null)?.destroy?.();
}

interface IUploadJob {
  readonly controller: AbortController;
  readonly version: number;
  readonly device: ICompressedUploadDevice;
  readonly snapshot: readonly unknown[];
  users: number;
  promise: Promise<ExternalTexture>;
}

/**
 * What a prepared texture depends on, in a fixed order: identities for objects and copied values
 * for scalars. A mutable object cannot show that an old width changed, so each scalar is copied.
 * The binding fields are the ones `Texture.copy` carries, except the `name` and `userData`
 * metadata, plus the optional `wrapR` and `compareFunction`. Matrix elements are spread so their
 * numbers, not the mutable array, are compared.
 */
function snapshotOf(texture: CompressedLike): unknown[] {
  const image = texture.image as { width?: unknown; height?: unknown; depth?: unknown } | null;
  const fields: unknown[] = [
    texture.version,
    texture.source,
    texture.source.version,
    texture.source.data,
    texture.source.dataReady,
    texture.mipmaps,
    image?.width,
    image?.height,
    image?.depth,
    texture.mapping,
    texture.channel,
    texture.format,
    texture.type,
    texture.internalFormat,
    texture.normalized,
    texture.colorSpace,
    texture.wrapS,
    texture.wrapT,
    "wrapR" in texture ? texture.wrapR : undefined,
    texture.magFilter,
    texture.minFilter,
    texture.anisotropy,
    "compareFunction" in texture ? texture.compareFunction : undefined,
    texture.flipY,
    texture.premultiplyAlpha,
    texture.unpackAlignment,
    texture.generateMipmaps,
    texture.matrixAutoUpdate,
    texture.offset.x,
    texture.offset.y,
    texture.repeat.x,
    texture.repeat.y,
    texture.center.x,
    texture.center.y,
    texture.rotation,
    ...texture.matrix.elements,
    texture.renderTarget,
    texture.isRenderTargetTexture,
    texture.isArrayTexture,
  ];
  for (const mip of texture.mipmaps) {
    const depth = "depth" in mip ? mip.depth : undefined;
    fields.push(mip, mip.data, mip.width, mip.height, depth);
  }
  return fields;
}

function sameSnapshot(expected: readonly unknown[], actual: readonly unknown[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((value, index) => Object.is(value, actual[index]));
}

const TEXTURE_BINDING = 4;
const COPY_DST = 2;

/**
 * One serialized upload lane for cold compressed textures. The lane keys work by `Texture`
 * identity, deduplicates concurrent callers of the same texture, keeps a caller's abort from
 * cancelling another caller, and owns every `GPUTexture` it allocates until the original is
 * disposed, the renderer disposes it, or the device is lost. It never mutates or disposes the
 * borrowed original.
 */
export class CompressedTextureUploads {
  private readonly jobs = new Map<Texture, IUploadJob>();
  private readonly cache = new Map<Texture, ICacheEntry>();
  private readonly owned = new Set<ExternalTexture>();
  private readonly reverse = new Map<ExternalTexture, Texture>();
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly observedDevices = new WeakSet<ICompressedUploadDevice>();
  private deviceLost: Error | undefined;

  constructor(
    private readonly getDevice: () => ICompressedUploadDevice | undefined,
    private readonly options: { readonly budgetMs: number; readonly maxBytesPerWrite: number } = {
      budgetMs: 2,
      maxBytesPerWrite: 65_536,
    },
  ) {}

  /**
   * Resolves a texture this lane owns back to the original it was prepared from. A repeated call
   * that hands back a previously published replacement keeps its identity instead of looking like
   * an unrelated texture.
   */
  resolveOriginal(texture: Texture): Texture {
    return this.reverse.get(texture as ExternalTexture) ?? texture;
  }

  /** Uploads one compressed texture and resolves the prepared `Texture`, or the original if it is not compressed. */
  upload(texture: Texture, signal?: AbortSignal): Promise<Texture> {
    if (this.disposed)
      return Promise.reject(new Error("Renderer disposed during texture preparation."));
    if (this.deviceLost) return Promise.reject(this.deviceLost);
    const device = this.getDevice();
    if (device === undefined)
      return Promise.reject(
        new Error("WebGPU renderer lacks bounded compressed texture preparation."),
      );
    this.subscribeLoss(device);
    if (signal?.aborted) return Promise.reject(signal.reason);

    const original = this.resolveOriginal(texture);
    const job = this.jobs.get(original);
    if (job !== undefined) {
      if (job.version !== original.version)
        return Promise.reject(new Error("Texture changed during preparation."));
      // A pending job serves only the device and source snapshot it captured when it started.
      if (job.device !== device)
        return Promise.reject(new Error("Texture preparation is pending on another device."));
      if (!sameSnapshot(job.snapshot, snapshotOf(original as CompressedLike)))
        return Promise.reject(new Error("Texture changed during preparation."));
      return this.wait(job, signal);
    }

    const cached = this.cache.get(original);
    if (cached !== undefined && this.matches(cached, device, original as CompressedLike))
      return Promise.resolve(cached.prepared);

    if (
      !(
        ("isCompressedTexture" in original && original.isCompressedTexture === true) ||
        ("isCompressedArrayTexture" in original && original.isCompressedArrayTexture === true)
      )
    )
      return Promise.resolve(original);
    if (
      original.version <= 0 ||
      original.mipmaps.length === 0 ||
      original.source.dataReady !== true
    )
      return Promise.reject(
        new Error("Bounded texture preparation requires ready compressed mip data."),
      );
    const block = compressedFormatFor(original);
    if (block === undefined)
      return Promise.reject(new Error("Unsupported compressed texture format."));
    if (device.features?.has(block.feature) !== true)
      return Promise.reject(new Error(`Compressed texture format requires ${block.feature}.`));

    const started = this.start(original as CompressedLike, device, block);
    return this.wait(started, signal);
  }

  private matches(
    entry: ICacheEntry,
    device: ICompressedUploadDevice,
    texture: CompressedLike,
  ): boolean {
    return entry.device === device && sameSnapshot(entry.snapshot, snapshotOf(texture));
  }

  private start(
    texture: CompressedLike,
    device: ICompressedUploadDevice,
    block: ICompressedFormatEntry,
  ): IUploadJob {
    const controller = new AbortController();
    const version = texture.version;
    // The job reads its snapshot before it queues. A source edit made while the job waits rejects
    // its write.
    const snapshot = snapshotOf(texture);
    // Queued and in-flight work needs its own dispose hook until commit adds the cache listener.
    // The job removes this hook when it settles.
    const transient = () => this.releaseOriginal(texture);
    texture.addEventListener("dispose", transient);
    const cancelled = new Promise<never>((_resolve, reject) =>
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      }),
    );
    const work = this.tail.then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return this.write(texture, device, block, controller.signal, snapshot);
    });
    const job: IUploadJob = {
      controller,
      device,
      promise: Promise.resolve(undefined as never),
      snapshot,
      users: 0,
      version,
    };
    // Owning this job's outcome on `work` (not on the raced promise) means a late write that
    // loses the race to cancellation still releases its allocation instead of leaking it.
    const settle = work.then((prepared) => {
      if (
        controller.signal.aborted ||
        this.getDevice() !== device ||
        !sameSnapshot(snapshot, snapshotOf(texture))
      ) {
        this.destroyOwned(prepared);
        throw new Error("Texture preparation invalidated.");
      }
      this.commit(texture, device, prepared, snapshot);
      return prepared;
    });
    job.promise = Promise.race([settle, cancelled]).finally(() => {
      texture.removeEventListener("dispose", transient);
      if (this.jobs.get(texture) === job) this.jobs.delete(texture);
    });
    this.jobs.set(texture, job);
    // Keep the lane serialized until the backend work and validation settle.
    this.tail = Promise.allSettled([work, job.promise]).then(() => undefined);
    return job;
  }

  /**
   * Registers a prepared replacement and keeps the original's dispose listener alive while any
   * cache entry or owned version for it survives. A version refresh publishes a new replacement
   * and leaves the previous one valid until its lifetime ends.
   */
  private commit(
    texture: CompressedLike,
    device: ICompressedUploadDevice,
    prepared: ExternalTexture,
    snapshot: readonly unknown[],
  ): void {
    const existing = this.cache.get(texture);
    if (existing === undefined) {
      const listener = () => this.releaseOriginal(texture);
      texture.addEventListener("dispose", listener);
      this.cache.set(texture, { device, snapshot, prepared, listener });
    } else {
      existing.device = device;
      existing.prepared = prepared;
      existing.snapshot = snapshot;
    }
    this.owned.add(prepared);
    this.reverse.set(prepared, texture);
  }

  private releaseOriginal(texture: Texture): void {
    const entry = this.cache.get(texture);
    if (entry !== undefined) {
      texture.removeEventListener("dispose", entry.listener);
      this.cache.delete(texture);
    }
    for (const prepared of [...this.owned]) {
      if (this.reverse.get(prepared) === texture) {
        this.owned.delete(prepared);
        this.reverse.delete(prepared);
        destroyPrepared(prepared);
      }
    }
    this.jobs.get(texture)?.controller.abort(new Error("Texture disposed during preparation."));
  }

  private destroyOwned(prepared: ExternalTexture): void {
    if (this.owned.delete(prepared)) {
      this.reverse.delete(prepared);
      destroyPrepared(prepared);
    }
  }

  private wait(job: IUploadJob, signal?: AbortSignal): Promise<Texture> {
    job.users += 1;
    return new Promise<Texture>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: ExternalTexture) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        job.users -= 1;
        if (error !== undefined && error !== null) reject(error);
        else resolve(value as ExternalTexture);
        if (job.users === 0 && !job.controller.signal.aborted)
          job.controller.abort(new Error("Texture preparation has no remaining caller."));
      };
      const abort = () => finish(signal?.reason ?? new Error("Texture preparation cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      job.promise.then(
        (value) => finish(undefined, value),
        (error: unknown) => finish(error),
      );
    });
  }

  private async write(
    texture: CompressedLike,
    device: ICompressedUploadDevice,
    block: ICompressedFormatEntry,
    signal: AbortSignal,
    snapshot: readonly unknown[],
  ): Promise<ExternalTexture> {
    const mipmaps = texture.mipmaps;
    const check = () => {
      if (signal.aborted) throw signal.reason ?? new Error("Compressed texture upload cancelled.");
      // A replaced device invalidates the job the same way a changed source does.
      if (this.getDevice() !== device || !sameSnapshot(snapshot, snapshotOf(texture)))
        throw new Error("Texture preparation invalidated.");
    };
    check();
    // Validate every dimension, layer, mip size and data bound before any GPU allocation.
    const plan = planCompressedUpload(texture, block, this.options.maxBytesPerWrite);
    check();
    if (
      (plan.width % block.blockWidth !== 0 || plan.height % block.blockHeight !== 0) &&
      device.features?.has("texture-compression-unaligned") !== true
    )
      throw new Error(
        "Compressed texture base must be block-aligned without texture-compression-unaligned.",
      );
    const gpuTexture = device.createTexture({
      size: { width: plan.width, height: plan.height, depthOrArrayLayers: plan.layers },
      format: block.gpuFormat,
      mipLevelCount: Math.max(1, mipmaps.length),
      dimension: "2d",
      usage: TEXTURE_BINDING | COPY_DST,
    });
    const prepared = new ExternalTexture(gpuTexture);
    // Own the replacement from creation, before `.copy` and any await, so a throwing copy, an
    // invalidation or `dispose` releases the allocation immediately and exactly once; `Set.delete`
    // in `destroyOwned` keeps that from double-destroying a committed version.
    this.owned.add(prepared);
    this.reverse.set(prepared, texture);
    try {
      // `ExternalTexture.copy` shares the original's `source` and increments its version.
      // Copy from a view whose `source` is a new `Source` over the same data. The original keeps
      // its own `source` and version.
      const isolatedSource = new Source(texture.source.data);
      const view = new Proxy(texture, {
        get(target, key, receiver) {
          return key === "source" ? isolatedSource : Reflect.get(target, key, receiver);
        },
      });
      // `ExternalTexture.copy` copies the original's `sourceTexture` (undefined for a cold texture),
      // so reassign the public GPU backing the frame binds after the copy.
      prepared.copy(view as never);
      prepared.sourceTexture = gpuTexture;
      prepared.needsUpdate = true;
      await this.writeTiles(device, gpuTexture, plan, signal, check);
    } catch (error) {
      // `.copy` can reset the public backing before it throws; restore it so the owned release
      // destroys the freshly allocated GPU texture exactly once.
      prepared.sourceTexture = gpuTexture;
      this.destroyOwned(prepared);
      throw error;
    }
    return prepared;
  }

  private async writeTiles(
    device: ICompressedUploadDevice,
    gpuTexture: { destroy(): void },
    plan: ICompressedUploadPlan,
    signal: AbortSignal,
    check: () => void,
  ): Promise<void> {
    const budgetMs = this.options.budgetMs;
    const scoped =
      typeof device.pushErrorScope === "function" && typeof device.popErrorScope === "function";
    const failures: unknown[] = [];
    const validations: Promise<void>[] = [];
    let started: number | null = null;
    let index = 0;
    try {
      while (index < plan.tiles.length && failures.length === 0) {
        check();
        if (started === null) started = performance.now();
        if (performance.now() - started >= budgetMs) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          started = performance.now();
          check();
        }
        if (scoped) {
          device.pushErrorScope?.("out-of-memory");
          device.pushErrorScope?.("validation");
        }
        try {
          do {
            check();
            const tile = plan.tiles[index];
            if (tile === undefined) break;
            device.queue.writeTexture(
              { texture: gpuTexture, mipLevel: tile.mipLevel, origin: tile.origin },
              tile.data,
              tile.layout,
              tile.extent,
            );
            index += 1;
          } while (index < plan.tiles.length && performance.now() - started < budgetMs);
        } finally {
          if (scoped) {
            validations.push(
              Promise.allSettled([device.popErrorScope?.(), device.popErrorScope?.()]).then(
                (results) => {
                  for (const result of results) {
                    if (result.status === "rejected") failures.push(result.reason);
                    else if (result.value !== null && result.value !== undefined)
                      failures.push(new Error((result.value as { message?: string }).message));
                  }
                },
              ),
            );
          }
        }
        if (validations.length === 4) await validations.shift();
        check();
        if (index < plan.tiles.length && failures.length === 0)
          await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      // A `check` or `writeTexture` throw exits the loop early. Settle every popped scope before
      // the lane advances. `allSettled` keeps the original failure as the propagated error.
      await Promise.allSettled(validations);
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `Compressed texture upload failed: ${failures
          .map((error) => (error as Error)?.message ?? String(error))
          .join("; ")}`,
      );
    check();
  }

  private subscribeLoss(device: ICompressedUploadDevice): void {
    if (this.observedDevices.has(device) || device.lost === undefined) return;
    this.observedDevices.add(device);
    const lost = (error: unknown) => {
      this.deviceLost =
        error instanceof Error ? error : new Error("Device lost during texture preparation.");
      for (const job of this.jobs.values()) job.controller.abort(this.deviceLost);
      for (const prepared of [...this.owned]) this.destroyOwned(prepared);
    };
    device.lost.then(lost, lost);
  }

  /** Releases every GPU allocation and listener the lane owns. Originals are untouched. */
  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values())
      job.controller.abort(new Error("Renderer disposed during texture preparation."));
    this.jobs.clear();
    for (const [texture, entry] of this.cache)
      texture.removeEventListener("dispose", entry.listener);
    this.cache.clear();
    for (const prepared of [...this.owned]) this.destroyOwned(prepared);
    this.owned.clear();
    this.reverse.clear();
  }
}
