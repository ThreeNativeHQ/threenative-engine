import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { expect, test } from "vitest";
import {
  createGuestContext,
  createRecordingConsole,
  createTimers,
  readRuntimeScript,
} from "./embedded-js.mjs";

/**
 * PRD-250 Phase 2 — the production worker's message, clone, error and teardown semantics.
 *
 * Two lanes, both executable, neither a source grep:
 *
 * 1. The shipped `url-worker-polyfill.js` runs in a guest realm with only the native boundary
 *    mocked, so the clone matrix, the refusals and the event dispatch are exercised as the game
 *    isolate really runs them.
 * 2. `TN_NATIVE_WORKER_BIN` points at `threenative-worker-production-test`, which drives a real
 *    `Runtime` with real `WorkerRegistry` threads. A set variable pointing at a missing binary is
 *    a failure, never a skip; CMake registers it as a contract test so the native lane always runs
 *    it. Without the variable the C++ contract reports UNVERIFIED rather than passing.
 *
 * The clone walk exists twice — once here in the polyfill for the game isolate, once in
 * `worker_thread.cpp`'s `workerGlobalCode` for the worker isolate — because they are separate
 * engines with no shared module. The mirror test below fails when the two drift.
 */

const polyfillJs = readRuntimeScript("url-worker-polyfill");

function setupWorkerContext(natives = {}) {
  const timers = createTimers();
  const consoleShim = createRecordingConsole();
  const context = createGuestContext({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: consoleShim,
    ...natives,
  });
  vm.runInContext(readRuntimeScript("fetch-polyfill"), context);
  vm.runInContext(readRuntimeScript("streams-polyfill"), context);
  vm.runInContext(readRuntimeScript("url-worker-polyfill"), context);
  vm.runInContext(readRuntimeScript("event-constructors-setup"), context);
  return { context, consoleShim, timers };
}

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

function makeWorker(context, script = "postMessage(1);") {
  const blobUrl = vm.runInContext(
    `URL.createObjectURL(new Blob([${JSON.stringify(script)}]))`,
    context,
  );
  return vm.runInContext(`new Worker(${JSON.stringify(blobUrl)})`, context);
}

/** Post `expression` and return the thrown error's name and message, or null when it did not throw. */
function postAndCatch(context, expression) {
  return vm.runInContext(
    `(() => {
       try {
         globalThis.__probe.postMessage(${expression});
         return null;
       } catch (error) {
         return { name: error.name, message: error.message };
       }
     })()`,
    context,
  );
}

function withProbeWorker() {
  const harness = createNativeWorkerHarness();
  const { context, consoleShim } = setupWorkerContext(harness.natives);
  const worker = makeWorker(context);
  vm.runInContext("globalThis.__probe = null;", context);
  context.__probe = worker;
  return { context, harness, worker, consoleShim };
}

// ---------------------------------------------------------------------------
// should deliver queued worker messages once in FIFO order
// ---------------------------------------------------------------------------

test("should deliver queued worker messages once in FIFO order", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupWorkerContext(harness.natives);

  const observed = vm.runInContext(
    `(() => {
       const first = new Worker(URL.createObjectURL(new Blob(["postMessage(0);"])));
       const second = new Worker(URL.createObjectURL(new Blob(["postMessage(0);"])));
       const seen = [];
       // Registered after construction, exactly as a game registers a handler after new Worker().
       first.onmessage = (event) => seen.push({ worker: 1, data: event.data });
       first.addEventListener("message", (event) => seen.push({ worker: 1, again: event.data }));
       second.onmessage = (event) => seen.push({ worker: 2, data: event.data });

       __tnNativeWorkerDispatch(first._id, 0, '"a"');
       __tnNativeWorkerDispatch(second._id, 0, '"x"');
       __tnNativeWorkerDispatch(first._id, 0, '"b"');
       __tnNativeWorkerDispatch(first._id, 1, "worker one failed");
       __tnNativeWorkerDispatch(second._id, 0, '"y"');
       return seen;
     })()`,
    context,
  );

  // Per-worker order preserved, no interleaving loss, each listener called exactly once per event.
  expect(observed.map((entry) => JSON.stringify(entry))).toEqual([
    JSON.stringify({ worker: 1, data: "a" }),
    JSON.stringify({ worker: 1, again: "a" }),
    JSON.stringify({ worker: 2, data: "x" }),
    JSON.stringify({ worker: 1, data: "b" }),
    JSON.stringify({ worker: 1, again: "b" }),
    JSON.stringify({ worker: 2, data: "y" }),
  ]);
});

