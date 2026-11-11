// PRD-859 on Windows and macOS (Linux: player-thread-placement.mjs). The game thread wins the CPU.
// Windows: the frame-critical threads read THREAD_PRIORITY_ABOVE_NORMAL (1) and every other player thread
// THREAD_PRIORITY_LOWEST (-2). The test reads each thread back through .NET (ProcessThread.PriorityLevel), apart
// from the player's own GetThreadPriority line.
// macOS: the frame-critical threads read QOS_CLASS_USER_INTERACTIVE (pthread_get_qos_class_np on each thread, which
// only that thread can read, so the report line is the readout).
// TN_PLAYER_PRIORITY=normal changes no thread on either OS.
// TN_PRIORITY_WINDOWED=1 opens a real window: only a presenter starts the present (tn-gpu) and render (tn-render)
// threads, so this mode fails unless both are reported and raised. The default mode runs SDL's dummy driver.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const windowed = process.env.TN_PRIORITY_WINDOWED === "1";
const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-thread-priority-desktop.mjs <tn-native-engine-player-v8[.exe]>");
assert(["win32", "darwin"].includes(process.platform), `Windows and macOS only; Linux runs player-thread-placement.mjs (${process.platform})`);

const work = await mkdtemp(resolve(native, "build/player-thread-priority-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
globalThis.tn.scene = new Scene();
globalThis.tn.camera = new PerspectiveCamera();
let frames = 0;
const frame = () => { if (++frames === 90) globalThis.tn.log("PRIORITY_READY"); requestAnimationFrame(frame); };
requestAnimationFrame(frame);
`);
await bundleNativeEngine({ entry, outfile, boot: false, host: true });

/** Every thread of `pid` with its .NET priority level (AboveNormal, Lowest, Normal, ...). */
const windowsThreads = (pid) => execFileSync("powershell", ["-NoProfile", "-Command",
  `(Get-Process -Id ${pid}).Threads | ForEach-Object { "$($_.Id) $($_.PriorityLevel)" }`], { encoding: "utf8" })
  .trim().split(/\r?\n/).map((line) => { const [tid, level] = line.trim().split(" "); return { tid: Number(tid), level }; });

async function run(extra = {}) {
  const env = { ...process.env, ...(windowed ? {} : { SDL_VIDEODRIVER: "dummy" }), SDL_AUDIO_DRIVER: "dummy", ...extra };
  delete env.TN_PLAYTEST_MAILBOX_ROOT;
  if (!("TN_PLAYER_PRIORITY" in extra)) delete env.TN_PLAYER_PRIORITY;
  const child = spawn(resolve(executable), [outfile], { env });
  let output = "";
  const closed = new Promise((done) => child.once("close", done));
  const ready = new Promise((done) => {
    const read = (chunk) => { output += chunk; if (output.includes("PRIORITY_READY")) done(true); };
    child.stdout.on("data", read); child.stderr.on("data", read);
    closed.then(() => done(false));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  assert(await ready, `player exited before PRIORITY_READY: ${output.slice(-2000)}`);
  await new Promise((done) => setTimeout(done, 1_500));  // one more sweep for threads started late
  const threads = process.platform === "win32" ? windowsThreads(child.pid) : [];
  child.kill();
  await closed; clearTimeout(timer);
  const report = [...output.matchAll(/^TN_PROCESS_PRIORITY (.*?)\r?$/gm)].map((m) => m[1]).at(-1) ?? "";
  assert(report, `no TN_PROCESS_PRIORITY line: ${output.slice(-2000)}`);
  const field = (key) => new RegExp(`(?:^| )${key}=(\\S+)`).exec(report)?.[1];
  return { report, field, threads };
}

const raised = await run();
const normal = await run({ TN_PLAYER_PRIORITY: "normal" });
assert.equal(raised.field("override"), "none");
assert.equal(normal.field("override"), "normal");
const critical = (r) => ["game", "render", "present"].filter((k) => r.field(k) !== "none");
assert(critical(raised).includes("game"), `the game thread is reported: ${raised.report}`);
if (windowed) for (const key of ["render", "present"]) assert(critical(raised).includes(key), `windowed: the ${key} thread is reported: ${raised.report}`);

if (process.platform === "win32") {
  for (const key of critical(raised)) assert.equal(raised.field(key), "1", `${key} reads THREAD_PRIORITY_ABOVE_NORMAL: ${raised.report}`);
  assert.equal(raised.field("background"), "-2", `every background thread reads THREAD_PRIORITY_LOWEST: ${raised.report}`);
  assert.equal(raised.field("source"), "SetThreadPriority");
  // Read back outside the player: exactly the reported frame-critical threads are AboveNormal, the rest Lowest.
  const above = raised.threads.filter((t) => t.level === "AboveNormal");
  const others = raised.threads.filter((t) => t.level !== "AboveNormal");
  assert.equal(above.length, critical(raised).length, `AboveNormal threads: ${JSON.stringify(raised.threads)}`);
  for (const t of others) assert.equal(t.level, "Lowest", `thread ${t.tid} reads ${t.level}`);
  for (const t of normal.threads) assert.equal(t.level, "Normal", `override: thread ${t.tid} reads ${t.level}`);
  for (const key of critical(normal)) assert.equal(normal.field(key), "0", `override: ${key} keeps THREAD_PRIORITY_NORMAL`);
} else {
  for (const key of critical(raised)) assert.equal(raised.field(key), "user-interactive", `${key} reads QOS_CLASS_USER_INTERACTIVE: ${raised.report}`);
  assert.equal(raised.field("source"), "qos");
  // The override sets no QoS; what the OS starts a thread with differs by launch context, so only the source is checked.
  assert.equal(normal.field("source"), "none", `override: no QoS is set: ${normal.report}`);
}
console.log(`PASS ${windowed ? "windowed" : "default"}: ${raised.report}`);
console.log(`PASS TN_PLAYER_PRIORITY=normal: ${normal.report}`);
