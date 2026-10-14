// A free-running V8 game (no playtest runner) whose frame is slow still runs its frame callbacks once per
// drawn frame. Flushing them on every catch-up tick ran core's whole frame (game update, matrix walk, cull)
// up to five times per drawn frame on Midway, and each pass made the next frame later (PRD-610 AC-1).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-frame-per-present.mjs <tn-native-engine-player-v8> [--cpu-profile]");
const cpuProfile = process.argv.includes("--cpu-profile");
const work = await mkdtemp(resolve(native, "build/player-frame-per-present-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
// Each frame callback costs 25 ms, more than a 60 Hz tick, so the fixed-step clock falls behind and
// catches up with several ticks before each drawn frame.
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
let calls = 0;
const frame = () => {
  for (let i = 0; i < 2; i++) globalThis.tn.scene.__cullProjected(globalThis.tn.camera, true, 1, 0, false);
  const end = performance.now() + 25;
  while (performance.now() < end);
  if (++calls <= 40) globalThis.tn.log("FRAME_CALLBACK " + calls);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
`);
await bundleNativeEngine({ entry, outfile, boot: false, host: true });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy", TN_PLAYER_METRICS: "1",
  ...(cpuProfile ? { TN_JS_CPU_PROFILE: "1", TN_JS_CPU_PROFILE_START_FRAME: "10" } : {}) };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
const stopped = once(child, "close");
let output = "";
const reached = await new Promise((done) => {
  const timer = setTimeout(() => done(false), 60_000);
  const read = (chunk) => {
    output += chunk;
    if (output.includes("FRAME_CALLBACK 40")) { clearTimeout(timer); done(true); }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => { clearTimeout(timer); done(output.includes("FRAME_CALLBACK 40")); });
});
child.kill();
const stopTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
const [exitCode, signal] = await stopped;
clearTimeout(stopTimeout);
assert.notEqual(signal, "SIGKILL", "player must stop within five seconds of SIGTERM");
assert(reached, `the game never ran 40 frame callbacks:\n${output.slice(-2000)}`);
if (cpuProfile) {
  assert.equal(exitCode, 0, "profile flush must exit successfully");
  const profileStart = output.indexOf("TN_PLAYER_CPU_PROFILE_START_FRAME:10");
  assert(
    profileStart > output.indexOf("FRAME_CALLBACK 10\n") &&
      profileStart < output.indexOf("FRAME_CALLBACK 11\n"),
    "CPU profile must start after requested drawn frame 10",
  );
  assert(
    Number(output.match(/TN_JS_CPU_PROFILE_TOTAL:(\d+)/)?.[1]) > 0,
    "CPU profile must flush nonempty samples on SIGTERM",
  );
  assert.match(
    output,
    /TN_JS_CPU_PROFILE:\d+\t[^\t]+\tframe @ game\.js\tgame\.js:\d+/,
    "CPU profile must name the sampled game function and bundle",
  );
  console.log("PASS CPU profile starts after frame 10 and flushes samples on SIGTERM");
}
// Frame callbacks between two drawn frames (TN_PLAYER_FRAME is printed once per drawn frame), past warm-up
// and before the game stops logging them.
const perFrame = [];
let pending = 0;
for (const line of output.slice(0, output.indexOf("FRAME_CALLBACK 40")).split("\n")) {
  if (line.includes("FRAME_CALLBACK")) pending++;
  else if (line.startsWith("TN_PLAYER_FRAME:")) { perFrame.push(pending); pending = 0; }
}
const settled = perFrame.slice(3);
assert(settled.length >= 10, `too few drawn frames to judge: ${perFrame.join(",")}`);
assert(settled.every((count) => count === 1), `frame callbacks per drawn frame: ${settled.join(",")} (want 1 each)`);
console.log(`PASS one frame callback per drawn frame over ${settled.length} frames`);
const cullFrames = output.split("\n").filter((line) => line.startsWith("TN_PLAYER_FRAME:"))
  .map((line) => JSON.parse(line.slice("TN_PLAYER_FRAME:".length))).slice(3, 20);
assert(cullFrames.length >= 10 && cullFrames.every((frame) => frame.projectedCullCalls === 2), "cull calls must reset for each CPU frame");
assert(cullFrames.every((frame) => Number.isFinite(frame.projectedCullCpuMs) && frame.projectedCullCpuMs >= 0 &&
  frame.projectedCullCpuMs <= frame.cpuFrameCpuMs + 0.01), "cull CPU must be measured inside the main-thread CPU frame");
assert(cullFrames.reduce((sum, frame) => sum + frame.projectedCullCpuMs, 0) > 0, "repeated cull work must record positive thread CPU");
console.log("PASS projected cull CPU and two calls per frame");

// Each frame line also counts the main thread's user-space instructions, the A/B figure that host load does
// not move (PRD-610). The 25 ms busy callback alone retires millions, so a frame under 1,000 K is a broken
// counter. Only where the kernel grants a thread its own counter (perf_event_paranoid at most 2).
const paranoid = Number(readFileSync("/proc/sys/kernel/perf_event_paranoid", "utf8"));
if (paranoid <= 2) {
  const counts = output.split("\n").filter((line) => line.startsWith("TN_PLAYER_FRAME:"))
    .map((line) => JSON.parse(line.slice("TN_PLAYER_FRAME:".length)).cpuFrameKInstructions).slice(3, 20);
  assert(counts.length >= 10 && counts.every((count) => count > 1000), `cpuFrameKInstructions per frame: ${counts.join(",")}`);
  console.log(`PASS cpuFrameKInstructions on every frame (median ${counts.sort((a, b) => a - b)[counts.length >> 1]} K)`);
}
