// TextDecoder fallback (only when the engine ships none — e.g. QuickJS).
// Implements the standard UTF-8 behavior the protocol needs: fatal:true
// throws a TypeError on malformed input, nonfatal decoding emits U+FFFD,
// an incomplete trailing sequence survives across { stream: true } calls,
// ArrayBuffer views honor byteOffset/byteLength, and unsupported
// labels/options are rejected instead of silently coerced.
if (typeof TextDecoder === "undefined") {
  const UTF8_LABELS = [
    "unicode-1-1-utf-8",
    "unicode11utf8",
    "unicode20utf8",
    "unicode-2-0-utf-8",
    "utf-8",
    "utf8",
    "x-unicode20utf8",
  ];

  function normalizeEncodingLabel(label) {
    const text = String(label === undefined ? "utf-8" : label)
      .toLowerCase()
      .replace(/[\t\n\f\r ]/g, "");
    if (UTF8_LABELS.indexOf(text) === -1) {
      throw new RangeError(`TextDecoder: unsupported encoding "${text}" (only utf-8 is supported)`);
    }
    return "utf-8";
  }

  function toDecoderOptions(value, what) {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object") {
      throw new TypeError(`${what} must be an object`);
    }
    return value;
  }

  function toDecodeBytes(input) {
    if (input === undefined || input === null) return new Uint8Array(0);
    // ArrayBuffer.isView covers every typed array and DataView, and the
    // (buffer, byteOffset, byteLength) view honors the caller's window.
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer) {
      return new Uint8Array(input);
    }
    throw new TypeError("TextDecoder.decode input must be an ArrayBuffer or ArrayBuffer view");
  }

  function malformed(fatal, out) {
    if (fatal) throw new TypeError("TextDecoder: malformed UTF-8 sequence");
    out.push("�");
  }

  // Lead byte -> { needed continuations, first-continuation bounds, point }.
  // The bounds reject overlongs, surrogates and out-of-range points; null
  // means a standalone continuation or impossible lead (0x80-0xC1, 0xF5-0xFF).
  function sequencePlan(lead) {
    if (lead >= 0xc2 && lead <= 0xdf) {
      return { needed: 1, lower: 0x80, upper: 0xbf, point: lead & 0x1f };
    }
    if (lead >= 0xe0 && lead <= 0xef) {
      return {
        needed: 2,
        point: lead & 0x0f,
        lower: lead === 0xe0 ? 0xa0 : 0x80,
        upper: lead === 0xed ? 0x9f : 0xbf,
      };
    }
    if (lead >= 0xf0 && lead <= 0xf4) {
      return {
        needed: 3,
        point: lead & 0x07,
        lower: lead === 0xf0 ? 0x90 : 0x80,
        upper: lead === 0xf4 ? 0x8f : 0xbf,
      };
    }
    return null;
  }

  // Consumes one multibyte sequence at bytes[cursor.index]. An incomplete
  // streaming tail rewinds and returns incomplete:true; a flush emits one
  // replacement. An out-of-bounds continuation is rejected immediately while
  // leaving the offending byte unconsumed.
  function consumeSequence(bytes, cursor, plan, fatal, out, stream) {
    const seqStart = cursor.index;
    cursor.index += 1;
    let lower = plan.lower;
    let upper = plan.upper;
    let point = plan.point;
    for (let seen = 0; seen < plan.needed; seen += 1) {
      if (cursor.index >= bytes.length) {
        if (stream) {
          cursor.index = seqStart;
          return { incomplete: true, point: null };
        }
        malformed(fatal, out);
        cursor.index = bytes.length;
        return { incomplete: false, point: null };
      }
      const continuation = bytes[cursor.index];
      if (continuation < lower || continuation > upper) {
        malformed(fatal, out);
        return { incomplete: false, point: null };
      }
      point = (point << 6) | (continuation & 0x3f);
      cursor.index += 1;
      lower = 0x80;
      upper = 0xbf;
    }
    return { incomplete: false, point };
  }

  // Decodes bytes as UTF-8. Returns { text, rest }: rest is the incomplete
  // trailing sequence a streaming caller keeps for the next chunk, or null
  // when everything was consumed (a truncated tail on flush is an error).
  function decodeUtf8(bytes, fatal, stream) {
    const out = [];
    const cursor = { index: 0 };
    while (cursor.index < bytes.length) {
      const lead = bytes[cursor.index];
      if (lead <= 0x7f) {
        out.push(String.fromCharCode(lead));
        cursor.index += 1;
        continue;
      }
      const plan = sequencePlan(lead);
      if (plan === null) {
        malformed(fatal, out);
        cursor.index += 1;
        continue;
      }
      const step = consumeSequence(bytes, cursor, plan, fatal, out, stream);
      if (step.incomplete) return { text: out.join(""), rest: bytes.slice(cursor.index) };
      if (step.point === null) continue;
      out.push(String.fromCodePoint(step.point));
    }
    const rest = cursor.index < bytes.length ? bytes.slice(cursor.index, bytes.length) : null;
    return { text: out.join(""), rest };
  }

  class TextDecoder {
    // Matches the Web IDL signature constructor(optional DOMString label = "utf-8", ...).
    // biome-ignore lint/style/useDefaultParameterLast: Web IDL default precedes options.
    constructor(label = "utf-8", options) {
      normalizeEncodingLabel(label);
      const settings = toDecoderOptions(options, "TextDecoder options");
      this.encoding = "utf-8";
      this.fatal = Boolean(settings.fatal);
      this.ignoreBOM = Boolean(settings.ignoreBOM);
      this._pending = new Uint8Array(0);
      this._bomChecked = false;
    }
    decode(input, options) {
      const settings = toDecoderOptions(options, "TextDecoder.decode options");
      const stream = Boolean(settings.stream);
      let bytes = toDecodeBytes(input);
      if (this._pending.length > 0) {
        const joined = new Uint8Array(this._pending.length + bytes.length);
        joined.set(this._pending, 0);
        joined.set(bytes, this._pending.length);
        bytes = joined;
        this._pending = new Uint8Array(0);
      }
      const result = decodeUtf8(bytes, this.fatal, stream);
      this._pending = result.rest === null ? new Uint8Array(0) : result.rest;
      let text = result.text;
      // The BOM is stripped once, at the start of the stream, unless ignored.
      if (!this._bomChecked && (text.length > 0 || !stream)) {
        this._bomChecked = true;
        if (!this.ignoreBOM && text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
      }
      return text;
    }
  }
  globalThis.TextDecoder = TextDecoder;
}

