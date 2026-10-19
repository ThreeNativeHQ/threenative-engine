---
prd_contract: v1
---

# PRD-355 — the reinvention gate sees one capability in fifty, and never sees a user's game

**Status: PROPOSED, 2026-09-04.** Filed in `agent-leverage/`, measured at `dae30759`.

**Priority:** P2 — Gate recall at one in fifty; precision corpus unbuilt, and it follows PRD-354.
**Complexity:** +3 for 10+ files, +2 for a new shipped module (the detector leaves `scripts/`),
+2 for multi-package (`create-threenative`, `engine-mcp`, `playtest`, `scripts/`) = **7 → HIGH
mode.** Run a `prd-work-reviewer` checkpoint after every phase.

**Depends on** [PRD-354](../done/PRD-354-the-manifest-never-names-an-import-a-game-cannot-resolve.md) —
a detector that names a capability must name one the game can import.

## 1. Context

**Problem.** The framework's answer to agent discovery is *pull*: search the manifest before you
write. The measured failure is that agents do not pull. The root `AGENTS.md` records it against
this repository's own session on 2026-09-03 — 880 colliders, a rewritten loading gate and four
tuned render stages, no search — and `feature-mining/PRD-325` records the worst case, where the
entry was present and findable and still nobody looked:

> bayview hand-wrote `src/perf.ts` — 190 lines of ring-buffered percentiles, per-section peaks and
> a spike counter — while `FrameBudget` ships from `packages/core/src/index.ts:268` and **is** in
> the manifest (`capabilities.json:664`).

This repository already built the *push* half. `scripts/detect-capability-duplicates.ts` (449
lines, landed as PRD-187 Phase 2) reads game source, finds constructs a capability declares it
supersedes, fails the build, and names the symbol that replaces the hand-written code. Its escape
hatch is an inline fact rather than a review conversation — `// engine-override: <reason>`, with an
empty reason always fatal.

**It works. It is aimed at almost nothing, and at nobody.**

### 1a. Coverage — 5 of 272

```
$ node -e "const a=require('./packages/create-threenative/capabilities.json').entries;
  const s=a.filter(e=>e.supersedes?.length);
  console.log(a.length,'entries;',s.length,'declare @supersedes');
  s.forEach(e=>console.log(' ',e.symbol,'<-',e.supersedes.join('|')))"
272 entries; 5 declare @supersedes
  AudioBus          <- new Audio(
  createRandom      <- Math.random(
  normaliseToMetres <- new Box3().setFromObject(
  prewarm           <- .visible = false
  ScenePicker       <- new Raycaster(
```

Every one of the 272 entries is a `class` or a `function` — there is no category of entry that is
structurally exempt. **1.8% coverage.**

Two structural rules carry the rest (`STRUCTURAL_RULES`, `detect-capability-duplicates.ts:72`):
a hand-rolled A* (`gScore` required, plus one of `cameFrom` / `fScore` / `openSet` / `frontier`)
and the opacity-0 prewarm (`opacity: 0` with `.visible = true`). That is the entire detector.

`FrameBudget` declares no supersession and matches neither rule. **The gate could not have seen
bayview's 190 lines.** Neither could it see a hand-written object pool, a hand-written fixed-step
accumulator, a hand-written percentile ring, a hand-written navmesh query, or a hand-written
instanced-batch assembler — each of which this repository has already watched a game write.

### 1b. Delivery — one caller, over a directory no user has

```
$ grep -rn "detect-capability-duplicates" package.json .github/workflows/
package.json:17: … && tsx scripts/detect-capability-duplicates.ts examples --strict && …
```

Its only non-test caller is this repository's `pnpm budgets`, scanning `examples/`. Not the ten
templates. Not a scaffolded project. Not `threenative build`. Not `threenative doctor`. Not the
playtest runner. **The primary consumer — a cold agent building a game on a user's machine —
receives this signal zero times.** The one measured population it has ever been pointed at is a
sandbox game an operator ran it against by hand (`sandbox/fps-framework`, PRD-187 §55).

### 1c. The precedent that constrains every fix below

The same script once carried a name-token heuristic. Its own header records the outcome:

> measured 25% precision (4 findings, 1 true positive, 2 real misses against fps-framework at
> `46dfa34`) and fired on exactly the wrong things

It survives only behind an advisory `--names` flag. **A widening that repeats that number is worse
than no widening**, because a gate that cries wolf teaches every agent that reads it to paste
`// engine-override:` without reading the reason — and then the escape hatch is gone too, along
with the five rules that currently work.

**Files analyzed.** `scripts/detect-capability-duplicates.ts` (449),
`scripts/__tests__/detect-capability-duplicates.spec.ts`, `scripts/build-capability-manifest.ts`
(615), `packages/create-threenative/capabilities.json` (272 entries),
`packages/create-threenative/src/{threenative,doctor,build,inspect}.ts`,
`packages/playtest/src/runner/cli.ts`, `package.json:17`, `examples/` (17 workspaces),
`packages/core/src/index.ts`.

