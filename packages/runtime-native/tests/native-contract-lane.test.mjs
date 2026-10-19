import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { buildNativeTarget } from "../scripts/native-test-lane.mjs";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

import {
  discoverNativeTestTargets,
  executionContracts,
  runNativeContractLane,
  validateExecutionContracts,
} from "../scripts/verify-native-contracts.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const cmake = readFileSync(join(root, "CMakeLists.txt"), "utf8");
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const helper = readFileSync(join(root, "scripts", "native-test-lane.mjs"), "utf8");
const coverageRunner = readFileSync(join(root, "scripts", "measure-native-coverage.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const physicsVerifier = readFileSync(join(root, "scripts", "verify-desktop-physics.mjs"), "utf8");

function selectedDesktopBuildDirectory(platform) {
  const lane = pathToFileURL(join(root, "scripts", "native-test-lane.mjs")).href;
  const program = `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} }); const lane = await import(${JSON.stringify(lane)}); console.log(lane.desktopBuildDirectory());`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function declaredTargets(source) {
  return [...source.matchAll(/add_executable\(\s*(threenative-[a-z0-9-]+-test)\b/gu)]
    .map((match) => match[1])
    .sort();
}

function registeredTargets(source) {
  return [...source.matchAll(/tn_register_contract_test\(\s*(threenative-[a-z0-9-]+-test)\b/gu)]
    .map((match) => match[1])
    .sort();
}

test("should register every native executable with CTest", () => {
  const declared = declaredTargets(cmake);
  assert.match(cmake, /enable_testing\(\)/u);
  assert.match(cmake, /function\(tn_register_contract_test target\)[\s\S]*add_test\(/u);
  assert.deepEqual(registeredTargets(cmake), declared);
  assert.equal(
    packageJson.scripts["native:test:cpp"],
    "node scripts/measure-native-coverage.mjs --ctest",
  );
  assert.match(cmake, /add_custom_target\(threenative-native-tests DEPENDS/u);
  assert.match(cmake, /tn_register_contract_test\(threenative-handle-lifetime-test v8\)/u);
  assert.match(cmake, /tn_register_contract_test\(threenative-shutdown-lifetime-test http\)/u);
  assert.match(cmake, /threenative-shutdown-lifetime-test-timer-watch[\s\S]*timer-watch/u);
  assert.match(selectedDesktopBuildDirectory("linux"), /build\/tn-linux$/u);
  assert.match(selectedDesktopBuildDirectory("darwin"), /build\/tn-macos$/u);
  assert.match(selectedDesktopBuildDirectory("win32"), /build\/tn-windows$/u);

  const withUnregisteredTarget = `${cmake}\nadd_executable(threenative-unregistered-test tests/unregistered.cpp)`;
  assert.notDeepEqual(
    registeredTargets(withUnregisteredTarget),
    declaredTargets(withUnregisteredTarget),
  );
});

test("keeps optional MetaHuman test target out of disabled sanitizer aggregates", () => {
  assert.match(cmake, /if\(TN_ENABLE_METAHUMAN\)\s*# The synthetic DNA and its reference vectors[\s\S]*add_executable\(threenative-metahuman-bindings-test[\s\S]*endif\(\)/u);
  assert.match(cmake, /if\(TN_ENABLE_METAHUMAN\)\s*tn_register_contract_test\(threenative-metahuman-bindings-test\)\s*else\(\)\s*tn_register_blocked_test\(threenative-metahuman-bindings-test\s*"TN_ENABLE_METAHUMAN=OFF"\)/u);

  assert.match(cmake, /if\(TN_ENABLE_METAHUMAN\)\s*# The facial rig is the one contract that parses untrusted bytes[\s\S]*tn_mark_sanitizer_contract_test\(threenative-metahuman-bindings-test\)\s*endif\(\)/u);
});

test("regenerates an existing native build before reading CTest registrations", () => {
  const runner = coverageRunner.slice(
    coverageRunner.indexOf("export function runNativeCtest()"),
    coverageRunner.indexOf("function registrationsForTarget"),
  );
  assert.ok(
    runner.indexOf('buildNativeTarget(cmake, buildDirectory, "threenative-native-tests"') <
      runner.indexOf("ctestRegistrations(buildDirectory, ctest)"),
  );
});

test("should fail when a declared test target is not executed", () => {
  const discovered = discoverNativeTestTargets(cmake);
  // 22 through PRD-224 step 1; +1 for the render-pass class table; +1 for PRD-227's executable
  // packed frame-stream replay contract; +1 for the canvas 2D dirty-tracking contract; +1 for
  // PRD-228's timestamp-query bindings; +1 for its device-pixel-ratio contract; +1 for PRD-250
  // Phase 2's worker production contract; +2 for the webtransport wire and surface contracts;
  // +1 for the rg11b10ufloat-renderable bindings contract; +1 for PRD-327's async pipeline
  // thread contract; +1 for PRD-327 Phase 4's stall-budget hitch shape contract; +1 for the
  // screenshot capture-gate ordering contract; +1 for PRD-329's surface-format selection
  // diagnostic contract; +5 for the comprehensive coverage contracts; +1 for PRD-368's pipeline
  // cache contract; +1 for PRD-399's presentation-pacing contract; +1 for PRD-465 Phase 2's
  // MetaHuman facial rig bindings contract; +1 for VQ07's surface acquisition status contract.; +1 for the desktop CSS UI overlay contract.
  // Bump alongside any new add_executable contract target.
  // 50 targets include the transient attachment host contract.
  // itself, so the literal is a tripwire for an unreviewed target, not the source of truth.
  assert.equal(discovered.length, 50);
  const missingExposure = { ...executionContracts };
  Reflect.deleteProperty(missingExposure, "threenative-exposure-graph-test");
  assert.throws(() => validateExecutionContracts(discovered, missingExposure),
    /missing execution contracts: threenative-exposure-graph-test/u);
  assert.deepEqual(discovered, declaredTargets(cmake));
  assert.doesNotThrow(() => validateExecutionContracts(discovered, executionContracts));

  const withUnexecutedTarget = discoverNativeTestTargets(
    `${cmake}\nadd_executable(threenative-unexecuted-test EXCLUDE_FROM_ALL tests/unexecuted.cpp)`,
  );
  assert.throws(
    () => validateExecutionContracts(withUnexecutedTarget, executionContracts),
    /missing execution contracts: threenative-unexecuted-test/u,
  );
});

test("should fail when discovery finds zero targets", () => {
  assert.throws(() => discoverNativeTestTargets("# no native tests here"), /discovered zero/u);
});

test("uses the required exceptional invocations and opt-in verification builds", () => {
  assert.deepEqual(executionContracts["threenative-handle-lifetime-test"].invocations[0].args, [
    "v8",
  ]);
  assert.deepEqual(
    executionContracts["threenative-shutdown-lifetime-test"].invocations.map(({ args }) => args),
    [["http"], ["timer-watch", "$THREENATIVE_TEMPORARY_DIRECTORY"]],
  );
  assert.match(helper, /contracts-video[\s\S]*"TN_ENABLE_VIDEO", "ON"/u);
  assert.match(
    helper,
    /build-native-physics\.mjs[\s\S]*--desktop[\s\S]*contracts-physics[\s\S]*"TN_ENABLE_NATIVE_PHYSICS", "ON"/u,
  );
  assert.match(helper, /contracts-metahuman[\s\S]*"TN_ENABLE_METAHUMAN", "ON"/u);
  assert.match(
    helper,
    /download-deps\.mjs"\), "--only", "openriglogic"[\s\S]*contracts-metahuman/u,
  );
  const metahumanVerifier = readFileSync(join(root, "scripts/verify-desktop-metahuman.mjs"), "utf8");
  assert.match(metahumanVerifier, /configureMetaHumanVerificationBuild\(cmake\)/u);
  assert.match(
    metahumanVerifier,
    /buildNativeTarget\(cmake, buildDirectory, target[\s\S]*run\(nativeTestExecutable\(buildDirectory, target\)[\s\S]*passLine/u,
  );
  assert.equal(
    packageJson.scripts["native:verify:metahuman"],
    "node scripts/verify-desktop-metahuman.mjs",
  );
  assert.doesNotMatch(packageJson.scripts["native:verify:desktop"], /verify-desktop-metahuman/u);
  assert.match(physicsVerifier, /configurePhysicsVerificationBuild\(cmake\)/u);
  assert.doesNotMatch(physicsVerifier, /build-native-physics\.mjs/u);
  assert.match(readFileSync(join(root, "CMakePresets.json"), "utf8"), /"TN_ENABLE_VIDEO": "OFF"/u);
});

function webtransportFixtureSource(selection = cmake) {
  // Evaluate the real decision text, not a copy: the early required/disabled
  // refusal plus the quiche selection block, sliced from CMakeLists.txt. A
  // A fixture of the complete native source is impractical in this bounded
  // vitest regression, so the slice is scoped to configure-time selection
  // only: the dummy header/library below prove presence/absence selection,
  // never linking.
  const earlyCondition = selection.indexOf(
    "TN_REQUIRE_WEBTRANSPORT AND NOT TN_ENABLE_WEBTRANSPORT",
  );
  assert.ok(earlyCondition >= 0, "early required refusal block is intact");
  const earlyStart = selection.lastIndexOf("if(", earlyCondition);
  const earlyEnd = selection.indexOf("endif()", earlyStart);
  const quicheStart = selection.indexOf('option(MYSTRAL_USE_QUICHE "');
  const disabledBranch = selection.indexOf("elseif(TN_REQUIRE_WEBTRANSPORT)", quicheStart);
  const quicheEnd = selection.indexOf("endif()", disabledBranch);
  assert.ok(earlyStart >= 0 && earlyEnd > earlyStart, "early required refusal block is intact");
  assert.ok(
    quicheStart >= 0 && disabledBranch > quicheStart && quicheEnd > disabledBranch,
    "quiche selection block is intact",
  );
  return `${selection.slice(earlyStart, earlyEnd + "endif()".length)}\n${selection.slice(quicheStart, quicheEnd + "endif()".length)}\n`;
}

function writeWebtransportFixture(directory, { selection = cmake, withQuicheArtifacts }) {
  const thirdParty = join(directory, "third_party");
  mkdirSync(thirdParty, { recursive: true });
  writeFileSync(
    join(directory, "CMakeLists.txt"),
    [
      "cmake_minimum_required(VERSION 3.20)",
      "project(tn-webtransport-required NONE)",
      `set(THIRD_PARTY_DIR "${thirdParty.replace(/\\/gu, "/")}")`,
      'set(MYSTRAL_PLATFORM "fixture-linux")',
      webtransportFixtureSource(selection),
      "",
    ].join("\n"),
  );
  if (withQuicheArtifacts) {
    const quiche = join(thirdParty, "quiche");
    mkdirSync(join(quiche, "include"), { recursive: true });
    writeFileSync(join(quiche, "include", "quiche.h"), "// presence fixture\n");
    writeFileSync(join(quiche, "libquiche.a"), "presence fixture\n");
  }
}

function configureWebtransportFixture({ defines, withQuicheArtifacts }) {
  const probe = spawnSync("cmake", ["--version"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(probe.status, 0, "cmake must be available for the configure regression");
  const scope = makeTempDirSync("tn-webtransport-required-");
  try {
    writeWebtransportFixture(scope, { withQuicheArtifacts });
    const result = spawnSync("cmake", ["-S", scope, "-B", join(scope, "build"), ...defines], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  } finally {
    rmSync(scope, { force: true, recursive: true });
  }
}

test("required WebTransport configure fails closed when quiche is absent", () => {
  const base = [
    "-DTN_ENABLE_WEBTRANSPORT=ON",
    "-DMYSTRAL_USE_QUICHE=ON",
    "-DMYSTRAL_USE_DAWN=OFF",
    "-DMYSTRAL_USE_WGPU=OFF",
  ];

  const requiredMissing = configureWebtransportFixture({
    defines: ["-DTN_REQUIRE_WEBTRANSPORT=ON", ...base],
    withQuicheArtifacts: false,
  });
  assert.notEqual(requiredMissing.status, 0);
  assert.match(requiredMissing.output, /TN_WEBTRANSPORT_REQUIRED/u);

  const optionalMissing = configureWebtransportFixture({
    defines: ["-DTN_REQUIRE_WEBTRANSPORT=OFF", ...base],
    withQuicheArtifacts: false,
  });
  assert.equal(optionalMissing.status, 0, optionalMissing.output);
  assert.match(optionalMissing.output, /quiche not found[\s\S]*?WebTransport disabled \(stub\)/u);

  const requiredPresent = configureWebtransportFixture({
    defines: ["-DTN_REQUIRE_WEBTRANSPORT=ON", ...base],
    withQuicheArtifacts: true,
  });
  assert.equal(requiredPresent.status, 0, requiredPresent.output);
  assert.match(requiredPresent.output, /Found quiche/u);

  const requiredTransportOff = configureWebtransportFixture({
    defines: ["-DTN_REQUIRE_WEBTRANSPORT=ON", "-DTN_ENABLE_WEBTRANSPORT=OFF"],
    withQuicheArtifacts: false,
  });
  assert.notEqual(requiredTransportOff.status, 0);
  assert.match(requiredTransportOff.output, /TN_WEBTRANSPORT_REQUIRED/u);

  const requiredQuicheOff = configureWebtransportFixture({
    defines: [
      "-DTN_REQUIRE_WEBTRANSPORT=ON",
      "-DTN_ENABLE_WEBTRANSPORT=ON",
      "-DMYSTRAL_USE_QUICHE=OFF",
    ],
    withQuicheArtifacts: false,
  });
  assert.notEqual(requiredQuicheOff.status, 0);
  assert.match(requiredQuicheOff.output, /TN_WEBTRANSPORT_REQUIRED/u);

  // Removing the required refusal must flip this regression red: without the
  // TN_REQUIRE_WEBTRANSPORT branches the required+missing configure succeeds.
  // Disable only the refusal severity in the extracted slice: the conditions
  // stay intact so the slice anchors still resolve, but neither configure
  // path can fail closed anymore.
  const neutered = cmake.replaceAll("message(FATAL_ERROR", "message(STATUS");
  assert.ok(
    webtransportFixtureSource(neutered).includes("TN_REQUIRE_WEBTRANSPORT"),
    "the mutation control must keep the sliced decision text",
  );
  const neuteredScope = makeTempDirSync("tn-webtransport-neutered-");
  try {
    writeWebtransportFixture(neuteredScope, { selection: neutered, withQuicheArtifacts: false });
    const neuteredMissing = spawnSync(
      "cmake",
      ["-S", neuteredScope, "-B", join(neuteredScope, "build"), "-DTN_REQUIRE_WEBTRANSPORT=ON", ...base],
      { encoding: "utf8", timeout: 60_000 },
    );
    // The diagnostic text still prints, but only as a non-fatal status: the
    // fail-closed property is the non-zero exit, which this must lose.
    assert.equal(neuteredMissing.status, 0, "neutered fixture must lose the refusal");
  } finally {
    rmSync(neuteredScope, { force: true, recursive: true });
  }
}, 120_000);

test("reports every target after aggregating build, execution, and pass-line failures", () => {
  const targets = ["threenative-alpha-test", "threenative-beta-test", "threenative-gamma-test"];
  const contracts = Object.fromEntries(
    targets.map((target) => [
      target,
      { invocations: [{ args: [], passLine: `${target} passed` }] },
    ]),
  );
  const reported = [];

  assert.throws(
    () =>
      runNativeContractLane({
        buildTarget(target) {
          if (target === targets[0]) throw new Error("compile failed");
        },
        contracts,
        discoveredTargets: targets,
        report(result) {
          reported.push(result);
        },
        runTarget(target) {
          if (target === targets[1]) return "wrong output";
          return `${target} passed`;
        },
      }),
    /2 native contract target\(s\) failed/u,
  );

  assert.deepEqual(
    reported.map(({ status, target }) => `${status} ${target}`),
    ["FAIL threenative-alpha-test", "FAIL threenative-beta-test", "PASS threenative-gamma-test"],
  );
});

test("desktop physics runs the scene with the physics-enabled verification binary", () => {
  const verifier = readFileSync(join(root, "scripts/verify-desktop-physics.mjs"), "utf8");
  assert.match(verifier, /buildNativeTarget\(cmake, buildDir, "mystral", 900_000\)/u);
  assert.match(
    verifier,
    /const buildDirectory = runActuationBindingsProof\(\);[\s\S]*runDesktopPhysics\(desktop, buildDirectory\)/u,
  );
});

// The Windows desktop leg reached the contract build and failed compiling
// `crash_handler_policy_test.cpp`: it drives `sigaction` and `siginfo_t`, which MSVC does not
// provide. The target is guarded to POSIX in CMakeLists.txt, and this file fails closed on a
// contract whose target does not exist — so the contract has to carry the same platform list, or
// guarding the build would simply move the failure into validation.
test('a contract declared for other platforms is not required to have a target here', () => {
  const contracts = {
    'threenative-everywhere-test': { invocations: [{ args: [], passLine: 'ok' }] },
    'threenative-posix-only-test': {
      platforms: ['darwin', 'linux'],
      invocations: [{ args: [], passLine: 'ok' }],
    },
  };

  // On Windows the POSIX target is absent, and that is correct rather than missing.
  assert.doesNotThrow(() =>
    validateExecutionContracts(['threenative-everywhere-test'], contracts, 'win32'),
  );

  // Discovery reads CMakeLists.txt as text and cannot see an `if(NOT WIN32)` guard, so it lists
  // the POSIX target on Windows anyway. That is not a missing contract — the contract says where
  // the target exists, and the lane skips it there.
  assert.doesNotThrow(() =>
    validateExecutionContracts(
      ['threenative-everywhere-test', 'threenative-posix-only-test'],
      contracts,
      'win32',
    ),
  );

  // On Linux it must be there: a platform the contract claims still fails closed without it.
  assert.throws(
    () => validateExecutionContracts(['threenative-everywhere-test'], contracts, 'linux'),
    /execution contracts without targets: threenative-posix-only-test/u,
  );

  // A target with no contract at all still fails closed on every platform.
  assert.throws(
    () => validateExecutionContracts(['threenative-unregistered-test'], {}, 'linux'),
    /missing execution contracts: threenative-unregistered-test/u,
  );
});


test("native build honors a requested positive worker cap and refuses invalid values", () => {
  const spawn = vi.mocked(spawnSync);
  const previous = process.env.CMAKE_BUILD_PARALLEL_LEVEL;
  try {
    process.env.CMAKE_BUILD_PARALLEL_LEVEL = "2";
    spawn.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    buildNativeTarget("cmake", "owned-build", "cap");
    assert.deepEqual(spawn.mock.calls.at(-1)?.[1],
      ["--build", "owned-build", "--target", "cap", "--parallel", "2"]);
    const calls = spawn.mock.calls.length;
    for (const invalid of ["", "0", "-1", "2.5", "2oops", "many", "9007199254740992"]) {
      process.env.CMAKE_BUILD_PARALLEL_LEVEL = invalid;
      assert.throws(() => buildNativeTarget("cmake", "owned-build", "cap"), /CMAKE_BUILD_PARALLEL_LEVEL.*positive integer/u);
    }
    assert.equal(spawn.mock.calls.length, calls);
    Reflect.deleteProperty(process.env, "CMAKE_BUILD_PARALLEL_LEVEL");
    spawn.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    buildNativeTarget("cmake", "owned-build", "cap");
    assert.deepEqual(spawn.mock.calls.at(-1)?.[1],
      ["--build", "owned-build", "--target", "cap", "--parallel"]);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "CMAKE_BUILD_PARALLEL_LEVEL");
    else process.env.CMAKE_BUILD_PARALLEL_LEVEL = previous;
    spawn.mockClear();
  }
});