// TextEncoder polyfill (if not available)
if (typeof TextEncoder === "undefined") {
  class TextEncoder {
    constructor() {
      this.encoding = "utf-8";
    }
    encode(str) {
      const utf8 = unescape(encodeURIComponent(str));
      const result = new Uint8Array(utf8.length);
      for (let i = 0; i < utf8.length; i++) {
        result[i] = utf8.charCodeAt(i);
      }
      return result;
    }
  }
  globalThis.TextEncoder = TextEncoder;
}

// AbortController / AbortSignal polyfill (Web API standard)
// Three.js' FileLoader/GLTFLoader (r168+) construct an AbortController to
// manage fetch cancellation, so these globals must exist or loading throws
// "ReferenceError: AbortController is not defined". MystralNative's native
// fetch cannot cancel an in-flight request, but it honors an aborted signal
// by rejecting the fetch promise (see fetch() below).
if (typeof AbortSignal === "undefined") {
  class AbortSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      this._listeners = [];
    }
    addEventListener(type, listener) {
      if (type === "abort" && typeof listener === "function") {
        this._listeners.push(listener);
      }
    }
    removeEventListener(type, listener) {
      if (type === "abort") {
        this._listeners = this._listeners.filter((l) => l !== listener);
      }
    }
    dispatchEvent(event) {
      if (event && event.type === "abort") {
        if (typeof this.onabort === "function") this.onabort(event);
        const listeners = this._listeners.slice();
        for (let i = 0; i < listeners.length; i++) listeners[i](event);
      }
      return true;
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason !== undefined ? this.reason : new Error("AbortError");
    }
    _fireAbort(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason !== undefined ? reason : new Error("AbortError");
      this.dispatchEvent({ type: "abort", target: this });
    }
    static abort(reason) {
      const signal = new AbortSignal();
      signal._fireAbort(reason);
      return signal;
    }
    static timeout(ms) {
      const signal = new AbortSignal();
      setTimeout(() => {
        signal._fireAbort(new Error("TimeoutError"));
      }, ms);
      return signal;
    }
    static any(signals) {
      const result = new AbortSignal();
      const list = Array.from(signals || []);
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s) continue;
        if (s.aborted) {
          result._fireAbort(s.reason);
          return result;
        }
        s.addEventListener("abort", () => {
          result._fireAbort(s.reason);
        });
      }
      return result;
    }
  }
  globalThis.AbortSignal = AbortSignal;
}

