// The public software-adapter fact, executed on the real native host, driving the template's own
// quality policy.
//
// Three earlier proofs each cover one link and none covers the path a game takes: the forced
// SwiftShader browser run proves the policy answers `low` on a CPU rasteriser, and the desktop STUB
// unit feeds a synthetic adapter to the classifier. `createRenderer` is internal to core, so the
// public way to reach the fact is what a game does: `game.start()`, then `ctx.renderer.softwareAdapter`,
// then the template's `resolveQualityTier`. This runs that on the built host — bundle, launch,
// observe — and classifies the adapter identity from a separate `requestAdapter()` read.
//
// What it does and does not claim: it proves the fact is produced and the policy consumes it on
// THIS host. A hardware host reports `softwareAdapter: null` and the high tier, which says nothing
// about a software adapter natively — that half is proven by the browser SwiftShader run. The
// assertions are written as the relationship rather than the value, so they hold for either class.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
// The classifier every capture lane already refuses to run without, reused rather than restated: it
// is what decides software from hardware for a browser run, so the same function decides it here.
import { softwareAdapterName } from "../../playtest/src/runner/browser.js";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const ROOT = join(import.meta.dirname, "..");
const WORKSPACE = join(ROOT, "..", "..");
const SMOKE_SRC = join(WORKSPACE, "examples", "native-smoke", "src");
const ENTRY = join(SMOKE_SRC, "adapter-policy.mjs");
const FRAMES = 3;
const IDENTITY_FIELDS = ["architecture", "description", "device", "vendor"];

