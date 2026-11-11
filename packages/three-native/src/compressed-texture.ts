/**
 * three's CompressedTexture on the browser back end (PRD-867): BC7 or ETC2 RGBA levels built from
 * three's `mipmaps`, each crossing to the engine once, coarse first, so a streamed finer level goes
 * up alone.
 */
import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  engineRef,
} from "./browser-backend.js";

type EngineClass = new (...args: unknown[]) => object;

/** One of three's `CompressedTexture.mipmaps`: a level's blocks, or null while it is not resident. */
interface ICompressedLevel {
  data: ArrayLike<number> | null;
  readonly width: number;
  readonly height: number;
}

/**
 * three's CompressedTexture(mipmaps, width, height, format) over the engine's (PRD-867), or undefined
 * when the engine binds none. The engine takes the level count; each level then crosses as one
 * `mipmaps.N.data`, coarse first.
 */
export function defineCompressedTexture(
  BaseCompressed: EngineClass | undefined,
  runtime: IBrowserRuntime,
): unknown {
  if (BaseCompressed === undefined) return undefined;
  const Base: EngineClass = BaseCompressed;
  /** A typed array as the runtime takes it: itself when typed arrays cross, else its numbers. */
  const crossing = (data: ArrayLike<number>): EngineValue =>
    runtime.typedArrays === true && ArrayBuffer.isView(data) && !(data instanceof DataView)
      ? (data as EngineValue)
      : Array.from(data);
  // Each CompressedTexture's `mipmaps`, and the `data` of each level the engine already holds.
  const levels = new WeakMap<object, ICompressedLevel[]>();
  const sent = new WeakMap<object, unknown[]>();
  /** Sends the levels whose `data` changed, coarse first: the engine keeps the finest resident level as the base. */
  const sendLevels = (texture: object): void => {
    const mipmaps = levels.get(texture) ?? [];
    const held = sent.get(texture) ?? [];
    for (let level = mipmaps.length - 1; level >= 0; level -= 1) {
      const data = mipmaps[level]?.data;
      if (data == null || held[level] === data) continue;
      runtime.set(
        engineRef(texture) as IEngineRef,
        `mipmaps.${String(level)}.data`,
        crossing(data),
      );
      held[level] = data;
    }
    sent.set(texture, held);
  };

  /**
   * three's CompressedTexture(mipmaps, width, height, format) over the engine's (PRD-867): BC7
   * (`RGBA_BPTC_Format`) or ETC2 RGBA (`RGBA_ETC2_EAC_Format`) levels, finest first. A level whose `data`
   * is null is not resident yet: set it and `needsUpdate`, and that level alone goes up, as a stream does.
   */
  function CompressedTexture(
    this: unknown,
    mipmaps: ICompressedLevel[] = [],
    width = 1,
    height = 1,
    format = 1023,
  ) {
    const texture = Reflect.construct(
      Base,
      [mipmaps.length, width, height, format],
      new.target ?? CompressedTexture,
    ) as object;
    levels.set(texture, mipmaps);
    sendLevels(texture);
    return texture;
  }
  {
    CompressedTexture.prototype = BaseCompressed.prototype;
    const needsUpdate = Object.getOwnPropertyDescriptor(
      BaseCompressed.prototype,
      "needsUpdate",
    )?.set;
    if (needsUpdate === undefined)
      throw new TypeError("TN_BROWSER_UNBOUND: CompressedTexture.needsUpdate");
    Object.defineProperties(BaseCompressed.prototype, {
      mipmaps: {
        configurable: true,
        get(this: object) {
          return levels.get(this) ?? [];
        },
        set(this: object, mipmaps: ICompressedLevel[]) {
          levels.set(this, mipmaps);
        },
      },
      image: {
        configurable: true,
        get(this: object) {
          const base = levels.get(this)?.[0];
          return { width: base?.width ?? 0, height: base?.height ?? 0 };
        },
      },
      needsUpdate: {
        configurable: true,
        set(this: object, value: unknown) {
          // A level the engine holds already is not re-sent: after one new level, the engine writes that one.
          if (value) sendLevels(this);
          needsUpdate.call(this, value);
        },
      },
    });
  }

  return CompressedTexture;
}