if (typeof AbortController === "undefined") {
  class AbortController {
    constructor() {
      this.signal = new AbortSignal();
    }
    abort(reason) {
      this.signal._fireAbort(reason);
    }
  }
  globalThis.AbortController = AbortController;
}

// Blob class (Web API standard)
if (typeof Blob === "undefined") {
  class Blob {
    constructor(blobParts = [], options = {}) {
      this.type = options.type || "";

      // Concatenate all parts into a single ArrayBuffer
      let totalSize = 0;
      const parts = [];

      for (const part of blobParts) {
        if (part instanceof ArrayBuffer) {
          parts.push(new Uint8Array(part));
          totalSize += part.byteLength;
        } else if (part instanceof Uint8Array) {
          parts.push(part);
          totalSize += part.byteLength;
        } else if (part instanceof Blob) {
          // Need to get the Blob's internal data
          parts.push(new Uint8Array(part._data));
          totalSize += part._data.byteLength;
        } else if (typeof part === "string") {
          const encoder = new TextEncoder();
          const encoded = encoder.encode(part);
          parts.push(encoded);
          totalSize += encoded.byteLength;
        }
      }

      // Create final buffer
      const buffer = new ArrayBuffer(totalSize);
      const view = new Uint8Array(buffer);
      let offset = 0;
      for (const part of parts) {
        view.set(part, offset);
        offset += part.byteLength;
      }

      this._data = buffer;
      this.size = totalSize;
    }

    async arrayBuffer() {
      return this._data;
    }

    async text() {
      const decoder = new TextDecoder();
      return decoder.decode(new Uint8Array(this._data));
    }

    slice(start = 0, end = this.size, type = "") {
      const data = new Uint8Array(this._data, start, end - start);
      return new Blob([data], { type });
    }

    async stream() {
      // ReadableStream not implemented yet
      throw new Error("Blob.stream() not implemented");
    }
  }
  globalThis.Blob = Blob;
}

// Headers class - mimics Web Headers API
class Headers {
  constructor(init = {}) {
    this._headers = new Map();
    if (init) {
      if (init instanceof Headers) {
        for (const [key, value] of init) {
          this._headers.set(key.toLowerCase(), value);
        }
      } else if (Array.isArray(init)) {
        for (const [key, value] of init) {
          this._headers.set(key.toLowerCase(), value);
        }
      } else if (typeof init === "object") {
        for (const [key, value] of Object.entries(init)) {
          this._headers.set(key.toLowerCase(), value);
        }
      }
    }
  }

  get(name) {
    return this._headers.get(name.toLowerCase()) || null;
  }

  set(name, value) {
    this._headers.set(name.toLowerCase(), value);
  }

  has(name) {
    return this._headers.has(name.toLowerCase());
  }

  delete(name) {
    this._headers.delete(name.toLowerCase());
  }

  entries() {
    return this._headers.entries();
  }

  keys() {
    return this._headers.keys();
  }

  values() {
    return this._headers.values();
  }

  forEach(callback) {
    this._headers.forEach((value, key) => callback(value, key, this));
  }

  [Symbol.iterator]() {
    return this._headers.entries();
  }
}
globalThis.Headers = Headers;

// Response class
class Response {
  constructor(data, options = {}) {
    this._data = data;
    this.ok = options.ok !== undefined ? options.ok : true;
    this.status = options.status || 200;
    this.statusText = options.statusText || "OK";
    this.url = options.url || "";
    this.headers = new Headers(options.headers || {});
  }

  async arrayBuffer() {
    return this._data;
  }

  async text() {
    const decoder = new TextDecoder();
    return decoder.decode(new Uint8Array(this._data));
  }

  async json() {
    const text = await this.text();
    return JSON.parse(text);
  }

  async blob() {
    return new Blob([this._data]);
  }
}

// Request class (Web API standard) - Three.js' FileLoader (r168+) wraps the
// URL in a Request (with headers/credentials/signal) before calling fetch().
class Request {
  constructor(input, init = {}) {
    if (input && typeof input === "object" && typeof input.url === "string") {
      this.url = input.url;
      this.method = init.method || input.method || "GET";
      this.headers = new Headers(init.headers || input.headers || {});
      this.credentials = init.credentials || input.credentials || "same-origin";
      this.signal = init.signal || input.signal || null;
      this.body = init.body !== undefined ? init.body : input.body != null ? input.body : null;
    } else {
      this.url = String(input);
      this.method = init.method || "GET";
      this.headers = new Headers(init.headers || {});
      this.credentials = init.credentials || "same-origin";
      this.signal = init.signal || null;
      this.body = init.body !== undefined ? init.body : null;
    }
    this.mode = init.mode || "cors";
  }
}
globalThis.Request = Request;

