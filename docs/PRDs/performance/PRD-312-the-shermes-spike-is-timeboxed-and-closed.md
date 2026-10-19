---
prd_contract: v1
---

# PRD-312 — The `shermes` AOT spike is timeboxed, answered, and closed either way

**Status:** OPEN, filed 2026-08-31 against `2e014460`. Planning only.

**Priority:** P2 — Timeboxed AOT spike with a pre-stated bar and graveyard close-out.
**Outcome:** the one idea that could stop iOS's no-JIT rule being permanent stops being an
unowned sentence in two architecture documents. Within a **fixed five-day timebox**, this repository
holds a number for *"does untyped Three.js game code gain anything from ahead-of-time compilation"*,
and the branch is closed — pursued with a PRD, or graveyarded with the measurement that killed it.

**Depends on:** nothing.

**Task 9 of Band 2.** See README for the tick-back rule.

**Complexity: 5 → MEDIUM mode.** +2 (new toolchain integration from scratch), +1 (external
toolchain with no pinned release), +1 (multi-package: `runtime-native` and the bench harness),
+1 (an answer that may be "no", which must land as firmly as a "yes").

---

## What a spike PRD may and may not claim

A spike's deliverable is a **decision backed by a measurement**, not shipped runtime code. This PRD
therefore states up front what it is *not* allowed to do, because a research branch that quietly
becomes a product branch is how a framework acquires a second JavaScript engine nobody chose:

- It does **not** add a fourth engine to `engine_factory.cpp`.
- It does **not** change what any shipped build runs.
- It does **not** leave a half-integrated toolchain in `packages/runtime-native/`. Everything it
  builds either lands behind an explicit follow-up PRD or is deleted in the closing commit.
- It **does** land one durable artifact regardless of outcome: a verification record and a
  graveyard-or-plan entry, both of which existing documents will point at instead of pointing at a
  sentence.

---

## 1. Context

**Problem:** iOS embedded JavaScriptCore is interpreter-only — Apple grants the JIT entitlement to
`WKWebView`, not to embedded JSC, and no third-party engine gets it. AOT compilation is the only
known sidestep, because compiled machine code needs no entitlement. It has been filed twice as
*"a spike, not a plan"*, owned by nobody, for long enough that it functions as a permanent
maybe.

**Files and documents analysed:**

- `docs/PRDs/done/PRD-068-android-javascript-engine.md:288-329, 367` — §4.3a: the three unchecked
  "ifs" (does untyped JS gain; can the toolchain be pinned; can it emit a linkable arm64 library),
  and the explicit note that no Apple hardware was available to check the third
- `docs/architecture/NATIVE-PERF-BOTTLENECKS.md:86` — the ⛔ row: *"Unfixable. The one sidestep is
  AOT … A spike, not a plan"*
- `docs/architecture/NATIVE-RENDER-TRANSPORT.md:53` — the same idea, restated
- `packages/runtime-native/src/js/` — `engine_factory.cpp`, `v8_engine.cpp`,
  `quickjs_engine.cpp`, `jsc_engine.mm`, `module_system.cpp`, `ts_transpiler.cpp`
- `scripts/engine-load-test/cli.ts:1, 183` — `pnpm bench:engines`, its arms
  (`tn-web`, `tn-desktop`, `tn-android`, …), `--frames/--warmup/--repeats/--ladder/--modes`,
  and `--compare`
- `examples/engine-load-test/` — the harness scene and its playtests

**Current behaviour:**

- Three engines ship: V8 (Android default), QuickJS, JSC (iOS). No AOT path exists.
- `pnpm bench:engines` already produces comparable per-arm numbers with warmup, repeats and a
  ladder — which is precisely the instrument this spike needs, and using anything else would make
  the result incomparable with everything already recorded.

---

## 2. Solution

**Approach — three questions, in the order that kills the branch fastest:**

1. **Can the toolchain be pinned and driven at all?** Build `shermes` at a specific commit, compile
   a trivial module, run it. Failing here at day two closes the branch with a toolchain reason.
