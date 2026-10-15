// PRD-610: the player's game thread owns one physical core and every other player thread runs on the
// remaining CPUs (TN_PLAYER_MAIN_CORE, Linux desktop). On Midway a busy-waiting present worker sharing
// the game thread's core cost it 15 to 30% of its IPC. Unset or `off` leaves placement to the OS (opt-in until a policy passes the keep rule).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-thread-placement.mjs <tn-native-engine-player-v8>");

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
const target = allowed.at(-1);
const core = parseList(readFileSync(`/sys/devices/system/cpu/cpu${target}/topology/thread_siblings_list`, "utf8"))
  .filter((cpu) => allowed.includes(cpu));

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

/** Runs the player until PLACEMENT_READY (after at least one sweep), then reads every thread's CPUs. */
async function placement(setting) {
  const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy", TN_PLAYER_MAIN_CORE: setting };
  delete env.TN_PLAYTEST_MAILBOX_ROOT;
  if (setting === undefined) delete env.TN_PLAYER_MAIN_CORE;
  const child = spawn(resolve(executable), [outfile], { env });
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
  const threads = readdirSync(`/proc/${child.pid}/task`).map((tid) => ({ tid: Number(tid), cpus: allowedOf(child.pid, tid) }));
  child.kill("SIGTERM");
  await closed; clearTimeout(timer);
  return { output, main: threads.find((t) => t.tid === child.pid).cpus, helpers: threads.filter((t) => t.tid !== child.pid) };
}

const pinned = await placement(String(target));
assert.match(pinned.output, new RegExp(`TN_THREAD_PLACEMENT main=${core.join(",")} helpers=${allowed.length - core.length}\\b`));
assert.deepEqual(pinned.main, core, "the game thread runs only on the named core");
assert(pinned.helpers.length > 0, "the player has helper threads");
for (const helper of pinned.helpers)
  assert(!helper.cpus.some((cpu) => core.includes(cpu)), `helper ${helper.tid} may run on the game core: ${helper.cpus}`);
console.log(`PASS game thread on ${core.join(",")}, ${pinned.helpers.length} helper threads off it`);

for (const setting of [undefined, "off"]) {
  const free = await placement(setting);
  assert.doesNotMatch(free.output, /TN_THREAD_PLACEMENT/);
  assert.deepEqual(free.main, allowed, `${setting ?? "unset"} leaves the game thread's CPUs alone`);
  console.log(`PASS ${setting ?? "unset"} leaves placement to the OS`);
}