function findBinary() {
  for (const candidate of [join(ROOT, "build", "tn-linux", "mystral"), join(ROOT, "build", "tn-linux-quickjs", "mystral")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("TN_ADAPTER_POLICY_NO_BINARY: build the desktop host first (pnpm native:build)");
}

/** The pinned runtime-native esbuild, the same one the Android proof bundle is built with. */
function esbuild() {
  const candidate = join(ROOT, "node_modules", ".bin", "esbuild");
  assert.ok(existsSync(candidate), `${candidate} is missing: run pnpm install in packages/runtime-native`);
  return candidate;
}

function buildBundle() {
  const out = join(makeTempDirSync("tn-adapter-policy-"), "bundle.js");
  execFileSync(esbuild(), [
    ENTRY,
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=es2022",
    `--outfile=${out}`,
    // `import.meta.env` is a Vite-ism; core reads it behind an optional chain and the host has no
    // bundler-defined value, which is the same substitution the Android proof bundle relies on.
    "--log-level=error",
    "--define:import.meta.env={}",
  ], { cwd: WORKSPACE, encoding: "utf8", timeout: 120_000 });
  assert.ok(existsSync(out), "esbuild produced no bundle");
  return out;
}

/**
 * Runs the real host on a private display and returns its RECEIPT, never its stdout alone.
 *
 * The host prints the fixture's marker from `enter()`, before any frame is presented and long
 * before the screenshot is written, so stdout alone cannot say the run finished: a host that
 * printed the marker and then died — a lost device, a failed save — carries the same marker as a
 * clean one. `spawnSync` keeps the child's exit status, which `execFileSync` threw away behind a
 * catch that returned the partial output as if it were the result. Never `xvfb-run`.
 */
function runHost(bundle, screenshotPath) {
  const dir = makeTempDirSync("tn-adapter-policy-run-");
  const shot = screenshotPath ?? join(dir, "shot.png");
  const child = spawnSync(
    "sh",
    [join(WORKSPACE, "scripts", "xvfb.sh"), "env", "SDL_VIDEODRIVER=x11", findBinary(),
      "run", bundle, "--screenshot", shot, "--frames", String(FRAMES)],
    // A host without a usable GPU logs one line per adapter probe. The 1 MB default cap turns that
    // log into ENOBUFS, which hides the host's verdict, so the cap is raised well past it.
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  return {
    error: child.error,
    output: `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
    presents: Number(/TN_PRESENTS:(\d+)/u.exec(child.stdout ?? "")?.[1] ?? Number.NaN),
    screenshot: shot,
    status: child.status,
  };
}

/**
 * What a finished host run must actually show: it exited clean, it presented the frames it was
 * asked for, and the capture is on disk and not empty.
 *
 * Every clause is a receipt the marker cannot forge. `TN_PRESENTS` is the host's own count of
 * presented frames; a run that printed the marker from `enter()` and never got there leaves it
 * absent, which is `NaN` and fails the comparison rather than defaulting to a pass.
 */
function assertFinishedRun(run) {
  assert.equal(run.error, undefined, `the host did not run to a verdict: ${String(run.error)}`);
  assert.equal(
    run.status,
    0,
    `the host exited ${run.status} — a marker printed before the frames is not a completed run:\n${run.output.slice(-2000)}`,
  );
  assert.doesNotMatch(run.output, /TN_NATIVE_ADAPTER_POLICY_FAILED/u, "the fixture failed on the host");
  assert.match(run.output, new RegExp(`Rendered ${FRAMES} frames`, "u"), "the host reported no frame count");
  assert.ok(
    Number.isInteger(run.presents) && run.presents >= FRAMES,
    `the host presented ${run.presents} of the ${FRAMES} frames it was asked for`,
  );
  assert.ok(existsSync(run.screenshot), `the host saved no screenshot at ${run.screenshot}`);
  assert.ok(statSync(run.screenshot).size > 0, `the screenshot at ${run.screenshot} is empty`);
}

function observePolicy(output) {
  const line = /TN_NATIVE_ADAPTER_POLICY:(\{.*\})/u.exec(output);
  assert.ok(
    line,
    `the host ran the bundle without reporting the policy marker:\n${output.slice(-2000)}`,
  );
  return JSON.parse(line[1]);
}

/**
 * The relationship between core's public fact and an identity read beside it.
 *
 * `softwareAdapterName` is the existing classifier, given the four fields the second read observed.
 * The fact and the classifier therefore have independent sources — `createRenderer`'s own
 * `requestAdapter` against the fixture's — and the assertions below are the relationship between
 * them. An earlier version derived the expected class from the fact it was checking, which made a
 * corrupted flag its own proof: a `swiftshader` string beside a real NVIDIA identity selected
 * `software` and `low`, and passed.
 */
function assertPolicyFollowsIdentity(observed) {
  // The WebGPU branch is the one that produces the fact; a webgl2 fallback reports no adapter
  // identity at all, and a run that got there proved nothing about adapter.info.
  assert.equal(observed.kind, "webgpu", "the host fell back past the WebGPU renderer");

  const identity = observed.identity ?? {};
  for (const field of IDENTITY_FIELDS) {
    assert.ok(
      typeof identity[field] === "string" && identity[field].length > 0,
      `adapter.info.${field} was not observed on this host`,
    );
  }

  // The combined identity core builds from those fields and hands the pipeline census: proof the
  // four reads became one adapter identity on this host, not four unrelated strings.
  assert.equal(
    typeof observed.censusIdentity,
    "string",
    "the pipeline census recorded no adapter identity on this host",
  );
  for (const field of IDENTITY_FIELDS) {
    assert.ok(
      observed.censusIdentity.includes(`${field}=`),
      `the census identity carries no ${field}: ${observed.censusIdentity}`,
    );
  }

  const expectedSoftware = softwareAdapterName(identity) ?? null;
  assert.equal(
    observed.softwareAdapter,
    expectedSoftware,
    `core reported ${JSON.stringify(observed.softwareAdapter)} where the observed identity classifies as ${JSON.stringify(expectedSoftware)}`,
  );
  const adapterClass = expectedSoftware === null ? "hardware" : "software";
  assert.equal(observed.adapterClass, adapterClass, "the reported class disagrees with the observed identity");

  // The relationship, not the value: this host is hardware, so `high` is its honest answer and
  // says nothing about a software adapter natively. Both halves follow from the observed identity.
  assert.equal(observed.policyTier, adapterClass === "hardware" ? "high" : "low");
  assert.equal(observed.renderChainTier, observed.policyTier === "low" ? "low" : null);

  // The software branch of the same policy, executed natively because it is pure. This is where a
  // low preset that chose `low` but left the chain's own tier at its default gets caught: the tier
  // a game PICKS and the tier the chain RUNS AT are two settings, and only one of them was ever
  // set. (Commit 9515d989c was the same defect found on a browser software rasteriser.)
  assert.deepEqual(observed.softwarePolicy, { renderChainTier: "low", tier: "low" });
}

/** One host run, shared by the assertions and by both controls, so the suite launches the host once. */
let sharedRun;
function hostRun() {
  if (sharedRun === undefined) sharedRun = runHost(buildBundle());
  return sharedRun;
}

test("native: the public softwareAdapter fact drives the template's quality tier", () => {
  assert.ok(existsSync(ENTRY), `${ENTRY} is missing`);

  const run = hostRun();
  assertFinishedRun(run);
  assertPolicyFollowsIdentity(observePolicy(run.output));
}, 180_000);

test("native: a marker from a host that then exits nonzero is not a completed run", () => {
  // The first version of this file caught every host error and returned the partial stdout, so a
  // run that printed the marker and died on the screenshot save reported the marker and passed.
  // Reproduced against the real host by pointing --screenshot at a directory that does not exist:
  // exit 1, marker printed, no capture. The receipt check has to reject that shape.
  const run = hostRun();
  const crashed = { ...run, output: run.output, screenshot: join(makeTempDirSync("tn-adapter-policy-crash-"), "shot.png"), status: 1 };
  assert.throws(() => assertFinishedRun(crashed), /exited 1/u);

  // And the same rejection for a run that reported frames it never presented.
  assert.throws(() => assertFinishedRun({ ...run, presents: 0 }), /presented 0 of the 3 frames/u);
});

/**
 * The negative control: a `softwareAdapter` fact that CONTRADICTS the identity beside it is rejected,
 * on either host class.
 *
 * An assertion that derives the expected class from the fact under test calls whatever that fact
 * says, picks the tier it implies, and passes — the fact becomes its own witness. So the corrupted
 * value is the one this host does NOT have, and the expectation comes from the OBSERVED identity:
 * `softwareAdapterName` on the four fields core read. A software host (a CI runner's Mesa llvmpipe)
 * names software and picks `low`; a hardware host names nothing and picks `high`.
 */
function assertContradictingFactRejected(observed) {
  const classified = softwareAdapterName(observed.identity ?? {}) ?? null;
  const corrupted = classified === null ? "swiftshader" : null;
  // Substring, not a regex: the classified name is an adapter description, and `(` in one of them
  // would otherwise turn the expectation into a group.
  const expected = `where the observed identity classifies as ${JSON.stringify(classified)}`;
  // The whole self-consistent chain a wrong flag produces: the fact, the class it selects, and the
  // tier that class picks. Every one of those agrees with the others, and none of them agrees with
  // the identity beside them.
  assert.throws(
    () => assertPolicyFollowsIdentity({
      ...observed,
      adapterClass: corrupted === null ? "hardware" : "software",
      policyTier: corrupted === null ? "high" : "low",
      renderChainTier: corrupted === null ? null : "low",
      softwareAdapter: corrupted,
    }),
    (error) => typeof error?.message === "string" && error.message.includes(expected),
    `the rejection did not name the observed classification: ${expected}`,
  );
}

test("native: a softwareAdapter fact that contradicts the observed identity is rejected", () => {
  assertContradictingFactRejected(observePolicy(hostRun().output));
});

// CI run 36866893285 ran this file on a software host and failed it before the control above could
// prove anything: it asserted `softwareAdapter === null` as a PRECONDITION, so a Mesa llvmpipe
// runner — which correctly reports its own software name — was a red before any control ran. The
// identity below is that runner's reported description; the other three fields are only there so
// `adapter.info` has all four (the real host fills them, and this asserts the control's behaviour,
// not a byte-exact capture). The claim is that the control holds on a software host too.
test("native: the contradicting-fact control also holds on a software host", () => {
  const identity = {
    architecture: "vulkan",
    description: "llvmpipe: Mesa 25.2.8-0ubuntu0.24.04.3 (LLVM 20.1.2)",
    device: "Mesa 25.2.8 (LLVM 20.1.2)",
    vendor: "mesa",
  };
  const software = softwareAdapterName(identity);
  assert.ok(software !== undefined, "the classifier no longer names a llvmpipe adapter");
  // The honest report for that host: the fact is the name the classifier read, the class is
  // software, and the policy picked the low tier.
  const observed = {
    adapterClass: "software",
    censusIdentity: IDENTITY_FIELDS.map((field) => `${field}=${identity[field]}`).join("|"),
    identity,
    kind: "webgpu",
    policyTier: "low",
    renderChainTier: "low",
    softwareAdapter: software,
    softwarePolicy: { renderChainTier: "low", tier: "low" },
  };
  assertPolicyFollowsIdentity(observed);
  // And the control that catches a fact claiming hardware beside a software identity.
  assertContradictingFactRejected(observed);
});

test("native: the bundle is a real core build, not a stubbed renderer", () => {
  // The whole claim rests on this file being the public core bundle. A fixture that reimplemented
  // `softwareAdapter` would pass the marker assertion above while proving nothing.
  const bundle = readFileSync(buildBundle(), "utf8");
  assert.match(bundle, /softwareAdapter/u);
  assert.match(bundle, /swiftshader\|llvmpipe/u, "core's software-adapter classifier must be in the bundle");
});