2. **Does untyped code gain anything?** This is the question that decides everything and it is
   answerable **on Linux**, with no Apple hardware. Compile the existing engine-load-test bundle —
   untyped, ordinary Three.js game code — with `shermes`, and run the same ladder the bench harness
   already runs against the interpreted path. Static Hermes' headline numbers come from typed code;
   the game code this framework runs is not typed.
3. **Only if 2 shows a gain:** can it emit a linkable arm64 library, and does the iOS embedding rule
   survive contact with it? This is the question the local machine cannot answer, and it is the one
   allowed to end in `BLOCKED/` — after the first two are answered, not before.

**The timebox is five working days and it is the acceptance criterion, not a suggestion.** At day
five the branch closes in whatever state it is in, and the record says which of the three questions
was reached. A spike that runs long has become a project without anyone deciding to start one.

**Architecture:**

```mermaid
flowchart LR
  q1{"Q1: toolchain pinnable?"} -->|no| close1["close: toolchain reason<br/>graveyard entry"]
  q1 -->|yes| q2{"Q2: untyped bundle faster?"}
  q2 -->|"< threshold"| close2["close: measured refutation<br/>graveyard entry + number"]
  q2 -->|"≥ threshold"| q3{"Q3: linkable arm64 lib?"}
  q3 -->|unknown here| blocked["BLOCKED/requires-ios-ecossystem<br/>with Q2's number attached"]
  q3 -->|yes| plan["follow-up PRD, scoped by Q2's number"]
```

**Key decisions:**

- [ ] Measure with `pnpm bench:engines`, not a bespoke timer. A new harness would produce a number
      incomparable with every engine number already recorded, and comparability is the entire point.
- [ ] The subject is the **existing untyped game bundle**, not a typed microbenchmark. A typed
      benchmark would answer a question this framework does not have — the toy proof this
      repository's rules forbid.
- [ ] The threshold is stated **before** the measurement: the standing bar is ≥ 2 ms of frame time,
      or an unambiguous throughput win on the ladder. Five levers have already died against that
      bar; this one gets the same bar, chosen in advance.
- [ ] Everything built during the spike lives in a worktree or a scratch path and is deleted or
      promoted in the closing commit. No dead toolchain in `packages/`.

**Data changes:** none.

---

## 3. Sequence flow

```mermaid
sequenceDiagram
    participant S as spike owner
    participant T as shermes toolchain
    participant B as pnpm bench:engines
    participant R as verification record
    S->>T: build at a pinned commit
    alt cannot pin or cannot run hello-world
        S->>R: close — toolchain reason, day N
    end
    S->>T: compile the engine-load-test bundle (untyped)
    alt compile refuses the bundle
        S->>R: close — the bundle is not compilable, with the refusal pasted
    end
    S->>B: same ladder, AOT arm vs interpreted arm
    B-->>S: per-arm numbers, warmup + repeats
    alt gain < stated threshold
        S->>R: close — refuted, with the number
    else
        S->>R: Q3 → follow-up PRD or BLOCKED, with the number attached
    end
```

---

## 4. Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `docs/verification/shermes-spike-<date>.md` | cited by rows 2 and 3; read by `pnpm round:next` | the unowned "a spike, not a plan" sentence | that sentence is edited in both documents | a record that does not name which of the three questions was reached fails checkpoint |
| 2 | edit to `NATIVE-PERF-BOTTLENECKS.md:86` | the document itself, which agents read | the ⛔ row's speculative wording | replaced in place | leaving the old wording beside a closed branch fails review |
| 3 | edit to `NATIVE-RENDER-TRANSPORT.md:53` | same | same | replaced in place | same |
| 4 | a `shermes` bench arm **or** its deletion | `scripts/engine-load-test/cli.ts` arm list — TBD, **only if Q2 is reached and positive** | nothing | the arm is deleted in the closing commit if the branch closes | an arm left in the CLI for a branch that closed is dead code and fails the census |
| 5 | graveyard entry or follow-up PRD | `docs/verification/runtime-perf-state.md` lever graveyard, or a new PRD file | nothing | n/a | closing with neither leaves the branch unowned again — the exact failure this PRD exists to end |

