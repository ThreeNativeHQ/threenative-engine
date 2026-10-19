import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const { test } = await import(process.env.VITEST ? "vitest" : "node:test");
const script = readFileSync(new URL("../src/runtime-scripts/image-bitmap-polyfill.js", import.meta.url), "utf8");

function host(decode) {
  const context = { ArrayBuffer, Uint8Array, __decodeImageDataAsync: decode };
  runInNewContext(script, context, { filename: "image-bitmap-polyfill.js" });
  return context;
}

for (const [name, source] of [
  ["an offset Uint8Array", new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4)],
  ["a prefix Uint8Array", new Uint8Array([1, 2, 3, 88]).subarray(0, 3)],
  ["a pooled Buffer", Buffer.from([99, 1, 2, 3, 88]).subarray(1, 4)],
]) {
  test(`createImageBitmap decodes only the byte range of ${name}`, async () => {
    let passed;
    const context = host((bytes, done) => {
      passed = [...new Uint8Array(bytes)];
      done({ width: 1, height: 1, _data: new ArrayBuffer(4) }, null);
    });
    const bitmap = await context.createImageBitmap(source);
    assert.equal(passed.length, 3, "unrelated backing-buffer bytes reached the decoder");
    assert.deepEqual(passed, [1, 2, 3]);
    assert.equal(bitmap.width, 1);
    assert.equal(bitmap.height, 1);
  });
}

test("a complete byte view keeps its backing buffer without another copy", async () => {
  const source = new Uint8Array([1, 2, 3]);
  let passed;
  const context = host((bytes, done) => {
    passed = bytes;
    done({ width: 1, height: 1, _data: new ArrayBuffer(4) }, null);
  });
  await context.createImageBitmap(source);
  assert.equal(passed, source.buffer);
});

test("native completion stays asynchronous and decode errors reject the promise", async () => {
  let complete;
  let settled = false;
  const context = host((_bytes, done) => { complete = done; });
  const promise = context.createImageBitmap(new ArrayBuffer(1));
  const observed = promise.then(() => { settled = true; }, (error) => {
    settled = true;
    throw error;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  const rejected = assert.rejects(observed, /invalid texture/u);
  complete(undefined, "invalid texture");
  await rejected;
});

test("Blob-like sources still await their encoded bytes", async () => {
  const bytes = new ArrayBuffer(3);
  let passed;
  const context = host((value, done) => {
    passed = value;
    done({ width: 2, height: 1, _data: new ArrayBuffer(8) }, null);
  });
  const bitmap = await context.createImageBitmap({ arrayBuffer: async () => bytes });
  assert.equal(passed, bytes);
  assert.equal(bitmap.width, 2);
});

// The Image shim backs stock three.js addons (SMAA and friends) that assign an embedded
// base64 PNG data URI to `.src`. It must decode through the same fetch plus
// createImageBitmap path and surface load/error the way an HTMLImageElement does.
function imageHost(overrides = {}) {
  const errors = [];
  const context = {
    ArrayBuffer,
    Uint8Array,
    __decodeImageDataAsync: () => {},
    console: { error: (...args) => errors.push(args), log() {}, warn() {} },
  };
  if (overrides.Image) context.Image = overrides.Image;
  runInNewContext(script, context, { filename: "image-bitmap-polyfill.js" });
  // The script installs the host createImageBitmap that drives the native decoder, so a stub
  // replaces it after the script runs, exactly as the engine binds its decoder.
  context.fetch = overrides.fetch ?? (async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }));
  if (overrides.createImageBitmap) context.createImageBitmap = overrides.createImageBitmap;
  context.__errors = errors;
  return context;
}

test("Image decodes a data-URI src and fires load once with the bitmap copied on", async () => {
  const sources = [];
  const context = imageHost({
    fetch: async (src) => { sources.push(src); return { arrayBuffer: async () => new ArrayBuffer(4) }; },
    createImageBitmap: async () => ({ width: 4, height: 5, _data: new ArrayBuffer(80) }),
  });
  context.__url = "data:image/png;base64,AAAA";
  const result = await runInNewContext(`(async () => {
    const img = new Image();
    let onloadCount = 0;
    let listenerCount = 0;
    img.onload = () => { onloadCount += 1; };
    img.addEventListener("load", () => { listenerCount += 1; });
    const completeBefore = img.complete;
    img.src = __url;
    await img.decode();
    return {
      completeBefore,
      complete: img.complete,
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      hasData: img._data instanceof ArrayBuffer,
      src: img.src,
      currentSrc: img.currentSrc,
      onloadCount,
      listenerCount,
    };
  })()`, context);
  assert.equal(result.completeBefore, true);
  assert.equal(result.complete, true);
  assert.equal(result.width, 4);
  assert.equal(result.height, 5);
  assert.equal(result.naturalWidth, 4);
  assert.equal(result.naturalHeight, 5);
  assert.equal(result.hasData, true);
  assert.equal(result.src, "data:image/png;base64,AAAA");
  assert.equal(result.currentSrc, "data:image/png;base64,AAAA");
  assert.equal(result.onloadCount, 1);
  assert.equal(result.listenerCount, 1);
  assert.deepEqual(sources, ["data:image/png;base64,AAAA"]);
});

test("Image reports a failed load through error handlers without firing load", async () => {
  const context = imageHost({ fetch: async () => { throw new Error("network down"); } });
  const result = await runInNewContext(`(async () => {
    const img = new Image();
    let errors = 0;
    let loads = 0;
    img.onerror = () => { errors += 1; };
    img.addEventListener("error", () => { errors += 1; });
    img.onload = () => { loads += 1; };
    img.src = "data:image/png;base64,broken";
    await img.decode();
    return { errors, loads, complete: img.complete, width: img.width, height: img.height };
  })()`, context);
  assert.equal(result.errors, 2);
  assert.equal(result.loads, 0);
  assert.equal(result.complete, true);
  assert.equal(result.width, 0);
  assert.equal(result.height, 0);
  assert.equal(context.__errors.length, 0, "a handled failure must not reach console.error");
});

test("Image reports an unhandled load failure to console.error", async () => {
  const context = imageHost({ fetch: async () => { throw new Error("boom"); } });
  await runInNewContext(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,broken";
    await img.decode();
  })()`, context);
  assert.equal(context.__errors.length, 1);
});

test("Image ignores a stale load when src changes mid-flight", async () => {
  let releaseFirst;
  const context = imageHost({
    fetch: (src) => src === "first"
      ? new Promise((resolve) => {
        releaseFirst = () => resolve({ marker: "first", arrayBuffer: async () => new ArrayBuffer(1) });
      })
      : Promise.resolve({ marker: "second", arrayBuffer: async () => new ArrayBuffer(1) }),
    createImageBitmap: async (source) => ({
      width: source.marker === "first" ? 1 : 2,
      height: 1,
      _data: new ArrayBuffer(4),
    }),
  });
  runInNewContext(`globalThis.__img = new Image(); __img.src = "first";`, context);
  const second = await runInNewContext(
    `(async () => { __img.src = "second"; await __img.decode(); return { width: __img.width, src: __img.src }; })()`,
    context,
  );
  assert.equal(second.width, 2);
  assert.equal(second.src, "second");
  releaseFirst();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    runInNewContext("__img.width", context),
    2,
    "the stale first load overwrote the latest image",
  );
});

test("an existing global Image is not replaced", () => {
  class ExistingImage {}
  const context = imageHost({ Image: ExistingImage });
  assert.equal(context.Image, ExistingImage);
});
