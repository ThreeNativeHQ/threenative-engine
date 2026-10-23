---
prd_contract: v1
---

# PRD-724 — The Unreal look follow-up lands the lines held out of #541

**Status:** NOT STARTED
**Priority:** P1 — the default look reaches the templates only when the starter and minimal port (PRD-722) lands, and five receipted lines wait for the same merge.
**Complexity:** 3 (MEDIUM) — about 6 lane branches to merge and re-prove on one combined tree (+2), the template budgets need an owner decision (+1).
**Owner:** João
**Depends on:** [PRD-632](PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md) (park notes for PRD-722 and PRD-723), [PRD-636](PRD-636-the-finishing-post-chain-matches-unreal-defaults.md), [PRD-641](../gi/PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md), [PRD-649](../shadows/PRD-649-shadow-calibration-scenes-are-built-in-unreal-and-judged-until-parity.md) and [PRD-697](../rendering/PRD-697-probe-volume-and-atmosphere-run-on-the-owned-engine.md).

## Context

Draft PR #541 (`feat/unreal-look-epic`) froze at f5d469841. Some lanes did not merge into it. Each one has a dated park note in the Decisions section of its own PRD. This PRD holds the order in which those lines land after #541 reaches develop.

PRD-722 (starter and minimal port) and PRD-723 (kit migration plan) exist only on lane branches (`lane/sunwarm`, `lane/migrate-prd`). They are not on the epic. This PRD does not copy their text.

| Line | Commit | PRD with the park note | State |
| --- | --- | --- | --- |
| `lane/corelook-swap`, `lane/corelook-sky` | 9f1306bd7, cce702913 | PRD-632 | Receipt exists. No capture at the final tip. |
| `lane/shipfix` | 9a51a0548 | PRD-636 | Judge NEUTRAL. No `compare --check`. |
| `lane/receiptD` (motion3) | 758cdaaee | PRD-641 | Judge IMPROVEMENT and CLOSE on cornell. Needs integration evidence. |
| `lane/receiptE-perf2` | 2a4eb91cf | PRD-649 | Judge NEUTRAL. Needs integration evidence. |
| `lane/sunwarm` | 52bc14827 | PRD-632 | Judge IMPROVEMENT. The `test:templates` budgets are red. |
| `lane/migrate-prd` | ddd18ab08 | PRD-632 | Blocked until the starter and minimal port lands. |
| `lane/ownedbind`, `lane/post`, `lane/wildwood` | WIP patches in `~/.cache/tmp-tn/reaped/wip/` | PRD-697, PRD-636, PRD-649 | Unfinished. No receipt. |

## Execution Phases

#### Phase 1: Merge the receipted lines
**Status:** NOT STARTED
**Files:** the lane branches in the table above, `tools/unreal-reference/gi/`, `docs/PRDs/Unreal/`
- [ ] The swap, sky, shipfix, motion3 and perf lines merge on the merged develop, in this order: swap, sky, shipfix, motion3, perf. proof: `git log origin/develop..HEAD` shows only these lines, and the merge commits name their SHAs.
- [ ] One combined lock board against ce69cbb7e shows no newly broken lock and no new broken ratchet. proof: `pnpm unreal-look:compare --check` on the reference L0 to L9 and on `gi:sunlit-room`, `gi:cornell` and `gi:neon-corridor`, with the board path written beside this box.
- [ ] The templates pass on the combined tree. proof: `pnpm test:templates` on the Debian laptop, exit code written beside this box.

#### Phase 2: The starter and minimal port, then the kit migration
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/`, `packages/create-threenative/templates/{starter,minimal}/src/render/`
- [ ] The `test:templates` budgets for the starter and minimal kits hold with the Unreal look on. The owner re-cuts the budgets or a perf round cuts the draw count (see Blocked on). proof: `pnpm test:templates`, starter `play.playtest` in the exclusive night window.
- [ ] The starter and minimal port merges with a judge verdict of IMPROVEMENT against the shipped look. proof: the judge JSON and the #541 or follow-up PR comment link.
- [ ] The kit migration of PRD-723 merges after the port. proof: `pnpm check:docs` and `pnpm unreal:status` on the merge tree.

#### Phase 3: The WIP lines
**Status:** NOT STARTED
**Files:** `~/.cache/tmp-tn/reaped/wip/unreal-{ownedbind,post,wildwood}.patch`
- [ ] Each of `lane/ownedbind` (PRD-697), `lane/post` (PRD-636 local exposure) and `lane/wildwood` (PRD-649) gets its own lane from its salvage patch, a receipt and a merge, or a Decisions entry that drops it. proof: the three Decisions entries in the three PRDs.

## Blocked on

- The owner decides whether to re-cut the starter and minimal kit budgets (p95 44.1 ms against 33, draws 1205 against 330, triangles 123047 against 52000) or to start a perf round on the draw count.

## Decisions

- 2026-10-23 (team-lead): Filed as PRD-724 because PRD-722 and PRD-723 are used by lane branches. The order of Phase 1 follows the dependency: the sky commit needs the swap commit.
- 2026-10-23 (team-lead): dispositions of the other lane branches that still have commits not on #541. None of them is merged, and none is lost: each is a local branch, and all are in the bundle `~/.cache/tmp-tn/epic-tools/lanes-2026-10-23.bundle`.
  - `lane/wave1` (15 patches) and `lane/wave1b` (6 patches), the twelve-kit filmic and auto-exposure defaults (PRD-632). Superseded by the core move: `lane/corelook` 8e7df2b0b is on #541, and the kits take the look from core through PRD-723. Do not merge these; reuse a patch only through PRD-723.
  - `lane/exposure` (15 commits, including 8ea346d16 and 74384b1f4) and `lane/gi2` (5 commits, including 71bd083cd and 0f5b52b98), the PRD-721 exposure line. Not merged: the lane ledger marks gi2 "do not merge", and the exposure line has no #541 receipt. Next step: PRD-721 re-reads both branches against the core auto exposure on #541 and takes only what is still missing, with its own receipt.
  - `lane/receiptE` and `lane/receiptE-perf` (15 patches each): the PRD-651 sheet-gain line, parked in PRD-651 under `lane/bounce-receipt` a57ab9d74. Same disposition as that park note.
  - `lane/ne-hygiene`, `lane/ne-midway`, `lane/ne-tsl-runtime`, `lane/ne-wasm-templates` and `lane/perry-games` (branched 2026-10-07): superseded. Their content reached develop through the native-engine squash in #493, which the epic carries (spot check: `tsl_call.cpp` and the `instanceCount` code are on the epic). Do not merge.