**Overlap check.** Every open PRD surveyed 2026-09-04.

- **PRD-324** ([`authoring/PRD-324`](PRD-324-the-capability-manifest-cannot-forget-an-export.md); HIGH, unassigned) — *the manifest cannot forget an export*. Its
  authoring-side gate is the natural host for §2's tag-coverage check, and `@supersedes` becomes a
  droppable tag the moment this PRD makes it load-bearing. **Land 324 first or in parallel.**
- **PRD-297 / PRD-298 / PRD-300 / PRD-301** (all in `authoring/`) — the pull lane. Orthogonal by
  construction: they improve what a search returns, this improves what happens when no search runs.
- **PRD-325** ([`feature-mining/PRD-325`](PRD-325-three-games-hand-wrote-the-same-three-seams.md)) — three seams three games hand-wrote. Each seam it lands is a
  capability this detector must then be able to see; the two PRDs are each other's acceptance test.
  Neither blocks the other.
- **PRD-186 §110, §481** and **PRD-276 §149** already cite this detector as the thing that will
  reject a fourth copy of a shipped mechanism. **Both citations are currently false for any code
  outside `examples/`.** Fixing that is this PRD.
- **PRD-353** (`tech-debt-code-quality/`) — template drift gate. Different gate, different script,
  no shared file.

## 2. Solution

Two halves, in this order, because widening a detector nobody runs is wasted work and shipping a
detector that sees 1.8% is a broken promise.

### 2a. Delivery — run it where the game is

The two questions, answered before anything moves. **(a) Could the game write this portably
itself?** No: it needs the capability manifest that ships with the engine, and the manifest is not
the game's to have. The framework owns it. **(b) Does it decide how anything looks?** No — it
reports, it renders nothing. So it may live in a package.

The detector moves out of `scripts/` into a shipped surface and gains three callers:

| Caller | Mode | Why that mode |
| --- | --- | --- |
| `threenative doctor` | reports, always, exit 0 | Already the "what is wrong with my project" command, already shipped in every generated project |
| `threenative build` | warns, exit 0 | A framework that fails a user's build on a heuristic is hostile, and §1c is why |
| this repository's `pnpm budgets` | `--strict`, fails | Unchanged behaviour, widened from `examples` to `examples` + the ten templates |

**A user's build never fails on this.** That is a deliberate asymmetry and it is the whole reason
the precision floor in 2b can be set honestly rather than defensively: this repository eats the
false positives, a user gets a sentence naming the symbol they already had.

### 2b. Coverage — earn every rule

Raise coverage two ways, both gated on measured precision, neither on judgement.

- **`@supersedes` where a supersession is a single construct.** `ScenePicker @supersedes new
  Raycaster(` is a *fact about the code*: the capability wraps that exact call. Audit all 272
  entries for the same relationship and tag the ones that have it. This is cheap, precise, and
  bounded by honesty — if there is no one construct, there is no tag.
- **Structural rules where there is not.** `FrameBudget` has no single call; a hand-rolled
  percentile ring buffer is a shape, not a construct. Each new rule ships with its measured
  precision against a held-out corpus and lands only above the floor.

**The corpus.** Real game source this repository can already read: `examples/` (17 workspaces),
the ten templates, and the sandbox games PRD-325 mined (`lumen-hall` 7,452 LOC, `bayview` 13,406,
`wildwood` 6,680) plus `fps-framework`. Split held-out before any rule is written, and never
tune a rule on the half you score it on.

**The floor.** Set it in Phase 0 with the 25% precedent in front of you and pre-register it
before the first rule is authored. A rule below the floor does not land, however obviously right
it looks — that is the entire discipline this PRD is buying.

**What must not happen.** This PRD adds no export, no runtime surface, no instruction text, and no
new vocabulary. It does not extract anything into a package — PRD-325 owns extraction. It does not
touch what any game looks like.

## 3. Integration Ledger

| # | New thing | Live caller | Replaces | Negative control |
|---|---|---|---|---|
| 1 | Detector as a shipped module | `threenative doctor`, `threenative build` | `scripts/`-only, repo-only | Scaffold a project, plant `new Raycaster(`, run `threenative doctor`; it names `ScenePicker` |
| 2 | Advisory mode (report, exit 0) | `threenative build` | nothing — no user-facing signal exists | Plant a finding; build succeeds and prints it. A non-zero exit here is a failed control |
| 3 | Widened `pnpm budgets` scan (`examples` + templates) | `package.json:17` | `examples`-only | Plant a finding in one template; `pnpm budgets` fails naming that template |
| 4 | `@supersedes` on audited entries | the generator → both manifests → the detector | 5 tags | Remove one new tag; the planted construct stops being found |
| 5 | Structural rules above the floor | `STRUCTURAL_RULES` | 2 rules | The held-out score; a rule below the floor is reverted in the same commit |
| 6 | Precision measurement itself | a new spec + a recorded evidence file | the unmeasured `--names` heuristic | Re-score `--names` with the same harness; it reproduces ~25% |

