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

const [projectRoot] = process.argv.slice(2);
if (projectRoot === undefined) {
  process.stderr.write("usage: non-visual-scenarios.mjs <project-root>\n");
  process.exit(2);
}
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
for (const name of entries.sort()) {
  const file = path.join(directory, name);
  (visual(readFileSync(file, "utf8")) ? skipped : kept).push(name);
}
// Never a silent narrowing: what this drops is printed where the job's log will carry it.
process.stderr.write(
  `non-visual scenarios: ${kept.length} kept, ${skipped.length} left to the lanes with hardware (${skipped.join(", ")})\n`,
);
if (kept.length === 0) {
  process.stderr.write("every scenario is visual; nothing would run\n");
  process.exit(1);
}
process.stdout.write(kept.map((name) => `playtests/${name}`).join("\n"));
