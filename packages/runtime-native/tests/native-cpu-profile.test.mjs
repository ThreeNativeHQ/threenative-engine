// PRD-444: a user names a hot native function without installing a system profiler. The V8
// `CpuProfiler` compiles into desktop builds behind `TN_JS_PROFILE`, `--cpu-prof <path>` writes a
// loadable Chrome DevTools `.cpuprofile`, and a shipping mobile build carries none of it.
//
// These are source-contract checks in the style of this package's other native tests: the real
// proof is AC-1's run on a built host, which this file's shape keeps honest.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { bundleNativeEngine } from "../scripts/bundle-native-engine.mjs";

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const cmake = source("../CMakeLists.txt");
const v8Engine = source("../src/js/v8_engine.cpp");
const main = source("../src/cli/main.cpp");
const bindings = source("../src/webgpu/bindings.cpp");
const engineHeader = source("../include/mystral/js/engine.h");
const player = source("../src/engine/player/v8_main.cpp");

test("the engine player accepts both CPU-profile forms and rejects missing paths before startup", () => {
  assert.match(player, /argument == "--cpu-prof"/u);
  assert.match(player, /argument\.rfind\("--cpu-prof=", 0\) == 0/u);
  assert.match(player, /cpuProfilePath\.empty\(\) \|\| cpuProfilePath\.rfind\("--", 0\) == 0/u);
  assert.match(player, /TN_PLAYER_V8_ARGS: --cpu-prof requires a nonempty file path/u);
  assert.match(player, /--cpu-prof requires a build compiled with TN_JS_PROFILE=ON/u);
  assert(player.indexOf("mystral::js::g_cpuProfilePath = cpuProfilePath;") < player.indexOf("if (!game.start(gamePath, error))"));
  assert.match(player, /g_cpuProfileStopRequested && mystral::js::g_dumpCpuProfile/u);
  assert.match(player, /std::_Exit\(mystral::js::g_cpuProfileFailed \? 1 : 0\)/u);
  assert.match(player, /return finish\(status\);/u);
  assert.match(player, /return mystral::js::g_cpuProfileFailed \? 1 : status;/u);
});

test("native profile maps retain original game sources through both bundling stages", async () => {
  const dir = makeTempDirSync("tn-profile-map-");
  const entry = join(dir, "hot.ts");
  const outfile = join(dir, "game.js");
  const original = 'import { Scene } from "three";\nexport function profileHot(value: number) { return Math.sqrt(value); }\nglobalThis.profileHot = profileHot;\nglobalThis.profileScene = new Scene();\n';
  writeFileSync(entry, original);
  const result = await bundleNativeEngine({ entry, outfile, boot: false, host: false });
  const output = readFileSync(outfile, "utf8");
  const map = JSON.parse(readFileSync(`${outfile}.map`, "utf8"));
  assert.equal(result.bytes, Buffer.byteLength(output));
  assert.equal(map.version, 3);
  assert(map.mappings.length > 0);
  assert(map.sources.some((name) => name.endsWith("/hot.ts")));
  assert(map.sourcesContent.includes(original));
  assert(map.sources.some((name) => name.endsWith("/core-three.mjs")));
  assert(!map.sources.includes("native-game:game"), "map must resolve the intermediate bundle");
  assert(!output.includes("sourceMappingURL=data:"), "production bundle must not embed source maps");
});

