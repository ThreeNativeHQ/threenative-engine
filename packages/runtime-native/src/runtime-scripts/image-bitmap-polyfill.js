// ImageBitmap class (web-compatible)
class ImageBitmap {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this._data = data; // Internal RGBA pixel data
    this._closed = false;
  }

  close() {
    this._closed = true;
    this._data = null;
  }
}

// createImageBitmap - Standard Web API
// Supports: Blob, ArrayBuffer, Response, or object with arrayBuffer() method
async function createImageBitmap(source, options) {
  let arrayBuffer;

  if (source instanceof ArrayBuffer) {
    arrayBuffer = source;
  } else if (source instanceof Uint8Array) {
    // A view may name one embedded image or part of a pooled buffer, not the whole allocation.
    arrayBuffer = source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
      ? source.buffer
      : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  } else if (source && typeof source.arrayBuffer === "function") {
    // Blob or Response
    arrayBuffer = await source.arrayBuffer();
  } else if (source?._data) {
    // Already an ImageBitmap-like object
    return source;
  } else {
    throw new Error("createImageBitmap: unsupported source type");
  }

  // Decode off the frame thread: the native side queues the bytes and calls back once a worker
  // has finished, so this returns to the event loop instead of stopping it for the whole decode.
  const decoded = await new Promise((resolve, reject) => {
    __decodeImageDataAsync(arrayBuffer, (bitmap, error) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(bitmap);
    });
  });

  if (!decoded) {
    throw new Error("createImageBitmap: failed to decode image");
  }

  // Create ImageBitmap
  const bitmap = new ImageBitmap(decoded.width, decoded.height, decoded._data);
  return bitmap;
}

globalThis.createImageBitmap = createImageBitmap;
globalThis.ImageBitmap = ImageBitmap;

// CanvasRenderingContext2D - Placeholder class for instanceof checks
// The actual implementation is in Canvas2D bindings, this is just for type checking
class CanvasRenderingContext2D {}
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;

// HTMLCanvasElement - Placeholder class for instanceof checks
class HTMLCanvasElement {}
globalThis.HTMLCanvasElement = HTMLCanvasElement;

// OffscreenCanvas - For type checking
class OffscreenCanvas {
  constructor(width, height) {
    this.width = width || 300;
    this.height = height || 150;
    this._contextType = null;
    this._context = null;
  }

  getContext(type, options) {
    if (type === "2d") {
      // For basic 2D context needs
      if (!this._context) {
        this._context = { canvas: this };
      }
      return this._context;
    }
    return null;
  }
}
globalThis.OffscreenCanvas = OffscreenCanvas;

// Image - minimal HTMLImageElement subset for stock three.js addons.
// Three's SMAA and other display nodes construct Image and assign a base64
// data URI to `.src`, so the native host must decode it through the same
// fetch/createImageBitmap path the rest of the runtime already uses.
class Image {
  constructor(width, height) {
    this.width = width || 0;
    this.height = height || 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.complete = true;
    this.currentSrc = "";
    this.crossOrigin = null;
    this.decoding = "auto";
    this.onload = null;
    this.onerror = null;
    this._src = "";
    this._data = null;
    this._loadToken = 0;
    this._loadPromise = Promise.resolve();
    this._listeners = { error: [], load: [] };
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = String(value);
    this.currentSrc = this._src;
    this._loadToken += 1;
    const token = this._loadToken;
    this.complete = false;
    this._loadPromise = (async () => {
      try {
        const response = await fetch(this._src);
        const bitmap = await createImageBitmap(response);
        if (token !== this._loadToken) return;
        this.width = bitmap.width;
        this.height = bitmap.height;
        this.naturalWidth = bitmap.width;
        this.naturalHeight = bitmap.height;
        this._data = bitmap._data ?? null;
        this.complete = true;
        this._fire("load");
      } catch (error) {
        if (token !== this._loadToken) return;
        this.width = 0;
        this.height = 0;
        this.naturalWidth = 0;
        this.naturalHeight = 0;
        this.complete = true;
        if (!this._fire("error")) {
          console.error("[Mystral] Image failed to load:", this._src, error);
        }
      }
    })();
  }

  addEventListener(type, listener) {
    const list = this._listeners[type];
    if (list && typeof listener === "function") list.push(listener);
  }

  removeEventListener(type, listener) {
    const list = this._listeners[type];
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }

  _fire(type) {
    const event = { target: this, type };
    const listeners = [...(this._listeners[type] || [])];
    for (const listener of listeners) listener.call(this, event);
    const handler = type === "load" ? this.onload : this.onerror;
    if (typeof handler === "function") handler.call(this, event);
    return listeners.length > 0 || typeof handler === "function";
  }

  decode() {
    return this._loadPromise;
  }
}

if (typeof globalThis.Image === "undefined") globalThis.Image = Image;
