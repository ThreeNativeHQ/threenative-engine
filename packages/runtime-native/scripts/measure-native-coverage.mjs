#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildNativeTarget,
  desktopBuildDirectory,
  desktopPreset,
  nativeTestExecutable,
  resolveCmake,
  run,
  runtimeRoot,
} from "./native-test-lane.mjs";
import {
  discoverNativeTestTargets,
  executionContracts,
  targetsMissingBlockedRegistration,
  validateExecutionContracts,
} from "./verify-native-contracts.mjs";
import { nativeCoverageEvidenceDigest } from "./native-coverage-evidence.mjs";

const profileDirectory = join(desktopBuildDirectory("coverage"), "coverage-profiles");
const defaultRecord = resolve(
  runtimeRoot,
  "..",
  "..",
  "docs",
  "verification",
  "native-coverage-2026-08-28.md",
);
const coverageProfileEnvironmentVariable = "LLVM_PROFILE_FILE";
const generatedRecordStart = "<!-- native-coverage-generated:start -->";
const generatedRecordEnd = "<!-- native-coverage-generated:end -->";
const sanitizerGeneratedStart = "<!-- native-sanitizer-generated:start -->";
const sanitizerGeneratedEnd = "<!-- native-sanitizer-generated:end -->";
const sourceExtensions = new Set([".c", ".cc", ".cpp", ".cxx", ".m", ".mm"]);
const configurationBlockers = new Map([
  [
    "threenative-physics-actuation-bindings-test",
    "TN_ENABLE_NATIVE_PHYSICS=OFF: native physics bindings are not linked",
  ],
  [
    "threenative-video-recorder-state-test",
    "TN_ENABLE_VIDEO=OFF: the video recorder target is not configured",
  ],
]);
export const sanitizerTargets = [
  "threenative-bindings-creation-test",
  "threenative-dom-dispatch-lifetime-test",
  "threenative-frame-op-stream-replay-test",
  "threenative-handle-lifetime-test",
  "threenative-shutdown-lifetime-test",
  "threenative-webgpu-bindings-reentrancy-test",
];

function percentage(covered, lines) {
  return lines === 0 ? 0 : Number(((covered / lines) * 100).toFixed(2));
}

