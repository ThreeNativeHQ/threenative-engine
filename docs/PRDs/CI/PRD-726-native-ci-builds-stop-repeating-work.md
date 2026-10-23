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

## Blocked on

- Hosted Windows/macOS/iOS/Android timing qualification requires the coordinator to run CI after integration. The brief forbids dispatch and pushing; local evidence and estimates cannot establish hosted savings.
