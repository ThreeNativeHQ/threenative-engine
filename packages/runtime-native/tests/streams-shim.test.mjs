import assert from "node:assert/strict";
import { test } from "vitest";
import vm from "node:vm";
import {
  createGuestContext,
  guest,
  readRuntimeScript,
} from "./embedded-js.mjs";

// The WHATWG streams shim backs Response bodies, GLTF streaming loaders and
// TextEncoderStream/TextDecoderStream pipelines on engines that lack them
// natively (QuickJS). Evaluated here exactly as the host does: fetch first
// (it owns TextEncoder/TextDecoder), then the streams block.

function setupStreamsContext() {
  const context = createGuestContext();
  vm.runInContext(readRuntimeScript("fetch-polyfill"), context);
  vm.runInContext(readRuntimeScript("streams-polyfill"), context);
  return context;
}

test("streams polyfill installs the full WHATWG surface", () => {
  const context = setupStreamsContext();
  const installed = vm.runInContext(
    `[typeof ReadableStream, typeof WritableStream, typeof TransformStream,
      typeof TextEncoderStream, typeof TextDecoderStream]`,
    context,
  );
  assert.deepEqual(guest(installed), ["function", "function", "function", "function", "function"]);
});

test("ReadableStream delivers queued chunks then done", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([2]));
          controller.close();
        },
      });
      const chunks = [];
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(...value);
      }
      await reader.closed;
      return { chunks, desiredSizeAfterClose: reader.desiredSize };
    })()`,
    context,
  );
  assert.deepEqual(guest(result).chunks, [1, 2]);
  assert.equal(guest(result).desiredSizeAfterClose, undefined);
});

test("reads made before enqueue are fulfilled when the chunk arrives", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      let controller;
      const stream = new ReadableStream({ start(c) { controller = c; } });
      const reader = stream.getReader();
      const pending = reader.read();
      // Snapshot whether the pending read settles on its own before any chunk.
      const stateBeforeEnqueue = await Promise.race([
        pending.then(() => "settled"),
        Promise.resolve("still-pending"),
      ]);
      controller.enqueue("chunk");
      const first = await pending;
      controller.close();
      const last = await reader.read();
      return {
        stateBeforeEnqueue,
        value: first.value,
        done: first.done,
        closed: last.done,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), { stateBeforeEnqueue: "still-pending", value: "chunk", done: false, closed: true });
});

test("stream errors reject pending and future reads and mark desiredSize null", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      let failure;
      const stream = new ReadableStream({
        start() { throw new Error("source exploded"); },
      });
      const reader = stream.getReader();
      try { await reader.read(); } catch (e) { failure = e.message; }
      return { failure, desiredSize: reader.desiredSize ?? stream._controller.desiredSize };
    })()`,
    context,
  );
  assert.equal(guest(result).failure, "source exploded");
  assert.equal(guest(result).desiredSize, null);
});

test("a locked stream refuses a second reader; releaseLock frees it", () => {
  const context = setupStreamsContext();
  const result = vm.runInContext(
    `(() => {
      const stream = new ReadableStream({});
      const first = stream.getReader();
      let secondThrew = null;
      try { stream.getReader(); } catch (e) { secondThrew = e.message; }
      first.releaseLock();
      const second = stream.getReader();
      return { lockedWhileHeld: stream.locked, secondThrew, lockedAgain: stream.locked };
    })()`,
    context,
  );
  assert.equal(guest(result).lockedWhileHeld, true);
  assert.match(guest(result).secondThrew, /locked/u);
  assert.equal(guest(result).lockedAgain, true);
});

