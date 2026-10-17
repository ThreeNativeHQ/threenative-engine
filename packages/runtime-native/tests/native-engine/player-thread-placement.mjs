// PRD-610: the player's game thread keeps its own cores (one L3 domain, or one physical core under a single
// L3) and every other player thread runs on the remaining CPUs (Linux desktop). On Midway a busy-waiting present worker sharing
// the game thread's core cost it 15 to 30% of its IPC. Placement is always on; the environment cannot opt out.
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

/** Runs the player until PLACEMENT_READY (after at least one sweep), then reads every thread's CPUs. */
async function placement(setting) {
  const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
  delete env.TN_PLAYTEST_MAILBOX_ROOT;
  if (setting === undefined) delete env[removed]; else env[removed] = setting;
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