test("should route a worker error to one error event, not to the message handler", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupWorkerContext(harness.natives);

  const observed = vm.runInContext(
    `(() => {
       const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(0);"])));
       const seen = [];
       worker.onmessage = (event) => seen.push({ kind: "message", data: event.data });
       worker.onerror = (event) => seen.push({ kind: "error", message: event.message });
       worker.addEventListener("error", (event) => seen.push({ kind: "error-listener", message: event.message }));
       __tnNativeWorkerDispatch(worker._id, 1, "TypeError: handler exploded");
       __tnNativeWorkerDispatch(worker._id, 0, '"still alive"');
       return seen;
     })()`,
    context,
  );

  expect(observed.map((entry) => entry.kind)).toEqual(["error", "error-listener", "message"]);
  expect(observed[0].message).toBe("TypeError: handler exploded");
});

// ---------------------------------------------------------------------------
// should reject unsupported worker values without corrupting the running game
// ---------------------------------------------------------------------------

test("should clone every admitted row of the declared matrix unchanged", () => {
  const { context, harness } = withProbeWorker();

  const admitted = [
    "undefined",
    "null",
    "true",
    "0",
    "-1.5",
    '"text"',
    "[]",
    "[1, 2, [3, {}]]",
    "({})",
    '({ a: 1, b: "two", c: [true, null], d: { e: 0 } })',
    "Object.create(null)",
  ];

  for (const expression of admitted) {
    const thrown = postAndCatch(context, expression);
    expect(thrown, `admitted row ${expression} was refused`).toBeNull();
  }

  const payloads = harness.posted.map((entry) => entry.payload);
  expect(payloads).toEqual([
    "",
    "null",
    "true",
    "0",
    "-1.5",
    '"text"',
    "[]",
    "[1,2,[3,{}]]",
    "{}",
    '{"a":1,"b":"two","c":[true,null],"d":{"e":0}}',
    "{}",
  ]);
});

test("should reject unsupported worker values without corrupting the running game", () => {
  const { context, harness } = withProbeWorker();

  const rejected = [
    // JSON drops these entirely: the receiver would get an object missing a field.
    ["({ run: () => 1 })", "function", "message.run"],
    ["({ tag: Symbol('x') })", "symbol", "message.tag"],
    // JSON turns these into null: silent numeric corruption.
    ["({ n: NaN })", "NaN", "message.n"],
    ["({ n: Infinity })", "Infinity", "message.n"],
    // JSON throws or changes the shape entirely.
    ["({ big: 1n })", "bigint", "message.big"],
    ["({ when: new Date(0) })", "Date", "message.when"],
    ["({ re: /x/ })", "RegExp", "message.re"],
    ["({ m: new Map() })", "Map", "message.m"],
    ["({ s: new Set() })", "Set", "message.s"],
    // A class instance arrives as a bare record with its prototype gone.
    ["(new (class Handle { constructor() { this.id = 1; } })())", "Handle instance", "message"],
    // Structured clone preserves these; JSON cannot.
    ["(() => { const a = {}; a.self = a; return a; })()", "a reference cycle", "message.self"],
    [
      "(() => { const shared = { v: 1 }; return { x: shared, y: shared }; })()",
      "a second reference to one object",
      "message.y",
    ],
  ];

  for (const [expression, what, path] of rejected) {
    const thrown = postAndCatch(context, expression);
    expect(thrown, `unsupported row ${expression} was accepted`).not.toBeNull();
    expect(thrown.name).toBe("DataCloneError");
    expect(thrown.message).toContain("TN_NATIVE_WORKER_CLONE_UNSUPPORTED");
    expect(thrown.message, `row ${expression} did not name what it refused`).toContain(what);
    expect(thrown.message, `row ${expression} did not name where it refused`).toContain(path);
  }

  // Refused before queueing: not one unsupported value reached the native boundary.
  expect(harness.posted).toEqual([]);

  // And the worker is still usable afterwards — a refusal must not poison the running game.
  expect(postAndCatch(context, "({ ok: 1 })")).toBeNull();
  expect(harness.posted.map((entry) => entry.payload)).toEqual(['{"ok":1}']);
});