test("async iteration drains the stream and tee duplicates every chunk", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      const source = new ReadableStream({
        start(controller) {
          for (const byte of [7, 8, 9]) controller.enqueue(byte);
          controller.close();
        },
      });
      const iterated = [];
      for await (const chunk of source) iterated.push(chunk);

      const original = new ReadableStream({
        start(controller) {
          controller.enqueue("a");
          controller.enqueue("b");
          controller.close();
        },
      });
      const [branchA, branchB] = original.tee();
      const fromA = [];
      for await (const chunk of branchA) fromA.push(chunk);
      const fromB = [];
      for await (const chunk of branchB) fromB.push(chunk);
      return { iterated, fromA, fromB };
    })()`,
    context,
  );
  assert.deepEqual(guest(result).iterated, [7, 8, 9]);
  assert.deepEqual(guest(result).fromA, ["a", "b"]);
  assert.deepEqual(guest(result).fromB, ["a", "b"]);
});

test("pipeTo forwards chunks into a writable sink and closes it", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      const written = [];
      let sinkClosed = false;
      const dest = new WritableStream({
        write(chunk) { written.push(chunk); },
        close() { sinkClosed = true; },
      });
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(1);
          controller.enqueue(2);
          controller.close();
        },
      });
      await source.pipeTo(dest);
      return { written, sinkClosed };
    })()`,
    context,
  );
  assert.deepEqual(guest(result).written, [1, 2]);
  assert.equal(guest(result).sinkClosed, true);
});

test("TransformStream + text streams round-trip bytes back to text", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      const upper = new TransformStream({
        transform(chunk, controller) { controller.enqueue(chunk.toUpperCase()); },
      });
      const writer = upper.writable.getWriter();
      writer.write("ab");
      writer.write("cd");
      writer.close();

      const piped = new TextEncoderStream();
      const decoded = new TextDecoderStream();

      const collected = [];
      for await (const chunk of upper.readable.pipeThrough(piped).pipeThrough(decoded)) {
        collected.push(chunk);
      }
      return collected.join("");
    })()`,
    context,
  );
  assert.equal(guest(result), "ABCD");
});

test("TextDecoderStream propagates label/options and preserves split sequences", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      // split "€" (U+20AC: e2 82 ac) across two chunks must survive streaming state
      const fatal = new TextDecoderStream("utf-8", { fatal: true });
      const fatalWriter = fatal.writable.getWriter();
      const fatalReader = fatal.readable.getReader();
      const first = fatalReader.read();
      await fatalWriter.write(new Uint8Array([0xe2, 0x82]));
      const pendingBefore = await Promise.race([first.then(() => "settled"), Promise.resolve("pending")]);
      await fatalWriter.write(new Uint8Array([0xac]));
      const firstValue = await first;
      await fatalWriter.close();
      // fatal stream rejects malformed input instead of replacing
      const bad = new TextDecoderStream("utf-8", { fatal: true });
      const badWriter = bad.writable.getWriter();
      const badReader = bad.readable.getReader();
      badReader.read().catch(() => {});
      badWriter.write(new Uint8Array([0xff])).catch(() => {});
      const badSettled = await badWriter.closed.then(() => "resolved", () => "rejected");
      let badLabel = null;
      try { new TextDecoderStream("utf-16"); } catch (e) { badLabel = e instanceof RangeError ? "RangeError" : String(e && e.name); }
      return {
        encoding: fatal.encoding,
        fatalFlag: fatal.fatal,
        pendingBefore,
        firstValue: firstValue.value,
        badSettled,
        badLabel,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    encoding: "utf-8",
    fatalFlag: true,
    pendingBefore: "pending",
    firstValue: "€",
    badSettled: "rejected",
    badLabel: "RangeError",
  });
});

test("identity TransformStream passes chunks through untouched", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      const identity = new TransformStream();
      const writer = identity.writable.getWriter();
      const read = identity.readable.getReader().read();
      writer.write("passthrough");
      const { value } = await read;
      writer.close();
      return value;
    })()`,
    context,
  );
  assert.equal(guest(result), "passthrough");
});