## 4. Phases

**Phase 0 — the red, and the pre-registration.** Three things, before a line changes.
1. Paste the 5-of-272 count and the single-caller `grep`.
2. **Reproduce the historical miss**: run the detector as it stands against bayview's
   `src/perf.ts`. It reports nothing. That is the red this PRD exists to turn green, and it is a
   real defect from a real game rather than a fixture.
3. **Pre-register the precision floor and the held-out split**, in this file, with the hashes of
   the corpus halves. Written after the split is drawn and before any rule is authored.

**Phase 1 — delivery.** Move the detector to its shipped home; wire `doctor` and `build`; widen
`budgets` to the templates. Behaviour in this repository is unchanged except for the wider scan —
if `pnpm budgets` reports new findings on the templates, they are real and each one is either fixed
or annotated with a reason.

**Phase 2 — the `@supersedes` audit.** All 272 entries. For each, the question is *"is there one
construct whose presence means this capability was bypassed"* — and "no" is the expected answer
most of the time. Record the count of entries tagged and the count deliberately left untagged with
one word of reason each; both numbers are evidence.

**Phase 3 — structural rules.** Author against the training half only. Score each against the
held-out half. Land only what clears the floor. `FrameBudget`'s rule is the named target because
its miss is Phase 0's red, but it is not exempt from the floor — if a percentile-ring rule cannot
clear it, that is a finding worth writing down, not a rule to smuggle in.

**Phase 4 — retire the dead flag.** `--names` measured 25%. Once the harness in Phase 3 exists, it
can be re-scored rather than remembered; delete it in the same commit as its final score.

**Phase 5 — the loop closes.** `docs/verification/` entry recording: tags before/after, rules
before/after, held-out precision and recall per rule, the bayview red turning green, and the
`--names` re-score.

## 5. Acceptance criteria

- [ ] **AC1 — the historical miss is the red.** Detector at `dae30759` vs bayview's
      `src/perf.ts`: zero findings, pasted. After Phase 3: names `FrameBudget` and its import path.
      **If Phase 3's rule cannot clear the floor, this AC is met by recording the failure**, not by
      lowering the floor.
- [ ] **AC2 — precision is measured, not asserted.** Every rule that lands reports its held-out
      precision and recall. A rule with no number does not land. The floor is the one
      pre-registered in Phase 0 and is not edited afterwards.
- [ ] **AC3 — the corpus split is honest.** Split hashes recorded in Phase 0, before rules exist.
      A rule authored against the held-out half invalidates this criterion and the rule.
- [ ] **AC4 — a scaffolded project gets the signal.** Scaffold from `starter` into a temp dir,
      plant `new Raycaster(`, run `threenative doctor`: the output names `ScenePicker` and its
      import path. Pasted.
- [ ] **AC5 — a user's build does not fail.** The same planted project: `threenative build`
      prints the finding and **exits 0**. A non-zero exit fails this criterion.
- [ ] **AC6 — the escape hatch survives.** `// engine-override: <reason>` still clears a finding;
      an empty reason is still fatal in `--strict`. Both pasted.
- [ ] **AC7 — the templates are clean or annotated.** After the widened scan, `pnpm budgets` is
      green, and every finding it raised was fixed or carries a real reason. A blanket suppression
      fails this criterion.
- [ ] **AC8 — no surface grew.** `git diff` adds no export to any package's public entry point,
      and `packages/core/__tests__/constraints.spec.ts` is untouched.
- [ ] **AC9 — sealed corpus untouched.** No `docs/benchmark/genres/*/brief.md` text reaches
      `capabilities.json`, either copy, or any rule. `git diff --stat docs/benchmark/` empty.
- [ ] **AC10 — gates.** `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets` and
      `pnpm test:templates`, output pasted.

## 6. Decline conditions

Close **Phase 3 only** as DECLINED — keeping Phases 1, 2 and 4 — if no structural rule clears the
pre-registered floor on the held-out half. That is a real result: it says the shape of hand-rolled
mechanism is not detectable at acceptable precision, and it means the push signal is worth exactly
its `@supersedes` coverage and no more. Record it; do not lower the floor to rescue the phase.

Close the whole PRD as DECLINED if Phase 2's audit finds fewer than a handful of entries with an
honest single-construct supersession **and** Phase 0's floor cannot be cleared — at which point the
detector is a five-rule tool that works, `examples`-scoped, and the correct action is to fix
PRD-186's and PRD-276's false citations of it rather than to grow it.
