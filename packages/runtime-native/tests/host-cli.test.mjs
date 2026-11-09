// Behaviour of the desktop CLI host (`mystral run`), proved by running it. It needs the
// `mystral` binary that `pnpm native:build` makes, so the default repository gate skips these.
// `pnpm native:verify:desktop` runs this file and requires the binary: a missing one fails there
// (also with TN_NATIVE_REQUIRE_HOST=1) instead of skipping.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { desktopBuildDirectory, nativeTestExecutable } from "../scripts/native-test-lane.mjs";

const mystral = process.env.TN_NATIVE_MYSTRAL_BIN ?? nativeTestExecutable(desktopBuildDirectory(), "mystral");
const required =
  process.env.TN_NATIVE_REQUIRE_HOST === "1" ||
  process.env.npm_lifecycle_event === "native:verify:desktop";
if (required) assert.ok(existsSync(mystral), `the desktop verify lane needs ${mystral} (run pnpm native:build)`);
const hostTest = existsSync(mystral) ? test : test.skip;
const scratch = makeTempDirSync("tn-host-cli-");

function runGame(source, env = {}, extraArgs = []) {
  const script = join(scratch, `game-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(script, source);
  const result = spawnSync(mystral, ["run", script, "--no-sdl", "--quiet", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

// Startup order is load-bearing: the playtest mailbox bridge is wired before the game script is
// evaluated (a game reads TN_PLAYTEST_MAILBOX at top level), and the script is evaluated before the
// main loop starts (the loop then fires the timer the script scheduled).
hostTest("runScript wires the host bridges, loads the game, then drives the loop", () => {
  const result = runGame(
    `const wired = typeof globalThis.TN_PLAYTEST_MAILBOX === "object" &&
       globalThis.TN_PLAYTEST_ENDPOINT === "native://desktop-mailbox";
     setTimeout(() => {
       console.log("TN_ORDER_PROBE " + (wired ? "bridge-before-load" : "bridge-missing"));
       process.exit(wired ? 0 : 3);
     }, 1);`,
    { TN_PLAYTEST_MAILBOX_ROOT: scratch },
  );
  assert.match(result.stdout, /TN_ORDER_PROBE bridge-before-load/u, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// The host-gap meter reports a window of 300 rAF frames as one `TN_HOST_GAP:` line. The default
// per-frame sample stays `frame` + `webtransportMs` so routine logs do not grow; only
// `TN_HOST_GAP_DETAIL=1` (exactly) adds every segment, the rAF period and the rAF join.
const rafLoop = `let n = 0;
  const tick = () => { if (++n >= 420) process.exit(0); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);`;

function hostGap(env) {
  const result = runGame(rafLoop, { TN_HOST_GAP: "1", ...env });
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("TN_HOST_GAP:"));
  assert.ok(line, `no TN_HOST_GAP line\n${result.stdout.slice(-800)}${result.stderr.slice(-400)}`);
  return JSON.parse(line.slice("TN_HOST_GAP:".length));
}

hostTest("host gap: the default per-frame sample is frame plus webtransportMs only", () => {
  const gap = hostGap({});
  assert.equal(gap.frames, 300);
  assert.ok(gap.periodP50Ms > 0, "the rAF period is recorded");
  assert.ok("webtransport" in gap.segments, "webtransport is a metered segment");
  assert.equal(gap.samples.length, 300);
  for (const sample of gap.samples) {
    assert.deepEqual(Object.keys(sample), ["frame", "webtransportMs"]);
  }
});

hostTest("host gap: TN_HOST_GAP_DETAIL=1 attaches every segment, the period and the rAF join", () => {
  const gap = hostGap({ TN_HOST_GAP_DETAIL: "1" });
  const segments = Object.keys(gap.segments);
  for (const sample of gap.samples) {
    assert.deepEqual(Object.keys(sample), [
      "frame",
      ...segments.map((name) => `${name}Ms`),
      "periodMs",
      "rafTimestampMs",
      "rafCallbacksMs",
    ]);
    assert.ok(sample.periodMs > 0, "every kept sample carries the period that ends at its rAF");
  }
  const frames = gap.samples.map((sample) => sample.frame);
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b), "frame ids only grow");
  const stamps = gap.samples.map((sample) => sample.rafTimestampMs);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), "rAF timestamps only grow");
});

hostTest("host gap: only the exact value 1 turns detail on", () => {
  for (const value of ["0", "11", "true", ""]) {
    const gap = hostGap({ TN_HOST_GAP_DETAIL: value });
    assert.deepEqual(Object.keys(gap.samples[0]), ["frame", "webtransportMs"], `value ${value}`);
  }
});

// A web UI is a game requirement: a UI root that is not a directory fails the launch closed with a
// named diagnostic, and only the explicit scene-diagnostics flag lets the game run without it.
hostTest("web UI startup fails closed unless --bypass-ui-loading is explicit", () => {
  const game = "console.log('TN_GAME_RAN'); process.exit(0);";
  const missing = join(scratch, "no-such-ui");

  const refused = runGame(game, {}, ["--ui", missing]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /TN_UI_BUNDLE_MISSING/u);
  assert.doesNotMatch(refused.stdout, /TN_GAME_RAN/u, "the game must not start without its UI");

  const bypassed = runGame(game, {}, ["--ui", missing, "--bypass-ui-loading"]);
  assert.equal(bypassed.status, 0, bypassed.stdout + bypassed.stderr);
  assert.match(bypassed.stdout, /TN_GAME_RAN/u);
});