// Standard `data:` URL body decoding (RFC 2397 / WHATWG fetch). Native games use data URIs for
// embedded assets — Three.js' SMAANode carries its two lookup tables as base64 PNGs — and the host
// has no `atob`. Decoding is byte-exact: a malformed escape or base64 digit rejects instead of
// yielding truncated bytes.
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const values = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) values[BASE64_ALPHABET.charCodeAt(i)] = i;
  return values;
})();

function decodeBase64Bytes(text) {
  // WHATWG forgiving-base64 decode: strip whitespace, drop one or two trailing
  // "=" only from a multiple-of-four length, reject a remainder of one, then
  // accept the remaining unpadded alphabet. A remainder of two or three is
  // valid unpadded input, not a truncated group.
  const clean = text.replace(/[\t\n\f\r ]/g, "");
  let data = clean;
  if (data.length % 4 === 0 && data.endsWith("==")) data = data.slice(0, -2);
  else if (data.length % 4 === 0 && data.endsWith("=")) data = data.slice(0, -1);
  if (data.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(data))
    throw new TypeError("fetch: invalid base64 in data: URL");
  const tail = data.length % 4;
  const bytes = new Uint8Array(((data.length - tail) / 4) * 3 + (tail === 2 ? 1 : tail === 3 ? 2 : 0));
  let write = 0;
  for (let i = 0; i < data.length; i += 4) {
    const group = data.slice(i, i + 4);
    let bits = 0;
    for (let j = 0; j < group.length; j += 1) bits = bits * 64 + BASE64_VALUES[group.charCodeAt(j)];
    bits *= 2 ** (6 * (4 - group.length)); // left-align the group to the full 24 bits
    const carried = group.length - 1;
    for (let j = 0; j < carried; j += 1) bytes[write + j] = (bits >> (16 - 8 * j)) & 0xff;
    write += carried;
  }
  return bytes;
}

function decodePercentBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "%") {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex))
        throw new TypeError("fetch: invalid percent-encoding in data: URL");
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    const point = text.codePointAt(i);
    if (point < 0x80) {
      bytes.push(point);
    } else {
      // A literal non-ASCII character is UTF-8 encoded, as the URL parser does.
      const encoded = new TextEncoder().encode(String.fromCodePoint(point));
      for (let j = 0; j < encoded.length; j += 1) bytes.push(encoded[j]);
      if (point > 0xffff) i += 1;
    }
  }
  return new Uint8Array(bytes);
}

function normalizeMediaType(metadata) {
  if (metadata.startsWith(";")) return `text/plain${metadata}`;
  if (metadata.includes("/")) return metadata;
  return "text/plain;charset=US-ASCII";
}

function decodeDataUrl(url) {
  // The URL parser removes the fragment before the data: processor runs, so a
  // raw "#" ends the body while a percent-encoded "%23" stays in it.
  const hash = url.indexOf("#");
  const source = hash === -1 ? url : url.slice(0, hash);
  const comma = source.indexOf(",");
  if (comma === -1) throw new TypeError("fetch: invalid data: URL (missing comma)");
  const metadata = source.slice(5, comma);
  let base64 = false;
  let mimeType = metadata;
  if (/;base64$/i.test(metadata)) {
    base64 = true;
    mimeType = metadata.slice(0, metadata.length - ";base64".length);
  }
  const payload = source.slice(comma + 1);
  let bytes;
  if (base64) {
    // The body is percent-decoded before base64-decoding (WHATWG fetch). Only
    // ASCII can survive into the base64 alphabet, so a byte above 0x7f rejects.
    const decoded = decodePercentBytes(payload);
    let ascii = "";
    for (let i = 0; i < decoded.length; i += 1) {
      if (decoded[i] > 0x7f) throw new TypeError("fetch: invalid base64 in data: URL");
      ascii += String.fromCharCode(decoded[i]);
    }
    bytes = decodeBase64Bytes(ascii);
  } else {
    bytes = decodePercentBytes(payload);
  }
  return new Response(bytes.buffer, {
    ok: true,
    status: 200,
    statusText: "OK",
    url: source,
    headers: { "content-type": normalizeMediaType(mimeType) },
  });
}