function subsystem(path) {
  const rest = path.replace(/^src\//u, "");
  return rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
}

export function requireCoverageProfile(path, fileExists = existsSync) {
  if (!fileExists(path)) {
    throw new Error(`coverage profile data is missing: ${path}`);
  }
  return path;
}

export function coverageConfigurationBlocker(target) {
  return configurationBlockers.get(target);
}

/**
 * The reason this configure gives for a target it registered but will not run, or undefined when
 * the target is a live test. `tn_register_blocked_test` registers a DISABLED entry labelled
 * `blocked` whose command echoes why, so an optional dependency that was not found is answered by
 * the configure that ran rather than by a list of target names kept in this file - which cannot be
 * right on both a machine that has quiche and one that does not.
 */
export function blockedRegistrationReason(inventory, target) {
  const entry = inventory.find(({ name }) => name === target);
  if (entry === undefined) return undefined;
  const properties = entry.properties ?? [];
  const disabled = properties.some(({ name, value }) => name === "DISABLED" && value === true);
  const labelled = properties.some(
    ({ name, value }) => name === "LABELS" && (value ?? []).includes("blocked"),
  );
  if (!(disabled && labelled)) return undefined;
  const echoed = (entry.command ?? []).find((argument) => argument.startsWith("BLOCKED: "));
  return echoed === undefined ? "blocked by this configure" : echoed.slice("BLOCKED: ".length);
}

/**
 * The WebGPU backend this configure selected, or undefined when it found none. A tree without
 * `third_party/` configures perfectly happily - cmake prints "Dawn library or headers not found"
 * among a hundred other lines and carries on - and the host then fails to compile, because the
 * full `BindingsState` and the `WGPUPresentMode_*` constants only exist behind
 * `MYSTRAL_WEBGPU_DAWN` / `MYSTRAL_WEBGPU_WGPU`. Read from the compile line the configure wrote,
 * so it is that configure's answer rather than a guess about the machine.
 */
export function configuredWebgpuBackend(compileCommands) {
  const defines = compileCommands.flatMap(({ command, arguments: argv }) =>
    typeof command === "string" ? command.split(/\s+/u) : (argv ?? []),
  );
  if (defines.includes("-DMYSTRAL_WEBGPU_DAWN")) return "dawn";
  if (defines.includes("-DMYSTRAL_WEBGPU_WGPU")) return "wgpu";
  return undefined;
}

export function summarizeNativeCoverage({
  blockedTargets,
  compiledSourceFiles,
  configuration,
  instrumentedFiles,
  sourceFiles,
}) {
  if (!Array.isArray(instrumentedFiles) || instrumentedFiles.length === 0) {
    throw new Error("native coverage contained zero instrumented source files");
  }
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    throw new Error("native source inventory is empty");
  }
  if (!Array.isArray(compiledSourceFiles) || compiledSourceFiles.length === 0) {
    throw new Error("native compile_commands inventory is empty");
  }
  const compiledSourceSet = new Set(compiledSourceFiles);
  const compiled = instrumentedFiles
    .filter(({ path }) => compiledSourceSet.has(path))
    .map(({ covered, lines, path }) => ({
      covered,
      lines,
      path,
      percent: percentage(covered, lines),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (compiled.length === 0) {
    throw new Error("native coverage matched zero files under packages/runtime-native/src");
  }
  const measuredSet = new Set(compiled.map(({ path }) => path));
  const missingMeasurements = compiledSourceFiles.filter((path) => !measuredSet.has(path)).sort();
  if (missingMeasurements.length > 0) {
    throw new Error(`llvm-cov omitted compiled source files: ${missingMeasurements.join(", ")}`);
  }
  const notCompiled = sourceFiles.filter((path) => !compiledSourceSet.has(path)).sort();
  const grouped = new Map();
  for (const file of compiled) {
    const name = subsystem(file.path);
    const current = grouped.get(name) ?? { covered: 0, lines: 0, name };
    current.covered += file.covered;
    current.lines += file.lines;
    grouped.set(name, current);
  }
  const subsystems = [...grouped.values()]
    .map((entry) => ({ ...entry, percent: percentage(entry.covered, entry.lines) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const totals = compiled.reduce(
    (total, file) => ({ covered: total.covered + file.covered, lines: total.lines + file.lines }),
    { covered: 0, lines: 0 },
  );
  return {
    blockedTargets: [...blockedTargets].sort((left, right) =>
      left.target.localeCompare(right.target),
    ),
    compiled,
    configuration,
    notCompiled,
    subsystems,
    total: { ...totals, percent: percentage(totals.covered, totals.lines) },
  };
}

function sourceInventory(directory = join(runtimeRoot, "src")) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        files.push(relative(runtimeRoot, path).split(sep).join("/"));
      }
    }
  };
  visit(directory);
  return files.sort();
}

function lcovSourcePath(line) {
  const absolute = resolve(line.slice(3));
  const candidate = relative(runtimeRoot, absolute).split(sep).join("/");
  return candidate.startsWith("../") || !candidate.startsWith("src/") ? undefined : candidate;
}

function addLcovDataLine(byPath, path, line) {
  const [lineNumberText, countText] = line.slice(3).split(",");
  const lineNumber = Number(lineNumberText);
  const count = Number(countText);
  if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0 || !Number.isFinite(count)) {
    throw new Error(`malformed llvm-cov LCOV line: ${line}`);
  }
  const lines = byPath.get(path) ?? new Map();
  lines.set(lineNumber, (lines.get(lineNumber) ?? 0) + count);
  byPath.set(path, lines);
}

function addLcovReport(byPath, report) {
  let path;
  for (const line of report.split("\n")) {
    if (line.startsWith("SF:")) path = lcovSourcePath(line);
    else if (line === "end_of_record") path = undefined;
    else if (line.startsWith("DA:") && path !== undefined) addLcovDataLine(byPath, path, line);
  }
}

export function instrumentedFilesFromLcov(reports) {
  const byPath = new Map();
  for (const report of reports) addLcovReport(byPath, report);
  return [...byPath.entries()].map(([path, lineCounts]) => ({
    covered: [...lineCounts.values()].filter((count) => count > 0).length,
    lines: lineCounts.size,
    path,
  }));
}

function compiledProductObjects(buildDirectory) {
  const commandsPath = join(buildDirectory, "compile_commands.json");
  if (!existsSync(commandsPath)) {
    throw new Error(`native coverage compile inventory is missing: ${commandsPath}`);
  }
  const commands = JSON.parse(readFileSync(commandsPath, "utf8"));
  if (!Array.isArray(commands)) throw new Error(`${commandsPath} is not a JSON array`);
  const bySource = new Map();
  for (const command of commands) {
    if (typeof command?.file !== "string" || typeof command?.output !== "string") continue;
    const source = relative(runtimeRoot, resolve(command.file)).split(sep).join("/");
    if (source.startsWith("../") || !source.startsWith("src/")) continue;
    const object = resolve(command.directory, command.output);
    if (!existsSync(object)) throw new Error(`compiled coverage object is missing: ${object}`);
    if (!bySource.has(source)) bySource.set(source, object);
  }
  if (bySource.size === 0) throw new Error("compile_commands contains zero native product objects");
  return {
    entries: [...bySource.entries()].map(([source, object]) => ({ object, source })),
    sourceFiles: [...bySource.keys()].sort(),
  };
}

function renderMarkdown(report, executedTargets, previousRecord = "") {
  const rows = report.subsystems
    .map(
      ({ covered, lines, name, percent }) =>
        `| \`src/${name}${name.includes(".") ? "" : "/"}\` | ${lines} | ${covered} | ${percent.toFixed(2)}% |`,
    )
    .join("\n");
  const floors = retainedCoverageFloors(previousRecord, report.subsystems)
    .map(({ name, percent }) => `| \`${name}\` | ${percent.toFixed(2)}% |`)
    .join("\n");
  const notCompiled =
    report.notCompiled.length === 0
      ? "- None."
      : report.notCompiled.map((path) => `- \`${path}\``).join("\n");
  const blocked =
    report.blockedTargets.length === 0
      ? "- None."
      : report.blockedTargets.map(({ reason, target }) => `- \`${target}\`: ${reason}`).join("\n");
  return `${generatedRecordStart}
# Native coverage — 2026-08-28

Configuration: \`${report.configuration}\` with clang source-based coverage. Executed
${executedTargets.length} native contract targets; ${report.blockedTargets.length} configured
targets could not be built and are named below.

| Subsystem | Instrumented lines | Covered | Line coverage |
| --- | ---: | ---: | ---: |
${rows}
| **TOTAL** | **${report.total.lines}** | **${report.total.covered}** | **${report.total.percent.toFixed(2)}%** |

Source digest: \`sha256:${nativeCoverageEvidenceDigest(runtimeRoot)}\`

The default \`pnpm budgets\` gate reads this committed measurement without configuring or compiling
the native host. Any native source, native C++ test, CTest registration, or coverage aggregation
change requires this opt-in command to refresh the record.

| Coverage floor | Minimum |
| --- | ---: |
${floors}

## Not compiled in this configuration

${notCompiled}

## Blocked targets

${blocked}
${generatedRecordEnd}
`;
}

export function retainedCoverageFloors(previousRecord, subsystems) {
  const recorded = new Map();
  const heading = "| Coverage floor | Minimum |";
  const start = previousRecord.indexOf(heading);
  if (start >= 0) {
    for (const line of previousRecord.slice(start).split(/\r?\n/u).slice(2)) {
      if (!line.startsWith("|")) break;
      const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*(\d+(?:\.\d+)?)%\s*\|$/u);
      if (!match) throw new Error(`native coverage record contains a malformed floor: ${line}`);
      if (recorded.has(match[1])) {
        throw new Error(`native coverage record contains a duplicate floor: ${match[1]}`);
      }
      recorded.set(match[1], Number(match[2]));
    }
  }
  return subsystems.map(({ name, percent }) => {
    const path = `src/${name}${name.includes(".") ? "" : "/"}`;
    // Match the gate's five-point margin without ever loosening an established floor.
    const ratcheted = Number((percent - 5).toFixed(2));
    return { name: path, percent: Math.max(recorded.get(path) ?? percent, ratcheted) };
  });
}

