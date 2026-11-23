// PRD-906: the owned engine player is a page, so a game hears its window hide and show as
// `visibilitychange`, and `process.exit(code)` ends the run with that code. This runs the real
// player executable on a private X display, unmaps its window with xdotool, and reads back the
// markers the game and the player printed (the same window probe as `host-window.test.mjs`).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { nativeTestExecutable, runtimeRoot } from "../scripts/native-test-lane.mjs";

// The player a checkout build writes (`cmake --preset tn-linux -B build/tn-engine-ui
// -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON ... --target tn-native-engine-player-v8`), or the one
// `THREENATIVE_ENGINE_PLAYER` names, as this package's other player tests take it.
const player =
  process.env.THREENATIVE_ENGINE_PLAYER ??
  nativeTestExecutable(join(runtimeRoot, "build", "tn-engine-ui"), "tn-native-engine-player-v8");
const xvfb = fileURLToPath(new URL("../../../scripts/xvfb.sh", import.meta.url));
const have = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
// The probe reads and unmaps the window the X server reports, so only the Linux lane can run it.
const linux = process.platform === "linux";
const available = linux && existsSync(player) && ["Xvfb", "xdotool", "xwininfo"].every(have);
const playerTest = available ? test : test.skip;
const scratch = makeTempDirSync("tn-player-visibility-");

playerTest("the player's page hears the window hide and show, and process.exit sets the run's code", () => {
  // A game with no imports: the player's own document, its own console (`[log]` lines), and no
  // scene, so the loop runs its loader frames while the window is unmapped and mapped again. The
  // update callback is what the player requires of a bundle before it starts the loop.
  const game = join(scratch, "game.js");
  writeFileSync(
    game,
    `globalThis.tn.onUpdate(() => {});
console.log("TN_TEST_VIS_INITIAL:" + document.visibilityState + ":" + document.hidden);
document.addEventListener("visibilitychange", () => { throw new Error("listener boom"); });
document.addEventListener("visibilitychange", () => {
  console.log("TN_TEST_VIS:" + document.visibilityState + ":" + document.hidden);
  if (!document.hidden) process.exit(3);
});
`,
  );
  const script = `
    TN_PLAYER_TITLE=player-visibility TN_PLAYER_WIDTH=320 TN_PLAYER_HEIGHT=200 ${JSON.stringify(player)} ${JSON.stringify(game)} >${JSON.stringify(`${game}.log`)} 2>&1 &
    pid=$!
    for i in $(seq 1 100); do
      sleep 0.1
      xwininfo -root -tree | grep -q player-visibility && break
    done
    sleep 1
    id=$(xwininfo -root -tree | grep player-visibility | awk '{print $1}' | head -1)
    xdotool windowunmap "$id"
    sleep 1
    xdotool windowmap "$id"
    for i in $(seq 1 100); do kill -0 $pid 2>/dev/null || break; sleep 0.1; done
    kill $pid 2>/dev/null
    wait $pid
    echo "TN_TEST_EXIT:$?"
    cat ${JSON.stringify(`${game}.log`)}
  `;
  const out = spawnSync("sh", [xvfb, "sh", "-c", script], { encoding: "utf8", timeout: 120_000 }).stdout;
  assert.match(out, /TN_TEST_VIS_INITIAL:visible:false/u, `the player's document starts visible\n${out.slice(-800)}`);
  const states = [...out.matchAll(/TN_TEST_VIS:(\w+):(\w+)/gu)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(states, ["hidden:true", "visible:false"], `the listener saw ${states}\n${out.slice(-800)}`);
  assert.match(out, /TN_VISIBILITY:\{"state":"hidden"\}/u, `the player reports each state it sets\n${out.slice(-800)}`);
  assert.match(out, /TN_VISIBILITY:\{"state":"visible"\}/u, `the player reports each state it sets\n${out.slice(-800)}`);
  assert.match(out, /listener boom/u, `a throwing listener is reported\n${out.slice(-800)}`);
  assert.match(out, /TN_TEST_EXIT:3/u, `process.exit(3) is the run's exit code\n${out.slice(-800)}`);
});
