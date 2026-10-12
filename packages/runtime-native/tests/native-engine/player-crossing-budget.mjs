// The bridge crossings of a settled frame (PRD-573 v1.11 step 0): the load test's R2 rung with 1,024 cubes
// and three setters per cube, through core's real projection pipeline on the real V8 player. A settled frame
// has to cost a few crossings per cube; the budget below is the v1.11 target, not today's number.
// CPU and GPU both run headless (no window), so it needs no display.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const CUBES = 1024;
const BUDGET_PER_CUBE = 3.5;
const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-crossing-budget.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-crossing-budget-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const outfile = resolve(work, "game.js");
await bundleNativeEngine({
  entry: resolve(native, "../../examples/engine-load-test/src/native-engine.ts"),
  outfile,
  boot: false,
  host: true,
  define: {
    __TN_PLATFORM__: JSON.stringify("engine-desktop"),
    __TN_BENCH_FOX_URL__: JSON.stringify(""),
    __TN_BENCH_CONFIG__: JSON.stringify({
      animate: true,
      axes: {},
      frames: Number(process.env.TN_CROSSING_FRAMES ?? 60),
      height: 360,
      ladder: [CUBES],
      modes: ["R2"],
      refreshHz: 60,
      repeats: 1,
      warmup: 30,
      width: 640,
    }),
  },
});

const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy", TN_PLAYER_METRICS: "1", TN_PLAYER_CROSSINGS: "1" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const finished = await new Promise((done) => {
  const timer = setTimeout(() => done(false), 240_000);
  const stop = () => { clearTimeout(timer); done(true); };
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("ENGINE_LOAD_TEST_JSON_END")) stop();
  });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.once("exit", stop);
});
// SIGTERM is SDL's quit: the player returns from its loop and prints the crossing histogram.
const exited = new Promise((done) => (child.exitCode === null ? child.once("exit", done) : done()));
child.kill("SIGTERM");
await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
child.kill("SIGKILL");
assert(finished, `the R2 rung never finished:\n${output.slice(-2000)}`);
assert(!output.includes("ENGINE_LOAD_TEST_FAILED"), output.slice(-2000));

// The timed window: the frames printed between the rung's two markers, the settled ones.
const lines = output.split("\n");
const begin = lines.findIndex((line) => line.trim() === `window R2@${CUBES}`);
const end = lines.findIndex((line) => line.startsWith(`rung R2@${CUBES} frame `));
assert(begin >= 0 && end > begin, "the rung printed no timed window");
const crossings = lines
  .slice(begin, end)
  .filter((line) => line.includes("TN_PLAYER_FRAME:"))
  .map((line) => JSON.parse(line.slice(line.indexOf("TN_PLAYER_FRAME:") + "TN_PLAYER_FRAME:".length)).bridgeCalls)
  .sort((a, b) => a - b);
assert(crossings.length >= 20, `only ${crossings.length} frames in the window`);
const median = crossings[crossings.length >> 1];
const perCube = median / CUBES;
// Where the crossings go (whole run, startup included), for whoever is bringing the number down.
const histogram = lines.find((line) => line.startsWith("TN_PLAYER_CROSSINGS:"));
if (histogram !== undefined) {
  const { total, names, collectVisits, liveWrappers } = JSON.parse(histogram.slice("TN_PLAYER_CROSSINGS:".length));
  const top = Object.entries(names).slice(0, 8).map(([name, count]) => `${name} ${count}`).join(", ");
  console.log(`whole run ${total} crossings, ${collectVisits} wrapper visits over ${liveWrappers} live wrappers; most crossed: ${top}`);
}
console.log(`R2@${CUBES}: median ${median} crossings per settled frame, ${perCube.toFixed(2)} per cube (budget ${BUDGET_PER_CUBE})`);
assert(perCube <= BUDGET_PER_CUBE, `${perCube.toFixed(2)} crossings per cube, over the budget of ${BUDGET_PER_CUBE}`);
console.log("PASS a settled R2 frame stays within the crossing budget");
