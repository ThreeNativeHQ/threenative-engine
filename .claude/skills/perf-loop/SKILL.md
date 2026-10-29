---
name: perf-loop
description: Run ThreeNative's performance loop — pin a baseline, measure on a frozen judge, attribute the frame, change one thing, prove nothing broke, keep or reject on a repeated paired A/B, re-profile, repeat. Use when asked to "run the perf loop", make the engine faster, cut frame time, work a performance campaign PRD such as PRD-400, or continue one. Not for a one-off FPS reading (measure-steady-state-fps) and not for startup, loading or compile work that has no steady-state metric.
---

# Performance loop

Make the same frame cost less, on the same scene, at the same pixels. The loop exists because
one-off optimizations never add up: a packet 80% smaller, a span 2 ms shorter, a draw count halved
have each shipped here without the game getting faster. **Only the end-to-end frame decides.**

Each run belongs to a campaign PRD (PRD-400 is the first). The PRD names the lanes, their order, the
workloads, the acceptance numbers and the facts already measured. Read its *already known* and
*already implemented* sections before the first candidate; a rediscovered fix is a wasted iteration.

## 0. Contract — once per campaign, before any candidate

Record these as ledger rows `L0-*` (see §6):

- **Target metric:** native desktop frame p50 on the campaign's representative game, plus the
  per-lane term being attacked. FPS is derived, never the target.
- **Judge:** the exact commands in §2, their flags, the workload and the scenario files.
- **Frozen paths:** every file the judge reads — its scripts, workloads, scenarios, playtest
  assertions and budgets. Write the list into the ledger.
- **Mutable surface:** the lane's files, named by the PRD.
- **Pinned baseline:** commit, built host binary hash, installed tarball hashes, machine state.
- **Noise band:** three A/A runs of the baseline per metric. The band is the largest median
  difference between any two of them.
- **Holdouts:** workloads the loop never tunes against, run only at lane end.

Work in `.claude/worktrees/<prd>-perf-loop/`, branched from `develop`, with the campaign's one draft PR.

## 1. Before every measurement

1. Run `node packages/playtest/dist/runner/cli.js doctor --text`. Name an unavailable target instead
   of substituting another.
2. Nothing else may hold the GPU or the CPU cores: no other renderer, capture, build, conformance run
   or agent arm. Check the process list and the GPU's memory users. The arm pool and the GPU are
   shared across sessions; a queue timeout is contention, not a broken tool.
3. Browser arms pass `--browser-recipe webgpu` and record `adapter.info`. SwiftShader is a failed
   arm, not a slow one.
4. A private Xvfb throttles presentation. There, compare `render` p50 and the CPU terms, never fps.
   FPS verdicts come from a real display or an attached device.
5. After a core or playtest change, rebuild core and playtest `dist` before measuring: games and core
   specs import them, and a stale `dist` measures the old code.
6. Sandbox games install tarballs by constant filename. Reinstall, verify the installed bytes, free
   the dev server by port (`lsof -ti tcp:<port> | xargs -r kill`) and start a fresh one.

## 2. The judge — the tools that exist

| Workload | Command |
| --- | --- |
| Synthetic matrix cell | `pnpm bench:engines --arm tn-desktop --ladder <n> --modes L1,L3 --repeats <k> --source-sha <sha>` (`tn-web`, `tn-android` for the other runtimes; `L3` is the projection on) |
| Scaffolded platformer, holdout | `pnpm profile:production --target desktop-pair --repetitions <n> --warmup <s> --duration <s>` |
| Judge sensitivity control | the same command with `--control slow-native`: must come back slower |
| Representative game | the `measure-steady-state-fps` skill on the campaign's game, native desktop and browser |

When the campaign PRD's Phase 1 extends a tool (a project input, new matrix axes), use the extended
form and freeze it; never use a flag the tool does not ship yet.

**Frame meters.** Every native run prints `TN_FRAME_BUDGET` (render/update/ui/residual/gpu) and
`TN_HOST_GAP` (the between-callbacks sub-phases, replay and present wait included) marker lines on
stdout. Read them with `node packages/playtest/dist/runner/cli.js perf --file <log>`, or
`--executable <host binary>`, or `--logcat <serial>`. The projection report carries
`timings.reconcileMs` and planned draws; the renderer's measured draws sit beside them. A divergence
between planned and measured draws is a finding.

**Profiles diagnose; they never judge.** `TN_JS_CPU_PROFILE=1` samples V8 only in a host built with
it, and it perturbs the frame. `pnpm profile:native-cpu` is Chromium: it isolates shared JS costs and
proves nothing about the native host.

## 3. Attribute before choosing

Split the steady-state frame into five terms: projection reconcile, three.js CPU, recorder JS,
native replay, present/GPU wait. The split must cover at least 95% of the frame; name what is
missing rather than guess. Then pick the largest **removable** term — the work whose inputs did not
change, the draw that did not need to exist — not the largest file or the cleverest subsystem.

