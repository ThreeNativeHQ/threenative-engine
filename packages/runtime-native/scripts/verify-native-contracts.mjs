#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildNativeTarget,
  configureMetaHumanVerificationBuild,
  configurePhysicsVerificationBuild,
  configureVideoVerificationBuild,
  desktopBuildDirectory,
  nativeTestExecutable,
  resolveCmake,
  run,
  runtimeRoot,
} from "./native-test-lane.mjs";

const temporaryDirectoryArgument = "$THREENATIVE_TEMPORARY_DIRECTORY";
const physicsTarget = "threenative-physics-actuation-bindings-test";
const metahumanTarget = "threenative-metahuman-bindings-test";
const videoTarget = "threenative-video-recorder-state-test";

export const executionContracts = {
  "threenative-transient-attachments-test": {
    invocations: [
      { args: [], passLine: "native transient attachments host contract passed:" },
      { args: ["--feature-off"], passLine: "native transient attachments host contract passed:" },
      { args: ["--direct"], passLine: "native transient attachments host contract passed:" },
    ],
  },
  "threenative-exposure-graph-test": {
    invocations: [
      { args: [], passLine: "native exposure graph contract passed" },
      { args: ["--inject-validation"], passLine: "native exposure validation negative control passed" },
    ],
  },
  "threenative-pipeline-cache-test": {
    invocations: [{ args: [], passLine: "pipeline cache filesystem contract passed:" }],
  },
  "threenative-audio-decode-ogg-test": {
    invocations: [{ args: [], passLine: "native Ogg Vorbis decode contract passed on " }],
  },
  "threenative-audio-decode-promise-test": {
    invocations: [{ args: [], passLine: "native decodeAudioData Promise contract passed on " }],
  },
  "threenative-audio-graph-test": {
    invocations: [{ args: [], passLine: "audio graph ok:" }],
  },
  "threenative-bindings-creation-test": {
    // The pass marker is `proof: <name>`, matching the behaviour-proof protocol that
    // `tn_register_contract_test` declares in CMakeLists.txt and that
    // `tests/webgpu-bindings-contract.test.mjs` asserts. This entry still named the marker the
    // test printed before that protocol existed, so the target failed everywhere it ran while
    // exiting 0 and printing its proof.
    invocations: [{ args: [], passLine: "proof: creation-refusal" }],
  },
  "threenative-command-encoder-class-table-test": {
    invocations: [{ args: [], passLine: "command-encoder-class-table: prototype=shared" }],
  },
  "threenative-frame-op-stream-replay-test": {
    invocations: [{ args: [], passLine: "frame op stream replay contract passed" }],
  },
  "threenative-render-pass-class-table-test": {
    invocations: [{ args: [], passLine: "render-pass-class-table: prototype=shared" }],
  },
  // One pass line for both lanes. With `TN_ENABLE_CSS_UI=ON` it is the CSS backend's own contract
  // (frames, hit test, one click in the game's queue); with the option off, which is what these two
  // configurations are, it is the refusal contract — the renderer is refused by name and the host
  // reports no overlay. Neither arm is a no-op that passes by printing.
  "threenative-css-ui-overlay-test": {
    invocations: [{ args: [], passLine: "native-css overlay contract passed: " }],
  },
  "threenative-crash-handler-policy-test": {
    // POSIX only. The test drives `sigaction` and `siginfo_t` directly, which MSVC does not
    // provide, and the Windows host installs a different crash handler — so on Windows this is a
    // contract that does not exist, not one that is skipped. Declared here because the target is
    // guarded in CMakeLists.txt, and this file fails closed on a contract with no target.
    platforms: ["darwin", "linux"],
    invocations: [{ args: [], passLine: "native crash-handler policy contract passed" }],
  },
  "threenative-dom-dispatch-lifetime-test": {
    invocations: [
      {
        args: [],
        passLine: "[dom-dispatch-lifetime] window and document dispatch survived clearFrameHandles",
      },
    ],
  },
  "threenative-embedded-bundle-test": {
    invocations: [{ args: [], passLine: "embedded_bundle bindings: all assertions passed" }],
  },
  "threenative-handle-lifetime-test": {
    invocations: [
      {
        args: ["v8"],
        passLine: "engine=v8 handles-created=512 handles-freed=512 outstanding=0",
      },
    ],
  },
  "threenative-input-restart-test": {
    invocations: [
      {
        args: [],
        passLine:
          "[input-restart] listener identity and capture survived restart, main canvas, and renderer canvas",
      },
    ],
  },
  "threenative-js-engine-contract-test": {
    invocations: [{ args: [], passLine: "js-engine-contract: engine=V8 property=own-data" }],
  },
  "threenative-canvas2d-dirty-test": {
    invocations: [{ args: [], passLine: "canvas2d dirty tracking passed" }],
  },
  "threenative-worker-production-test": {
    invocations: [{ args: [], passLine: "[worker-production] every worker contract held" }],
  },
  "threenative-lifecycle-policy-test": {
    invocations: [{ args: [], passLine: "native lifecycle policy contract passed" }],
  },
  "threenative-presentation-pacing-test": {
    invocations: [{ args: [], passLine: "PRESENTATION_PACING_OK" }],
  },
  "threenative-canvas-presentation-test": {
    invocations: [{ args: [], passLine: "native canvas presentation pixels passed" }],
  },
  "threenative-surface-texture-status-test": {
    invocations: [{ args: [], passLine: "native surface acquisition status contract passed" }],
  },
  "threenative-local-storage-test": {
    invocations: [{ args: [], passLine: "local_storage bindings: all assertions passed" }],
  },
  "threenative-physics-actuation-bindings-test": {
    invocations: [{ args: [], passLine: "native physics actuation bindings passed" }],
  },
  "threenative-metahuman-bindings-test": {
    invocations: [{ args: [], passLine: "native metahuman bindings passed" }],
  },
  "threenative-rt-handle-allocation-test": {
    invocations: [{ args: [], passLine: "raytracing handle allocation contract passed" }],
  },
  "threenative-screenshot-capture-gate-test": {
    invocations: [{ args: [], passLine: "native screenshot capture gate contract passed" }],
  },
  "threenative-shader-module-metadata-test": {
    invocations: [
      {
        args: [],
        passLine: "shader-module-metadata: wrapper=erase+release-once duplicate-wrapper-refs=release-each teardown=release-survivors",
      },
    ],
  },
  "threenative-shutdown-lifetime-test": {
    invocations: [
      {
        args: ["http"],
        passLine: "[shutdown-lifetime] exited cleanly with a live keep-alive socket",
      },
      {
        args: ["timer-watch", temporaryDirectoryArgument],
        passLine: "[shutdown-lifetime] exited cleanly with an active interval and watch",
      },
    ],
  },
  // PRD-228 Phase 1. Needs no display: it asserts the CSS-box / backing-store / ratio invariant,
  // which holds at every density including a headless display's 1.0.
  "threenative-device-pixel-ratio-test": {
    invocations: [{ args: [], passLine: "native device pixel ratio contract passed" }],
  },
  // PRD-228 Change B. Needs no display: it drives the real bindings through a headless Runtime,
  // times a compute dispatch at both ends and resolves the query set into a mappable buffer.
  // PRD-327 Phase 0. Needs no display: it drives the raw backend behind a headless Runtime's
  // device, times a synchronous pipeline compile against the async entry's call, and destroys the
  // descriptor before polling so a backend that reads it after returning fails here rather than in
  // a game's first frame.
  "threenative-async-pipeline-thread-test": {
    invocations: [{ args: [], passLine: "native async pipeline thread contract passed" }],
  },
  // PRD-327 Phase 4. Needs no display and no GPU: it drives the header-only launch instruments
  // directly — launch attribution, the post-present per-frame pipelineCompile accumulator, and
  // the TN_FRAME_HITCH payload that names a late synchronous compile.
  // Header-only CPU drivers can prove envelope/device lifetime, never compiled-data growth.
  "threenative-pipeline-cache-lifecycle-test": {
    invocations: [{ args: [], passLine: "native pipeline cache contract passed" }],
  },
  // PRD-368 Phases 1A and 1B. Needs no display: it drives the patched wgpu-native cache API by
  // hand on a headless device, then drives four pipelines through the host's own JavaScript
  // bindings and requires the device cache to grow past the bytes an empty one holds. It passes on
  // a build that has no cache API and on an adapter that does not advertise the feature -- both
  // print TN_PIPELINE_CACHE_UNAVAILABLE, which is the contract, not a skip.
  "threenative-pipeline-cache-api-test": {
    invocations: [{ args: [], passLine: "native pipeline cache contract passed" }],
  },
  "threenative-stall-budget-hitch-test": {
    invocations: [{ args: [], passLine: "native stall budget hitch contract passed" }],
  },
  "threenative-timestamp-query-test": {
    invocations: [{ args: [], passLine: "native timestamp-query bindings contract passed" }],
  },
  // The rg11b10ufloat-renderable bindings. Needs no display: a raw Dawn oracle is compared
  // against the JS feature surfaces and a render pass into the format must leave the device
  // alive — the pass that was the pre-fix device loss behind three's SSGI target.
  "threenative-rg11b10-renderable-test": {
    invocations: [{ args: [], passLine: "native rg11b10 renderable bindings contract passed" }],
  },
  "threenative-timer-delivery-test": {
    invocations: [{ args: [], passLine: "native timer delivery contract passed" }],
  },
  "threenative-timer-engine-first-test": {
    invocations: [{ args: [], passLine: "native engine-first timer delivery contract passed" }],
  },
  "threenative-video-recorder-state-test": {
    invocations: [{ args: [], passLine: "native video recorder missing-state guard passed" }],
  },
  "threenative-webgpu-bindings-reentrancy-test": {
    invocations: [{ args: [], passLine: "native WebGPU bindings reentrancy passed" }],
  },
  "threenative-webtransport-surface-test": {
    invocations: [{ args: [], passLine: "native webtransport surface contract passed" }],
  },
  "threenative-webtransport-wire-test": {
    invocations: [{ args: [], passLine: "webtransport wire contract passed" }],
  },
  "threenative-wgpu-null-handle-test": {
    invocations: [{ args: [], passLine: "native wgpu NULL-handle contract passed" }],
  },
  "threenative-surface-format-selection-test": {
    invocations: [{ args: [], passLine: "surface-format-selection: PASS" }],
  },
  "threenative-webgpu-comprehensive-test": {
    invocations: [{ args: [], passLine: "native WebGPU comprehensive contract passed" }],
  },
  "threenative-js-module-comprehensive-test": {
    invocations: [{ args: [], passLine: "native JS module comprehensive contract passed" }],
  },
  "threenative-runtime-platform-comprehensive-test": {
    invocations: [{ args: [], passLine: "native runtime and platform comprehensive contract passed" }],
  },
  "threenative-canvas-audio-comprehensive-test": {
    invocations: [{ args: [], passLine: "native canvas and audio comprehensive contract passed" }],
  },
  "threenative-cli-network-fs-test": {
    invocations: [{ args: [], passLine: "native CLI network and FS comprehensive contract passed" }],
  },
};