// Opt in only after rebuilding the player; an older local binary cannot qualify this change.
const enginePlayer = process.env.THREENATIVE_ENGINE_PLAYER;
test.skipIf(!enginePlayer)("the built engine player rejects malformed profile args and flushes both CLI forms", async () => {
  for (const args of [["--cpu-prof"], ["--cpu-prof="], ["--cpu-prof", ""], ["--cpu-prof", "--check-game"]]) {
    const result = spawnSync(enginePlayer, ["unused.js", ...args], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--cpu-prof requires a nonempty file path/u);
  }
  const dir = makeTempDirSync("tn-player-cpu-prof-");
  const entry = join(dir, "game.ts");
  const script = join(dir, "game.js");
  writeFileSync(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
const begin = performance.now();
while (performance.now() - begin < 100) Math.sqrt(performance.now());
let frames = 0;
const frame = () => {
  if (++frames === 1) globalThis.tn.log("PROFILE_FRAME_READY");
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
`);
  await bundleNativeEngine({ entry, outfile: script, boot: false, host: true });
  for (const equals of [false, true]) {
    const out = join(dir, `${equals}.cpuprofile`);
    const result = spawnSync(enginePlayer, [script, "--check-game", ...(equals ? [`--cpu-prof=${out}`] : ["--cpu-prof", out])],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const profile = JSON.parse(readFileSync(out, "utf8"));
    assert(profile.nodes.length > 0 && profile.samples.length > 0);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    if (process.platform === "linux") {
      assert.equal(profile.clockBounds?.clock, "CLOCK_MONOTONIC");
      const [startBefore, startAfter] = profile.clockBounds.start;
      const [endBefore, endAfter] = profile.clockBounds.end;
      assert.ok(startBefore <= startAfter && startAfter <= endBefore && endBefore <= endAfter);
      const low = Math.max(startBefore - profile.startTime, endBefore - profile.endTime);
      const high = Math.min(startAfter - profile.startTime, endAfter - profile.endTime);
      assert.ok(low <= high, `profile clocks contradict recorded bounds: [${low}, ${high}]`);
    }
  }
  const result = spawnSync(enginePlayer, [script, "--check-game", `--cpu-prof=${join(dir, "missing", "out.cpuprofile")}`],
    { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TN_CPU_PROFILE_WRITE_FAILED/u);
  assert(!result.stdout.includes("startup=passed"));

  const out = join(dir, "sigterm.cpuprofile");
  const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy", TN_PLAYER_METRICS: "1" };
  delete env.TN_PLAYTEST_MAILBOX_ROOT;
  const child = spawn(enginePlayer, [script, `--cpu-prof=${out}`], {
    env,
  });
  const stopped = once(child, "close");
  let output = "";
  let terminated = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      // A completed frame proves the loop and signal handler are ready, unlike bundle evaluation.
      if (!terminated && output.includes("PROFILE_FRAME_READY") && output.includes("TN_PLAYER_FRAME:")) {
        terminated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const [status, signal] = await stopped;
    assert(terminated, `player never completed the fixture's first frame: ${output}`);
    assert.equal(signal, null, output);
    assert.equal(status, 0, output);
    const profile = JSON.parse(readFileSync(out, "utf8"));
    assert(profile.nodes.length > 0 && profile.samples.length > 0);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("desktop builds compile the V8 CPU profiler and mobile builds do not", () => {
  // On by default for a desktop build, off for Android and iOS. The option default is computed
  // from the target, so a shipping mobile build carries no profiler code at all.
  assert.match(cmake, /set\(TN_JS_PROFILE_DEFAULT OFF\)/u);
  assert.match(cmake, /set\(TN_JS_PROFILE_DEFAULT ON\)/u);
  assert.match(cmake, /option\(TN_JS_PROFILE[^\n]+ \$\{TN_JS_PROFILE_DEFAULT\}\)/u);
  assert.match(cmake, /TN_JS_PROFILE=\$<BOOL:\$\{TN_JS_PROFILE\}>/u);
  // The profiler blocks stay reachable for the existing Android profiling build.
  assert.match(v8Engine, /#if TN_JS_PROFILE \|\| TN_ANDROID_JS_PROFILE/u);
  assert.doesNotMatch(v8Engine, /#if TN_ANDROID_JS_PROFILE\n#include "v8-profiler\.h"/u);
});

test("--cpu-prof writes the DevTools .cpuprofile itself, escaping every string", () => {
  // V8's `CpuProfile::Serialize` writes names and URLs unescaped: a native Midway run produced a
  // `RegExp: ^((?:[^\[\]…` frame name and a file DevTools could not parse. The host walks the
  // profile API and escapes instead.
  assert.doesNotMatch(v8Engine, /profile->Serialize\(/u);
  assert.match(v8Engine, /static void writeJsonString\(std::ostream& out, const char\* text\)/u);
  assert.match(v8Engine, /writeCpuProfile\(isolate_, profile, temporaryPath\)/u);
  assert.match(engineHeader, /inline thread_local std::string g_cpuProfilePath;/u);
assert.match(v8Engine, /writeCpuProfile\(isolate_, profile, temporaryPath,/u);
  assert.match(engineHeader, /inline std::string g_cpuProfilePath;/u);
  assert.match(engineHeader, /inline bool g_cpuProfileFailed = false;/u);
});

const compiler = process.env.CXX || "c++";
const compilerProbe = spawnSync(compiler, ["--version"], { encoding: "utf8" });

test.skipIf(compilerProbe.error?.code === "ENOENT")("CPU profile paths and callbacks belong to their engine thread", () => {
  assert.equal(compilerProbe.status, 0, compilerProbe.error?.message ?? compilerProbe.stderr);
  const dir = makeTempDirSync("tn-cpu-prof-thread-");
  const cpp = join(dir, "ownership.cpp");
  const executable = join(dir, process.platform === "win32" ? "ownership.exe" : "ownership");
  writeFileSync(cpp, `
#include "mystral/js/engine.h"
#include <iostream>
#include <thread>
int main() {
  using namespace mystral::js;
  int mainStarts = 0, mainDumps = 0, workerStarts = 0, workerDumps = 0;
  bool wrongThread = false, workerEmpty = false;
  const auto mainThread = std::this_thread::get_id();
  g_cpuProfilePath = "main.cpuprofile";
  g_startCpuProfile = [&] { wrongThread |= std::this_thread::get_id() != mainThread; ++mainStarts; };
  g_dumpCpuProfile = [&] { wrongThread |= std::this_thread::get_id() != mainThread; ++mainDumps; };
  std::thread worker([&] {
    workerEmpty = g_cpuProfilePath.empty() && !g_startCpuProfile && !g_dumpCpuProfile;
    const auto workerThread = std::this_thread::get_id();
    g_cpuProfilePath = "worker.cpuprofile";
    g_startCpuProfile = [&, workerThread] { wrongThread |= std::this_thread::get_id() != workerThread; ++workerStarts; };
    g_dumpCpuProfile = [&, workerThread] { wrongThread |= std::this_thread::get_id() != workerThread; ++workerDumps; };
    g_startCpuProfile();
    g_dumpCpuProfile();
  });
  worker.join(); // Serialize access even with the unfixed, process-global declarations.
  const bool mainPathPreserved = g_cpuProfilePath == "main.cpuprofile";
  g_startCpuProfile();
  g_dumpCpuProfile();
  if (!workerEmpty || !mainPathPreserved || wrongThread || mainStarts != 1 ||
      mainDumps != 1 || workerStarts != 1 || workerDumps != 1) {
    std::cerr << "profiler ownership failed: workerEmpty=" << workerEmpty
              << " mainPathPreserved=" << mainPathPreserved << " wrongThread=" << wrongThread << '\\n';
    return 1;
  }
}
`);
  execFileSync(compiler, ["-std=c++17", "-pthread", "-I", fileURLToPath(new URL("../include", import.meta.url)), cpp, "-o", executable], { stdio: "pipe", timeout: 30_000 });
  execFileSync(executable, [], { stdio: "pipe", timeout: 5_000 });
});

const host = fileURLToPath(new URL("../build/tn-linux/mystral", import.meta.url));

test.skipIf(!existsSync(host))("a profile whose script URL holds a quote and a backslash still parses", () => {
  const dir = makeTempDirSync("tn-cpu-prof-");
  const script = join(dir, "hot.js");
  const out = join(dir, "hot.cpuprofile");
  writeFileSync(script, [
    "const hot = eval('(function hot() { let x = 0; for (let i = 0; i < 2e5; i++) x += Math.sqrt(i); return x; })\\n//# sourceURL=we\"ird\\\\path.js');",
    "const t0 = Date.now();",
    "while (Date.now() - t0 < 500) hot();",
  ].join("\n"));
  execFileSync(host, ["run", script, "--no-sdl", "--cpu-prof", out], { stdio: "ignore", timeout: 60_000 });
  const profile = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  assert.equal(profile.clockBounds?.clock, "CLOCK_MONOTONIC");
  const [startBefore, startAfter] = profile.clockBounds.start;
  const [endBefore, endAfter] = profile.clockBounds.end;
  assert.ok(startBefore <= startAfter && startAfter <= endBefore && endBefore <= endAfter, "clockBounds out of order");
  // Each profile time was taken inside its bounds, so one constant offset must place both.
  const offsetLow = Math.max(profile.startTime - startAfter, profile.endTime - endAfter);
  const offsetHigh = Math.min(profile.startTime - startBefore, profile.endTime - endBefore);
  assert.ok(offsetLow <= offsetHigh, `no single offset places the profile inside clockBounds: [${offsetLow}, ${offsetHigh}]`);
  const hot = profile.nodes.find((node) => node.callFrame.functionName === "hot");
  assert.equal(hot?.callFrame.url, 'we"ird\\path.js');
}, 90_000);

test("a SIGTERM run flushes the profile from the frame boundary, not the signal handler", () => {
  // A playtest stops the host with SIGTERM, which runs no destructor. The handler may only set a
  // signal-safe flag; the render loop dumps from a normal context where V8 is safe to call.
  assert.match(engineHeader, /inline volatile std::sig_atomic_t g_cpuProfileStopRequested = 0;/u);
  assert.match(main, /std::signal\(SIGTERM, \[\]\(int\) \{ mystral::js::g_cpuProfileStopRequested = 1; \}\)/u);
  assert.match(bindings, /js::g_cpuProfileStopRequested && js::g_dumpCpuProfile/u);
  assert.doesNotMatch(main, /SIGTERM[\s\S]{0,200}g_dumpCpuProfile/u);
});

test("the host CLI parses --cpu-prof, forwards the path and fails closed without the profiler", () => {
  assert.match(main, /arg == "--cpu-prof" && i \+ 1 < argc/u);
  assert.match(main, /arg\.rfind\("--cpu-prof=", 0\) == 0/u);
  assert.match(main, /mystral::js::g_cpuProfilePath = opts\.cpuProfilePath;/u);
  // A build without the profiler refuses the flag rather than running and writing nothing.
  assert.match(main, /--cpu-prof requires a build compiled with TN_JS_PROFILE=ON/u);
  // The profiler starts at the steady-state frame for the env var, and at once for --cpu-prof.
  assert.match(bindings, /getenv\("TN_JS_CPU_PROFILE_START_FRAME"\)[\s\S]{0,120}: 226u;/u);
  assert.match(bindings, /frameEndCount == startFrame\) js::g_startCpuProfile\(\);/u);
  assert.match(v8Engine, /if \(!g_cpuProfilePath\.empty\(\)\) g_startCpuProfile\(\);/u);
});
