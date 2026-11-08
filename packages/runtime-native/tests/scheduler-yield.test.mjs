// Does the host give three.js a cooperative yield, instead of a whole rendered frame?
//
// `three`'s `yieldToMain()` (src/utils.js) is:
//
//     if ( typeof self !== 'undefined' && typeof self.scheduler !== 'undefined'
//          && typeof self.scheduler.yield !== 'undefined' ) return self.scheduler.yield();
//     return new Promise( resolve => { requestAnimationFrame( resolve ); } );
//
// `NodeBuilder.buildAsync()` awaits that once per node, and the render path's deferred build queue
// (`NodeManager.getForRenderDeferred` -> `_processBuildQueue` -> `getForRenderAsync`) goes through
// the same call. This runtime shimmed `self` years ago and never shimmed `scheduler`, so the probe
// always failed and every async node build cost **one fully rendered frame** — 50 ms and up during
// play on a Pixel 8, paid per node, which is what a player feels when a new material first appears.
//
// These assertions execute the installer exactly as the runtime ships it: the script is read from
// `src/runtime-scripts/scheduler-yield.js` rather than retyped, so a test cannot pass against a
// copy that has drifted from the source. That is the whole point — a hand-copied snippet would
// keep passing after someone edited the real one. That the host loads the script is proved by
// running it: `tests/shim_bootstrap_test.cpp` probes `scheduler.yield` on a booted Runtime.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Reads the installer as it ships. */
function installerSource() {
  return readFileSync(join(root, "src/runtime-scripts/scheduler-yield.js"), "utf8");
}

/** Builds a fake global scope, installs the shim into it, and returns the scope. */
function install(scope = {}) {
  scope.globalThis = scope;
  scope.self = scope;
  scope.setTimeout = setTimeout;
  scope.Promise = Promise;
  // The installer closes over `globalThis`, so it is evaluated with the fake scope bound to that
  // name rather than the real one — otherwise the test would shim the test runner.
  const factory = new Function("globalThis", `return (${installerSource()});`)(scope);
  const ok = factory((callback) => setTimeout(callback, 0));
  return { scope, ok };
}

test("the runtime installs scheduler.yield so three stops burning a frame per node build", () => {
  const { scope, ok } = install();
  assert.equal(ok, true, "the installer reports success");
  assert.equal(typeof scope.scheduler.yield, "function");
  // three probes `self.scheduler`, not `globalThis.scheduler`. `self` is an alias of the global on
  // this host, so both must see the same object; asserting only the latter would pass while three
  // still took the requestAnimationFrame path.
  assert.equal(scope.self.scheduler, scope.scheduler);
});

test("three's yieldToMain takes the scheduler path once the shim is installed", async () => {
  // The real function, copied in shape from three/src/utils.js, run against the shimmed scope.
  const yieldToMain = (self) => {
    if (
      typeof self !== "undefined" &&
      typeof self.scheduler !== "undefined" &&
      typeof self.scheduler.yield !== "undefined"
    ) {
      return self.scheduler.yield();
    }
    return new Promise((resolve) => self.requestAnimationFrame(resolve));
  };

  // Without the shim: a frame is requested, which on the device is a full render.
  const frames = [];
  const bare = { requestAnimationFrame: (callback) => frames.push(callback) };
  bare.self = bare;
  void yieldToMain(bare);
  assert.equal(frames.length, 1, "the unshimmed host still costs a rendered frame");

  // With it: no frame is requested at all, and the yield resolves on its own.
  const { scope } = install({
    requestAnimationFrame: () => assert.fail("must not request a frame once scheduler.yield exists"),
  });
  await yieldToMain(scope);
});

test("scheduler.yield resolves on a macrotask, not a microtask", async () => {
  // A microtask would drain without ever letting the loop run, which defeats the reason three
  // calls it: the point is to give the host a chance to render and read input between node builds.
  const { scope } = install();
  const order = [];
  const yielded = scope.scheduler.yield().then(() => order.push("yield"));
  await Promise.resolve().then(() => order.push("microtask"));
  await yielded;
  assert.deepEqual(order, ["microtask", "yield"]);
});

test("an existing scheduler implementation is left alone", () => {
  // A host or polyfill that already provides the real API must keep it; overwriting a genuine
  // scheduler with a setTimeout would be a downgrade wearing the same name.
  const real = { yield: () => Promise.resolve("real") };
  const { scope, ok } = install({ scheduler: real });
  assert.equal(ok, true);
  assert.equal(scope.scheduler, real);
  assert.equal(scope.scheduler.yield, real.yield);
});

test("a scheduler object without yield is completed rather than replaced", () => {
  // `scheduler.postTask` without `scheduler.yield` is a real browser state. Filling in the missing
  // method must not discard the methods that were already there.
  const postTask = () => Promise.resolve();
  const { scope } = install({ scheduler: { postTask } });
  assert.equal(scope.scheduler.postTask, postTask);
  assert.equal(typeof scope.scheduler.yield, "function");
});

test("the shim is recorded in the host-surface manifest", () => {
  // Every global this runtime installs is a contract with the TypeScript side, and the manifest is
  // the enforced inventory rather than a second prose list.
  const manifest = JSON.parse(readFileSync(join(root, "shim-manifest.json"), "utf8"));
  const entry = manifest.shims.find((shim) => shim.name === "scheduler");
  assert.ok(entry, "shim-manifest.json must record the scheduler global");
  assert.match(entry.evidence, /runtime-scripts\/scheduler-yield\.js/u);
});