// Fetch function - supports file://, http://, and https://
// HTTP requests are now async via libuv (non-blocking)
// Accepts either a URL string or a Request object (Three.js passes a Request).
async function fetchRequest(input, options = {}) {
  let url;
  if (input && typeof input === "object" && typeof input.url === "string") {
    // Unwrap a Request object: pull url + per-request fields unless overridden.
    url = input.url;
    if (options.signal === undefined && input.signal) options.signal = input.signal;
    if (options.method === undefined && input.method) options.method = input.method;
    if (options.headers === undefined && input.headers) options.headers = input.headers;
    if (options.body === undefined && input.body != null) options.body = input.body;
  } else {
    url = String(input);
  }

  // AbortController support: reject up-front if the signal is already aborted.
  // The native request itself cannot be cancelled mid-flight, but a late abort
  // rejects the promise (the in-flight native op simply completes and is ignored).
  const signal = options?.signal;
  const abortError = () =>
    signal && signal.reason !== undefined ? signal.reason : new Error("AbortError");
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }

  // blob: URLs - created via URL.createObjectURL(). Three.js GLTFLoader uses
  // these for embedded (GLB) and external textures, fetched by ImageBitmapLoader.
  if (url.startsWith("blob:")) {
    const blob = typeof URL !== "undefined" && URL._getBlobData ? URL._getBlobData(url) : null;
    if (!blob) {
      return new Response(new ArrayBuffer(0), {
        ok: false,
        status: 404,
        statusText: "Not Found",
        url,
      });
    }
    let data = blob._data;
    if (data instanceof Uint8Array) data = data.buffer;
    if (!(data instanceof ArrayBuffer)) data = new ArrayBuffer(0);
    return new Response(data, {
      ok: true,
      status: 200,
      statusText: "OK",
      url,
      headers: { "content-type": blob.type || "" },
    });
  }

  // data: URLs - an embedded resource, decoded here because the host has no `atob`. Image loaders
  // and asset code pass Three.js' base64 PNG lookup tables through this path.
  if (/^data:/i.test(url)) {
    return decodeDataUrl(url);
  }

  // Check URL type
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // HTTP/HTTPS request via async libcurl + libuv (non-blocking)
    const nativeOptions = { ...(options || {}) };
    if (nativeOptions.headers !== undefined && !(nativeOptions.headers instanceof Headers)) {
      nativeOptions.headers = new Headers(nativeOptions.headers);
    }
    return new Promise((resolve, reject) => {
      if (signal) signal.addEventListener("abort", () => reject(abortError()));
      __httpRequestAsync(url, nativeOptions, (result) => {
        if (result.error) {
          reject(new Error(`Fetch error: ${result.error}`));
        } else {
          resolve(
            new Response(result.data || new ArrayBuffer(0), {
              ok: result.ok,
              status: result.status,
              statusText: result.ok ? "OK" : "Error",
              url: result.url || url,
            }),
          );
        }
      });
    });
  }

  // File URL or relative path - use async file reading for non-blocking I/O
  let path = url;
  if (url.startsWith("file://")) {
    path = url;
  } else if (!url.includes("://")) {
    // Relative path - treat as file
    path = url;
  } else {
    throw new Error(`Unsupported URL scheme: ${url.split("://")[0]}`);
  }

  // Use async file reading to avoid blocking the render loop
  return new Promise((resolve, reject) => {
    if (signal) signal.addEventListener("abort", () => reject(abortError()));
    __readFileAsync(path, (data, error) => {
      if (error) {
        reject(new Error(`File read error: ${error}`));
      } else if (data === null) {
        resolve(
          new Response(new ArrayBuffer(0), {
            ok: false,
            status: 404,
            statusText: "Not Found",
            url: url,
          }),
        );
      } else {
        resolve(
          new Response(data, {
            ok: true,
            status: 200,
            statusText: "OK",
            url: url,
          }),
        );
      }
    });
  });
}

// Retain actual fetch failures from startup through the final playtest observation.
const networkEntries = [];
let networkRequests = 0;
async function fetch(input, options = {}) {
  const url = input && typeof input.url === "string" ? input.url : String(input);
  const method = options.method || input?.method || "GET";
  networkRequests++;
  try {
    const response = await fetchRequest(input, options);
    if (!response.ok && networkEntries.length <= 256) networkEntries.push({ method, url });
    return response;
  } catch (error) {
    if (networkEntries.length <= 256) networkEntries.push({ method, url });
    throw error;
  }
}
fetch.network = () => {
  if (networkEntries.length > 256) throw new Error("TN_PLAYTEST_NETWORK_OVERFLOW: more than 256 failed requests.");
  return { requests: networkRequests, entries: networkEntries.map((entry) => ({ ...entry })) };
};

// Also expose globally
globalThis.fetch = fetch;
globalThis.Response = Response;
