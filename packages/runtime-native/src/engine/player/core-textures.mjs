// three's texture sources over the V8 adapter: the typed array a DataTexture was built from, a 2D
// canvas, and an ImageBitmap from the cooked package. The engine keeps a copy of the texels, so the
// JS-side source is re-sent on `needsUpdate`, as three re-reads `texture.image` before an upload.
import { DataUtils } from "../../../../three-native/src/addons/data-utils.ts";

export { DataUtils };
export const HalfFloatType = 1016;

const NativeTexture = globalThis.Texture;
const NativeDataTexture = globalThis.DataTexture;
const NativeCanvasTexture = globalThis.CanvasTexture;
const sources = new WeakMap();
const bitmaps = new WeakMap();
const nativeFlipY = Object.getOwnPropertyDescriptor(NativeTexture.prototype, "flipY").set;

/** The package entry a URL names: `tnpk:<path>` and `<package>#<path>` from `assets.resolve`, or the path. */
export function logicalPath(url) {
  if (typeof url !== "string" || !url) throw new Error("TN_NATIVE_ASSET_INVALID: expected a nonempty URL");
  if (url.startsWith("tnpk:")) return url.slice(5);
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(hash + 1);
}

/** A canvas-like image's RGBA pixels, read through the standard 2D API. */
function canvasPixels(canvas) {
  const pixels = canvas?.getContext?.("2d")?.getImageData?.(0, 0, canvas.width, canvas.height)?.data;
  if (!pixels) throw new Error("TN_NATIVE_CANVAS_TEXTURE_SOURCE: expected a canvas whose 2D context answers getImageData");
  return pixels;
}

// `image` is the JS source; `needsUpdate` re-sends its texels, as three re-reads `texture.image`.
for (const Native of [NativeDataTexture, NativeCanvasTexture]) {
  const nativeImage = Object.getOwnPropertyDescriptor(Native.prototype, "image").get;
  const nativeNeedsUpdate = Object.getOwnPropertyDescriptor(Native.prototype, "needsUpdate").set;
  Object.defineProperties(Native.prototype, {
    image: {
      configurable: true,
      get() { return sources.get(this) ?? nativeImage.call(this); },
      set(image) { sources.set(this, image); },
    },
    needsUpdate: {
      configurable: true,
      set(value) {
        const image = value ? sources.get(this) : undefined;
        if (image) nativeImage.call(this).data = image.getContext ? canvasPixels(image) : image.data;
        nativeNeedsUpdate.call(this, value);
      },
    },
  });
}

export function DataTexture(data = null, width = 1, height = 1, ...rest) {
  const texture = Reflect.construct(NativeDataTexture, [data ?? undefined, width, height, ...rest], new.target ?? DataTexture);
  if (data) sources.set(texture, { data, width, height });
  return texture;
}
DataTexture.prototype = NativeDataTexture.prototype;
// The adapter finds the engine class a subclass constructs by walking new.target's prototype chain.
Object.setPrototypeOf(DataTexture, NativeDataTexture);

// three's CanvasTexture: the engine's own class over the canvas's pixels, with a full mip chain.
export function CanvasTexture(canvas, ...rest) {
  const texture = Reflect.construct(NativeCanvasTexture, [canvasPixels(canvas), canvas.width, canvas.height, ...rest],
    new.target ?? CanvasTexture);
  sources.set(texture, canvas);
  return texture;
}
CanvasTexture.prototype = NativeCanvasTexture.prototype;
Object.setPrototypeOf(CanvasTexture, NativeCanvasTexture);
if (!Object.hasOwn(CanvasTexture.prototype, "isCanvasTexture")) CanvasTexture.prototype.isCanvasTexture = true;

