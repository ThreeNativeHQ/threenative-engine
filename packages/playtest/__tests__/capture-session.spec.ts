import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

vi.mock("playwright", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/capture.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/index.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/runner/browser.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/runner/browserSession.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/runner/observationSampling.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/runner/runner-support.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/runner/server.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/runner/startupReady.js", async () => import("./fixtures/capture-session.js"));
vi.mock("../src/runner/steps.js", async () => import("./fixtures/capture-session.js"));

import { withBrowserCapture } from "../src/runner/captureSession.js";
import { captureConfig, resetCaptureFixture, state } from "./fixtures/capture-session.js";
let directory = "";
beforeEach(async () => { resetCaptureFixture(); directory = await makeTempDir("tn-capture-session-"); });

const cleanup = ["close-browser", "profiles", "stop-server", "release-display", "release-lock"];

test("borrows ready resources, verifies screenshots and cleans up in ownership order", async () => {
  let borrowedSignal: AbortSignal | undefined;
  const destination = await withBrowserCapture(captureConfig(directory), async (session) => {
    borrowedSignal = session.signal;
    assert.ok(state.events.includes("startup"));
    assert.ok(state.events.includes("provenance"));
    return session.screenshot("ready");
  });
  assert.equal(destination, join(directory, "ready.png"));
  assert.equal(await readFile(destination, "utf8"), "fixture pixels");
  assert.equal(state.launchOptions?.headless, false);
  assert.equal(state.launchOptions?.env?.DISPLAY, ":123");
  assert.equal(borrowedSignal?.aborted, true);
  assert.deepEqual(state.events.slice(-5), cleanup);
  const envelope = JSON.parse(await readFile(join(directory, "capture-session.json"), "utf8"));
  assert.equal(envelope.timingEvidence, "not-qualified");
});

test("custom captures retain a startup console error for parity checks after readiness recovers", async () => {
  state.startupConsoleError = true;
  const observed = await withBrowserCapture(captureConfig(directory), async (session) => {
    assert.equal(state.startupConsoleError, false);
    await session.screenshot("recovered");
    return {
      parityPasses: session.errors.length === 0,
      errors: session.errors,
      consoleEntries: session.consoleEntries,
    };
  });
  assert.equal(observed.parityPasses, false);
  assert.deepEqual(observed.errors, ["startup compile error, later recovered", "startup assertion failed"]);
  assert.deepEqual(observed.consoleEntries, [{
    source: "browser-console",
    text: "startup compile error, later recovered",
    type: "error",
  }, {
    source: "browser-console",
    text: "startup assertion failed",
    type: "assert",
  }]);
});

test("a dead server keeps its diagnostic and does not launch a browser", async () => {
  const failure = new Error("managed server exited"); state.serverError = failure;
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => assert.fail("must not capture")), (error) => error === failure);
  assert.ok(!state.events.includes("browser"));
  assert.deepEqual(state.events.slice(-3), ["stop-server", "release-display", "release-lock"]);
});

test("lock contention remains a lock failure, not a test failure", async () => {
  const failure = new Error("LOCK TIMEOUT"); state.lockError = failure;
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => assert.fail("must not capture")), (error) => error === failure);
  assert.deepEqual(state.events, ["lock"]);
});

test("missing startup capability fails before capture", async () => {
  state.capabilities = ["clock"];
  state.startupConsoleError = true;
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => assert.fail("must not capture")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^TN_CAPTURE_SESSION_READINESS_REQUIRED: the page must report runtime.startup/);
    const observations = JSON.parse(error.message.split("; observations=")[1] ?? "{}");
    assert.deepEqual(observations.capabilities, ["clock"]);
    assert.deepEqual(observations.errors, ["startup compile error, later recovered", "startup assertion failed"]);
    assert.deepEqual(observations.consoleEntries.map((entry: { text: string }) => entry.text), observations.errors);
    assert.deepEqual(observations.networkEntries, []);
    return true;
  });
  assert.deepEqual(state.events.slice(-5), cleanup);
});

test("a startup failure is not a dead-server diagnosis", async () => {
  state.startupError = new Error("TN_PLAYTEST_STARTUP_NOT_READY");
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => assert.fail("must not capture")), /STARTUP_NOT_READY/);
  assert.deepEqual(state.events.slice(-5), cleanup);
});

test("software adapters require explicit permission", async () => {
  state.software = true;
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => 1), /ADAPTER_REJECTED/);
  assert.equal(await withBrowserCapture({ ...captureConfig(directory), allowSoftwareAdapter: true }, async () => 7), 7);
});

test("blank frames are not written as successful screenshots", async () => {
  state.blank = true;
  await writeFile(join(directory, "blank.png"), "stale successful capture");
  await assert.rejects(withBrowserCapture(captureConfig(directory), (session) => session.screenshot("blank")), /TN_CAPTURE_BLANK/);
  assert.ok(!(await readdir(directory)).includes("blank.png"));
  assert.deepEqual(state.events.slice(-5), cleanup);
});

test("capture labels cannot escape the artifact directory", async () => {
  await assert.rejects(withBrowserCapture(captureConfig(directory), (session) => session.screenshot("../escape")), /LABEL_INVALID/);
  assert.ok(!state.events.includes("screenshot"));
});

test("a hung callback is bounded and releases its browser/display/lock", async () => {
  await assert.rejects(withBrowserCapture({ ...captureConfig(directory), timeoutMs: 20 }, () => new Promise<never>(() => undefined)), /TIMEOUT: custom capture callback/);
  assert.deepEqual(state.events.slice(-5), cleanup);
});

test("cancellation during a callback returns resources", async () => {
  const controller = new AbortController();
  const failure = new Error("cancel capture");
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => {
    controller.abort(failure);
    return new Promise<never>(() => undefined);
  }, controller.signal), (error) => error === failure);
  assert.deepEqual(state.events.slice(-5), cleanup);
});

test("pre-cancelled captures acquire nothing", async () => {
  const controller = new AbortController(); controller.abort(new Error("already cancelled"));
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => 1, controller.signal), /already cancelled/);
  assert.deepEqual(state.events, []);
});

test("a hung context creation still disposes its owning browser", async () => {
  state.contextHangs = true;
  await assert.rejects(withBrowserCapture({ ...captureConfig(directory), timeoutMs: 20 }, async () => 1), /TIMEOUT: context creation/);
  assert.deepEqual(state.events.slice(-5), cleanup);
});


test("a native scenario cannot be relabelled as browser evidence", async () => {
  state.target = "desktop";
  await assert.rejects(withBrowserCapture(captureConfig(directory), async () => 1), /TN_CAPTURE_SESSION_TARGET/);
  assert.deepEqual(state.events, []);
});
