# PRD-727 — Shooter software-renderer scenario latency

**Status:** IN PROGRESS
**Priority:** P1 — shooter CI takes 77–95 minutes against a 30-minute goal.
**Complexity:** 3 (LOW); risk override: none.
**Owner:** ciperf-lane
**Depends on:** None

## Context
The owner brief at `~/.cache/tmp-tn/epic-tools/briefs/ciperf-lane.md` authorizes a two-hour diagnosis and local commit only. Base: `6da4a6606`; checkout: `.claude/worktrees/ciperf`; branch: `fix/ci-shooter-time`. Other checkouts are read-only. No push or PR.

## Solution
Attribute a scaffolded shooter scenario with forced SwiftShader and both named engines before choosing a cause-level fix. Preserve all assertions, scenarios, bounds and engine selection. Reuse the CI tarball scaffold and playtest runner. This is runtime/harness work, not a new Unreal feature port. Integration remains unchanged until attribution identifies the owning layer.

## Acceptance criteria
Shooter completes all nonvisual scenarios in under 30 minutes on the measured software lane, with unchanged assertions. Rain startup improves without weakening coverage. Any screen-affecting change requires before/after captures for the coordinator's independent judge.

## Findings
- Layer: engine. `packages/core/src/playtest.ts` `entityObject` accepted only `Object3D`, `mesh` or `object`. The shooter registers its soldier class, which exposes `group`, so `subject: "enemy"` was never observable. `establishSceneSubject` (`packages/playtest/src/runner/runner.ts:692`) then waits up to 30 display frames after every step. One SwiftShader frame costs 1.3 to 1.9 s on both engines, so one scenario burned about 5 minutes.
- The CI engine gap is not the cause: with the cause present, `enemy-uses-crouch-clips` took 376 s and 434 s on the owned engine and 524 s on `engine: "threejs"` (desktop, load 35, SwiftShader).
- Rain is a separate cost. Four pinned cores: owned 199 to 233 s per launch against 56 to 77 s for `engine: "threejs"`. The page main thread is idle (rAF callbacks 0 ms), the GPU process saturates its cores, and each presented frame takes about 9 s. The scene is one raymarched fragment shader plus a cloud pass, so the cost is shader execution on SwiftShader. Not yet attributed to a pass.

## Execution Phases
### Phase 1: Reproduce and attribute
- [x] Establish owned/threejs scenario times and top phase cost. proof: shooter `enemy-uses-crouch-clips` 376 s and 434 s owned, 524 s threejs, forced SwiftShader, `~/.cache/tmp-tn/ciperf/base-*-crouch*.json`; 211 `waitFrames` calls from `establishSceneSubject` by stack trace.
### Phase 2: Correct the cause
- [x] Fix the owning layer with a failing-before/passing-after check. proof: `packages/core/__tests__/playtest.spec.ts` "observes the group root of a registered entity" failed before and passes after (32 of 32); same scenario 62 s and 47 s after.
### Phase 3: Qualify
- [x] Measure all shooter scenarios. proof: 26 of 26 pass in 1094 s (18.2 min) on the desktop under load 14 to 45, from 77 to 95 min in CI.
- [ ] Rain launch improves. proof: paired 4-core launches of `cinematic` before and after a fix; open, no fix yet (see Findings).
- [ ] Run workflow readers, typecheck, lint and affected tests. proof: ci-*, doc and sync specs 676 of 676 pass, core `tsc --noEmit` clean, biome on the two touched files (3 existing complexity warnings); repo-wide `pnpm typecheck`, `pnpm lint` and `pnpm test` not run, so the box stays open.

## Decisions
- 2026-10-23: use the exact checkout path and no-push/no-PR delivery in the owner brief, overriding general worktree/PR defaults. Keep the unmerged checkout available to team-lead for integration.
- 2026-10-23: shooter timeout 120 to 60 minutes. Estimate 31 minutes on the hosted runner (desktop time times 1.7), unconfirmed by a CI run.
