import assert from "node:assert/strict";
import { test } from "vitest";
import vm from "node:vm";
import {
  createGuestContext,
  createRecordingConsole,
  createTimers,
  guest,
  readRuntimeScript,
} from "./embedded-js.mjs";

// URL/URLSearchParams and the standard Worker facade over the native worker
// registry. This test deliberately mocks only the native boundary: worker
// source must never be evaluated in the game isolate.

function setupUrlWorkerContext(natives = {}) {
  const timers = createTimers();
  const consoleShim = createRecordingConsole();
  const context = createGuestContext({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: consoleShim,
    ...natives,
  });
  // All blocks land in one global, as in RuntimeImpl; the event constructors
  // are included because the Worker polyfill's failed-load path constructs an
  // ErrorEvent when its deferred callback fires.
  vm.runInContext(readRuntimeScript("fetch-polyfill"), context);
  vm.runInContext(readRuntimeScript("streams-polyfill"), context);
  vm.runInContext(readRuntimeScript("url-worker-polyfill"), context);
  vm.runInContext(readRuntimeScript("event-constructors-setup"), context);
  return { context, timers };
}

test("URL parses protocol, authority, port, path, query and hash", () => {
  const { context } = setupUrlWorkerContext();
  const result = vm.runInContext(
    `(() => {
      const url = new URL("https://cdn.example:8443/assets/models/ship.glb?v=3#lod");
      return {
        protocol: url.protocol,
        host: url.host,
        hostname: url.hostname,
        port: url.port,
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
        origin: url.origin,
        href: url.href,
        queryParam: url.searchParams.get("v"),
        stringifies: String(url) === url.href,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    protocol: "https:",
    host: "cdn.example:8443",
    hostname: "cdn.example",
    port: "8443",
    pathname: "/assets/models/ship.glb",
    search: "?v=3",
    hash: "#lod",
    origin: "https://cdn.example:8443",
    href: "https://cdn.example:8443/assets/models/ship.glb?v=3#lod",
    queryParam: "3",
    stringifies: true,
  });
});

test("relative URLs resolve against a base like GLTFLoader resource paths", () => {
  const { context } = setupUrlWorkerContext();
  const result = vm.runInContext(
    `(() => {
      const base = new URL("https://game.example/assets/scene.gltf");
      return {
        sibling: new URL("textures/hull.png", base).href,
        rootRelative: new URL("/shared/env.hdr", base).href,
        absoluteWins: new URL("https://other.example/x.bin", base).href,
        baseQueryIgnored: new URL("mesh.bin", "https://game.example/a/b.glb?token=x").href,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    sibling: "https://game.example/assets/textures/hull.png",
    rootRelative: "https://game.example/shared/env.hdr",
    absoluteWins: "https://other.example/x.bin",
    baseQueryIgnored: "https://game.example/a/mesh.bin",
  });
});

test("URLSearchParams round-trips encoding and mutates in place", () => {
  const { context } = setupUrlWorkerContext();
  const result = vm.runInContext(
    `(() => {
      const params = new URLSearchParams("a=1&flag&b=hello%20world");
      params.set("a", "2");     // replaces every occurrence of a
      params.append("a", "3");  // appends a duplicate
      params.delete("flag");
      const entries = [...params.entries()];
      const fromObject = new URLSearchParams({ key: "val ue" });
      return {
        getA: params.get("a"),
        flagGone: params.has("flag"),
        entries,
        serialized: params.toString(),
        objectInit: fromObject.toString(),
        missingNull: params.get("nope") === null,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    getA: "2",
    flagGone: false,
    entries: [["a", "2"], ["b", "hello world"], ["a", "3"]],
    serialized: "a=2&b=hello%20world&a=3",
    objectInit: "key=val%20ue",
    missingNull: true,
  });
});

function createNativeWorkerHarness() {
  let nextId = 1;
  const created = [];
  const posted = [];
  const terminated = [];
  return {
    natives: {
      __tnNativeWorkerCreate(source) {
        created.push(source);
        return nextId++;
      },
      __tnNativeWorkerPost(id, payload) {
        posted.push({ id, payload });
        return true;
      },
      __tnNativeWorkerTerminate(id) {
        terminated.push(id);
      },
    },
    created,
    posted,
    terminated,
  };
}

function makeWorker(context, script, options = undefined) {
  const blobUrl = vm.runInContext(
    `URL.createObjectURL(new Blob([${JSON.stringify(script)}]))`,
    context,
  );
  return vm.runInContext(
    `new Worker("${blobUrl}"${options ? `, ${JSON.stringify(options)}` : ""})`,
    context,
  );
}

test("classic Blob worker source and messages cross only the native boundary", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupUrlWorkerContext(harness.natives);
  const source = `throw new Error("must not execute in the game isolate");`;
  const worker = makeWorker(context, source);
  const received = [];
  worker.onmessage = (event) => received.push(event.data);

  worker.postMessage({ value: 2 });
  vm.runInContext(`__tnNativeWorkerDispatch(1, 0, '{"echo":2}')`, context);

  assert.deepEqual(harness.created, [source]);
  assert.deepEqual(harness.posted, [{ id: 1, payload: '{"value":2}' }]);
  assert.deepEqual(guest(received), [{ echo: 2 }]);
});

test("terminate crosses the native boundary and suppresses late callbacks", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupUrlWorkerContext(harness.natives);
  const worker = makeWorker(context, `postMessage("late");`);
  const received = [];
  worker.onmessage = (event) => received.push(event.data);

  worker.terminate();
  vm.runInContext(`__tnNativeWorkerDispatch(1, 0, '"late"')`, context);

  assert.deepEqual(harness.terminated, [1]);
  assert.deepEqual(guest(received), []);
});

test("missing native worker callbacks fail closed without inline evaluation", () => {
  const { context } = setupUrlWorkerContext();
  const result = vm.runInContext(
    `(() => {
      const url = URL.createObjectURL(new Blob(['globalThis.inlineFallbackRan = true']));
      try { new Worker(url); } catch (error) {
        return { name: error.name, message: error.message, inlineFallbackRan: globalThis.inlineFallbackRan === true };
      }
    })()`,
    context,
  );

  assert.deepEqual(guest(result), {
    name: "NotSupportedError",
    message: "TN_NATIVE_WORKER_UNAVAILABLE: native worker sources were not linked",
    inlineFallbackRan: false,
  });
});

test("Phase 1 rejects module and non-Blob worker sources by stable names", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupUrlWorkerContext(harness.natives);
  const result = vm.runInContext(
    `(() => {
      const blob = URL.createObjectURL(new Blob(['postMessage(1)']));
      const capture = (factory) => { try { factory(); } catch (error) { return error.message; } };
      return {
        module: capture(() => new Worker(blob, { type: 'module' })),
        external: capture(() => new Worker('worker.js')),
      };
    })()`,
    context,
  );

  assert.deepEqual(guest(result), {
    module: "TN_NATIVE_WORKER_MODULE_UNSUPPORTED: module workers are not supported",
    external: "TN_NATIVE_WORKER_URL_UNSUPPORTED: native workers support classic Blob URLs only",
  });
});
