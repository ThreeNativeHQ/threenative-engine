// A free-running V8 game (no playtest runner) whose frame is slow still runs its frame callbacks once per
// drawn frame. Flushing them on every catch-up tick ran core's whole frame (game update, matrix walk, cull)
// up to five times per drawn frame on Midway, and each pass made the next frame later (PRD-610 AC-1).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-frame-per-present.mjs <tn-native-engine-player-v8> [--cpu-profile] [--main-thread-cpu] [--driven-clock]");
const drivenClock = process.argv.includes("--driven-clock");
const liveClock = process.argv.includes("--live-clock");
const cpuProfile = process.argv.includes("--cpu-profile");
const mainThreadCpu = process.argv.includes("--main-thread-cpu");
const gpuTiming = process.argv.includes("--gpu-timing");
const work = await mkdtemp(resolve(native, "build/player-frame-per-present-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
// Each frame callback costs 25 ms, more than a 60 Hz tick, so the fixed-step clock falls behind and
// catches up with several ticks before each drawn frame.
await writeFile(entry, `
import { Scene, PerspectiveCamera, Object3D, AnimationMixer, AnimationClip, VectorKeyframeTrack } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
${drivenClock || liveClock ? `const player = new Object3D(); player.name = "player";
globalThis.tn.scene.add(player);
globalThis.tn.onUpdate(() => { player.position.x++; });` : ""}
const mixer = new AnimationMixer(new Object3D());
mixer.clipAction(new AnimationClip("meter", 1, [
  new VectorKeyframeTrack(".position", [0, 1], [0, 0, 0, 1, 0, 0]),
])).play();
let calls = 0;
const frame = () => {
  mixer.update(1 / 120);
  mixer.update(1 / 120);
  for (let i = 0; i < 2; i++) globalThis.tn.scene.__cullProjected(globalThis.tn.camera, true, 1, 0, false);
  const end = performance.now() + ${drivenClock ? 0 : 25};
  while (performance.now() < end);
  if (++calls <= 40) globalThis.tn.log("FRAME_CALLBACK " + calls);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
`);
await bundleNativeEngine({ entry, outfile, boot: false, host: true });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy", TN_PLAYER_METRICS: "1",
  ...(cpuProfile ? { TN_JS_CPU_PROFILE: "1", TN_JS_CPU_PROFILE_START_FRAME: "10" } : {}) };
delete env.TN_PLAYER_GPU_TIMING;
if (gpuTiming) env.TN_PLAYER_GPU_TIMING = "1";
delete env.TN_PLAYER_MAIN_THREAD_CPU;
if (mainThreadCpu) env.TN_PLAYER_MAIN_THREAD_CPU = "1";
delete env.TN_PLAYTEST_MAILBOX_ROOT;
if (gpuTiming && process.argv.includes("--render-thread")) {
  env.TN_RENDER_THREAD = "1";
  const child = spawn(resolve(executable), [outfile], { env });
  let output = "";
  const read = (chunk) => { output += chunk; if (output.includes("FRAME_CALLBACK")) child.kill("SIGTERM"); };
  child.stdout.on("data", read); child.stderr.on("data", read);
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = await once(child, "close"); clearTimeout(timer);
  assert.equal(code, 2); assert.match(output, /TN_PLAYER_GPU_TIMING_UNSUPPORTED.*TN_RENDER_THREAD=1/);
  console.log("PASS GPU timestamps reject requested render-thread execution");
  process.exit(0);
}

if (drivenClock || liveClock) {
  const mailbox = resolve(work, "mailbox");
  mkdirSync(mailbox);
  env.TN_PLAYTEST_MAILBOX_ROOT = mailbox;
  const request = resolve(mailbox, "tn-playtest-request.json");
  const response = resolve(mailbox, "tn-playtest-response.json");
  const child = spawn(resolve(executable), [outfile], { env });
  const stopped = once(child, "close");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const answer = async (id) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      if (existsSync(response)) {
        const text = readFileSync(response, "utf8");
        if (text.includes(`"id":"${id}"`)) { unlinkSync(response); return JSON.parse(text); }
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.fail(`missing mailbox answer ${id}: ${output.slice(-2000)}`);
  };
  let advanced;
  let sampled;
  try {
    await answer("ready");
    const call = async (id, method, argument) => {
      // A live held loop can poll between open(O_TRUNC) and write: publish atomically.
      writeFileSync(`${request}.tmp`, JSON.stringify({ id, method, argument }));
      renameSync(`${request}.tmp`, request);
      return answer(id);
    };
    if (liveClock) {
      const initial = await call("setup", "advance", 10);
      assert.equal(initial.result.clock.tick, 10);
      const mode = await call("live", "_setClockMode", "wall-clock");
      assert(Number.isSafeInteger(mode.result.epoch) && mode.result.epoch >= 0, "negotiation reports the current epoch");
      assert.equal(mode.error, undefined, "host must negotiate autonomous simulation");
      const forbidden = await call("forbidden", "advance", 1);
      assert.match(forbidden.error?.message ?? "", /TN_INSPECT_UNSUPPORTED/);
      await new Promise((done) => setTimeout(done, 180));
      const running = await call("running", "sample", { resources: ["state"] });
      assert.equal(running.result.clock.mode, "wall-clock");
      assert(running.result.clock.tick > 10, "live host must update without injected advances");
      assert.equal(running.result.clock.tick, running.result.resources.state.playerX);
      await call("renderhold", "_holdAutomaticRender", true);
      await new Promise((done) => setTimeout(done, 100));
      const whileHeld = await call("whileheld", "_setClockMode", "wall-clock");
      assert.equal(whileHeld.result.epoch, (await call("heldepoch", "_presentationCompletions")).result.epoch, "same-mode reply retains the held epoch");
      assert(whileHeld.result.tick > running.result.clock.tick, "render hold must not hold live simulation");
      const heldSample = await call("heldsample", "sample", { resources: ["state"] });
      assert.equal(heldSample.result.clock.tick, heldSample.result.resources.state.playerX);
      const completions = await call("cadence", "_presentationCompletions");
      assert.equal(completions.result.source, "present-return");
      assert.deepEqual(completions.result.samples, [], "headless draws are not presentations");
      await call("renderresume", "_holdAutomaticRender", false);
      const frozen = await call("fixed", "_setClockMode", "fixed-step");
      const tick = frozen.result.tick;
      await new Promise((done) => setTimeout(done, 120));
      const held = await call("held", "sample", {});
      assert.equal(held.result.clock.tick, tick, "returning to lockstep stops autonomous updates");
      const resumed = await call("resumed", "advance", 3);
      assert.equal(resumed.result.clock.tick, tick + 3, "mode switches preserve monotonic ticks");
      const again = await call("liveagain", "_setClockMode", "wall-clock");
      assert.equal(again.result.tick, tick + 3, "rebasing does not reset or inject simulation ticks");
      await new Promise((done) => setTimeout(done, 100));
      const active = await call("active", "sample", {});
      assert(active.result.clock.tick > tick + 3, "a second live epoch updates autonomously");
      // finally tears down an actively updating host, not only a held lockstep host.
    } else {
    writeFileSync(request, JSON.stringify({ id: "advance", method: "advance", argument: 2500 }));
    advanced = await answer("advance");
    writeFileSync(request, JSON.stringify({ id: "sample", method: "sample", argument: { resources: ["state"] } }));
    sampled = await answer("sample");
    }
  } finally {
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const [, signal] = await stopped;
    clearTimeout(timer);
    assert.notEqual(signal, "SIGKILL", "driven player must stop within five seconds");
  }
  if (liveClock) { console.log("PASS negotiated live clock, autonomous updates, headless exclusion and lockstep restoration"); process.exit(0); }
  assert.equal(advanced.error, undefined);
  assert.equal(sampled.error, undefined);
  assert.equal(advanced.result.ticks, 2500);
  assert.equal(advanced.result.clock.tick, 2500, "host clock must count every driven update");
  assert.equal(sampled.result.clock.tick, 2500, "sample clock must share the driven clock");
  assert.equal(sampled.result.resources.state.tick, 2500, "game resource must share the driven clock");
  assert.equal(sampled.result.resources.state.playerX, 2500, "each requested tick must execute one game update");
  const frames = output.split("\n").filter((line) => line.startsWith("TN_PLAYER_FRAME:"))
    .map((line) => JSON.parse(line.slice("TN_PLAYER_FRAME:".length))).filter((frame) => frame.updates === 1);
  assert.equal(frames.length, 2500, "metrics mode must render each driven update");
  frames.forEach((frame, index) => assert.equal(frame.tick, index + 1, "frame clock must advance exactly once per update"));
  console.log("PASS 2500 driven updates share authoritative host, sample, resource and rendered-frame ticks");
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
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
assert(cullFrames.every((frame) => Object.hasOwn(frame, "gpuTiming") === gpuTiming), "GPU timestamp metrics must be opt-in");
if (gpuTiming) {
  for (let i = 0; i < cullFrames.length; i++) {
    const value = cullFrames[i].gpuTiming;
    assert.equal(value.enabled, true);
    assert.equal(typeof value.supported, "boolean");
    assert(Number.isInteger(value.samples) && value.samples >= 0);
    assert.equal(typeof value.fresh, "boolean");
    if (!value.supported) assert.equal(value.samples, 0);
    if (value.samples === 0) {
      assert.equal(value.elapsedMs, null); assert.equal(value.segmentsMs, null); assert.equal(value.fresh, false);
    } else {
      assert(Number.isFinite(value.elapsedMs) && value.elapsedMs > 0);
      assert.equal(value.segmentsMs.length, 4);
      assert(value.segmentsMs.every((v) => Number.isFinite(v) && v >= 0));
    }
    if (i > 0) {
      assert(value.samples >= cullFrames[i - 1].gpuTiming.samples);
      assert.equal(value.fresh, value.samples > cullFrames[i - 1].gpuTiming.samples);
    }
  }
  console.log("PASS GPU timestamp metric schema/freshness (not a GPU support claim)");
}
assert(cullFrames.every((frame) => Object.hasOwn(frame, "mainThreadCpuMs") === mainThreadCpu &&
  Object.hasOwn(frame, "measuredFrames") === mainThreadCpu), "whole main-thread CPU endpoints must be opt-in");
if (mainThreadCpu) {
  assert(cullFrames.every((frame) => Number.isFinite(frame.mainThreadCpuMs) && frame.mainThreadCpuMs > 0 &&
    Number.isInteger(frame.measuredFrames) && frame.measuredFrames > 0), "CPU endpoints need the clock and completed frame count");
  for (let i = 1; i < cullFrames.length; i++) {
    assert.equal(cullFrames[i].measuredFrames, cullFrames[i - 1].measuredFrames + 1, "count every complete rendered frame");
    assert(cullFrames[i].mainThreadCpuMs - cullFrames[i - 1].mainThreadCpuMs >= cullFrames[i].cpuFrameCpuMs - 0.01,
      "cumulative main-thread CPU must include the existing frame CPU window");
  }
  console.log("PASS cumulative main-thread CPU and completed-frame endpoints");
}
assert(cullFrames.length >= 10 && cullFrames.every((frame) => frame.projectedCullCalls === 2), "cull calls must reset for each CPU frame");
assert(cullFrames.every((frame) => Number.isFinite(frame.projectedCullCpuMs) && frame.projectedCullCpuMs >= 0 &&
  frame.projectedCullCpuMs <= frame.cpuFrameCpuMs + 0.01), "cull CPU must be measured inside the main-thread CPU frame");
assert(cullFrames.reduce((sum, frame) => sum + frame.projectedCullCpuMs, 0) > 0, "repeated cull work must record positive thread CPU");
console.log("PASS projected cull CPU and two calls per frame");
// This is native mixer work through property publication; event-listener callbacks are excluded.
assert(cullFrames.every((frame) => frame.animationMixerCalls === 2), "mixer calls must reset for each CPU frame");
assert(cullFrames.every((frame) => Object.hasOwn(frame, "animationMixerCpuMs") &&
  (frame.animationMixerCpuMs === null || (Number.isFinite(frame.animationMixerCpuMs) && frame.animationMixerCpuMs >= 0))),
  "mixer CPU must be finite/nonnegative or explicitly null when unavailable");
assert(cullFrames.every((frame) => !Number.isFinite(frame.cpuFrameCpuMs)
  ? frame.animationMixerCpuMs === null
  : Number.isFinite(frame.animationMixerCpuMs) && frame.animationMixerCpuMs <= frame.cpuFrameCpuMs + 0.01),
  "mixer CPU must use its paired main-thread CPU frame, or be null when that clock is unavailable");
assert(cullFrames.reduce((sum, frame) => sum + frame.animationMixerCpuMs, 0) > 0,
  "repeated mixer work must record positive thread CPU");
console.log("PASS native mixer CPU (excluding listeners) and two calls per frame");

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