## 4. One iteration

1. **Hypothesis, written first:** the term, the expected delta in ms, at most five files, and why the
   work is removable. Check the PRD's *already implemented* list.
2. **Capability search** (`engine_search_capabilities`, then `engine_capability_detail` on each hit)
   before any new file under `packages/`.
3. **Test first** when behaviour can change: the lane's mutation cases (the campaign PRD lists them)
   fail before the change or were already green and must stay green.
4. **Implement and commit** the candidate by path. Commit messages go through `-F <file>`.
5. **Frozen-path check:** `git diff --name-only <baseline>..HEAD -- <frozen paths>` prints nothing.
   Anything printed rejects the candidate.
6. **Correctness:** the affected `<package>/__tests__` specs. For `runtime-native`: `pnpm native:build`,
   rebuild the contract-test targets it skips (a stale one reads as a real GPU refusal), run them,
   and regenerate `pnpm census` — plus `pnpm --filter @threenative/runtime-native native:coverage`
   when `runtime-native/tests/` changed — in the same commit.
7. **Paired A/B:** five interleaved baseline/candidate pairs on the same cell and machine state.
   Record both build hashes and assert they differ: two arms that agree to eight decimals tested one
   build twice.
8. **End to end, only if the A/B wins:** the representative game on native desktop, and the same cell
   in the browser when the code runs on both runtimes.
9. **Verdict** (§5). A non-keep is reverted with `git revert --no-edit`, never reset away.
10. **Ledger row** (§6), committed. Then re-attribute: the dominant term may have moved.

## 5. Verdict rules

- **Keep** when the target metric's median delta beats the noise band, holds in at least four of five
  pairs, survives end to end, no other recorded metric regresses beyond its own band, and every check
  on the cadence table is green.
- **Reject** when a check fails, the frozen-path check prints, or pixels change beyond the visual
  noise floor.
- **Inconclusive** when the delta sits inside the band or the pairs disagree. Record it and move on;
  do not rerun until it looks green.
- Two failures with the same cause: stop editing, re-attribute, re-plan.

## 6. Ledger

One section of `docs/verification/runtime-perf-state.md` per campaign, *Performance loop — PRD-<id>*.
Runtime and core performance findings update that file in place; open no other report. One row per
candidate, rejected and inconclusive ones included:

```markdown
| id | hypothesis | files | target: baseline → candidate (band) | other metrics | verdict | commit |
| --- | --- | --- | --- | --- | --- | --- |
| L1-03 | batches keep per-member culling for shadow cameras | projection-apply.ts | frame p50 22.1 → 20.6 ms (±0.3) | draws 1742 → 1188; reconcile +0.1 ms | keep | abc1234 |
```

Tick the campaign PRD's boxes from these rows, in the same commit.

## 7. Cadence

| When | Runs |
| --- | --- |
| Every candidate | affected specs; the lane's mutation cases; the paired A/B on one native desktop matrix cell |
| Every keep | the lane's playtest scenario; the representative game on native desktop; the same cell in the browser on a real adapter |
| Every third keep, and at lane end | `pnpm typecheck && pnpm lint && pnpm test`; `pnpm test:playtest`; `pnpm test:templates`; `pnpm parity` when `runtime-native` changed; `pnpm visuals:ab`; the holdouts |
| Lane end | the Android arm on an attached device for any FPS claim; the emulator proves correctness only |
| Campaign end | `native-platforms.yml` dispatched on the PR head for iOS, macOS and Windows correctness |

A red suite under load is re-run in isolation before it is blamed on the candidate; a red that
survives isolation is the candidate's.

## 8. Rules that do not bend

1. **The candidate never changes the evaluator.** Changing the judge is its own commit, and it
   re-baselines the lane.
2. **No quality moves:** resolution, `resolutionScale`, `sampleCount`, content, quality tier, post
   chain and shadow maps stay fixed.
3. **A local win must survive end to end.** Microbenchmarks and span deltas diagnose.
4. **The loop may reject its own work.** A neutral result is not a success.
5. **Mechanism only:** changes land in `packages/` or the three patch, never in game code or
   `src/render/`. A path both runtimes share is measured on both.
6. **Warm-cache startup wins are not steady-state wins.** Startup, loading, compile and scheduling
   go to the PRDs that own them, with the number that sent them there.

## 9. When to stop

- **A lane** stops after three consecutive rejected or inconclusive candidates when no removable
  term in it exceeds the noise band, or when its term falls below 10% of the frame. Start the next
  lane from a fresh attribution.
- **The campaign** stops when its PRD's acceptance criteria are met or every lane has stopped. Close
  it through the `prd-lifecycle` skill.
- **Never stop for a question mid-loop.** Collect what needs the owner — an attached device, a freed
  GPU, a threshold call — and ask once, at the end of the lane.