/**
 * Every `threenative-*-test` target `add_executable` writes, paired with the `if()` conditions it
 * is nested inside, outermost first. Discovery reads CMakeLists.txt as text and cannot evaluate a
 * condition, so a caller that has to tell "this target is in every configure" from "this target
 * appears only when its dependency was found" reads the conditions instead of guessing from a flat
 * list of names.
 */
export function discoverNativeTestTargetConditions(cmakeSource) {
  const conditions = new Map();
  const enclosing = [];
  for (const rawLine of cmakeSource.split("\n")) {
    const line = rawLine.replace(/#.*$/u, "");
    if (/^\s*if\s*\(/iu.test(line)) enclosing.push(line.trim());
    else if (/^\s*endif\s*\(/iu.test(line)) enclosing.pop();
    const declared = /add_executable\(\s*(threenative-[a-z0-9-]+-test)\b/u.exec(line);
    if (declared !== null) conditions.set(declared[1], [...enclosing]);
  }
  if (enclosing.length !== 0) {
    throw new Error(`CMakeLists.txt left ${enclosing.length} if() block(s) unclosed`);
  }
  return conditions;
}

export function discoverNativeTestTargets(cmakeSource) {
  const discovered = [...discoverNativeTestTargetConditions(cmakeSource).keys()].sort();
  if (discovered.length === 0) throw new Error("discovered zero native contract test targets");
  return discovered;
}

/**
 * The targets that carry a condition beyond the ones every test target shares, mapped to those
 * extra conditions. Every native test target sits inside the same desktop platform guard, which
 * says nothing about any one of them; a target with something further - `if(TN_ENABLE_VIDEO)`,
 * `if(TARGET quiche::quiche)` - is configured only when that dependency is present, and a configure
 * without it omits the target for a good reason. The shared guard is whatever all of them have in
 * common rather than a string written down here, so moving the tests under a different guard does
 * not silently turn every target optional.
 */
export function optionallyConfiguredNativeTestTargets(cmakeSource) {
  const conditions = discoverNativeTestTargetConditions(cmakeSource);
  const stacks = [...conditions.values()];
  const shared = stacks.reduce(
    (common, stack) => common.filter((condition) => stack.includes(condition)),
    stacks[0] ?? [],
  );
  return new Map(
    [...conditions]
      .map(([target, stack]) => [target, stack.filter((condition) => !shared.includes(condition))])
      .filter(([, extra]) => extra.length > 0),
  );
}

/**
 * Conditional targets that neither mechanism accounts for. A target written under an extra
 * condition is absent from some configures, and exactly one of two things has to say so: a
 * platform guard is declared by its contract's `platforms` list, and a dependency guard registers
 * a blocked placeholder with `tn_register_blocked_test`, which tells CTest the target exists and
 * why it is not running. A target that does neither leaves the coverage lane unable to tell "this
 * dependency is absent" from "this registration is broken", so it fails on the honest case.
 * Returns the targets that leave that hole; an empty list is the passing state.
 */
export function targetsMissingBlockedRegistration(cmakeSource, contracts = executionContracts) {
  return [...optionallyConfiguredNativeTestTargets(cmakeSource).keys()]
    .filter((target) => contracts[target]?.platforms === undefined)
    .filter((target) => !cmakeSource.includes(`tn_register_blocked_test(${target}`))
    .sort();
}

/** Does this contract exist on the platform the lane is running on? */
export function contractAppliesTo(contract, platform = process.platform) {
  return contract?.platforms === undefined || contract.platforms.includes(platform);
}

export function validateExecutionContracts(discoveredTargets, contracts, platform = process.platform) {
  const discovered = new Set(discoveredTargets);
  // Discovery reads `add_executable` out of CMakeLists.txt as text, so it cannot see an
  // `if(NOT WIN32)` guard and lists POSIX-only targets on Windows too. The contract's platform
  // list is the authority on where a target exists; discovery only says what is written down.
  const missing = discoveredTargets.filter((target) => contracts[target] === undefined);
  const extra = Object.entries(contracts)
    .filter(([target, contract]) => contractAppliesTo(contract, platform) && !discovered.has(target))
    .map(([target]) => target)
    .sort();
  const errors = [];
  if (missing.length > 0) errors.push(`missing execution contracts: ${missing.join(", ")}`);
  if (extra.length > 0) errors.push(`execution contracts without targets: ${extra.join(", ")}`);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function runContractInvocations(target, contract, runTarget) {
  const failures = [];
  for (const invocation of contract.invocations) {
    try {
      const log = runTarget(target, invocation.args);
      if (!log.includes(invocation.passLine)) {
        failures.push(
          `invocation ${JSON.stringify(invocation.args)} did not report '${invocation.passLine}':\n${log}`,
        );
      }
    } catch (error) {
      failures.push(`invocation ${JSON.stringify(invocation.args)} failed: ${error.message}`);
    }
  }
  return failures;
}

function executeTarget(target, contract, buildTarget, runTarget) {
  try {
    buildTarget(target);
  } catch (error) {
    return [`build failed: ${error.message}`];
  }
  return runContractInvocations(target, contract, runTarget);
}

export function runNativeContractLane({
  buildTarget,
  contracts,
  discoveredTargets,
  report,
  runTarget,
}) {
  validateExecutionContracts(discoveredTargets, contracts);
  const failures = [];
  for (const target of discoveredTargets) {
    // A target the contract scopes to other platforms is not built here; running it would fail on
    // an executable CMake never produced. Reported rather than skipped silently, so the lane's
    // output still accounts for every target it was given.
    if (!contractAppliesTo(contracts[target])) {
      report({ failures: [], status: "SKIP", target });
      continue;
    }
    const targetFailures = executeTarget(target, contracts[target], buildTarget, runTarget);
    const status = targetFailures.length === 0 ? "PASS" : "FAIL";
    report({ failures: targetFailures, status, target });
    if (targetFailures.length > 0) failures.push(`${target}:\n${targetFailures.join("\n")}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} native contract target(s) failed:\n\n${failures.join("\n\n")}`,
    );
  }
}

export function verifyNativeContracts() {
  const cmakeSource = readFileSync(join(runtimeRoot, "CMakeLists.txt"), "utf8");
  const discoveredTargets = discoverNativeTestTargets(cmakeSource);
  validateExecutionContracts(discoveredTargets, executionContracts);
  const cmake = resolveCmake();
  const shippingBuildDirectory = desktopBuildDirectory();
  let physicsBuildDirectory;
  let metahumanBuildDirectory;
  let videoBuildDirectory;
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "threenative-shutdown-lifetime-"));
  try {
    runNativeContractLane({
      buildTarget(target) {
        if (target === physicsTarget && physicsBuildDirectory === undefined) {
          physicsBuildDirectory = configurePhysicsVerificationBuild(cmake);
        }
        if (target === metahumanTarget && metahumanBuildDirectory === undefined) {
          metahumanBuildDirectory = configureMetaHumanVerificationBuild(cmake);
        }
        if (target === videoTarget && videoBuildDirectory === undefined) {
          videoBuildDirectory = configureVideoVerificationBuild(cmake);
        }
        let buildDirectory = shippingBuildDirectory;
        if (target === physicsTarget) buildDirectory = physicsBuildDirectory;
        if (target === metahumanTarget) buildDirectory = metahumanBuildDirectory;
        if (target === videoTarget) buildDirectory = videoBuildDirectory;
        buildNativeTarget(cmake, buildDirectory, target);
      },
      contracts: executionContracts,
      discoveredTargets,
      report({ failures, status, target }) {
        console.info(`${status} ${target}`);
        for (const failure of failures) console.error(`  ${failure}`);
      },
      runTarget(target, args) {
        let buildDirectory = shippingBuildDirectory;
        if (target === physicsTarget) buildDirectory = physicsBuildDirectory;
        if (target === metahumanTarget) buildDirectory = metahumanBuildDirectory;
        if (target === videoTarget) buildDirectory = videoBuildDirectory;
        const resolvedArgs = args.map((argument) =>
          argument === temporaryDirectoryArgument ? temporaryDirectory : argument,
        );
        return run(nativeTestExecutable(buildDirectory, target), resolvedArgs, {
          timeout: 120_000,
        });
      },
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
  return discoveredTargets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = verifyNativeContracts();
  console.info(`native contract lane passed: ${targets.length} of ${targets.length} targets`);
}
