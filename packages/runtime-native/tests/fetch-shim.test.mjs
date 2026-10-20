import assert from "node:assert/strict";
import { test } from "vitest";
import vm from "node:vm";
import {
  createGuestContext,
  createTimers,
  extractEmbeddedJs,
  guest,
  readRuntimeCpp,
} from "./embedded-js.mjs";

// The fetch shim backs every asset load in a native game: Three.js' FileLoader
// and GLTFLoader construct Requests, pass AbortSignals, and read Responses
// through this surface. These tests eval the exact embedded block into a bare
// context (no Node globals) the way the host evals it into QuickJS/V8.

function setupFetchContext(natives = {}) {
  const timers = createTimers();
  const context = createGuestContext({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...natives });
  vm.runInContext(extractEmbeddedJs(readRuntimeCpp(), "fetchPolyfill"), context);
  return { context, timers };
}

function bytes(value) {
  return Array.from(new Uint8Array(value));
}

test("fetch polyfill installs the globals Three.js loaders require", () => {
  const { context } = setupFetchContext();
  const installed = vm.runInContext(
    `[typeof fetch, typeof Response, typeof Request, typeof Headers, typeof Blob,
      typeof AbortController, typeof AbortSignal, typeof TextEncoder, typeof TextDecoder]`,
    context,
  );
  assert.deepEqual(guest(installed), [
    "function", "function", "function", "function", "function",
    "function", "function", "function", "function",
  ]);
});

test("TextEncoder/TextDecoder round-trip multi-byte UTF-8", () => {
  const { context } = setupFetchContext();
  const roundTrip = vm.runInContext(
    `(() => {
      const text = "héllo — 中文字 🎮";
      const bytes = new TextEncoder().encode(text);
      const decoded = new TextDecoder().decode(bytes);
      return [decoded === text, bytes.length > text.length];
    })()`,
    context,
  );
  assert.deepEqual(guest(roundTrip), [true, true]);
});

