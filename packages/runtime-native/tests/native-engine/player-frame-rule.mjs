// PRD-644 and PRD-652 on the V8 player: the frame-period rule (Unreal's DynamicRenderScaling) that BudgetLadder,
// ShadowFilterBudget and GIBudget decide with. The rule runs here on scripted frame readings: a frame over the
// period for 2 frames steps a level down at once, a GPU that idles inside the period holds its level, a frame the
// stage cannot absorb keeps its level, and a move waits 8 frames. GIBudget then reads the player's own GPU timing of a
// pass labelled "SSGI" against the frame period for 120 frames and holds its method.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-frame-rule.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-frame-rule-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { AmbientLight, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SphereGeometry } from "three";
import { rtt, screenUV, vec4 } from "three/tsl";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { BudgetLadder, GIBudget, ShadowFilterBudget } from "@threenative/core";

const PERIOD = 1000 / 60;
const feed = (target, stage, frame, count) => {
  const windows = [];
  for (let i = 0; i < count; i++) {
    const closed = target.observe(stage, frame);
    if (closed !== undefined) windows.push(closed);
  }
  return windows;
};
const ladder = (start) => new BudgetLadder({ framePeriodMs: PERIOD, levels: ["cheap", "mid", "full"], start, windowFrames: 10 });
const rule = {};
// Two frames of 22 ms over the 16.7 ms period, 8 ms of it this stage: a step down at once.
const panic = feed(ladder("full"), 8, 22, 2);
rule.panic = { frames: panic[0]?.frames, panic: panic[0]?.panic, stepped: panic[0]?.stepped };
// One frame is not enough.
rule.oneFrame = feed(ladder("full"), 8, 22, 1).length;
// The same 8 ms of stage time at boost: a 9 ms frame holds.
rule.boost = feed(ladder("full"), 8, 9, 100).filter((w) => w.stepped !== undefined).length;
// A GPU that idles at P5 inside the period (14.8 ms against the 15 ms target) holds.
rule.idle = feed(ladder("mid"), 3, 14.8, 200).filter((w) => w.stepped !== undefined).length;
// A 30 ms frame of which this stage is 0.5 ms: the stage cannot absorb it and keeps its level.
const blame = feed(ladder("full"), 0.5, 30, 60);
rule.notBlamed = { stepped: blame.filter((w) => w.stepped !== undefined).length, flagged: blame.every((w) => w.notBlamed) };
// After a step, a 16 ms frame (over the target, inside the period) waits for the 8-frame change period.
const gated = ladder("full");
feed(gated, 8, 20, 2);
rule.gate = { early: feed(gated, 8, 16, 7).filter((w) => w.stepped !== undefined).length, eighth: feed(gated, 8, 16, 1)[0]?.stepped };
// The shadow tier follows Unreal's VSM settings: a 16.2 ms frame (over the 15.8 ms target) steps after the change period.
const shadow = new ShadowFilterBudget({ framePeriodMs: PERIOD, report: () => undefined, tier: "high", windowFrames: 10 });
rule.shadow = feed(shadow, 4, 16.2, 8).map((w) => w.stepped).filter(Boolean);

const scene = new Scene();
const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
camera.position.set(0, 1.5, 4);
camera.lookAt(0, 0.6, 0);
const floor = new Mesh(new PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x808080 }));
const ball = new Mesh(new SphereGeometry(0.8, 48, 24), new MeshStandardMaterial({ color: 0xb03030 }));
ball.position.y = 0.8;
const sun = new DirectionalLight(0xffffff, 3);
sun.position.set(2, 4, 3);
scene.add(floor, ball, sun, new AmbientLight(0xffffff, 0.4));
globalThis.tn.scene = scene;
globalThis.tn.camera = camera;
const renderer = new WebGPURenderer({ canvas: { width: 1280, height: 720 } });

const gi = new GIBudget({ framePeriodMs: PERIOD, method: "screenProbeGather", report: () => undefined, stages: ["SSGI"], windowFrames: 40 });
const reports = [];
let frame = 0;
let pipeline;
const step = () => {
  frame += 1;
  renderer.info.frame = frame;
  if (frame === 3) {
    const gather = rtt(vec4(0.2, 0.4, 0.6, 1), 256, 144, { type: 1016, gpuStage: "SSGI" });
    pipeline = new RenderPipeline(renderer, gather.sample(screenUV));
  }
  if (pipeline !== undefined) pipeline.render();
  if (frame >= 10) {
    const report = gi.observeRenderer(renderer);
    if (report !== undefined) reports.push(report);
  }
  if (frame === 160) {
    globalThis.tn.log("FRAME_RULE " + JSON.stringify({ rule, reports, method: gi.finalGatherMethod, enabled: globalThis.tn.renderInfo().gpuTiming.enabled }));
    return;
  }
  requestAnimationFrame(step);
};
requestAnimationFrame(step);
`);
await bundleNativeEngine({ entry, outfile, boot: false, host: true });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const verdict = await new Promise((done) => {
  const timer = setTimeout(() => done("timeout"), 90_000);
  const find = () => output.match(/FRAME_RULE (\{[^\n]*\})/u)?.[1];
  const read = (chunk) => {
    output += chunk;
    const found = find();
    if (found) {
      clearTimeout(timer);
      done(found);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done(find() ?? "exited");
  });
});
child.kill();
assert.doesNotMatch(verdict, /^(timeout|exited)$/u, `${verdict}\n${output.slice(-2000)}`);
const seen = JSON.parse(verdict);
const { rule } = seen;
assert.deepEqual(rule.panic, { frames: 2, panic: true, stepped: "mid" }, verdict);
assert.equal(rule.oneFrame, 0, verdict);
assert.equal(rule.boost, 0, verdict);
assert.equal(rule.idle, 0, verdict);
assert.deepEqual(rule.notBlamed, { stepped: 0, flagged: true }, verdict);
assert.deepEqual(rule.gate, { early: 0, eighth: "cheap" }, verdict);
assert.deepEqual(rule.shadow, ["medium"], verdict);
// GIBudget holds its method whatever the frame reads.
assert.equal(seen.method, "screenProbeGather", verdict);
if (!seen.enabled) {
  console.log("PASS the frame-period rule runs on the V8 player (SKIP the GI reading: this device has no timestamp-query)");
  process.exit(0);
}
assert(seen.reports.length >= 2, verdict);
for (const report of seen.reports) {
  assert.equal(report.finalGatherMethod, "screenProbeGather", verdict);
  assert(report.frameMs > 0, verdict);
  assert(report.stagesSeen.includes("SSGI"), verdict);
  assert(report.windowMs > 0 && report.windowMs < report.frameMs, verdict);
  assert(report.targetMs < report.periodMs, verdict);
  assert(report.verdict === (report.frameMs > report.targetMs ? "over" : "within"), verdict);
}
const last = seen.reports.at(-1);
console.log(`PASS the V8 player decides by the frame period: 2 frames over it step down, an idle GPU holds, GIBudget holds ${seen.method} (frame ${last.frameMs} ms of ${last.targetMs} ms target, SSGI ${last.windowMs} ms, ${last.verdict})`);
