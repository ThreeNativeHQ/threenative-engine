---
prd_contract: v1
---

# PRD-163 — Round 12 repairs the two template defects round 11 measured, and re-measures them blind

**Status:** PROPOSED, 2026-08-19. Nothing below has executed. Every number quoted comes from
[`round-11-2026-08-19.md`](../../verification/round-11-2026-08-19.md) and is that round's result,
not this one's.

**Closed 2026-08-20 — repairs landed and scored.** Round 12 is filed at
[round-12-2026-08-20](../../verification/round-12-2026-08-20.md) as a visual-only round with a
paired seven-template capture and three blind raters.

**Outcome:** the starter template's measured **−2 LOSS** and the minimal template's HUD/scene
contradiction are repaired in template source, and round 12 re-measures both blind against round
11's after-frames with a duplicate-calibrated MDE — so the repair is a measured result rather than
a source diff someone read and believed.

**Depends on:** [PRD-164](PRD-164-the-round-loop-is-dead-again.md) for a working `pnpm round:next`
before round 12's ledger is written. The capture itself depends on nothing external: `scripts/visual-ab.ts`,
`scripts/score-blind.ts`, `pnpm visuals:baseline` and the WebGPU recipe all run here.

**Blocks:** nothing formally. It is the only PRD in this batch that moves the score a human grades —
the templates are what a player sees.

**Complexity: 5 → MEDIUM mode.** Two bounded template edits, one paired capture, one blind score.

**Blast radius: ~8 files.** `packages/create-threenative/templates/starter/src/`,
`packages/create-threenative/templates/minimal/src/`, their `AGENTS.md` if a convention line changes,
`docs/verification/round-12-2026-08-20.md`, and a new `docs/verification/visuals/ab-*/` bundle.

---

## 1. What round 11 left open

Round 11 scored seven templates before/after, measured a visual MDE of **1**, and disposed of five
gaps. Three were closed as unresolvable at that resolution. **Two were re-opened**, and round 11
explicitly refused to repair them in its own lane: *"the round measures; the repair is the next
round's spend."*

| Gap | Template | Measured | The named source cause |
|---|---|---|---|
| 4 | `starter` | 4 → 2, **LOSS**, above resolution | `templates/starter/src/scenes/Play.ts:66-69` still creates `sculptureMesh` — a torus-knot ornament — and places it at `(-2, 2.6, -1.5)` |
| 5 | `minimal` | 2 → 2, INDETERMINATE, but the frame and source contradict each other | `templates/minimal/src/scenes/Play.ts:26-29` calls `createHud(..., "SCORE", "ITEMS")` while the scene has no items |

Gap 4 is the only resolvable regression in the whole round: the starter — the **first** template a
cold agent scaffolds — lost two points against its own earlier self.

## 2. The trap this PRD must not fall into

Round 11's own note names it: *"Reading `sky.ts` and concluding a gradient reaches the screen is the
exact false signal that made the baseline necessary in the first place."*

Therefore **the repair lane and the measurement lane are separate, and the firewall from round 11 is
inherited verbatim**:

- Capture before and after in separate detached worktrees.
- Adapter identity is checked — `--browser-recipe webgpu`, and `adapter.info` must not read
  SwiftShader. A run that cannot name its adapter is discarded.
- The bundle carries duplicate pairs; a bundle with `--duplicates 0` must refuse to score.
- Raters see the blind bundle, never the reveal, before scoring.
- No delta at or under the measured MDE is reported as a result.

**A repair that cannot be resolved by the instrument is an INDETERMINATE row, not a win.** Round 11
measured MDE 1 with three raters and six duplicate observations; if this round's MDE comes out
higher, the starter's −2 may itself become unresolvable, and that is a legitimate outcome to record
rather than a reason to reach for a different instrument mid-run.

## 3. Phase 1 — repair, in template source only

Both fixes ship where the charter puts them: **generated user source**, never a package.

**Starter (gap 4).** Diagnose the −2 before changing anything: capture the current
`after/starter.png` side by side with the round-11 before frame and name, in one sentence per item,
what the before frame had that the after frame lost. The torus knot is the named suspect, not a
proven cause. Repair what the frames show — composition, contrast, framing, or the ornament itself.
The starter must still pass every one of its playtests afterwards.

**Minimal (gap 5).** The HUD advertises `ITEMS` in a scene with no items. Two honest repairs exist —
give the scene collectable items the HUD counts, or stop advertising a count the scene cannot
produce. Pick one, write the reason, and make the frame and the source agree.

Constraint on both: **do not add a second web-only HUD.** Round 11's gap-1 fact stands — the
platformer has no native desktop HUD after Shape A, and `templates/platformer/AGENTS.md:118-122`
records that. Anything added here that a native build cannot render is a new parity hole.

## 4. Phase 2 — measure, blind

1. Capture the before arm from the round-11 after commit (`709ac6bb` or the current `HEAD` before
   this PRD's repair commit) in a detached worktree.
2. Capture the after arm from the repaired tree.
3. Build one shuffled bundle with duplicate pairs, score it with three fresh read-only raters, and
   compute the MDE from the duplicate observations.
4. Write `docs/verification/round-12-2026-08-20.md` with arms, gap list, dispositions for **every**
   gap, deltas, negative controls, gates, and firewall attestation.
5. Carry forward round 11's three unresolved gaps (1, 2, 3) with an explicit disposition each —
   re-measured, still unresolved, or closed. A gap without a disposition fails the ledger validator.

## 5. Negative controls, each observed red

| Control | Deliberate defect | Required result |
|---|---|---|
| Adapter identity | Omit `--enable-features=Vulkan` from the headed probe | run rejected; `adapter.info` reads SwiftShader |
| Duplicate calibration | Build the bundle with `--duplicates 0 --raters 1` | exit non-zero; `TN_VISUAL_AB_NO_DUPLICATE_PAIR` |
| Sub-MDE claim | Claim a delta of ±MDE as a WIN in a synthetic ledger | validator rejects it |
| Gap coverage | Remove one disposition row from a synthetic copy | validator rejects it |
| Blank frame | Feed the scorer an all-black PNG | rejected before scoring, not scored as a low number |

## 6. Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | The starter's regression is repaired or recorded as unresolvable at the measured MDE | round-12 ledger, delta row |
| 2 | The minimal template's frame and source no longer contradict each other | source diff plus after-frame |
| 3 | Round 12's ledger has one disposition for every gap, including the three carried from round 11 | ledger validator exit `0` |
| 4 | The MDE is measured from duplicate observations in this round, not inherited from round 11 | bundle plus score output |
| 5 | All five controls in §5 observed red | pasted output |
| 6 | No package source changed; no second web-only HUD added | `git diff --stat packages/*/src` empty except templates |
| 7 | `pnpm typecheck && pnpm lint && pnpm test && pnpm test:templates` green | pasted output |

## 7. Claims this PRD may not make

- No human-baseline claim. Model raters are not the human blind session
  `docs/product/VISUAL-BASELINE.md` requires; round 11 refused this and so does round 12.
- No aggregate quality-floor claim over seven templates while any row is INDETERMINATE.
- No native, device or parity claim of any kind.