### Reachability

**How is this reached?** A person or agent runs `pnpm bench:engines` with the spike arm during the
timebox, and afterwards, reads the record. The durable consumer is documentation that other agents
already read: the two architecture documents lose a speculative row and gain a decided one.

**Pre-existing files edited:** `docs/architecture/NATIVE-PERF-BOTTLENECKS.md`,
`docs/architecture/NATIVE-RENDER-TRANSPORT.md`, and — only on a positive Q2 —
`scripts/engine-load-test/cli.ts`.

**Is this user-facing?** No. It decides whether iOS gets a performance story at all, which is
upstream of everything user-facing on that platform.

**Full flow:** owner starts the timebox → pins the toolchain → compiles the untyped bundle → runs
the ladder → the number goes in the record → both architecture documents are edited to say what was
decided → the branch is either a PRD or a graveyard row, and in neither case is it still a maybe.

**What does this replace?** The two speculative sentences. They are edited, not left standing
beside the answer.

---

## 5. Execution phases

#### Phase 1 (days 1–2): Q1 — pin the toolchain and run something

**Files (2):**

- `docs/verification/shermes-spike-<date>.md` — NEW: the pinned commit, the build command, and
  either a running hello-world or the failure
- `packages/runtime-native/AGENTS.md` — EDIT **only if** the toolchain is pinned: one line naming
  where the spike's toolchain lives and that it is not part of any build

**Implementation:**

- [ ] Build `shermes` at an explicit commit. Record the commit, the host toolchain, and the build
      time. "Latest" is not a pin.
- [ ] Compile and run a trivial ES module. Paste the output.
- [ ] Never symlink anything into `packages/runtime-native/third_party/` — the dependency downloader
      creates that path and a symlink there has previously endangered the real dependency cache.
- [ ] Day-2 stop: if the toolchain cannot be pinned or cannot run a hello-world, close and write the
      record. That is a complete, successful outcome for this PRD.

**Tests required:** none — the gate is the pasted build and run.

**Revert check:** n/a for a spike phase; the checkpoint rejects a record without pasted commands and
output.

**User verification:** read the record — it names a commit and pastes a run, or names the failure.

---

#### Phase 2 (days 3–4): Q2 — does the untyped game bundle gain anything

**Files (3):**

- `scripts/engine-load-test/cli.ts` — EDIT: a spike arm, clearly marked and deletable
- `docs/verification/shermes-spike-<date>.md` — EDIT: the ladder results, both arms
- `docs/verification/runtime-perf-state.md` — EDIT: the number, in the frame ledger or the lever
  graveyard depending on the outcome

**Implementation:**

- [ ] Subject: the **existing** engine-load-test bundle — untyped ordinary Three.js game code. Not a
      typed microbenchmark, not a hand-written hot loop.
- [ ] Same `--frames`, `--warmup`, `--repeats`, `--ladder` and `--modes` as the interpreted arm.
      Different settings between arms makes the comparison meaningless.
- [ ] If the compiler refuses the bundle, that refusal **is** the answer to Q2 for this codebase:
      paste it and close.
- [ ] Compare against the threshold stated in §2, which was chosen before the run.

**Wiring:**

- [ ] Caller edited: the bench CLI's arm list, if and only if Q1 passed
- [ ] Ledger rows filled: #4 (and its deletion is part of the closing commit if the branch closes)

**Tests required:**

| Test file | Test name | Assertion | Negative control (must be observed red) |
|---|---|---|---|
| `scripts/__tests__/engine-load-test.spec.ts` | `should reject an unknown arm name` | throws | add the spike arm and confirm it is accepted only when registered → red before registration |
| same | `should refuse mismatched ladder settings between compared arms` | throws | compare two arms with different frame counts → observed red |