/** `new Texture(bitmap)` adopts an ImageBitmapLoader result; any other image has no native source. */
export function Texture(image, ...rest) {
  if (image === undefined || image === null) return Reflect.construct(NativeTexture, rest, new.target ?? Texture);
  const bitmap = bitmaps.get(image);
  if (!bitmap) throw new Error("TN_NATIVE_TEXTURE_IMAGE_UNSUPPORTED: a native Texture takes an ImageBitmapLoader result or no image");
  if (bitmap.texture === undefined)
    throw new Error("TN_NATIVE_IMAGE_BITMAP_CLOSED: this ImageBitmap was closed or already adopted by a Texture");
  const { texture, flipped } = bitmap;
  bitmap.texture = undefined;
  // A bitmap decoded with imageOrientation "flipY" is stored upside down; three's WebGPU upload
  // then applies texture.flipY on top, so the engine flips when exactly one of the two asks.
  let flipY = texture.flipY;
  Object.defineProperty(texture, "flipY", {
    configurable: true,
    get() { return flipY; },
    set(value) { flipY = Boolean(value); nativeFlipY.call(texture, flipY !== flipped); },
  });
  texture.flipY = flipY;
  return texture;
}
Texture.prototype = NativeTexture.prototype;
Object.setPrototypeOf(Texture, NativeTexture);

/** An ImageBitmap whose pixels are a native Texture, adopted once by `new Texture(bitmap)`. */
function imageBitmap(texture, options = {}, width = undefined, height = undefined) {
  if (options.premultiplyAlpha === "premultiply")
    throw new Error("TN_NATIVE_IMAGE_BITMAP_OPTION: premultiplyAlpha \"premultiply\" is unsupported; the engine keeps straight alpha");
  for (const option of ["resizeWidth", "resizeHeight", "resizeQuality"])
    if (options[option] !== undefined) throw new Error(`TN_NATIVE_IMAGE_BITMAP_OPTION: ${option} is unsupported`);
  const bitmap = { width, height, close() { bitmaps.get(bitmap).texture = undefined; } };
  bitmaps.set(bitmap, { texture, flipped: options.imageOrientation === "flipY" });
  return bitmap;
}

/**
 * The browser's createImageBitmap for encoded PNG or JPEG bytes (a Blob, an ArrayBuffer or a typed
 * array), decoded by the engine's image decoder. Installed only when the player has that decoder.
 */
export async function createImageBitmap(source, ...rest) {
  if (rest.length > 1) throw new Error("TN_NATIVE_IMAGE_BITMAP_CROP: a source rectangle is unsupported");
  const bytes = typeof source?.arrayBuffer === "function" ? await source.arrayBuffer() : source;
  if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes))
    throw new TypeError("TN_NATIVE_IMAGE_BITMAP_SOURCE: expected a Blob, an ArrayBuffer or a typed array of PNG or JPEG bytes");
  const { texture, width, height } = globalThis.tn.decodeImage(bytes);
  return imageBitmap(texture, rest[0], width, height);
}
if (typeof globalThis.tn?.decodeImage === "function") globalThis.createImageBitmap = createImageBitmap;

/** three's ImageBitmapLoader over the cooked package: the bitmap is the package's decoded texture. */
export class ImageBitmapLoader {
  constructor() {
    this.options = { premultiplyAlpha: "none" };
    this.path = "";
  }
  setOptions(options) { this.options = options; return this; }
  setPath(path) { this.path = path; return this; }
  load(url, onLoad, onProgress, onError) {
    this.loadAsync(url).then(onLoad, (error) => { if (onError) onError(error); else throw error; });
  }
  async loadAsync(url) {
    return imageBitmap(globalThis.tn.loadAsset("texture", logicalPath(this.path + url)).value, this.options);
  }
}

/**
 * three's TextureLoader over the cooked package. The package texture is already decoded, so `load`
 * returns it at once (upright, flipY true, as three's <img> path) and calls onLoad a microtask later.
 */
export class TextureLoader {
  constructor() { this.path = ""; }
  setPath(path) { this.path = path; return this; }
  setCrossOrigin() { return this; }
  load(url, onLoad, onProgress, onError) {
    let texture;
    try {
      texture = globalThis.tn.loadAsset("texture", logicalPath(this.path + url)).value;
    } catch (error) {
      Promise.resolve().then(() => { if (onError) onError(error); else throw error; });
      return new NativeTexture();
    }
    if (onLoad) Promise.resolve().then(() => onLoad(texture));
    return texture;
  }
  loadAsync(url) {
    return new Promise((resolve, reject) => this.load(url, resolve, undefined, reject));
  }
}