test("queue strategies measure byte sizes and terminal desiredSize", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      let controller;
      let sized = 0;
      const stream = new ReadableStream({
        start(c) { controller = c; },
      }, {
        highWaterMark: 3,
        size(chunk) { sized += 1; return chunk.byteLength; },
      });
      const reader = stream.getReader();
      const initial = controller.desiredSize;
      controller.enqueue(new Uint8Array(2));
      const afterTwo = controller.desiredSize;
      controller.enqueue(new Uint8Array(1));
      const atPressure = controller.desiredSize;
      controller.close();
      const whileClosing = controller.desiredSize;
      await reader.read();
      const afterFirstRead = controller.desiredSize;
      await reader.read();
      const done = await reader.read();
      await reader.closed;

      let errorController;
      const failed = new ReadableStream({ start(c) { errorController = c; } }, { highWaterMark: 4 });
      const failedReader = failed.getReader();
      errorController.enqueue("stale");
      errorController.error(new Error("queue failed"));
      let failure;
      try { await failedReader.read(); } catch (e) { failure = e.message; }
      return {
        initial, afterTwo, atPressure, whileClosing, afterFirstRead,
        final: controller.desiredSize, sized, done: done.done,
        error: failure, errorDesiredSize: errorController.desiredSize,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    initial: 3,
    afterTwo: 1,
    atPressure: 0,
    whileClosing: 0,
    afterFirstRead: 2,
    final: 0,
    sized: 2,
    done: true,
    error: "queue failed",
    errorDesiredSize: null,
  });
});

test("ReadableStream pulls on demand, serializes async pulls, and stops at pressure", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      let pulls = 0;
      let active = 0;
      let maxActive = 0;
      let release;
      const stream = new ReadableStream({
        pull(c) {
          pulls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (pulls === 1) {
            return new Promise((resolve) => {
              release = () => {
                c.enqueue("one");
                active -= 1;
                resolve();
              };
            });
          }
          c.enqueue("two");
          c.close();
          active -= 1;
        },
      }, { highWaterMark: 1 });
      await Promise.resolve();
      await Promise.resolve();
      const started = pulls;
      if (!release) return { started, pulls, maxActive, missingPull: true };
      release();
      await Promise.resolve();
      await Promise.resolve();
      const unread = pulls;
      const reader = stream.getReader();
      const first = reader.read();
      const firstResult = await first;
      await Promise.resolve();
      await Promise.resolve();
      const afterRead = pulls;
      const secondResult = await reader.read();
      const finalResult = await reader.read();
      return {
        started,
        unread,
        afterRead,
        pulls,
        maxActive,
        missingPull: false,
        first: firstResult.value,
        second: secondResult.value,
        done: finalResult.done,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    started: 1,
    unread: 1,
    afterRead: 2,
    pulls: 2,
    maxActive: 1,
    missingPull: false,
    first: "one",
    second: "two",
    done: true,
  });
});

