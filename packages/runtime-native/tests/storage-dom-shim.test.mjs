import assert from "node:assert/strict";
import { test } from "vitest";
import vm from "node:vm";
import {
  createGuestContext,
  createRecordingConsole,
  guest,
  readRuntimeScript,
} from "./embedded-js.mjs";

// Storage and the document.createElement stubs. localStorage is the persistence
// surface framework code may use on native; sessionStorage is documented as
// memory-only. createElement('canvas') is what @loaders.gl probes for WebP
// support, so its shape is part of the host contract too.

function makeNativeStorageRecorder() {
  const calls = [];
  const backing = new Map();
  return {
    calls,
    natives: {
      __storageGetItem: (key) => {
        calls.push(["get", key]);
        return backing.has(key) ? backing.get(key) : null;
      },
      __storageSetItem: (key, value) => {
        calls.push(["set", key, value]);
        backing.set(key, value);
      },
      __storageRemoveItem: (key) => {
        calls.push(["remove", key]);
        backing.delete(key);
      },
      __storageClear: () => {
        calls.push(["clear"]);
        backing.clear();
      },
      __storageKey: (index) => {
        calls.push(["key", index]);
        return [...backing.keys()][index] ?? null;
      },
      __storageLength: () => {
        calls.push(["length"]);
        return backing.size;
      },
    },
  };
}

function setupStorageContext(natives = {}) {
  const context = createGuestContext(natives);
  vm.runInContext(readRuntimeScript("storage-polyfill"), context);
  return context;
}

test("localStorage persists through the native storage bindings", () => {
  const { natives, calls } = makeNativeStorageRecorder();
  const context = setupStorageContext(natives);
  vm.runInContext(
    `(() => {
      localStorage.setItem("progress", "depth-42");
      localStorage.setItem("progress", "depth-43"); // overwrite
      return [
        localStorage.getItem("progress"),
        localStorage.getItem("never-set"),
        localStorage.length,
        localStorage.key(0),
      ];
    })()`,
    context,
  );
  assert.equal(vm.runInContext(`localStorage.getItem("progress")`, context), "depth-43");
  assert.equal(vm.runInContext(`localStorage.getItem("never-set")`, context), null);
  assert.equal(vm.runInContext(`localStorage.length`, context), 1);
  assert.deepEqual(calls.filter(([op]) => op === "set"), [
    ["set", "progress", "depth-42"],
    ["set", "progress", "depth-43"],
  ]);
});

test("sessionStorage is memory-backed with list ordering for key()", () => {
  const context = setupStorageContext();
  const result = vm.runInContext(
    `(() => {
      sessionStorage.setItem("a", "1");
      sessionStorage.setItem("b", "2");
      sessionStorage.setItem("c", "3");
      sessionStorage.removeItem("b");
      const keysAfterRemove = [sessionStorage.key(0), sessionStorage.key(1), sessionStorage.key(2)];
      sessionStorage.clear();
      return { keysAfterRemove, lengthAfterClear: sessionStorage.length };
    })()`,
    context,
  );
  assert.deepEqual(guest(result).keysAfterRemove, ["a", "c", null]);
  assert.equal(guest(result).lengthAfterClear, 0);
});

test("Proxy bracket access reads through getItem and writes through setItem", () => {
  const { natives } = makeNativeStorageRecorder();
  const context = setupStorageContext(natives);
  // Sloppy-mode assignment: the set trap returns false for method names, which
  // throws only under strict mode. Games run sloppy by default.
  const result = vm.runInContext(
    `(() => {
      localStorage["shield"] = "mk2";       // set trap
      const viaBracket = localStorage["shield"];
      const viaProperty = localStorage.shield;
      let methodOverwrite = "no-error";
      try { localStorage.getItem = function() { return "hijacked"; }; } catch (e) { methodOverwrite = "threw"; }
      delete localStorage.shield;            // delete trap routes to removeItem
      return {
        viaBracket,
        viaProperty,
        stillNative: typeof localStorage.getItem === "function" && localStorage.getItem("shield"),
        methodOverwrite,
        goneAfterDelete: localStorage.getItem("shield"),
      };
    })()`,
    context,
  );
  assert.equal(guest(result).viaBracket, "mk2");
  assert.equal(guest(result).viaProperty, "mk2");
  assert.equal(guest(result).methodOverwrite, "no-error");
  assert.equal(guest(result).stillNative, null); // getItem works; key deleted below
  assert.equal(guest(result).goneAfterDelete, null);
});

test("keys and values are coerced through String() like a browser storage", () => {
  const context = setupStorageContext();
  const result = vm.runInContext(
    `(() => {
      sessionStorage.setItem(42, true);
      return [sessionStorage.getItem("42"), typeof sessionStorage.getItem("42"), sessionStorage.key(0)];
    })()`,
    context,
  );
  assert.deepEqual(guest(result), ["true", "string", "42"]);
});

function setupDocumentContext(natives = {}, globals = {}) {
  const consoleShim = createRecordingConsole();
  const context = createGuestContext({
    document: { createElement: () => { throw new Error("createElement must be replaced"); } },
    console: consoleShim,
    ...natives,
    ...globals,
  });
  vm.runInContext(readRuntimeScript("create-element-setup"), context);
  return { context, consoleShim };
}

test("createElement returns the stub shapes Three.js compatibility requires", () => {
  const { context } = setupDocumentContext({
    __nativeCanvasToDataURL: (mime) => `data:${mime};base64,AAAA`,
  });
  const result = vm.runInContext(
    `(() => {
      const canvas = document.createElement("canvas");
      const script = document.createElement("script");
      const style = document.createElement("style");
      const div = document.createElement("div");
      const unknown = document.createElement("video");
      return {
        canvas: [canvas.tagName, canvas.width, canvas.height],
        canvasHasNoContext: canvas.getContext("2d") === null,
        canvasDataUrl: canvas.toDataURL("image/webp").startsWith("data:image/webp"),
        script: [script.tagName, typeof script.onload],
        styleType: style.type,
        divTag: div.tagName,
        unknownUpper: unknown.tagName,
        nsDelegates: document.createElementNS("http://www.w3.org/2000/svg", "canvas").tagName,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result).canvas, ["CANVAS", 64, 64]);
  assert.equal(guest(result).canvasHasNoContext, true);
  assert.equal(guest(result).canvasDataUrl, true);
  assert.deepEqual(guest(result).script, ["SCRIPT", "object"]); // onload: null
  assert.equal(guest(result).styleType, "text/css");
  assert.equal(guest(result).divTag, "DIV");
  assert.equal(guest(result).unknownUpper, "VIDEO");
  assert.equal(guest(result).nsDelegates, "CANVAS");
});

test("imageSupportInit probes WebP once without throwing when decoding is absent", () => {
  // The native toDataURL returns PNG (no WebP decoder): the probe logs NO.
  const noWebp = setupDocumentContext({
    __nativeCanvasToDataURL: () => "data:image/png;base64,AAAA",
  });
  vm.runInContext(readRuntimeScript("image-support-init"), noWebp.context);
  assert.ok(
    noWebp.consoleShim.lines.some((line) => line.includes("WebP format support: NO")),
    JSON.stringify(noWebp.consoleShim.lines),
  );

  const brokenCanvas = setupDocumentContext({
    __nativeCanvasToDataURL: () => { throw new Error("decoder missing"); },
  });
  assert.doesNotThrow(() =>
    vm.runInContext(readRuntimeScript("image-support-init"), brokenCanvas.context),
  );
  assert.ok(
    brokenCanvas.consoleShim.lines.some((line) => line.includes("[Mystral] Error checking image format support")),
  );
});