test("existing engine globals are not overwritten by the shims", () => {
  // V8 desktop ships TextDecoder natively; the guards must leave it alone.
  const source = readRuntimeCpp();
  const block = extractEmbeddedJs(source, "fetchPolyfill");
  assert.match(block, /if \(typeof TextDecoder === ["']undefined["']\)/u);
  assert.match(block, /if \(typeof TextEncoder === ["']undefined["']\)/u);
  assert.match(block, /if \(typeof AbortSignal === ["']undefined["']\)/u);
});

test("AbortController signals fire listeners exactly once and throwIfAborted carries the reason", async () => {
  const { context } = setupFetchContext();
  const result = await vm.runInContext(
    `(async () => {
      const controller = new AbortController();
      let fires = 0;
      controller.signal.addEventListener("abort", () => { fires += 1; });
      try { controller.signal.throwIfAborted(); } catch { throw new Error("threw before abort"); }
      controller.abort(new Error("game requested"));
      controller.abort(); // second abort is a no-op
      let caught;
      try { controller.signal.throwIfAborted(); } catch (e) { caught = e; }
      return {
        aborted: controller.signal.aborted,
        fires,
        reason: caught && caught.message,
        listenerReason: controller.signal.reason.message,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    aborted: true,
    fires: 1,
    reason: "game requested",
    listenerReason: "game requested",
  });
});

test("Headers are case-insensitive and iterate lowercase keys like the Web API", () => {
  const { context } = setupFetchContext();
  const result = vm.runInContext(
    `(() => {
      const headers = new Headers({ "Content-Type": "model/gltf-binary" });
      headers.set("ACCEPT", "*/*");
      const fromArray = new Headers([["x-one", "1"], ["X-One", "2"]]);
      const entries = [];
      headers.forEach((value, key) => entries.push(key + "=" + value));
      return {
        get: headers.get("content-type"),
        mixedGet: headers.get("CONTENT-TYPE"),
        has: headers.has("accept"),
        lastWriteWins: fromArray.get("x-one"),
        entries,
        missingIsNull: headers.get("nope") === null,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    get: "model/gltf-binary",
    mixedGet: "model/gltf-binary",
    has: true,
    lastWriteWins: "2",
    entries: ["content-type=model/gltf-binary", "accept=*/*"],
    missingIsNull: true,
  });
});

test("Response decodes body through text/json/arrayBuffer/blob", async () => {
  const { context } = setupFetchContext();
  const payload = JSON.stringify({ name: "abyss", depth: 42 });
  context.__payloadText = payload;
  const result = await vm.runInContext(
    `(async () => {
      const response = new Response(new TextEncoder().encode(__payloadText).buffer);
      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        json: await new Response(new TextEncoder().encode(text).buffer).json(),
        emptyBlobSize: (await new Response(new ArrayBuffer(0)).blob()).size,
        blobText: await (await response.blob()).text(),
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result).json, { name: "abyss", depth: 42 });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.emptyBlobSize, 0);
  assert.equal(result.blobText, payload);
});

test("Request carries url/method/headers/signal and unwraps a prior Request", () => {
  const { context } = setupFetchContext();
  const controller = new AbortController();
  context.__probeSignal = controller.signal;
  const result = vm.runInContext(
    `(() => {
      const fromUrl = new Request("models/ship.glb", {
        method: "POST", headers: { "x-game": "yes" }, signal: __probeSignal,
      });
      const rewrapped = new Request(fromUrl, { method: "PUT" });
      return {
        method: fromUrl.method,
        header: fromUrl.headers.get("x-game"),
        signalKept: rewrapped.signal === __probeSignal,
        rewrappedMethod: rewrapped.method,
        sameOrigin: fromUrl.credentials,
        bodyDefaultsNull: fromUrl.body === null,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    method: "POST",
    header: "yes",
    signalKept: true,
    rewrappedMethod: "PUT",
    sameOrigin: "same-origin",
    bodyDefaultsNull: true,
  });
});

test("file fetch resolves 200 on data, 404 on null, and rejects on native error", async () => {
  const calls = [];
  const { context } = setupFetchContext({
    __readFileAsync: (path, callback) => {
      calls.push(path);
      // Shim semantics: a null data with no error string means "not found"
      // and becomes a 404 Response; any truthy error string rejects instead.
      if (path === "assets/missing.glb") callback(null, null);
      else if (path === "assets/broken.glb") callback(undefined, "io failure");
      else callback(new ArrayBuffer(3), undefined);
    },
  });

  const good = await vm.runInContext(`fetch("assets/ship.glb")`, context);
  assert.deepEqual(bytes(good._data), [0, 0, 0]);
  assert.equal(good.ok, true);

  const missing = await vm.runInContext(`fetch("assets/missing.glb")`, context);
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);

  await assert.rejects(
    vm.runInContext(`fetch("assets/broken.glb")`, context),
    /File read error: io failure/u,
  );
  assert.deepEqual(calls, ["assets/ship.glb", "assets/missing.glb", "assets/broken.glb"]);
});

test("pre-aborted signal rejects fetch before any native call is made", async () => {
  let nativeCalls = 0;
  const { context } = setupFetchContext({
    __readFileAsync: () => { nativeCalls += 1; },
  });
  context.__makeAborted = () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    return controller.signal;
  };
  await assert.rejects(
    vm.runInContext(`fetch("assets/ship.glb", { signal: __makeAborted() })`, context),
    /cancelled/u,
  );
  assert.equal(nativeCalls, 0);
});

test("aborting mid-flight rejects the pending fetch promise", async () => {
  const { context } = setupFetchContext({
    __readFileAsync: (_path, callback) => {
      // Native op completes later; the late abort must still reject the game's promise.
      setTimeout(() => callback(new ArrayBuffer(1), undefined), 0);
    },
  });
  const outcome = await vm.runInContext(
    `(async () => {
      const controller = new AbortController();
      const pending = fetch("assets/ship.glb", { signal: controller.signal });
      controller.abort();
      try {
        await pending;
        return "resolved";
      } catch (e) {
        return e.message;
      }
    })()`,
    context,
  );
  assert.equal(outcome, "AbortError");
});

test("http fetch surfaces status fields and unwraps a Request for the native bridge", async () => {
  const seen = [];
  const { context } = setupFetchContext({
    __httpRequestAsync: (url, options, callback) => {
      seen.push({
        headers: options.headers?.entries ? Array.from(options.headers.entries()) : null,
        method: options.method,
        url,
      });
      if (url.includes("down")) callback({ error: "connection refused" });
      else callback({ ok: true, status: 200, url, data: new ArrayBuffer(4) });
    },
  });

  const response = await vm.runInContext(`fetch("https://cdn.example/ship.glb")`, context);
  assert.equal(response.ok, true);
  await vm.runInContext(
    `fetch("https://cdn.example/auth", {
      method: "POST", headers: { Authorization: "Bearer token" }, body: "{}",
    })`,
    context,
  );
  assert.equal(response.status, 200);

  // Three.js r168+ passes a Request object, not a URL string.
  const viaRequest = await vm.runInContext(
    `fetch(new Request("https://cdn.example/tracks.glb", { method: "GET" }))`,
    context,
  );
  assert.equal(viaRequest.status, 200);
  assert.deepEqual(guest(seen.slice(0, 3)), [
    { headers: null, url: "https://cdn.example/ship.glb" },
    { headers: [["authorization", "Bearer token"]], method: "POST", url: "https://cdn.example/auth" },
    { headers: [], method: "GET", url: "https://cdn.example/tracks.glb" },
  ]);

  await assert.rejects(
    vm.runInContext(`fetch("https://cdn.example/down")`, context),
    /Fetch error: connection refused/u,
  );
});

test("fallback TextDecoder: fatal throws, nonfatal replaces, splits and offsets decode", () => {
  const { context } = setupFetchContext();
  const result = vm.runInContext(
    `(() => {
      const malformed = new Uint8Array([0xff, 0xfe]);
      let fatalThrew = null;
      try { new TextDecoder("utf-8", { fatal: true }).decode(malformed); }
      catch (e) { fatalThrew = e instanceof TypeError ? e.name : String(e && e.name); }
      const replaced = new TextDecoder().decode(malformed);
      // valid split multibyte sequence across streaming chunks ("é" = U+00E9)
      const streaming = new TextDecoder();
      const first = streaming.decode(new Uint8Array([0xc3]), { stream: true });
      const second = streaming.decode(new Uint8Array([0xa9]));
      // ArrayBuffer views must honor byteOffset/byteLength
      const backing = new Uint8Array([0x00, 0x68, 0x69, 0x00]);
      const view = new Uint8Array(backing.buffer, 1, 2);
      const offset = new TextDecoder().decode(view);
      // unsupported encodings/options reject honestly
      let badLabel = null;
      try { new TextDecoder("utf-16"); } catch (e) { badLabel = e instanceof RangeError ? "RangeError" : String(e && e.name); }
      let badOption = null;
      try { new TextDecoder("utf-8", { fatal: true }).decode("nope"); } catch (e) { badOption = "threw"; }
      return {
        fatalThrew, replaced, first, second,
        offset, badLabel, badOption,
        fatalFlag: new TextDecoder("utf-8", { fatal: true }).fatal,
        encoding: new TextDecoder().encoding,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    fatalThrew: "TypeError",
    replaced: "��",
    first: "",
    second: "é",
    offset: "hi",
    badLabel: "RangeError",
    badOption: "threw",
    fatalFlag: true,
    encoding: "utf-8",
  });
});

// Three.js' SMAANode carries its two lookup tables as embedded base64 PNG data URIs; a native
// host has no `atob`, so the fetch shim must decode the standard `data:` form byte-exactly.
const SMAA_SEARCH_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEIAAAAhCAAAAABIXyLAAAAAOElEQVRIx2NgGAWjYBSMglEwEICREYRgFBZBqDCSLA2MGPUIVQETE9iNUAqLR5gIeoQKRgwXjwAAGn4AtaFeYLEAAAAASUVORK5CYII=";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

test("data: URL fetch decodes base64 bytes exactly and keeps the media type", async () => {
  const { context } = setupFetchContext();
  context.__png = SMAA_SEARCH_PNG;
  const result = await vm.runInContext(
    `(async () => {
      const response = await fetch("data:image/png;base64," + __png);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type"),
        signature: Array.from(bytes.slice(0, 8)),
        length: bytes.length,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    ok: true,
    status: 200,
    contentType: "image/png",
    signature: PNG_SIGNATURE,
    length: Buffer.from(SMAA_SEARCH_PNG, "base64").length,
  });
});

test("data: URL fetch percent-decodes text and bytes and applies the default media type", async () => {
  const { context } = setupFetchContext();
  const result = await vm.runInContext(
    `(async () => {
      const text = await fetch("data:text/plain,hello%20world%21");
      const binary = await fetch("data:application/octet-stream,%00%01%FE");
      const defaulted = await fetch("data:,plain");
      return {
        text: await text.text(),
        textType: text.headers.get("content-type"),
        binary: Array.from(new Uint8Array(await binary.arrayBuffer())),
        defaulted: await defaulted.text(),
        defaultedType: defaulted.headers.get("content-type"),
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    text: "hello world!",
    textType: "text/plain",
    binary: [0, 1, 254],
    defaulted: "plain",
    defaultedType: "text/plain;charset=US-ASCII",
  });
});

test("data: URL fetch accepts empty payloads and rejects malformed input", async () => {
  const { context } = setupFetchContext();
  const result = await vm.runInContext(
    `(async () => {
      const emptyBase64 = await fetch("data:image/png;base64,");
      const emptyPlain = await fetch("data:text/plain,");
      return {
        emptyBase64: (await emptyBase64.arrayBuffer()).byteLength,
        emptyPlain: (await emptyPlain.arrayBuffer()).byteLength,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), { emptyBase64: 0, emptyPlain: 0 });

  for (const url of [
    "data:image/png;base64,@@@@",
    "data:image/png;base64,AAAA====",
    "data:image/png;base64,=AAA",
    "data:image/png;base64,A",
    "data:text/plain,%ZZ",
    "data:text/plain,%A",
  ])
    await assert.rejects(vm.runInContext(`fetch(${JSON.stringify(url)})`, context));

  // A malformed data URL is a real failure, not a 200 with truncated bytes.
  const observation = await vm.runInContext("fetch.network()", context);
  assert.equal(observation.entries.length, 6);
});

// The standalone forgiving-base64 algorithm (WHATWG infra) plus the data: URL
// processor (WHATWG fetch) define what the platform returns for these bounded
// fixtures: base64 with remainder 2 or 3 is valid unpadded, the body is
// percent-decoded before it is base64-decoded, and a raw URL fragment is not
// part of the body. Node's own fetch is the independent oracle, so the shim
// cannot grade its own output.
const FORGIVING_DATA_URLS = [
  "data:;base64,TWE",
  "data:;base64,AAA",
  "data:;base64,AA",
  "data:;base64,AAAA",
  "data:;base64,T%57E=",
  "data:;base64,AAA%3D",
  "data:;base64,",
  "data:image/png;base64,iVBORw0KGgo=",
  "data:,body#fragment",
  "data:text/plain,%23hash",
  "data:;charset=UTF-8,hi",
];

test("data: URL fetch matches the platform for forgiving base64, percent-decoded bodies and fragments", async () => {
  const { context } = setupFetchContext();
  context.__urls = FORGIVING_DATA_URLS;
  const shim = await vm.runInContext(
    `(async () => {
      const out = [];
      for (const url of __urls) {
        const response = await fetch(url);
        out.push({
          contentType: response.headers.get("content-type"),
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        });
      }
      return out;
    })()`,
    context,
  );
  const oracle = [];
  for (const url of FORGIVING_DATA_URLS) {
    const response = await fetch(url);
    oracle.push({
      contentType: response.headers.get("content-type"),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
    });
  }
  assert.deepEqual(guest(shim), oracle);
});

test("unsupported URL schemes reject instead of falling through to file reads", async () => {
  const { context } = setupFetchContext({
    __readFileAsync: () => { throw new Error("must not be reached"); },
  });
  await assert.rejects(
    vm.runInContext(`fetch("ftp://cdn.example/ship.glb")`, context),
    /Unsupported URL scheme: ftp/u,
  );
});

test("native fetch network observation records real HTTP and asset failures", async () => {
  const { context } = setupFetchContext({
    __httpRequestAsync: (url, _options, callback) => callback(
      url.endsWith("/reject") ? { error: "connection refused" }
        : { ok: !url.endsWith("/404"), status: url.endsWith("/404") ? 404 : 200, url },
    ),
    __readFileAsync: (_path, callback) => callback(null, "missing asset"),
  });
  const observation = await vm.runInContext(`(async () => {
    await fetch("https://host/ok");
    await fetch(new Request("https://host/404", { method: "POST" }));
    await fetch("https://host/reject").catch(() => {});
    await fetch("missing.bin").catch(() => {});
    return fetch.network();
  })()`, context);
  assert.deepEqual(guest(observation), { requests: 4, entries: [
    { method: "POST", url: "https://host/404" },
    { method: "GET", url: "https://host/reject" },
    { method: "GET", url: "missing.bin" },
  ] });
  assert.match(readRuntimeCpp(), /setProperty\(playtestMailbox, "network"/u);
});

test("native fetch network observation fails closed on overflow and protects its retained entries", async () => {
  const { context } = setupFetchContext({
    __httpRequestAsync: (_url, _options, callback) => callback({ ok: false, status: 500 }),
  });
  await vm.runInContext(`(async () => {
    await fetch("https://host/error");
    fetch.network().entries.length = 0;
  })()`, context);
  assert.equal(vm.runInContext("fetch.network().entries.length", context), 1);
  await vm.runInContext(`(async () => {
    for (let i = 0; i < 256; i++) await fetch("https://host/error");
  })()`, context);
  assert.throws(() => vm.runInContext("fetch.network()", context), /NETWORK.*OVERFLOW/u);
});
