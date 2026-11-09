// PRD-610: the player's game thread keeps its own cores (one L3 domain, or one physical core under a single
// L3) and every other player thread runs on the remaining CPUs (Linux desktop). On Midway a busy-waiting present worker sharing
// the game thread's core cost it 15 to 30% of its IPC. Placement is always on; the environment cannot opt out.
// PRD-859: the game thread wins the CPU. The frame-critical threads (game, `tn-render`, `tn-gpu`) ask for nice -10
// (setpriority, else rtkit) and every other thread and child process yields at nice +10. A refused raise is reported,
// never fatal, and TN_PLAYER_PRIORITY=normal keeps the OS default. Values are read back from /proc (stat field 19).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-thread-placement.mjs <tn-native-engine-player-v8> [--x11]");
// --x11 (under scripts/xvfb.sh): a presenter exists, so the GPU and render threads start and must be raised too.
const x11 = process.argv[3] === "--x11";
// The setting PRD-610 removed, assembled so its name never appears in the tree again. The player ignores it.
const removed = ["TN", "PLAYER", "MAIN", "CORE"].join("_");

const parseList = (text) => text.trim().split(",").flatMap((part) => {
  const [first, last = first] = part.split("-").map(Number);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
});
const allowedOf = (pid, tid) => parseList(/Cpus_allowed_list:\s*(\S+)/.exec(readFileSync(`/proc/${pid}/task/${tid}/status`, "utf8"))[1]);
const allowed = allowedOf(process.pid, process.pid);
if (allowed.length < 4) {
  console.log(`SKIP fewer than four allowed CPUs (${allowed.join(",")})`);
  process.exit(0);
}
const work = await mkdtemp(resolve(native, "build/player-thread-placement-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
let frames = 0;
const frame = () => { if (++frames === 90) globalThis.tn.log("PLACEMENT_READY"); requestAnimationFrame(frame); };
requestAnimationFrame(frame);
`);
await bundleNativeEngine({ entry, outfile, boot: false, host: true });

// Field 19 of /proc/<pid>/task/<tid>/stat; the name field (2) may hold spaces, so count from its closing paren.
const niceOf = (pid, tid) => Number(readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8").split(") ")[1].split(" ")[16]);
const commOf = (pid, tid) => readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf8").trim();
/** Every thread of `pid` and of each descendant process. */
const tasksOf = (pid) => readdirSync(`/proc/${pid}/task`).flatMap((tid) => {
  let children = [];
  try { children = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch {}
  return [{ pid, tid: Number(tid), comm: commOf(pid, tid), nice: niceOf(pid, tid), cpus: allowedOf(pid, tid) }, ...children.flatMap(tasksOf)];
});

/** Runs the player until PLACEMENT_READY (after at least one sweep), then reads every thread's CPUs and nice value. */
async function placement(setting, { env: extra = {}, wrap = [] } = {}) {
  const env = { ...process.env, SDL_VIDEODRIVER: x11 ? "x11" : "dummy", SDL_AUDIO_DRIVER: "dummy", ...extra };
  delete env.TN_PLAYTEST_MAILBOX_ROOT;
  if (!("TN_PLAYER_PRIORITY" in extra)) delete env.TN_PLAYER_PRIORITY;
  if (setting === undefined) delete env[removed]; else env[removed] = setting;
  const command = [...wrap, resolve(executable), outfile];
  // The player inherits this process's nice value (a renice daemon such as ananicy-cpp may have moved it off 0).
  const startNice = niceOf(process.pid, process.pid);
  const child = spawn(command[0], command.slice(1), { env });
  let output = "";
  const closed = new Promise((done) => child.once("close", done));
  const ready = new Promise((done) => {
    const read = (chunk) => { output += chunk; if (output.includes("PLACEMENT_READY")) done(true); };
    child.stdout.on("data", read); child.stderr.on("data", read);
    closed.then(() => done(false));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  assert(await ready, `player exited before PLACEMENT_READY: ${output.slice(-2000)}`);
  await new Promise((done) => setTimeout(done, 1_200));  // one more sweep for threads started late
  const threads = tasksOf(child.pid);  // `prlimit` execs the player, so the child pid is the player's
  child.kill("SIGTERM");
  await closed; clearTimeout(timer);
  const game = threads.find((t) => t.tid === child.pid);
  const critical = (t) => t === game || (t.pid === child.pid && (t.comm === "tn-render" || t.comm === "tn-gpu"));
  const reports = [...output.matchAll(/^TN_PROCESS_PRIORITY (.*)$/gm)].map((m) => m[1]);
  return { output, main: game.cpus, helpers: threads.filter((t) => t !== game), game, critical: threads.filter(critical),
    // SDL raises its own audio device threads; the player leaves them as SDL set them.
    background: threads.filter((t) => !critical(t) && !(t.pid === child.pid && t.comm.startsWith("SDLAudio"))), report: reports.at(-1) ?? "", startNice };
}

for (const setting of [undefined, "off"]) {
  const placed = await placement(setting);
  const match = /TN_THREAD_PLACEMENT main=(\S+) helpers=(\d+)/.exec(placed.output);
  assert(match, `${removed} ${setting ?? "unset"} still gets the auto placement: ${placed.output.slice(-2000)}`);
  const main = match[1].split(",").map(Number);
  assert.deepEqual(placed.main, main, "the game thread runs only on the announced core");
  assert(placed.helpers.length > 0, "the player has helper threads");
  for (const helper of placed.helpers)
    assert(!helper.cpus.some((cpu) => main.includes(cpu)), `helper ${helper.tid} may run on the game core: ${helper.cpus}`);
  console.log(`PASS ${removed} ${setting ?? "unset"} is ignored: the game thread holds ${main.join(",")}`);
}

const pass = (name, run) => { console.log(`PASS ${name}: ${run.report}`); };
const field = (run, key) => new RegExp(`(?:^| )${key}=(\\S+)`).exec(run.report)?.[1];
const assertReport = (run, name) => {
  assert(run.report, `${name}: no TN_PROCESS_PRIORITY line: ${run.output.slice(-2000)}`);
  // The line states what the OS applied: each frame-critical value matches /proc.
  assert.equal(Number(field(run, "game")), run.game.nice, `${name}: the report's game value is what /proc reads`);
  for (const t of run.critical.filter((c) => c !== run.game))
    assert.equal(Number(field(run, t.comm === "tn-gpu" ? "present" : "render")), t.nice, `${name}: the report's ${t.comm} value is what /proc reads`);
};

// AC-1: every background thread and child process reads nice +10 or more (a renice daemon such as ananicy-cpp can start
// the player higher: it files `node` as BG_CPUIO, nice 16); the frame-critical threads stay at or below 0.
const raised = await placement(undefined);
assertReport(raised, "default");
assert(raised.background.length > 0, "the player has background threads");
for (const t of raised.background) assert(t.nice >= 10, `background ${t.pid}/${t.tid} (${t.comm}) reads nice ${t.nice}`);
for (const t of raised.critical) assert(t.nice <= 0, `frame-critical ${t.tid} (${t.comm}) reads nice ${t.nice}`);
if (x11) assert.deepEqual(raised.critical.filter((t) => t !== raised.game).map((t) => t.comm).sort(), ["tn-gpu", "tn-render"], "the GPU and render threads name themselves");
assert(Number(field(raised, "background")) >= 10, "the report states the lowest background value, at least 10");
assert.equal(field(raised, "override"), "none");
pass("default", raised);

// AC-2: with no RLIMIT_NICE allowance, rtkit raises the game thread (when this machine runs rtkit) ...
const rtkit = await placement(undefined, { wrap: ["prlimit", "--nice=0", "--"] });
assertReport(rtkit, "RLIMIT_NICE=0");
if (field(rtkit, "source") === "rtkit") {
  assert.equal(rtkit.game.nice, -10, "rtkit raised the game thread to -10");
  pass("RLIMIT_NICE=0 raises through rtkit", rtkit);
} else {
  assert.equal(field(rtkit, "source"), "none", `RLIMIT_NICE=0 without rtkit reports source=none: ${rtkit.report}`);
  console.log(`SKIP rtkit is not reachable here: ${rtkit.report}`);
}
// ... and with neither route the game thread keeps its nice value, the line says why, and the player still runs.
const refused = await placement(undefined, { wrap: ["prlimit", "--nice=0", "--"], env: { DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/nonexistent/tn-prd-859" } });
assertReport(refused, "no route");
assert.equal(refused.game.nice, refused.startNice, "a refused raise leaves the game thread at its starting nice value");
assert.equal(field(refused, "source"), "none");
assert.match(refused.report, /reason=EACCES/);
for (const t of refused.background) assert(t.nice >= 10, `background ${t.tid} (${t.comm}) still yields without a raise`);
pass("no raise route", refused);

// AC-7: TN_PLAYER_PRIORITY=normal (display.priority: "normal") keeps the OS default and says so.
const normal = await placement(undefined, { env: { TN_PLAYER_PRIORITY: "normal" } });
assertReport(normal, "override");
assert.equal(field(normal, "override"), "normal");
for (const t of [...normal.background, ...normal.critical]) assert.equal(t.nice, normal.startNice, `${t.tid} (${t.comm}) keeps the OS default`);
pass("TN_PLAYER_PRIORITY=normal", normal);
