---
name: weak-model-benchmark
description: Use a weak model as the benchmark for ThreeNative authoring. DeepSeek V4.1 Flash max on leanpi (the remote model) builds a sealed brief in a user-like sandbox, a friction meter scores its session, and each failure becomes a framework change, then the same brief runs again. Use when asked to run the weak-model benchmark or loop, to measure cold-agent friction on a cheap model, or to make the framework easier for a weak author. Not the framework-versus-vanilla comparison (self-improve).
---

# weak-model-benchmark

The framework is good when a weak model gets far with it. A strong model hides friction
because it recovers from bad docs, wrong APIs and missing defaults. DeepSeek V4.1 Flash max on
leanpi is the model the remote sessions use, so it is the benchmark.

**Roles.** DeepSeek builds, and only DeepSeek builds. You (the lead) scaffold, run gates, read
the transcript, classify failures and fix the framework. You do not edit the arm's game.

## The score

One run gives two files in its archive. Compare runs of the same brief only.

| Signal | Source | Better is |
|---|---|---|
| Sealed proof pass count | `proof.json` from `pnpm sweep:proof` | higher (primary) |
| `firstSrcWriteAt` | `friction.json` | lower: the kit and docs got the agent working fast |
| `capabilitySearchesBeforeFirstWrite` | `friction.json` | at least 1: the agent found the manifest |
| `toolErrors`, `packageInternalReads` | `friction.json` | lower: the public surface answered |
| `typecheckRuns`, `playtestRuns` | `friction.json` | at least 1 each: the agent verified |
| `outputTokens`, `costUsd`, `stopReason` | `friction.json` | lower cost, `stop` not a cap |

A run with `verdict: "VOID"` ran on a model other than `opencode-go/deepseek-v4.1-flash` at
thinking `max`. It is not evidence. Discard it and run again.

## Loop

1. **Resume.** List earlier runs: `ls docs/benchmark/sweeps/ | grep wm-`. Read only the newest
   `friction.json` and `proof.json` for the brief you continue.
2. **Scaffold** a fresh user-like game. Pick a sealed genre from `docs/benchmark/genres/` and
   the kit that `create-threenative --genre <alias>` resolves for it:

   ```sh
   pnpm sandbox --genre <genre> --template <kit> --name wm-<genre>-<n> --out ~/projects/threenative/wm-sandboxes/wm-<genre>-<n>
   ```

   Give each run its own `--out` root. In the shared `../sandbox` the arm walked into a sibling
   game and ran its scripts (wm-platformer-1, calls 11-19); from a worktree the default lands inside
   the repo, where the arm inherits the repo's `AGENTS.md` chain. A fresh worktree also needs `packages/runtime-native/build/web`
   (copy it from a checkout whose build is newer than the last native source change).

   The game must have `brief.md`, `reference.png`, `AGENTS.md` and `.mcp.json`.
3. **Run the arm.** One arm at a time (two arms trip systemd-oomd):

   ```sh
   .claude/skills/weak-model-benchmark/scripts/run-arm.sh ../sandbox/wm-<genre>-<n> \
     artifacts/weak-model/wm-<genre>-<n> ["<user prompt>"]
   ```

   The default prompt is the user's request: build `brief.md`, match `reference.png`, play
   from spawn. Add no hints, no repo paths and no skill names. A hint hides the friction that
   the run must find. `WM_ARM_MINUTES` caps the run (default 90). The script pins every leanpi
   role to DeepSeek flash in `~/.cache/tmp-tn/weak-model/xdg/`, because the Auto router can
   switch to Claude Opus.
4. **Gate.** Run the sealed proof on the arm's output, then keep the evidence:

   ```sh
   pnpm sweep:capture <game-dir>        # the sealed proof headed on the GPU; writes proof.json
   pnpm sweep:archive <game-dir>        # refuses a game without proof.json
   cp artifacts/weak-model/wm-<genre>-<n>/friction.json docs/benchmark/sweeps/<archive>/
   ```

   `pnpm sweep:proof` runs headless, lands on SwiftShader and fails `TN_PLAYTEST_SOFTWARE_ADAPTER`.
   When `nvidia-smi` reports a driver/library mismatch, source the per-process driver shim first.
5. **Read the failures.** Read the session log with `jq`, not whole:
   errors (`toolResult.isError`), reads into `node_modules/@threenative/*/src|dist`, rewrites of
   a shipped system, and the point where the agent gave up or stopped verifying. Write one row
   for each failure: symptom, call number, layer, smallest framework fix.
6. **Fix the framework, not the game.** Name the layer first (`AGENTS.md`, "Name the layer"):

   | Failure | Fix goes to |
   |---|---|
   | Wrong or invented API | the type (closed union, required param) or an error message that names the fix |
   | Rewrote a shipped system | the capability row text, the kit default, or a kit lint rule in `packages/create-threenative/src/quality/` |
   | Read package internals | the capability row or the kit `AGENTS.md` that should have answered |
   | Did not verify | the kit's one verify command and its output |
   | Lost in instructions | a shorter kit `AGENTS.md`: move each rule into a type, a lint rule or a default |

   Each fix gets a red-green test. Record it in the PRD that owns this loop.
7. **Run the same brief again** with a new `<n>`. Keep a fix when the primary score does not
   drop and its target signal improves. Run each arm at least twice before you claim a win:
   one DeepSeek run is noisy.

## Rules

- Keep all build work on DeepSeek. Do not hand the arm a Claude subagent, a skill or a hint.
- Do not edit a sealed `brief.md`, `reference.png` or proof scenario.
- Do not fix a failure in the sandbox game. A fix there leaves every other game broken.
- Do not add an abstraction that no weak-model run reached for. The kill switch
  (`AGENTS.md` rule 2) still applies.
- Report `unmeasured` for a gate that did not run.

## Stop rules

Stop at the first that applies, and record which:

1. **Floor reached:** two consecutive VALID runs per genre pass the full sealed proof.
2. **Plateau:** two consecutive rounds move no signal beyond run-to-run noise.
3. **Blocked:** a verified tool or environment failure. Name the missing piece.
4. **Budget spent:** the owner's round, time or cost budget.

## Known facts

- leanpi adds its own house-style prefix (TLDR, status emoji). Remote users get the same
  prefix, so it is part of the benchmark.
- leanpi loads MCP servers lazily. On a fresh scaffold its catalog has no cache, so the arm
  sees **no** `engine_*` tools until a server connects (probe, 2026-11-12). A `tools` hint
  list in the generated `.mcp.json` entry gives leanpi catalog rows without a connection
  (`lean-pi/src/mcp/catalog.ts`).