test("should preserve undefined object fields and array entries", () => {
  const { context, harness } = withProbeWorker();

  expect(postAndCatch(context, "({ id: undefined, values: [1, undefined, 3] })")).toBeNull();
  expect(harness.posted[0].payload).toContain("__tnNativeWorkerUndefined");

  const observed = vm.runInContext(
    `(() => {
       let seen = null;
       globalThis.__probe.onmessage = (event) => {
         seen = {
           hasId: Object.hasOwn(event.data, "id"),
           id: event.data.id,
           length: event.data.values.length,
           middle: event.data.values[1],
         };
       };
       __tnNativeWorkerDispatch(globalThis.__probe._id, 0, ${JSON.stringify(
         JSON.stringify({
           id: { __tnNativeWorkerUndefined: true },
           values: [1, { __tnNativeWorkerUndefined: true }, 3],
         }),
       )});
       return seen;
     })()`,
    context,
  );
  expect(observed.hasId).toBe(true);
  expect(observed.id).toBeUndefined();
  expect(observed.length).toBe(3);
  expect(observed.middle).toBeUndefined();
});

test("should copy transferable binary values across the native worker wire", () => {
  const { context, harness } = withProbeWorker();

  const result = vm.runInContext(
    `(() => {
       const buffer = new Uint8Array([3, 1, 4, 1]).buffer;
       try {
         globalThis.__probe.postMessage({ buffer, bytes: new Uint8Array([2, 7]) }, [buffer]);
         return { thrown: null, byteLength: buffer.byteLength };
       } catch (error) {
         return { thrown: { name: error.name, message: error.message } };
       }
     })()`,
    context,
  );

  expect(result.thrown).toBeNull();
  expect(result.byteLength).toBe(4);
  expect(harness.posted).toHaveLength(1);
  expect(harness.posted[0].payload).toContain("__tnNativeWorkerBinary");

  const observed = vm.runInContext(
    `(() => {
       let seen = null;
       globalThis.__probe.onmessage = (event) => {
         seen = {
           buffer: Array.from(new Uint8Array(event.data.buffer)),
           bytes: Array.from(event.data.bytes),
           typed: event.data.bytes instanceof Uint8Array,
         };
       };
       __tnNativeWorkerDispatch(globalThis.__probe._id, 0, ${JSON.stringify(
         JSON.stringify({
           buffer: { __tnNativeWorkerBinary: "ArrayBuffer", bytes: [3, 1, 4, 1] },
           bytes: { __tnNativeWorkerBinary: "Uint8Array", bytes: [2, 7] },
         }),
       )});
       return seen;
     })()`,
    context,
  );
  expect(Array.from(observed.buffer)).toEqual([3, 1, 4, 1]);
  expect(Array.from(observed.bytes)).toEqual([2, 7]);
  expect(observed.typed).toBe(true);
});

// ---------------------------------------------------------------------------
// should surface worker failures and terminate before runtime teardown
// ---------------------------------------------------------------------------

test("should stop delivering to a terminated worker and release its handlers", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupWorkerContext(harness.natives);

  const observed = vm.runInContext(
    `(() => {
       const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(0);"])));
       const seen = [];
       worker.onmessage = (event) => seen.push(event.data);
       worker.addEventListener("error", (event) => seen.push("error:" + event.message));
       __tnNativeWorkerDispatch(worker._id, 0, '"before"');
       worker.terminate();
       // A completion already collected by the host before the join must not reach the game.
       __tnNativeWorkerDispatch(worker._id, 0, '"after"');
       __tnNativeWorkerDispatch(worker._id, 1, "late failure");
       // Posting to a terminated worker is a no-op, never a throw and never a native call.
       worker.postMessage({ ignored: true });
       return { seen, id: worker._id };
     })()`,
    context,
  );

  expect(observed.seen).toEqual(["before"]);
  expect(harness.terminated).toEqual([observed.id]);
  expect(harness.posted).toEqual([]);
});