function writeGeneratedRecord(
  recordPath,
  generatedRecord,
  startMarker = generatedRecordStart,
  endMarker = generatedRecordEnd,
) {
  let contents = generatedRecord;
  if (existsSync(recordPath)) {
    const previous = readFileSync(recordPath, "utf8");
    const start = previous.indexOf(startMarker);
    const end = previous.indexOf(endMarker);
    if (start !== -1 && end > start) {
      contents = `${previous.slice(0, start)}${generatedRecord}${previous.slice(end + endMarker.length).replace(/^\n/u, "")}`;
    }
  }
  writeFileSync(recordPath, contents);
}

function compactFailure(error) {
  return String(error?.message ?? error)
    .split("\n")
    .filter(Boolean)
    .slice(-6)
    .join(" ");
}

function runForStdout(command, args) {
  const result = spawnSync(command, args, {
    cwd: runtimeRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}:\n${result.stderr ?? ""}`);
  }
  if (result.stderr?.trim()) {
    throw new Error(`${command} emitted a coverage warning:\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function requireInvocationProfiles(expectedPrefixes, profileNames) {
  const missing = expectedPrefixes.filter(
    (prefix) => !profileNames.some((name) => name.startsWith(prefix) && name.endsWith(".profraw")),
  );
  if (missing.length > 0) {
    throw new Error(`native coverage invocation profiles are missing: ${missing.join(", ")}`);
  }
}

function coverageExports({ buildDirectory, compiledProducts, executedTargets, profileNames }) {
  const commonArguments = [
    "--format=lcov",
    "-ignore-filename-regex=(third_party|\\.runtime|/usr/|/opt/|sdl3-build)",
  ];
  const reports = [];
  const zeroLineSources = [];
  for (const { object, source } of compiledProducts.entries) {
    const report = runForStdout("llvm-cov", [
      "export",
      "--empty-profile",
      object,
      ...commonArguments,
    ]);
    reports.push(report);
    const files = instrumentedFilesFromLcov([report]);
    if (!files.some(({ path }) => path === source)) zeroLineSources.push(source);
  }
  for (const target of executedTargets) {
    const targetProfiles = profileNames
      .filter((name) => name.startsWith(`${target}-`))
      .map((name) => join(profileDirectory, name));
    if (targetProfiles.length === 0) {
      throw new Error(`native coverage target profile is missing: ${target}`);
    }
    const targetProfile = join(profileDirectory, `${target}.profdata`);
    run("llvm-profdata", ["merge", "-sparse", ...targetProfiles, "-o", targetProfile]);
    requireCoverageProfile(targetProfile);
    reports.push(
      runForStdout("llvm-cov", [
        "export",
        nativeTestExecutable(buildDirectory, target),
        ...commonArguments,
        `-instr-profile=${targetProfile}`,
      ]),
    );
  }
  return { reports, zeroLineSources };
}

function ctestInventory(buildDirectory, ctest) {
  const inventory = JSON.parse(
    runForStdout(ctest, ["--test-dir", buildDirectory, "--show-only=json-v1"]),
  );
  if (!Array.isArray(inventory?.tests) || inventory.tests.length === 0) {
    throw new Error("CTest registered zero native contract tests");
  }
  return inventory.tests;
}

function ctestRegistrations(buildDirectory, ctest) {
  return ctestInventory(buildDirectory, ctest).map(({ name }) => name);
}

function resolveCtest(cmake) {
  if (cmake === "cmake") return "ctest";
  return join(dirname(cmake), process.platform === "win32" ? "ctest.exe" : "ctest");
}

export function runNativeCtest() {
  const cmake = resolveCmake();
  const ctest = resolveCtest(cmake);
  const buildDirectory = desktopBuildDirectory();
  const cmakeSource = readFileSync(join(runtimeRoot, "CMakeLists.txt"), "utf8");
  const targets = discoverNativeTestTargets(cmakeSource);
  buildNativeTarget(cmake, buildDirectory, "threenative-native-tests", 1_800_000);
  const registrations = ctestRegistrations(buildDirectory, ctest);
  for (const target of targets) {
    if (!registrations.includes(target)) throw new Error(`CTest omitted native target: ${target}`);
  }
  const output = run(ctest, ["--test-dir", buildDirectory, "--output-on-failure"], {
    timeout: 900_000,
  });
  console.info(output);
  return targets;
}

export function summarizeSanitizerLane({ allTargets, selectedTargets }) {
  if (!Array.isArray(allTargets) || allTargets.length === 0) {
    throw new Error("native sanitizer source inventory is empty");
  }
  const selected = new Set(selectedTargets);
  const missing = sanitizerTargets.filter((target) => !selected.has(target));
  if (missing.length > 0) {
    throw new Error(`sanitizer lane omitted required targets: ${missing.join(", ")}`);
  }
  const unknown = selectedTargets.filter((target) => !allTargets.includes(target));
  if (unknown.length > 0) {
    throw new Error(`sanitizer lane selected unknown targets: ${unknown.join(", ")}`);
  }
  return {
    notRun: allTargets.filter((target) => !selected.has(target)).sort(),
    ran: [...selected].sort(),
  };
}

function sanitizerMarkdown(report) {
  return `${sanitizerGeneratedStart}
# Native sanitizer lane — 2026-08-28

Configuration: \`${desktopPreset()}-asan\`

## Ran under ASan + UBSan

${report.ran.map((target) => `- \`${target}\``).join("\n")}

## Not run by this lifetime-focused lane

${report.notRun.map((target) => `- \`${target}\`: outside the lifetime sanitizer scope`).join("\n")}
${sanitizerGeneratedEnd}
`;
}

export function runNativeSanitizers({ recordPath } = {}) {
  if (process.platform === "win32") {
    throw new Error("native sanitizer lane currently requires a Clang or GCC desktop host");
  }
  const cmake = resolveCmake();
  const ctest = resolveCtest(cmake);
  const buildDirectory = desktopBuildDirectory("asan");
  run(
    cmake,
    [
      "--preset",
      desktopPreset(),
      "-B",
      buildDirectory,
      "-G",
      "Unix Makefiles",
      "-DCMAKE_BUILD_TYPE=RelWithDebInfo",
      "-DTN_ENABLE_SANITIZERS=ON",
      "-DTN_ENABLE_COVERAGE=OFF",
      "-DTN_ENABLE_NATIVE_PHYSICS=OFF",
      "-DTN_ENABLE_UI_OVERLAY=OFF",
    ],
    { timeout: 900_000 },
  );
  run(
    cmake,
    [
      "--build",
      buildDirectory,
      "--target",
      "threenative-native-sanitizer-tests",
      "--parallel",
      "--",
      "-s",
    ],
    { timeout: 1_800_000 },
  );
  const selectedTargets = ctestInventory(buildDirectory, ctest)
    .filter(({ properties }) =>
      properties?.some(
        ({ name, value }) => name === "LABELS" && value.includes("native-sanitizer"),
      ),
    )
    .map(({ name }) => name);
  const cmakeSource = readFileSync(join(runtimeRoot, "CMakeLists.txt"), "utf8");
  const report = summarizeSanitizerLane({
    allTargets: discoverNativeTestTargets(cmakeSource),
    selectedTargets,
  });
  const suppressionPath = join(buildDirectory, "native-lsan-2026-08-28.supp");
  writeFileSync(
    suppressionPath,
    `# 2026-08-28: DBus retains process-global loader state after the Vulkan adapter probe.
leak:_dbus_message_loader_queue_messages
# 2026-08-28: NVIDIA's userspace Vulkan driver retains process-global allocation state.
leak:libnvidia-glcore.so
# 2026-08-28: NVIDIA's GL/Vulkan support library retains process-global allocation state.
leak:libnvidia-glsi.so
# 2026-08-28: NVIDIA EGL initialization retains process-global Vulkan ICD allocation state.
leak:libEGL_nvidia.so
# 2026-08-28: Dawn's Vulkan queue retains driver-owned work until process teardown.
leak:dawn::native::vulkan::Queue
`,
  );
  const sanitizerEnvironment = { ...process.env };
  Reflect.set(
    sanitizerEnvironment,
    "ASAN_OPTIONS",
    "abort_on_error=1:fast_unwind_on_malloc=0:halt_on_error=1",
  );
  Reflect.set(sanitizerEnvironment, "LSAN_OPTIONS", `suppressions=${suppressionPath}`);
  Reflect.set(sanitizerEnvironment, "UBSAN_OPTIONS", "halt_on_error=1:print_stacktrace=1");
  const output = run(
    ctest,
    ["--test-dir", buildDirectory, "--output-on-failure", "--label-regex", "native-sanitizer"],
    {
      env: sanitizerEnvironment,
      timeout: 900_000,
    },
  );
  const markdown = sanitizerMarkdown(report);
  const outputPath =
    recordPath ??
    resolve(runtimeRoot, "..", "..", "docs", "verification", "native-sanitizer-lane-2026-08-28.md");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeGeneratedRecord(outputPath, markdown, sanitizerGeneratedStart, sanitizerGeneratedEnd);
  console.info(`${output}\n${markdown}`);
  return report;
}

function registrationsForTarget(registrations, target) {
  return registrations.filter((name) => name === target || name.startsWith(`${target}-`)).sort();
}

function runCoverageTargets({ buildDirectory, cmake, ctest, inventory, registrations, targets }) {
  const blockedTargets = [];
  const executedTargets = [];
  const executionFailures = [];
  const expectedProfilePrefixes = [];
  for (const target of targets) {
    const configurationBlocker =
      blockedRegistrationReason(inventory, target) ?? coverageConfigurationBlocker(target);
    if (configurationBlocker !== undefined) {
      blockedTargets.push({ reason: configurationBlocker, target });
      continue;
    }
    try {
      buildNativeTarget(cmake, buildDirectory, target, 1_800_000);
    } catch (error) {
      executionFailures.push({ reason: `build failed: ${compactFailure(error)}`, target });
      continue;
    }
    let targetPassed = true;
    const testNames = registrationsForTarget(registrations, target);
    if (testNames.length !== executionContracts[target].invocations.length) {
      executionFailures.push({
        reason: `CTest registered ${testNames.length} invocation(s), expected ${executionContracts[target].invocations.length}`,
        target,
      });
      continue;
    }
    for (const [index, testName] of testNames.entries()) {
      try {
        const env = { ...process.env };
        const profilePrefix = `${target}-${index}-`;
        expectedProfilePrefixes.push(profilePrefix);
        env[coverageProfileEnvironmentVariable] = join(
          profileDirectory,
          `${profilePrefix}%p.profraw`,
        );
        run(ctest, ["--test-dir", buildDirectory, "--output-on-failure", "-R", `^${testName}$`], {
          env,
          timeout: 120_000,
        });
      } catch (error) {
        targetPassed = false;
        executionFailures.push({ reason: compactFailure(error), target });
      }
    }
    if (targetPassed) executedTargets.push(target);
  }
  return { blockedTargets, executedTargets, executionFailures, expectedProfilePrefixes };
}

const COVERAGE_GENERATOR = "Unix Makefiles";

/**
 * The coverage lane configures with its own generator while every other lane uses the preset's
 * Ninja, so a build directory left by another lane makes cmake fail with a raw "does not match the
 * generator used previously" dump that names no fix. Returns the directory that has to go, or null
 * when there is nothing in the way. Fail closed: a cache whose generator cannot be read counts as
 * a conflict, never as agreement.
 */
export function staleGeneratorBuildDirectory(buildDirectory, generator, dependencies = {}) {
  const cachePath = join(buildDirectory, "CMakeCache.txt");
  if (!(dependencies.existsSyncImpl ?? existsSync)(cachePath)) return null;
  const cache = (dependencies.readFileSyncImpl ?? readFileSync)(cachePath, "utf8");
  const previous = /^CMAKE_GENERATOR:INTERNAL=(.*)$/mu.exec(cache)?.[1]?.trim();
  return previous === generator ? null : buildDirectory;
}

export function measureNativeCoverage({ recordPath = defaultRecord } = {}) {
  if (process.platform === "win32") {
    throw new Error("native coverage currently requires a clang desktop host");
  }
  const cmake = resolveCmake();
  const ctest = resolveCtest(cmake);
  const buildDirectory = desktopBuildDirectory("coverage");
  const conflicting = staleGeneratorBuildDirectory(buildDirectory, COVERAGE_GENERATOR);
  if (conflicting !== null) {
    throw new Error(
      `${conflicting} was configured by a different CMake generator than the coverage lane's "${COVERAGE_GENERATOR}". Remove it and re-run:\n  rm -rf ${conflicting}\nIt is derived output, but rebuilding needs third_party/ present - run pnpm native:build first if it is absent.`,
    );
  }
  run(
    cmake,
    [
      "--preset",
      desktopPreset(),
      "-B",
      buildDirectory,
      "-G",
      COVERAGE_GENERATOR,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_C_COMPILER=clang",
      "-DCMAKE_CXX_COMPILER=clang++",
      "-DTN_ENABLE_COVERAGE=ON",
      "-DTN_ENABLE_NATIVE_PHYSICS=OFF",
      "-DTN_ENABLE_UI_OVERLAY=OFF",
    ],
    { timeout: 900_000 },
  );
  const cmakeSource = readFileSync(join(runtimeRoot, "CMakeLists.txt"), "utf8");
  const targets = discoverNativeTestTargets(cmakeSource);
  validateExecutionContracts(targets, executionContracts);
  const compileCommandsPath = join(buildDirectory, "compile_commands.json");
  if (!existsSync(compileCommandsPath)) {
    throw new Error(`the coverage configure wrote no compile inventory: ${compileCommandsPath}`);
  }
  if (configuredWebgpuBackend(JSON.parse(readFileSync(compileCommandsPath, "utf8"))) === undefined) {
    throw new Error(
      "the coverage configure selected no WebGPU backend, so the native host cannot compile. third_party/ is missing or incomplete - run pnpm native:build (or node packages/runtime-native/scripts/download-deps.mjs) and re-run.",
    );
  }
  const hollow = targetsMissingBlockedRegistration(cmakeSource);
  if (hollow.length > 0) {
    throw new Error(
      `native test target(s) written under a condition that registers nothing when it does not hold: ${hollow.join(", ")}. Give each one a tn_register_blocked_test in the else branch, or a platforms list on its execution contract.`,
    );
  }
  const inventory = ctestInventory(buildDirectory, ctest);
  const registrations = inventory.map(({ name }) => name);
  for (const target of targets) {
    if (!registrations.includes(target)) throw new Error(`CTest omitted native target: ${target}`);
  }
  rmSync(profileDirectory, { force: true, recursive: true });
  mkdirSync(profileDirectory, { recursive: true });

  buildNativeTarget(cmake, buildDirectory, "mystral", 1_800_000);
  buildNativeTarget(cmake, buildDirectory, "mystral-tools", 1_800_000);
  const { blockedTargets, executedTargets, executionFailures, expectedProfilePrefixes } =
    runCoverageTargets({
      buildDirectory,
      cmake,
      ctest,
      inventory,
      registrations,
      targets,
    });
  if (executionFailures.length > 0) {
    const detail = executionFailures.map(({ reason, target }) => `${target}: ${reason}`).join("\n");
    throw new Error(`native coverage execution failed:\n${detail}`);
  }

  const profileNames = readdirSync(profileDirectory).filter((name) => name.endsWith(".profraw"));
  requireInvocationProfiles(expectedProfilePrefixes, profileNames);
  const compiledProducts = compiledProductObjects(buildDirectory);
  const coverage = coverageExports({
    buildDirectory,
    compiledProducts,
    executedTargets,
    profileNames,
  });
  const report = summarizeNativeCoverage({
    blockedTargets,
    compiledSourceFiles: compiledProducts.sourceFiles,
    configuration: `${desktopPreset()}-coverage`,
    instrumentedFiles: [
      ...instrumentedFilesFromLcov(coverage.reports),
      ...coverage.zeroLineSources.map((path) => ({ covered: 0, lines: 0, path })),
    ],
    sourceFiles: sourceInventory(),
  });
  const previousRecord = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : "";
  const markdown = renderMarkdown(report, executedTargets, previousRecord);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeGeneratedRecord(recordPath, markdown);
  console.info(markdown);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--sanitizers")) runNativeSanitizers();
  else if (process.argv.includes("--ctest")) runNativeCtest();
  else measureNativeCoverage();
}
