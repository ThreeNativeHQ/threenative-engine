#!/usr/bin/env node
// Prints the scenarios in a scaffolded project that prove behaviour without needing a rendered
// frame. golden-path proves that a stranger can scaffold, install, build and play — its runner has
// no GPU, and the pixel scenarios it cannot serve are already covered by test-browser and visuals.
//
// The split is derived from the scenario files, never listed here: a scenario is visual when it
// captures a screenshot or names a baseline image. A hand-maintained list is the drift that leaves
// a newly added pixel scenario running on a machine that cannot render it.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const [projectRoot, boardFlag, boardKit] = process.argv.slice(2);
if (
  projectRoot === undefined ||
  (boardFlag !== undefined && (boardFlag !== "--board" || !boardKit))
) {
  process.stderr.write("usage: non-visual-scenarios.mjs <project-root> [--board <kit>]\n");
  process.exit(2);
}
// Owner cut (2026-11-01): on these kits a board leaves its longest scenarios to the nightly, which
// runs every scenario. Frames, not files, cost the time, and a scenario's scripted ticks predict
// its frames (run 41325468129: shooter debug-endurance 6866 ticks, 6846 frames).
const BOARD_TRIMMED_KITS = new Set([
  "shooter",
  "collectathon",
  "rain",
  "adventure",
  "platformer",
  "kart",
  // sailing's longest scenario is also the first one alphabetically, so on a board it paid the
  // kit's whole cold `pnpm dev` transform plus a cold SwiftShader pipeline compile inside its
  // first-frame budget and reported `waitFrames requested 1 frame(s) exceeded 20250ms` at 0
  // frames, while every later scenario in the same kit rendered (run 43355962916: 7650, 3620 and
  // 1896 ticks against a 500 limit). The nightly builds the project and runs every scenario, and
  // there the same scenario completes 7590 frames.
  "sailing",
]);
const BOARD_TICK_LIMIT = 500;
const scriptedTicks = (scenario) =>
  (scenario.warmupFrames ?? 0) +
  (scenario.steps ?? []).reduce(
    (total, step) => total + (step.holdTicks ?? 0) + (step.waitTicks ?? 0),
    0,
  );
const directory = path.join(projectRoot, "playtests");
const entries = readdirSync(directory).filter((name) => name.endsWith(".playtest.json"));
if (entries.length === 0) {
  process.stderr.write(`no scenarios found in ${directory}\n`);
  process.exit(1);
}

const visual = (source) => {
  const scenario = JSON.parse(source);
  if (scenario.artifacts?.screenshots !== undefined && scenario.artifacts.screenshots !== false)
    return true;
  if (JSON.stringify(scenario.assert ?? {}).includes("baseline")) return true;
  // A frame-time budget needs a GPU as surely as a pixel does — more, in fact: the starter's
  // `play` asserts maxFrameMsP95 33 at 1920x1080, which a CPU rasteriser cannot meet however
  // correct the game is. It belongs to the lanes that have hardware, not to the proof that a
  // stranger can scaffold and play.
  if (scenario.assert?.performance !== undefined) return true;
  // A `visual` assertion forces the runner to capture a frame no matter what the artifacts say —
  // `wantsVisual` overrides `--no-screenshots`, correctly, because the assertion needs the pixels.
  // Missing this let a scenario through as non-visual and straight into the screenshot hang.
  if (scenario.assert?.visual !== undefined || scenario.assert?.tone !== undefined) return true;
  // A scenario whose steps hold an input for many ticks and then assert on where the subject
  // ended up is measuring distance travelled under sustained simulation, which is as much a
  // hardware property as a pixel is. `coyote` is the case: it walks the player off a ledge over
  // 91 ticks and asserts a coyote jump, and on a CPU rasteriser the player does not reach the
  // edge — the run reports `jumps: 1, coyoteJumps: 0`, an ordinary jump, because the ledge is
  // still under it. Tightening the wait makes it worse, not better: with a shorter hold the
  // player has definitely not left the ground.
  //
  // Keyed off the scenario's own shape rather than a name list: a long input hold followed by an
  // assertion on a resource the movement drives. `pnpm test:templates` runs these with hardware,
  // which is the gate that can actually answer them.
  const longHoldTicks = 60;
  const holdsLong = (scenario.steps ?? []).some(
    (step) => typeof step.holdTicks === "number" && step.holdTicks >= longHoldTicks,
  );
  const assertsMovementResource = (scenario.assert?.resources ?? []).some(
    ({ path: resourcePath }) =>
      typeof resourcePath === "string" && /coyote|jumps/iu.test(resourcePath),
  );
  if (holdsLong && assertsMovementResource) return true;
  return (scenario.steps ?? []).some((step) => step.screenshot !== undefined);
};

const kept = [];
const skipped = [];
const nightly = [];
for (const name of entries.sort()) {
  const source = readFileSync(path.join(directory, name), "utf8");
  if (visual(source)) skipped.push(name);
  else if (
    BOARD_TRIMMED_KITS.has(boardKit) &&
    scriptedTicks(JSON.parse(source)) >= BOARD_TICK_LIMIT
  )
    nightly.push(name);
  else kept.push(name);
}
// Never a silent narrowing: what this drops is printed where the job's log will carry it.
process.stderr.write(
  `non-visual scenarios: ${kept.length} kept, ${skipped.length} left to the lanes with hardware (${skipped.join(", ")}), ${nightly.length} left to the nightly (${nightly.join(", ")})\n`,
);
if (kept.length === 0) {
  process.stderr.write("every scenario is visual; nothing would run\n");
  process.exit(1);
}
process.stdout.write(kept.map((name) => `playtests/${name}`).join("\n"));