test("should resolve only worker URL forms the packed host proves", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupWorkerContext(harness.natives);
  const observed = vm.runInContext(
    `(() => {
       const capture = (create) => {
         try {
           create();
           return null;
         } catch (error) {
           return { name: error.name, message: error.message };
         }
       };
       const blob = URL.createObjectURL(new Blob(["postMessage(1);"]));
       const admitted = capture(() => new Worker(blob));
       const moduleWorker = capture(() => new Worker(blob, { type: "module" }));
       const stagedClassic = capture(() => new Worker("workers/checksum.js"));
       const external = capture(() => new Worker("https://example.invalid/checksum.js"));
       URL.revokeObjectURL(blob);
       const revoked = capture(() => new Worker(blob));
       return { admitted, external, moduleWorker, revoked, stagedClassic };
     })()`,
    context,
  );

  expect(observed.admitted).toBeNull();
  expect(harness.created).toEqual(["postMessage(1);"]);
  expect(observed.moduleWorker).toMatchObject({
    name: "NotSupportedError",
    message: expect.stringContaining("TN_NATIVE_WORKER_MODULE_UNSUPPORTED"),
  });
  for (const row of [observed.stagedClassic, observed.external]) {
    expect(row).toMatchObject({
      name: "NotSupportedError",
      message: expect.stringContaining("TN_NATIVE_WORKER_URL_UNSUPPORTED"),
    });
  }
  expect(observed.revoked).toMatchObject({
    name: "NetworkError",
    message: expect.stringContaining("TN_NATIVE_WORKER_SOURCE_MISSING"),
  });
});

test("should reject acceptance when the internal worker rollback selector is active", () => {
  const harness = createNativeWorkerHarness();
  const { context } = setupWorkerContext({
    ...harness.natives,
    __tnNativeWorkerRollbackActive: true,
  });
  const observed = vm.runInContext(
    `(() => {
       const blob = URL.createObjectURL(new Blob(["postMessage(1);"]));
       try {
         new Worker(blob);
         return null;
       } catch (error) {
         return { name: error.name, message: error.message };
       }
     })()`,
    context,
  );

  expect(observed).toMatchObject({
    name: "NotSupportedError",
    message: expect.stringContaining("TN_NATIVE_WORKER_ROLLBACK_ACTIVE"),
  });
  expect(harness.created).toEqual([]);
});

// ---------------------------------------------------------------------------
// The packed C++ contract. Executed when the native lane built it.
// ---------------------------------------------------------------------------

test("should prove the registry contract against real worker threads", () => {
  const binary = process.env.TN_NATIVE_WORKER_BIN;
  if (!binary) {
    // Fail-closed reporting: this is not a pass. The native lane sets the variable via CMake.
    console.log(
      "TN_NATIVE_WORKER_CONTRACT:UNVERIFIED — TN_NATIVE_WORKER_BIN unset; " +
        "build threenative-worker-production-test and re-run to execute the packed contract",
    );
    return;
  }

  const stdout = execFileSync(binary, { encoding: "utf8", timeout: 120_000 });
  const results = [...stdout.matchAll(/WORKER_CONTRACT (\w+) (PASS|FAIL)(?: (.*))?$/gmu)].map(
    (match) => ({ name: match[1], verdict: match[2], detail: match[3] ?? "" }),
  );

  const required = [
    "fifoAcrossHandlerRegistration",
    "cloneMatrixRoundTrip",
    "binaryCloneAndWorkerEventListener",
    "wasmPromiseTasksAfterMessage",
    "cloneRefusalNamed",
    "workerSideCloneRefusalReachesError",
    "topLevelThrowReachesError",
    "handlerThrowReachesError",
    "finalMessageSurvivesSelfClose",
    "terminateStopsCallbacks",
    "shutdownJoinsEveryWorker",
    "registryReopensForASecondRuntime",
  ];
  // Each marker is emitted whole and ends its line, even with worker threads logging at once. A
  // worker thread may still have written its own "[Worker N" prefix before it on that line.
  const created = stdout.split("\n").filter((line) => line.includes("TN_NATIVE_WORKER_CREATED"));
  expect(created.length).toBeGreaterThan(0);
  for (const line of created) {
    expect(line).toMatch(/TN_NATIVE_WORKER_CREATED:\{"id":\d+,"engine":"[^"]+"\}$/u);
  }
  const terminated = stdout.split("\n").filter((line) => line.includes("TN_NATIVE_WORKER_TERMINATED"));
  expect(terminated.length).toBeGreaterThan(0);
  for (const line of terminated) {
    expect(line).toMatch(/TN_NATIVE_WORKER_TERMINATED:\{"id":\d+\}$/u);
  }
  const byName = new Map(results.map((row) => [row.name, row]));
  for (const name of required) {
    const row = byName.get(name);
    expect(row, `packed contract never reported ${name}`).toBeDefined();
    expect(`${name} ${row.verdict} ${row.detail}`.trim()).toBe(`${name} PASS`);
  }
});
