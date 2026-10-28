---
prd_contract: v1
---

# PRD-726 — Native CI builds stop repeating work

**Status:** IN PROGRESS
**Priority:** P1 — Native hosted jobs take 12–43 minutes; eliminate measured repeated preparation without changing coverage.
**Owner:** ciperf-native-lane (Codex)
**Complexity:** 1 → LOW; risk override: none (build preparation only).
**Progress:** 3/3 phases verified.

## Scope

Execute the owner brief at `/home/joao/.cache/tmp-tn/epic-tools/briefs/ciperf-native-lane.md`.
Attribute the last three successful develop CI runs and epic run 39992565239, fix measured preparation costs, preserve every scenario/platform/assertion/threshold, run all workflow consumers, commit locally on `fix/ci-native-time`. No push, dispatch, display use or other-worktree edits.

Integration: workflow jobs → existing build/package commands → fresh native assertions and exact candidate artifacts. No verdict reuse.

## Execution Phases

#### Phase 1 — Attribute the time

- [x] Identify repeated expensive steps and their scripts. proof: GitHub jobs/step timestamps for 39894129224, 39888992001, 39600953542 and 39992565239, summarized in the requested final report. All four successful run payloads captured; Windows zero cache hits and slow Ubuntu Azure mirror confirmed from step logs.

#### Phase 2 — Remove repeated preparation

- [x] Apply the smallest safe fixes with measured local preparation comparisons. proof: seven focused workflow contracts pass (seven fail on the unchanged baseline); actual pack step 164.984s → 15.994s with all archive file bytes identical; Ubuntu archive package download 1.842s versus Azure timeout at 60s. Simulator startup is fixture-verified; hosted timing remains unverified.

#### Phase 3 — Validate and hand off

- [x] All workflow-reading specs pass and changes are committed without pushing. proof: 37 of 38 workflow-reading spec files pass (953/954 tests). The one failure is `create-threenative/__tests__/template.spec.ts` (`TN_WASM_ENGINE_MISSING`: this worktree has no built Wasm engine), unrelated to workflow text. Re-run of ci-native-preparation, ci-structure, ci-needs, ios-package-output-snapshot and ci-native-chain: 255/255.

## Decisions

- The native cache budget is already full (10,810,517,605 bytes / 66 entries). Do not add SDK/AVD caches or unbounded new cache families.
- Retain the unmerged task checkout for the coordinator to integrate; never remove an unmerged lane automatically.
- Final evidence belongs only in the owner-requested `~/.cache/tmp-tn/ciperf-native/report.md`.

## Hosted timings after integration (2026-10-23)

Green job wall times, in minutes, from the develop baseline run 39894129224 and from the two #541 runs that carry these changes: PR run 40036262286 and merge-queue run 40046171681 (attempt 2).

| Job | Baseline | PR run | Queue run |
| --- | ---: | ---: | ---: |
| Windows desktop core | 43 | 33 | 30 |
| macOS desktop core | 18 | 15 | 16 |
| test-native | 12 | 11 | 10 |
| Android emulator visual parity | 33 | 31 | 36 |
| Scaffolded starter desktop artifact (linux-arm64) | 17 | 19 | 18 |
| Scaffolded starter desktop artifact (linux-x64) | 15 | 34 | 11 |
| iOS simulator runtime and no-Xcode consumer handoff | 25 | 29 | 44 |

- Windows (-10 to -13 min), macOS (-2 to -3 min) and test-native (-1 to -2 min) are faster in both runs.
- Android and linux-arm64 are within run-to-run noise.
- linux-x64 varies between 11 and 34 min. The 34 min run is the epic-look packaging cost that the ciperf-epic lane attributed separately.
- iOS is slower in both runs (+4 and +19 min). The likely suspect is the change that boots the simulator before the compile. It is unverified, because the step timings were not split.

## Blocked on

- iOS got slower after the simulator-boot reorder. Next step: pull the per-step timings of the iOS job in runs 40036262286 and 40046171681 against 39894129224. Keep the reorder only if the boot overlaps the compile. Otherwise revert it. Unblocked by the step-timing comparison, and by one more hosted run after any revert.
