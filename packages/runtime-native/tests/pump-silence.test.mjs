// PRD-360 pump-silence observer: real-host green proof.
//
// The observer (`include/mystral/pump_silence.h`) stamps every pollEvents()
// entry on the coldStartNowMs() clock and emits one TN_PUMP_SILENCE line at a
// bounded endpoint (first present, else shutdown). HostGapMeter is rAF-keyed,
// drops >2s periods and gates on a full window: unsuitable, and untouched.
// Missing observation (no line, or observed:false) is failure, never a pass.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const ROOT = join(import.meta.dirname, "..");
const EVALUATOR_SOURCE = join(
  ROOT,
  "..",
  "..",
  "docs",
  "verification",
  "prd-360-startup-2026-09-05",
  "evaluate-first-playable.mjs.txt",
);
const RUNTIME_SRC = readFileSync(join(ROOT, "src", "runtime.cpp"), "utf8");
const PRES_SRC = readFileSync(join(ROOT, "src", "webgpu", "bindings_presentation.cpp"), "utf8");
const HEADER = readFileSync(join(ROOT, "include", "mystral", "pump_silence.h"), "utf8");

function findBinary() {
  for (const candidate of [
    join(ROOT, "build", "tn-linux", "mystral"),
    join(ROOT, "build", "tn-linux-quickjs", "mystral"),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("TN_PUMP_PROBE_NO_BINARY: build the desktop host first (pnpm native:build)");
}

// Runs the real desktop host. Never xvfb-run (its cleanup kill replaces the
// command status); SDL_VIDEODRIVER=x11 is what verify-desktop-core.mjs sets.
// `screenshot`: the presenting path, so the bounded first-frame endpoint fires.
// `plain`: `run` without `--screenshot`, so the main-loop-exit endpoint fires
// (a never-presenting run proves the shutdown flush).
function runHost(bundlePath, mode = "screenshot") {
  const dir = makeTempDirSync("tn-pump-");
  const shot = join(dir, "shot.png");
  const xvfb = join(ROOT, "..", "..", "scripts", "xvfb.sh");
  const args =
    mode === "screenshot"
      ? ["run", bundlePath, "--screenshot", shot, "--frames", "5"]
      : ["run", bundlePath];
  try {
    return execFileSync("sh", [xvfb, "env", "SDL_VIDEODRIVER=x11", findBinary(), ...args], {
      cwd: dir,
      encoding: "utf8",
      // The default 1 MB cap cuts off a host's log, and the pump line is often after the cut.
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (error) {
    return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
}

function runHostKill(bundleJs) {
  // SIGKILL mid-run: no graceful exit is possible, so no endpoint line can
  // exist. The harness must treat the missing line as failure, never a pass.
  const dir = makeTempDirSync("tn-pump-kill-");
  const bundle = join(dir, "game.js");
  const hostPidFile = join(dir, "host.pid");
  writeFileSync(bundle, bundleJs);
  const xvfb = join(ROOT, "..", "..", "scripts", "xvfb.sh");
  return new Promise((resolve) => {
    const chunks = [];
    const controller = 'printf "%s\\n" "$$" > "$1"; shift; exec "$@"';
    const child = spawn(
      xvfb,
      [
        "env",
        "SDL_VIDEODRIVER=x11",
        "sh",
        "-c",
        controller,
        "tn-pump-kill",
        hostPidFile,
        findBinary(),
        "run",
        bundle,
      ],
      { cwd: dir },
    );
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));

    const killHost = () => {
      try {
        const hostPid = Number(readFileSync(hostPidFile, "utf8"));
        if (!Number.isInteger(hostPid) || hostPid <= 0) throw new Error("invalid host pid");
        process.kill(hostPid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    };

    setTimeout(() => {
      if (!killHost()) child.kill("SIGTERM");
    }, 3000);
    setTimeout(() => {
      killHost();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }, 6000);
  });
}

const SMOKE = join(ROOT, "..", "..", "examples", "native-smoke", "dist", "native-smoke.js");

function pumpLine(log) {
  const line = log.split("\n").find((entry) => entry.includes("TN_PUMP_SILENCE:"));
  assert.ok(line, "TN_PUMP_SILENCE_UNOBSERVED: missing observation must fail, never pass");
  return JSON.parse(line.slice(line.indexOf("{")));
}

function endpointSnapshots(log) {
  return log
    .split("\n")
    .filter((entry) => entry.includes("TN_PUMP_ENDPOINT:"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
}

async function loadEvaluator() {
  const evaluatorPath = join(makeTempDirSync("tn-pump-evaluator-"), "evaluate-first-playable.mjs");
  writeFileSync(evaluatorPath, readFileSync(EVALUATOR_SOURCE, "utf8"));
  return import(pathToFileURL(evaluatorPath).href);
}

// Drives the real host through an actual mailbox respond() with a
// displacement-shaped payload, like device.ts dispatch() after sampling.
// Returns the host log plus the response path for coordinator correlation.
function runMailboxRespond({
  requestId = "sample-1",
  requestMethod = "sample",
  responsePathSegment = "response.json",
  stallBeforeRespondMs = 0,
} = {}) {
  const dir = makeTempDirSync("tn-pump-ep-");
  const root = join(dir, "mbox");
  mkdirSync(root, { recursive: true });
  const res = join(root, responsePathSegment);
  const bundle = join(dir, "game.js");
  const responseBody = JSON.stringify({
    id: requestId,
    result: { entities: { player: { position: [0.41, -0.02, -0.46] } } },
  });
  const spin =
    stallBeforeRespondMs > 0
      ? `const spinEnd = Date.now() + ${stallBeforeRespondMs}; while (Date.now() < spinEnd) {}`
      : "";
  writeFileSync(
    bundle,
    [
      `globalThis.TN_PLAYTEST_MAILBOX=${JSON.stringify({ request: join(root, "request.json"), response: res })};`,
      "let n = 0;",
      "const id = setInterval(() => {",
      "  n += 1;",
      "  if (n === 3) {",
      `    ${spin}`,
      `    __THREENATIVE_NATIVE__.playtest.respond(${JSON.stringify(res)}, ${JSON.stringify(responseBody)}, ${JSON.stringify(requestId)}, ${JSON.stringify(requestMethod)}, 1);`,
      "  }",
      "  if (n >= 5) { clearInterval(id); process.exit(0); }",
      "}, 50);",
    ].join("\n"),
  );
  return { log: runHost(bundle, "plain"), res };
}

test("entry stamp sits at the pollEvents() head, ahead of every early return", () => {
  const pollStart = RUNTIME_SRC.indexOf("bool pollEvents() override");
  assert.ok(pollStart >= 0, "missing pollEvents");
  const entry = RUNTIME_SRC.slice(pollStart, pollStart + 600);
  assert.match(entry, /pumpSilence\(\)\.notePumpEntry\(coldStartNowMs\(\)\)/u);
  assert.ok(
    entry.indexOf("notePumpEntry") < entry.indexOf("hostGapMeter_.begin"),
    "the pump stamp must precede the kEvents bracket",
  );
});

test("the observer keeps every long gap: no hitch filter, no windowing", () => {
  assert.doesNotMatch(HEADER, /kHitchPeriodMicros|kWindow|dropPartialFrame|noteRafBegin/u);
  assert.match(HEADER, /kLongGapMs = 250\.0/u);
  assert.match(HEADER, /longGaps_\.push_back\(gapMs\)/u);
});

// This file keeps the real-host probes and fail-closed endpoint controls. The
// former injected-clock unit contract was removed to keep the PRD phase within
// its five-file implementation/test budget.

test("bounded endpoint: first present flushes, shutdown flushes the rest", () => {
  assert.match(
    PRES_SRC,
    /pumpSilence\(\)\.flush\(mystral::coldStartNowMs\(\)\)/u,
    "first-frame endpoint must flush beside first_frame",
  );
  const shutdown = RUNTIME_SRC.slice(
    RUNTIME_SRC.indexOf("void shutdown()"),
    RUNTIME_SRC.indexOf("void shutdown()") + 500,
  );
  assert.match(shutdown, /pumpSilence\(\)\.flush\(coldStartNowMs\(\)\)/u);
  assert.match(HEADER, /if \(flushed_\) return;/u, "exactly one line per launch");
});

test("respond() stamps a non-consuming displacement-correlated endpoint", () => {
  assert.match(
    RUNTIME_SRC,
    /pumpSilence\(\)\.snapshot\(coldStartNowMs\(\)\)/u,
    "respond() must snapshot on the launch clock",
  );
  assert.match(
    RUNTIME_SRC,
    /TN_PUMP_ENDPOINT/u,
    "endpoint rides the existing diagnostic transport",
  );
  assert.match(RUNTIME_SRC, /std::cout << endpointRecord << std::endl;/u);
  assert.match(RUNTIME_SRC, /LOGI\("%s", endpointRecord\.c_str\(\)\);/u);
});

test("real host: the pump is observed at the bounded endpoint", () => {
  // The smoke bundle presents, so the first-frame endpoint fires. A rAF-keyed
  // meter would need frame callbacks; this observer needs only pump entries.
  const payload = pumpLine(runHost(SMOKE));
  assert.equal(payload.observed, true);
  assert.ok(payload.pumpCount >= 1, "at least one pump entry before the endpoint");
  assert.ok(payload.firstPumpAtMs >= 0, "launch-relative first-pump stamp");
  assert.ok(payload.trailingGapMs >= 0, "trailing interval measured, not dropped");
});

test("real host: a deliberate 400ms stall is retained, not filtered", () => {
  // The spin runs INSIDE a pump iteration (timers segment). Screenshot mode
  // presents on pump 1, so it lands in the trailing interval; the plain-mode
  // timer run below proves the inter-entry half.
  const dir = makeTempDirSync("tn-pump-stall-");
  const stalled = join(dir, "stall.js");
  const smokeSrc = readFileSync(SMOKE, "utf8");
  writeFileSync(
    stalled,
    [
      "setTimeout(() => { const end = Date.now() + 400; while (Date.now() < end) {} }, 10);",
      smokeSrc,
    ].join("\n"),
  );
  const payload = pumpLine(runHost(stalled));
  assert.ok(
    payload.maxGapMs >= 250 ||
      payload.trailingGapMs >= 250 ||
      payload.longGaps.some((gap) => gap >= 250),
    `stall discarded: ${JSON.stringify(payload)}`,
  );
});

test("real host: multi-pump inter-entry >250ms gap is retained", () => {
  // Plain `run` (no screenshot gate): a 50 ms timer keeps pumps coming, a
  // 400 ms spin at tick 6 forces a genuine inter-entry gap. Proves retention
  // independently of rAF/presentation — no frame callback is registered.
  const dir = makeTempDirSync("tn-pump-multi-");
  const bundle = join(dir, "game.js");
  writeFileSync(
    bundle,
    "let n = 0;\n" +
      "const id = setInterval(() => { n += 1; " +
      "if (n === 6) { const end = Date.now() + 400; while (Date.now() < end) {} } " +
      "if (n >= 12) { clearInterval(id); process.exit(0); } }, 50);\n",
  );
  const payload = pumpLine(runHost(bundle, "plain"));
  assert.ok(payload.pumpCount > 2, `expected many pumps, got ${payload.pumpCount}`);
  assert.ok(payload.maxGapMs >= 250, `inter-entry stall lost: ${JSON.stringify(payload)}`);
  assert.ok(
    payload.longGaps.some((gap) => gap >= 250),
    `no retained long gap: ${JSON.stringify(payload)}`,
  );
});

test("real host: shutdown without a present still flushes", () => {
  // A timer-only run never presents, so the first-frame endpoint never fires;
  // the main-loop-exit flush is the bounded endpoint. Missing line fails.
  const dir = makeTempDirSync("tn-pump-noflip-");
  const bundle = join(dir, "game.js");
  writeFileSync(
    bundle,
    "let n = 0;\nconst id = setInterval(() => { n += 1; if (n >= 4) { clearInterval(id); process.exit(0); } }, 50);\n",
  );
  const payload = pumpLine(runHost(bundle, "plain"));
  assert.equal(payload.observed, true);
  assert.ok(payload.firstPumpAtMs >= 0, "process-to-first-pump stamped");
  assert.ok(payload.trailingGapMs >= 0, "trailing interval measured at exit");
});

test("real host: SIGKILL leaves no endpoint line — missing must fail", async () => {
  const log = await runHostKill("setInterval(() => {}, 50);\n");
  assert.ok(log.includes("game_eval_begin"), "the killed run really started");
  assert.ok(
    !log.includes("TN_PUMP_SILENCE:"),
    "a killed run must not produce an observation to misread as good",
  );
  assert.throws(() => pumpLine(log), /TN_PUMP_SILENCE_UNOBSERVED/u);
});

test("real host: mailbox respond() yields a correlated endpoint snapshot", () => {
  // Full option-(a) path on the real host: the game reports through the
  // existing mailbox, the host stamps atMs on the launch clock, counters
  // survive for the later loop-exit flush.
  const { log, res } = runMailboxRespond();
  const endpoints = endpointSnapshots(log);
  assert.ok(endpoints.length >= 1, "respond() must emit TN_PUMP_ENDPOINT");
  const endpoint = endpoints.at(-1);
  assert.equal(endpoint.path, res, "endpoint correlates to the actual response path");
  assert.equal(endpoint.stored, true);
  const { pump } = endpoint;
  assert.equal(pump.observed, true);
  assert.ok(pump.atMs > pump.lastPumpAtMs, "endpoint covers the report, not a stale stamp");
  assert.ok(pump.firstPumpAtMs >= 0, "process-to-first-pump retained through endpoint");
  const diagnostics = (log.match(/TN_PUMP_SILENCE:/g) ?? []).length;
  assert.equal(diagnostics, 1, "requested snapshot must not suppress the diagnostic line");
});

test("real host: endpoint strings round-trip through the actual evaluator", async () => {
  const requestId = 'sample-"quoted"\\control\n\t\u0001';
  const { log, res } = runMailboxRespond({
    requestId,
    responsePathSegment: 'response"\\control\n\t\u0001.json',
  });
  const movementResponseBody = readFileSync(res, "utf8");
  const { evaluatePumpEndpoint } = await loadEvaluator();
  const result = evaluatePumpEndpoint({
    hostLog: log,
    movementPayload: { entity: "player", position: [0.41, -0.02, -0.46] },
    movementResponseBody,
    movementResponseObservation: {
      inputOrder: 0,
      method: "sample",
      order: 1,
      postInput: true,
      requestId,
    },
    movementResponsePath: res,
  });
  assert.ok(result.pass || result.code === "R7_PUMP_SILENCE_EXCEEDED", JSON.stringify(result));
  const endpoint = endpointSnapshots(log).at(-1);
  assert.equal(endpoint.path, res);
  assert.equal(endpoint.requestId, requestId);
  assert.equal(endpoint.requestMethod, "sample");
});

test("real host: request method controls round-trip through the actual evaluator parser", async () => {
  const requestMethod = 'sample-"quoted"\\control\n\t\u0001';
  const { log, res } = runMailboxRespond({ requestMethod });
  const movementResponseBody = readFileSync(res, "utf8");
  const { evaluatePumpEndpoint } = await loadEvaluator();
  const result = evaluatePumpEndpoint({
    hostLog: log,
    movementPayload: { entity: "player", position: [0.41, -0.02, -0.46] },
    movementResponseBody,
    movementResponseObservation: {
      inputOrder: 0,
      method: "sample",
      order: 1,
      postInput: true,
      requestId: "sample-1",
    },
    movementResponsePath: res,
  });
  assert.equal(result.code, "R7_PUMP_CORRELATION_UNPROVEN", JSON.stringify(result));
  assert.equal(result.detail.gotRequestMethod, requestMethod);
});

test("real host: >250ms trailing stall through the endpoint is rejected-worthy", () => {
  // 400 ms spin inside the pump just before respond(): the endpoint's
  // trailing interval carries it. The verifier (not this file) rejects;
  // here we prove the number actually arrives on the real host.
  const { log } = runMailboxRespond({ stallBeforeRespondMs: 400 });
  const endpoint = endpointSnapshots(log).at(-1);
  assert.ok(endpoint, "stall run must still produce the endpoint");
  assert.ok(
    endpoint.pump.trailingGapMs >= 250,
    `trailing stall lost: ${JSON.stringify(endpoint.pump)}`,
  );
});