**Revert check:** remove the spike arm → the comparison command fails with an unknown-arm error,
proving the arm was actually wired and not a name in a document.

**User verification:** `pnpm bench:engines --compare --left tn-desktop --right tn-desktop-shermes` —
two comparable numbers, or a pasted refusal.

---

#### Phase 3 (day 5): Close it, in one direction, in writing

**Files (4):**

- `docs/architecture/NATIVE-PERF-BOTTLENECKS.md` — EDIT: line 86 replaced with the decision
- `docs/architecture/NATIVE-RENDER-TRANSPORT.md` — EDIT: line 53 replaced with the decision
- `docs/architecture/FUTURE-ARCHITECTURE-DIRECTION.md` — EDIT: task 9 ticked with the outcome
- either a new follow-up PRD, or the graveyard row in
  `docs/verification/runtime-perf-state.md`, plus deletion of the spike arm

**Implementation:**

- [ ] Write the decision as a plain clause, not a cross-reference: an agent reading either document
      must learn the answer without opening a third file.
- [ ] If Q3 is the only open question, file under `docs/PRDs/BLOCKED/requires-ios-ecossystem/` with
      Q2's number attached — and attempt the blocked step once before believing the reason, since
      several folders there have outlived their conditions.
- [ ] Delete everything the spike built that is not promoted. A pinned toolchain left in the tree
      for a closed branch is dead weight the kill switch will find later at higher cost.

**Wiring:**

- [ ] Ledger rows filled: #1, #2, #3, #5

**Revert check:** grep both architecture documents for the old speculative wording — no hits.

**User verification:** read either architecture document; the AOT row states a decision and cites
the record.

---

## 6. Verification plan

1. **Toolchain:** pinned commit, build log, hello-world output — pasted.
2. **Benchmark:** `pnpm bench:engines` both arms, identical settings, `--compare` output pasted.
3. **Unit:** the two bench-CLI guard cases above.
4. **Integration proof:**

```sh
# 1. The speculative wording is gone from both documents
grep -rn "a spike, not a plan" docs/architecture/
# Expected: no output

# 2. Nothing half-integrated is left behind
grep -rn "shermes" packages/runtime-native/src scripts/
# Expected: either a registered, working arm (branch pursued) or no output (branch closed)

# 3. The record exists and names which question was reached
grep -n "Q1\|Q2\|Q3" docs/verification/shermes-spike-*.md
# Expected: an explicit "reached Q<n>" line
```

5. **Negative controls:** unregistered arm rejected; mismatched ladder settings rejected; the
   pre-edit documents still containing the old wording (observed, then fixed).

---

## 7. Acceptance criteria

- [ ] Five working days after it starts, the branch is closed in one direction — no fourth outcome,
      no extension. The record names the day it closed.
- [ ] `docs/verification/` holds a number for *"does untyped Three.js game code gain from AOT"*, or
      a pasted refusal explaining why the question could not be reached.
- [ ] Both architecture documents state the decision as a plain clause and cite the record; neither
      still says "a spike, not a plan".
- [ ] The tree contains **either** a working, registered bench arm and a follow-up PRD, **or** no
      trace of the spike beyond its record and a graveyard row. Not a half-integrated toolchain.
- [ ] If the branch survives to Q3, it is filed under a blocked reason that was **attempted once**
      and found genuinely blocking, with Q2's number attached so a future owner does not re-measure.
- [ ] Task 9 in the direction document is ticked with its outcome, whichever way it went.

**Integration gates:**

- [ ] Integration Ledger has zero `TBD` cells
- [ ] Caller census pasted for the bench arm, or its absence proved by grep
- [ ] Revert check pasted: removing the arm breaks the comparison command
- [ ] The old speculative wording is deleted from both documents, not left beside the decision
- [ ] Every gate has an observed red, pasted
- [ ] Measured on the real subject: the existing untyped game bundle, not a typed microbenchmark