test("WritableStream awaits start, serializes writes, and makes ready reflect pressure", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      const events = [];
      let releaseStart;
      const startDone = new Promise((resolve) => { releaseStart = resolve; });
      const releases = [];
      const stream = new WritableStream({
        start() {
          events.push("start");
          return startDone;
        },
        write(chunk) {
          events.push("write:" + chunk);
          return new Promise((resolve) => releases.push(() => {
            events.push("done:" + chunk);
            resolve();
          }));
        },
        close() { events.push("close"); },
      }, { highWaterMark: 2, size: (chunk) => chunk.length });
      const writer = stream.getWriter();
      const first = writer.write("aa");
      await Promise.resolve();
      const beforeStart = events.slice();
      const settlesByCheckpoint = async (promise) => {
        let state = "pending";
        promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
        await Promise.resolve();
        await Promise.resolve();
        return state;
      };
      const knownResolved = await settlesByCheckpoint(Promise.resolve());
      const readyBeforeStart = await settlesByCheckpoint(writer.ready);
      releaseStart();
      await Promise.resolve();
      await Promise.resolve();
      const afterStart = events.slice();
      const second = writer.write("b");
      const serial = events.filter((event) => event.startsWith("write:")).join(",") === "write:aa";
      const readyWithTwoQueued = await settlesByCheckpoint(writer.ready);
      const readyDuringFirst = writer.ready;
      releases.shift()();
      await first;
      await Promise.resolve();
      await Promise.resolve();
      const afterFirst = events.slice();
      const readyAfterFirst = await settlesByCheckpoint(readyDuringFirst);
      const close = writer.close();
      const closeBeforeSecond = await settlesByCheckpoint(close);
      releases.shift()();
      await second;
      await close;
      await writer.closed;
      return {
        beforeStart, knownResolved, readyBeforeStart, afterStart, serial,
        readyWithTwoQueued, readyAfterFirst, afterFirst, closeBeforeSecond, events,
      };
    })()`,
    context,
  );
  assert.deepEqual(guest(result), {
    beforeStart: ["start"],
    knownResolved: "resolved",
    readyBeforeStart: "pending",
    afterStart: ["start", "write:aa"],
    serial: true,
    readyWithTwoQueued: "pending",
    readyAfterFirst: "resolved",
    afterFirst: ["start", "write:aa", "done:aa", "write:b"],
    closeBeforeSecond: "pending",
    events: ["start", "write:aa", "done:aa", "write:b", "done:b", "close"],
  });
});

test("stream errors, cancellation, and release settle pending operations and propagate async failures", async () => {
  const context = setupStreamsContext();
  const result = await vm.runInContext(
    `(async () => {
      let readController;
      const readable = new ReadableStream({ start(c) { readController = c; } });
      const reader = readable.getReader();
      const pendingRead = reader.read();
      readController.error(new Error("read failed"));
      const readFailure = await pendingRead.then(() => "resolved", (e) => e.message);
      const closedFailure = await reader.closed.then(() => "resolved", (e) => e.message);

      const cancelled = new ReadableStream({
        cancel() { return Promise.reject(new Error("cancel failed")); },
      });
      const cancelledReader = cancelled.getReader();
      const pendingCancelledRead = cancelledReader.read();
      const cancelFailure = await cancelledReader.cancel("stop").then(() => "resolved", (e) => e.message);
      const cancelledRead = await pendingCancelledRead.then(
        (value) => value.done ? "done" : "value",
        (e) => e.message,
      );

      const released = new ReadableStream({});
      const releasedReader = released.getReader();
      const pendingReleasedRead = releasedReader.read();
      releasedReader.releaseLock();
      const releaseFailure = await pendingReleasedRead.then(() => "resolved", (e) => e.name);
      const releasedClosedPending = await releasedReader.closed.then(() => "resolved", (e) => e.name);

      let sinkController;
      let releaseWrite;
      const writable = new WritableStream({
        start(c) { sinkController = c; },
        write() { return new Promise((resolve) => { releaseWrite = resolve; }); },
      });
      const writer = writable.getWriter();
      const firstWrite = writer.write("first");
      await Promise.resolve();
      const queuedWrite = writer.write("queued");
      const readyBeforeError = writer.ready;
      sinkController.error(new Error("sink failed"));
      const queuedFailurePromise = queuedWrite.then(() => "resolved", (e) => e.message);
      const readyFailurePromise = readyBeforeError.then(() => "resolved", (e) => e.message);
      releaseWrite();
      const firstResult = await firstWrite.then(() => "resolved", (e) => e.message);
      const queuedFailure = await queuedFailurePromise;
      const readyFailure = await readyFailurePromise;

      let lateController;
      const late = new WritableStream({ start(c) { lateController = c; } });
      lateController.error(new Error("late"));
      const lateWriter = late.getWriter();
      lateWriter.closed.catch(() => {});
      const lateReady = await lateWriter.ready.then(() => "resolved", (e) => e.message);

      const releasedWriter = new WritableStream().getWriter();
      await releasedWriter.ready;
      releasedWriter.releaseLock();
      const releasedReady = await releasedWriter.ready.then(() => "resolved", (e) => e.name);

      let releasedReadableController;
      const settledReader = new ReadableStream({
        start(c) { releasedReadableController = c; },
      }).getReader();
      releasedReadableController.close();
      await settledReader.closed;
      settledReader.releaseLock();
      const releasedClosedAfterSettlement = await settledReader.closed.then(() => "resolved", (e) => e.name);

      const abortWritable = new WritableStream({
        abort() { return Promise.reject(new Error("abort failed")); },
      });
      const abortWriter = abortWritable.getWriter();
      const abortFailure = await abortWriter.abort("stop").then(() => "resolved", (e) => e.message);
      const closedAfterAbort = await abortWriter.closed.then(() => "resolved", (e) => e);
      return {
        readFailure, closedFailure, cancelFailure, cancelledRead,
        releaseFailure, releasedClosedPending, queuedFailure, readyFailure,
        firstResult, lateReady, releasedReady, releasedClosedAfterSettlement,
        abortFailure, closedAfterAbort,
      };
    })()`,
    context,
  );
  const observed = guest(result);
  assert.equal(observed.readFailure, "read failed");
  assert.equal(observed.closedFailure, "read failed");
  assert.equal(observed.cancelFailure, "cancel failed");
  assert.equal(observed.cancelledRead, "done");
  assert.equal(observed.releaseFailure, "TypeError");
  assert.equal(observed.releasedClosedPending, "TypeError");
  assert.equal(observed.queuedFailure, "sink failed");
  assert.equal(observed.readyFailure, "sink failed");
  assert.equal(observed.firstResult, "resolved");
  assert.equal(observed.lateReady, "late");
  assert.equal(observed.releasedReady, "TypeError");
  assert.equal(observed.releasedClosedAfterSettlement, "TypeError");
  assert.equal(observed.abortFailure, "abort failed");
  assert.equal(observed.closedAfterAbort, "stop");
});

test("WritableStream replaces fulfilled ready with a rejection after controller error", async () => {
  const probe = `(async () => {
    let controller;
    const writer = new WritableStream({ start(c) { controller = c; } }).getWriter();
    writer.closed.catch(() => {});
    await writer.ready;
    controller.error(new Error("sink failed"));
    return writer.ready.then(() => "resolved", (error) => error.message);
  })()`;
  assert.equal(await vm.runInNewContext(probe, { WritableStream }), "sink failed");
  assert.equal(await vm.runInContext(probe, setupStreamsContext()), "sink failed");
});

test("WritableStream exposes a stable abort signal and follows terminal abort ordering", async () => {
  const probe = `(async () => {
    let controller;
    const events = [];
    const sinkFailure = new Error("sink abort failed");
    const stream = new WritableStream({
      start(c) { controller = c; },
      abort() { events.push("abort"); return Promise.reject(sinkFailure); },
    });
    const writer = stream.getWriter();
    writer.closed.catch(() => {});
    const reason = { tag: "requested" };
    const signal = controller.signal;
    const hasSignal = !!signal && typeof signal.addEventListener === "function";
    if (hasSignal) signal.addEventListener("abort", () => events.push("signal"));
    const firstAbort = await writer.abort(reason).then(
      () => "resolved",
      (error) => error === sinkFailure ? "sink-abort-failed" : "other-error",
    );
    const closed = await writer.closed.then(
      () => "resolved",
      (error) => error === reason ? "reason" : "other-error",
    );
    const secondAbort = await writer.abort({ tag: "second" }).then(
      () => "resolved",
      () => "rejected",
    );
    return {
      hasSignal,
      stable: hasSignal && signal === controller.signal,
      aborted: hasSignal && signal.aborted,
      reasonSame: hasSignal && signal.reason === reason,
      firstAbort, closed, secondAbort, events,
    };
  })()`;
  const expected = {
    hasSignal: true,
    stable: true,
    aborted: true,
    reasonSame: true,
    firstAbort: "sink-abort-failed",
    closed: "reason",
    secondAbort: "resolved",
    events: ["signal", "abort"],
  };
  assert.deepEqual(guest(await vm.runInNewContext(probe, { WritableStream })), expected);
  assert.deepEqual(guest(await vm.runInContext(probe, setupStreamsContext())), expected);
});

test("WritableStream abort signal rejects a held write before abort waits for it", async () => {
  const probe = `(async () => {
    let controller;
    let settleWrite;
    const events = [];
    const stream = new WritableStream({
      start(c) { controller = c; },
      write() {
        events.push("write");
        return new Promise((resolve, reject) => {
          settleWrite = reject;
          if (controller.signal) controller.signal.addEventListener("abort", () => {
            events.push("signal");
            reject(controller.signal.reason);
          });
        });
      },
      abort(reason) { events.push("abort:" + reason.tag); },
    });
    const writer = stream.getWriter();
    writer.closed.catch(() => {});
    const reason = { tag: "stop" };
    let writeState = "pending";
    const writing = writer.write("held").then(
      () => { writeState = "resolved"; return "resolved"; },
      (error) => { writeState = error === reason ? "reason" : "other-error"; return writeState; },
    );
    await Promise.resolve(); await Promise.resolve();
    const aborting = writer.abort(reason).then(() => "resolved", () => "rejected");
    const eventsAtAbortCall = events.slice();
    for (let checkpoint = 0; checkpoint < 6; checkpoint += 1) await Promise.resolve();
    const observedBeforeRelease = {
      events: eventsAtAbortCall,
      aborted: !!controller.signal && controller.signal.aborted,
      reasonSame: !!controller.signal && controller.signal.reason === reason,
      writeSettled: writeState !== "pending",
    };
    if (writeState === "pending" && settleWrite) settleWrite(reason);
    const result = await writing;
    const abortResult = await aborting;
    const closed = await writer.closed.then(
      () => "resolved",
      (error) => error === reason ? "reason" : "other-error",
    );
    return { observedBeforeRelease, result, abortResult, closed, events };
  })()`;
  const expected = {
    observedBeforeRelease: {
      events: ["write", "signal"],
      aborted: true,
      reasonSame: true,
      writeSettled: true,
    },
    result: "reason",
    abortResult: "resolved",
    closed: "reason",
    events: ["write", "signal", "abort:stop"],
  };
  assert.deepEqual(guest(await vm.runInNewContext(probe, { WritableStream })), expected);
  assert.deepEqual(guest(await vm.runInContext(probe, setupStreamsContext())), expected);
});

test("WritableStream abort re-reads state after a synchronous signal listener errors it", async () => {
  // Chromium reference: artifacts/networking-359/task2b-integration-decisions.md
  // records abort/closed as listener-error, one signal event, and no sink.abort.
  const probe = `(async () => {
    let controller;
    let releaseStart;
    const startHeld = new Promise((resolve) => { releaseStart = resolve; });
    const listenerError = new Error("listener-error");
    const events = [];
    const stream = new WritableStream({
      start(c) {
        controller = c;
        if (c.signal) {
          c.signal.addEventListener("abort", () => {
            events.push("signal");
            c.error(listenerError);
          });
        }
        return startHeld;
      },
      abort() { events.push("sink-abort"); },
    });
    const writer = stream.getWriter();
    writer.closed.catch(() => {});
    const aborting = writer.abort("requested").then(
      () => "resolved",
      (error) => error === listenerError ? "listener-error" : "other-error",
    );
    const signalState = {
      events: events.slice(),
      aborted: !!controller.signal && controller.signal.aborted,
      reason: controller.signal && controller.signal.reason,
    };
    releaseStart();
    const abort = await aborting;
    const closed = await writer.closed.then(
      () => "resolved",
      (error) => error === listenerError ? "listener-error" : "other-error",
    );
    return { abort, closed, signalReason: signalState.reason, events };
  })()`;
  const expected = {
    abort: "listener-error",
    closed: "listener-error",
    signalReason: "requested",
    events: ["signal"],
  };
  assert.deepEqual(guest(await vm.runInContext(probe, setupStreamsContext())), expected);
});

test("WritableStream abort on closed or errored streams is already settled", async () => {
  const probe = `(async () => {
    let closedController;
    const closed = new WritableStream({ start(c) { closedController = c; } });
    const closedWriter = closed.getWriter();
    await closedWriter.close();
    const afterClose = await closedWriter.abort("after-close").then(() => "resolved", () => "rejected");

    let erroredController;
    const stored = new Error("stored");
    const errored = new WritableStream({ start(c) { erroredController = c; } });
    const erroredWriter = errored.getWriter();
    erroredWriter.closed.catch(() => {});
    erroredController.error(stored);
    await erroredWriter.closed.catch(() => {});
    const afterError = await erroredWriter.abort("after-error").then(
      () => "resolved",
      (error) => error === stored ? "stored" : "rejected",
    );
    return {
      closedSignalAborted: closedController.signal ? closedController.signal.aborted : false,
      afterClose,
      erroredSignalAborted: erroredController.signal ? erroredController.signal.aborted : false,
      afterError,
    };
  })()`;
  const expected = {
    closedSignalAborted: false,
    afterClose: "resolved",
    erroredSignalAborted: false,
    afterError: "resolved",
  };
  assert.deepEqual(guest(await vm.runInNewContext(probe, { WritableStream })), expected);
  assert.deepEqual(guest(await vm.runInContext(probe, setupStreamsContext())), expected);
});

for (const phase of ["start", "write"]) {
  test(`WritableStream abort waits for pending ${phase} and preserves in-flight completion`, async () => {
    const probe = `(async () => {
      const events = [];
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const stream = new WritableStream({
        start() { if (${JSON.stringify(phase)} === "start") return held; },
        write() { events.push("write"); return held; },
        abort(reason) { events.push("abort:" + reason); },
      });
      const writer = stream.getWriter();
      writer.closed.catch(() => {});
      const writing = writer.write("first").then(() => "resolved", (e) => e);
      await Promise.resolve(); await Promise.resolve();
      const queued = writer.write("queued").then(() => "resolved", (e) => e);
      const aborting = writer.abort("stop");
      let abortSettled = false;
      aborting.then(() => { abortSettled = true; });
      await Promise.resolve(); await Promise.resolve();
      const before = { events: events.slice(), abortSettled };
      release();
      await aborting;
      return { before, first: await writing, queued: await queued, events };
    })()`;
    const expected = {
      before: { events: phase === "write" ? ["write"] : [], abortSettled: false },
      first: phase === "write" ? "resolved" : "stop",
      queued: "stop",
      events: phase === "write" ? ["write", "abort:stop"] : ["abort:stop"],
    };
    assert.deepEqual(guest(await vm.runInNewContext(probe, { WritableStream })), expected);
    assert.deepEqual(guest(await vm.runInContext(probe, setupStreamsContext())), expected);
  });
}

test("WritableStream does not send after a size callback errors the stream", async () => {
  const probe = `(async () => {
    let controller;
    const writes = [];
    const writer = new WritableStream({
      start(c) { controller = c; },
      write(chunk) { writes.push(chunk); },
    }, { size() { controller.error(new Error("size failed")); return 1; } }).getWriter();
    writer.closed.catch(() => {});
    await Promise.resolve();
    const result = await writer.write("must not send").then(() => "resolved", (e) => e.message);
    return { result, writes };
  })()`;
  const expected = { result: "size failed", writes: [] };
  assert.deepEqual(guest(await vm.runInNewContext(probe, { WritableStream })), expected);
  assert.deepEqual(guest(await vm.runInContext(probe, setupStreamsContext())), expected);
});

for (const phase of ["start", "write"]) {
  test(`WritableStream close during erroring waits for pending ${phase}`, async () => {
    const probe = `(async () => {
      let controller;
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const writer = new WritableStream({
        start(c) { controller = c; if (${JSON.stringify(phase)} === "start") return held; },
        write() { return held; },
      }).getWriter();
      writer.closed.catch(() => {});
      const writing = writer.write("first").then(() => "resolved", (e) => e.message);
      await Promise.resolve(); await Promise.resolve();
      controller.error(new Error("ctrl"));
      let closeState = "pending";
      writer.close().then(() => { closeState = "resolved"; }, (e) => { closeState = e.message; });
      let duplicate = "pending";
      writer.close().then(() => { duplicate = "resolved"; }, (e) => { duplicate = e.name; });
      await Promise.resolve(); await Promise.resolve();
      const before = closeState;
      release();
      const write = await writing;
      await Promise.resolve(); await Promise.resolve();
      return { before, after: closeState, write, duplicate };
    })()`;
    const expected = { before: "pending", after: "ctrl", write: phase === "write" ? "resolved" : "ctrl", duplicate: "TypeError" };
    assert.deepEqual(guest(await vm.runInNewContext(probe, { WritableStream })), expected);
    assert.deepEqual(guest(await vm.runInContext(probe, setupStreamsContext())), expected);
  });
}
