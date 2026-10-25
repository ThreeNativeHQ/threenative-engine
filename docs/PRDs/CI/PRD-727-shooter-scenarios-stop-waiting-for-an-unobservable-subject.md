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
- Rain is a separate cost, now attributed. The scenarios' `warmupFrames: 30` wait (`packages/playtest/src/runner/runner.ts:468`) is the cost: one `page.evaluate` in that wait took 147 s and 168 s of 179-199 s runs. The owned engine compiles pipelines synchronously and reports warm-up settled at about 1.2 s (`packages/three-native/src/browser-renderer.ts` `compileAsync()` resolves at once), so every warm-up rAF is a full rain frame (world raymarch pass 75-80 % of the frame). three.js serves those rAFs with cheap loader-cover frames while its pipelines compile asynchronously, and draws only 3-4 world frames per run. Paired, owned, 4 cores: warmupFrames 30 gives 199-233 s, warmupFrames 3 gives 71 s.

## Execution Phases
### Phase 1: Reproduce and attribute
- [x] Establish owned/threejs scenario times and top phase cost. proof: shooter `enemy-uses-crouch-clips` 376 s and 434 s owned, 524 s threejs, forced SwiftShader, `~/.cache/tmp-tn/ciperf/base-*-crouch*.json`; 211 `waitFrames` calls from `establishSceneSubject` by stack trace.
### Phase 2: Correct the cause
- [x] Fix the owning layer with a failing-before/passing-after check. proof: `packages/core/__tests__/playtest.spec.ts` "observes the group root of a registered entity" failed before and passes after (32 of 32); same scenario 62 s and 47 s after.
### Phase 3: Qualify
- [x] Measure all shooter scenarios. proof: 26 of 26 pass in 1094 s (18.2 min) on the desktop under load 14 to 45, from 77 to 95 min in CI.
- [ ] Rain launch improves. proof: paired 4-core launches of `cinematic` before and after the owned engine compiles pipelines asynchronously behind the loader cover; open (see Findings and Decisions).
- [ ] Run workflow readers, typecheck, lint and affected tests. proof: ci-*, doc and sync specs 676 of 676 pass, core `tsc --noEmit` clean, biome on the two touched files (3 existing complexity warnings); repo-wide `pnpm typecheck`, `pnpm lint` and `pnpm test` not run, so the box stays open.

## Decisions
- 2026-10-23: use the exact checkout path and no-push/no-PR delivery in the owner brief, overriding general worktree/PR defaults. Keep the unmerged checkout available to team-lead for integration.
- 2026-10-23: shooter timeout 120 to 60 minutes. Estimate 31 minutes on the hosted runner (desktop time times 1.7), unconfirmed by a CI run.
- 2026-10-23 (team-lead, owner order "as efficient as possible"): rain ships unchanged on #541. It already finishes in about 30 min inside its 60-min cap. The fix is an owned-engine warm-up that really compiles pipelines asynchronously, so `compileSettled` is honest. It needs a Wasm rebuild and a startup-order proof, so it does not block #541. Rejected: skipping redraws of unchanged frames, because it breaks temporal accumulation (TAA, SSGI, auto exposure).
