/**
 * Android Canvas2D/Skia: per-ABI static staging and Android font manager.
 *
 * The CMake fixture below extracts the production Skia block from CMakeLists.txt. It
 * configures that block with temporary layouts, then builds a tiny executable through
 * the imported Skia target. The executable needs a second archive scan, proving that
 * the shipped --start-group/--end-group flags actually close a cyclic static link.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const cmakeLists = readFileSync(join(runtimeRoot, "CMakeLists.txt"), "utf8");
const temporaries = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { force: true, recursive: true });
});

const SKIA_ARCHIVES = [
  "libskia.a",
  "libfreetype2.a",
  "libpng.a",
  "libzlib.a",
  "libexpat.a",
  "libskcms.a",
  "libwuffs.a",
  "libcpu-features.a",
];

function extractSkiaBlock() {
  const begin = "# TN_SKIA_BLOCK_BEGIN";
  const end = "# TN_SKIA_BLOCK_END";
  const start = cmakeLists.indexOf(begin);
  const stop = cmakeLists.indexOf(end);
  assert.ok(start !== -1 && stop !== -1 && stop > start, "production Skia block markers missing");
  return cmakeLists.slice(start + begin.length, stop);
}

function writeFixture(dir, { android, abi, canvas2dOn, platform = "linux", link = false }) {
  const block = extractSkiaBlock();
  const linkSource = link
    ? `
file(WRITE "${dir}/main.cpp" "extern int skia_entry(); int main() { return skia_entry() == 7 ? 0 : 1; }\\n")
add_executable(cyclic-link "${dir}/main.cpp")
target_link_libraries(cyclic-link PRIVATE skia::skia)
add_executable(cyclic-link-no-group EXCLUDE_FROM_ALL "${dir}/main.cpp")
target_link_libraries(cyclic-link-no-group PRIVATE \${SKIA_LIBRARY} \${SKIA_ANDROID_EXTRA_LIBS})
`
    : "";
  writeFileSync(
    join(dir, "CMakeLists.txt"),
    `cmake_minimum_required(VERSION 3.20)
project(tn-android-skia-fixture C CXX)
set(THIRD_PARTY_DIR "${dir}/third_party")
set(TN_ENABLE_CANVAS2D ${canvas2dOn ? "ON" : "OFF"})
set(ANDROID ${android ? "TRUE" : "FALSE"})
set(ANDROID_ABI "${abi ?? ""}")
set(MYSTRAL_PLATFORM "${platform}")
${block}
if(TARGET skia::skia)
  get_target_property(SKIA_LINKS skia::skia INTERFACE_LINK_LIBRARIES)
else()
  set(SKIA_LINKS "")
endif()
file(WRITE "${dir}/verdict.txt" "SKIA_LIBRARY=\${SKIA_LIBRARY}\\nSKIA_INCLUDE_DIR=\${SKIA_INCLUDE_DIR}\\nSKIA_ANDROID_ABI=\${SKIA_ANDROID_ABI}\\nSKIA_ANDROID_EXTRA_LIBS=\${SKIA_ANDROID_EXTRA_LIBS}\\nSKIA_LINKS=\${SKIA_LINKS}\\n")
${linkSource}`,
  );
}

const DEFAULT_COMMANDS = { AR: "ar", CMAKE: "cmake", CXX: "c++" };
const requireNativeFixture = process.env.TN_REQUIRE_ANDROID_CANVAS_SKIA_FIXTURE === "1";

function command(name) {
  return process.env[name] ?? DEFAULT_COMMANDS[name];
}

function hasCommand(name) {
  const value = command(name);
  if (!value) return false;
  if (value.includes("/") || value.includes("\\")) return existsSync(value);
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((entry) => entry.length > 0 && existsSync(join(entry, value)));
}

const hasNativeToolchain = process.platform === "linux" && ["AR", "CMAKE", "CXX"].every(hasCommand);

function run(commandName, args, cwd) {
  return execFileSync(command(commandName), args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function makeArchive(path, source, symbol, references = []) {
  const sourcePath = `${path}.cpp`;
  const objectPath = `${path}.o`;
  const referencesText = references.map((name) => `extern int ${name}();`).join(" ");
  const body = references.length
    ? `int ${symbol}() { return ${references.map((name) => `${name}()`).join(" + ")}; }`
    : `int ${symbol}() { return 7; }`;
  writeFileSync(sourcePath, `${referencesText}\n${body}\n`);
  run("CXX", ["-c", sourcePath, "-o", objectPath], source);
  run("AR", ["rcs", path, objectPath], source);
  unlinkSync(sourcePath);
  unlinkSync(objectPath);
}

function appendArchiveObject(path, source, symbol) {
  const sourcePath = join(source, `${symbol}.cpp`);
  const objectPath = join(source, `${symbol}.o`);
  writeFileSync(sourcePath, `int ${symbol}() { return 7; }\n`);
  run("CXX", ["-c", sourcePath, "-o", objectPath], source);
  run("AR", ["rcs", path, objectPath], source);
  unlinkSync(sourcePath);
  unlinkSync(objectPath);
}

function makeLayout(dir, { abi = "arm64-v8a", missing = [], cyclic = false, root = "skia" } = {}) {
  const includeDir = join(dir, "third_party", root, "build", "include");
  const libDir = root === "skia-android"
    ? join(dir, "third_party", root, "build", "android", "lib", "Release", abi)
    : join(dir, "third_party", root, "build", "linux-gpu", "lib", "Release", "x64");
  mkdirSync(join(includeDir, "include", "core"), { recursive: true });
  mkdirSync(join(includeDir, "include", "ports"), { recursive: true });
  writeFileSync(join(includeDir, "include", "core", "SkCanvas.h"), "// fixture\n");
  if (root === "skia-android") {
    writeFileSync(join(includeDir, "include", "ports", "SkFontMgr_android.h"), "// fixture\n");
    writeFileSync(join(includeDir, "include", "ports", "SkFontScanner_FreeType.h"), "// fixture\n");
  }
  mkdirSync(libDir, { recursive: true });
  for (const archive of SKIA_ARCHIVES) {
    if (missing.includes(archive)) continue;
    const archivePath = join(libDir, archive);
    if (cyclic && archive === "libskia.a") {
      makeArchive(archivePath, dir, "skia_entry", ["font_entry"]);
      appendArchiveObject(archivePath, dir, "skia_helper");
    } else if (cyclic && archive === "libfreetype2.a") {
      makeArchive(archivePath, dir, "font_entry", ["skia_helper"]);
    } else {
      run("AR", ["rcs", archivePath], dir);
    }
  }
  return { includeDir, libDir };
}

function configure(dir) {
  const buildDir = join(dir, "build");
  mkdirSync(buildDir, { recursive: true });
  try {
    run("CMAKE", ["-S", dir, "-B", buildDir], dir);
    return { ok: true, log: "" };
  } catch (error) {
    return { ok: false, log: `${error.stdout ?? ""}\n${error.stderr ?? ""}` };
  }
}

function build(dir) {
  const buildDir = join(dir, "build");
  run("CMAKE", ["--build", buildDir], dir);
  const executable = process.platform === "win32" ? join(buildDir, "Debug", "cyclic-link.exe") : join(buildDir, "cyclic-link");
  execFileSync(executable, [], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}

function expectNoGroupFailure(dir) {
  const buildDir = join(dir, "build");
  let output = "";
  try {
    run("CMAKE", ["--build", buildDir, "--target", "cyclic-link-no-group"], dir);
  } catch (error) {
    output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  assert.match(output, /undefined reference[^\n]*skia_helper|skia_helper[^\n]*undefined reference/u);
}

test("Android Skia block markers exist so tests execute production code", () => {
  assert.ok(cmakeLists.includes("# TN_SKIA_BLOCK_BEGIN"), "missing TN_SKIA_BLOCK_BEGIN");
  assert.ok(cmakeLists.includes("# TN_SKIA_BLOCK_END"), "missing TN_SKIA_BLOCK_END");
});

test.runIf(process.platform === "linux" && requireNativeFixture)(
  "required Linux Android Skia fixture tools are available",
  () => {
    assert.ok(
      hasNativeToolchain,
      "TN_REQUIRE_ANDROID_CANVAS_SKIA_FIXTURE=1 requires cmake, c++, and ar on PATH (or explicit tool paths)",
    );
  },
);

test.runIf(hasNativeToolchain)("Android + Canvas2D without staging fails closed at configure", () => {
  const dir = makeTempDirSync("tn-skia-android-missing-");
  temporaries.push(dir);
  writeFixture(dir, { android: true, abi: "arm64-v8a", canvas2dOn: true });
  const result = configure(dir);
  assert.equal(result.ok, false, "configure must fail without Android Skia layout");
  assert.match(result.log, /TN_SKIA_ANDROID/u);
});

test.runIf(hasNativeToolchain)("Android + Canvas2D missing a header fails closed", () => {
  const dir = makeTempDirSync("tn-skia-android-header-");
  temporaries.push(dir);
  writeFixture(dir, { android: true, abi: "arm64-v8a", canvas2dOn: true });
  const { includeDir } = makeLayout(dir, { root: "skia-android" });
  rmSync(join(includeDir, "include", "ports", "SkFontMgr_android.h"));
  const result = configure(dir);
  assert.equal(result.ok, false, "configure must fail without Android font headers");
  assert.match(result.log, /TN_SKIA_ANDROID_HEADERS_MISSING/u);
});

test.runIf(hasNativeToolchain)("Android + Canvas2D missing an archive fails closed and names it", () => {
  const dir = makeTempDirSync("tn-skia-android-partial-");
  temporaries.push(dir);
  writeFixture(dir, { android: true, abi: "arm64-v8a", canvas2dOn: true });
  makeLayout(dir, { missing: ["libfreetype2.a"], root: "skia-android" });
  const result = configure(dir);
  assert.equal(result.ok, false, "configure must fail with a partial archive set");
  assert.match(result.log, /libfreetype2\.a/u);
});

test.runIf(hasNativeToolchain)("Android + Canvas2D selects the ABI layout and closes a cyclic static link", () => {
  const dir = makeTempDirSync("tn-skia-android-valid-");
  temporaries.push(dir);
  writeFixture(dir, { android: true, abi: "arm64-v8a", canvas2dOn: true, link: true });
  const { libDir } = makeLayout(dir, { cyclic: true, root: "skia-android" });
  const decoy = join(dir, "third_party", "skia", "build", "linux-gpu", "lib", "Release", "x64");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "libskia.a"), "host decoy");
  const result = configure(dir);
  assert.equal(result.ok, true, `valid Android layout must configure:\n${result.log}`);
  const verdict = readFileSync(join(dir, "verdict.txt"), "utf8");
  assert.ok(verdict.includes(libDir), `selected library must be the Android ABI dir:\n${verdict}`);
  assert.ok(!verdict.includes("linux-gpu"), `host Linux layout leaked into verdict:\n${verdict}`);
  assert.ok(verdict.includes("SKIA_ANDROID_ABI=arm64-v8a"), `ABI not recorded:\n${verdict}`);
  assert.match(verdict, /--start-group/u);
  assert.match(verdict, /--end-group/u);
  expectNoGroupFailure(dir);
  build(dir);
});

test.runIf(hasNativeToolchain)("Canvas2D OFF does not require Android staging", () => {
  const dir = makeTempDirSync("tn-skia-android-off-");
  temporaries.push(dir);
  writeFixture(dir, { android: true, abi: "arm64-v8a", canvas2dOn: false });
  const result = configure(dir);
  assert.equal(result.ok, true, `Canvas2D OFF should preserve the disabled path:\n${result.log}`);
});

test.runIf(hasNativeToolchain)("non-Android Skia keeps the existing host layout", () => {
  const dir = makeTempDirSync("tn-skia-desktop-");
  temporaries.push(dir);
  writeFixture(dir, { android: false, canvas2dOn: true });
  const { libDir } = makeLayout(dir);
  const result = configure(dir);
  assert.equal(result.ok, true, `desktop Skia layout must remain usable:\n${result.log}`);
  const verdict = readFileSync(join(dir, "verdict.txt"), "utf8");
  assert.ok(verdict.includes(libDir), `desktop library was not selected:\n${verdict}`);
});
