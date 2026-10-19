# PRD-113 — The sealed proof stops testing whether the builder guessed the names

**Status: BLOCKED on criteria 2 and 3 — 2026-08-15.** Five of seven criteria are met and marked
below with their evidence. What remains is two runs, not two decisions: round 6's archive replayed
against the revised contract scoring meaningfully above 0/10, and a build that does not satisfy the
brief still failing that contract, run and pasted. Both need an archive replayed against the
current sealed hashes; the round-8 archives cannot serve, because the physics-puzzle brief moved to
`a2a40e96` and `sweep:proof` refuses the mismatch rather than re-scoring.

**Priority:** P1 — Blocked only on editing the brief and playtest json that leak player and goal names.
Originally: **BLOCKED — 2026-08-15, after three repair lanes.** Option C was implemented. The `r2` lane
stopped at `93c76b7`; repair r1 (`46187a8`) and repair r2 (`8412788`) each drew REQUEST_CHANGES for
accepting autonomous motion as input-driven evidence, and repair r3 closed that thread at
`5af281e` on an APPROVE with no findings
(`docs/PRDs/done/PRD-113-repair-causal-baseline-and-pointer-input.md`) — anonymous movement now
needs a zero-motion causal baseline, and a buttonless pointer counts as input on both the browser
and Android paths. **What remains open is the consumer proof:** the committed replay record has
1/6 positive direct rows and the paired round is explicitly void. See
`PRD-113-repair-sealed-behavior-proof.md`. Sliced from
`docs/strategy/PRODUCTION-READINESS.md` item 4.

**Criteria 4 and 5 closed 2026-08-15**, by a peer session that was handed them after round 8 was
recorded — `docs/verification/sealed-token-gate-2026-08-15.md`. The audit that Phase 2 requires
now walks all six genres and whole scenarios rather than physics-puzzle's `assert.resources`, and
covers `textIncludes` beside `equals`. It was observed red on five surviving tokens in four
genres — `won`, `SECURE`, `hub`, `north.archive` and `"7"` — before any proof or brief was
touched; two were published in their brief and three made behavioural. **This is the second hash
discontinuity in this PRD's history**: four genres' brief or proof hashes move, so round 8's
physics-puzzle archives are historical and not re-runnable, and `sweep:proof` refuses the mismatch
rather than silently re-scoring. Criteria 2, 3 and 6 remain open, and this PRD stays BLOCKED on
its consumer proof.

**Complexity: 3 → LOW mode as code. HIGH as consequence.** A small edit to a sealed input voids
comparison with every earlier round, which is why Phase 0 is a decision and not a task.

**LOC:** lands in `docs/benchmark/genres/`. Spends no framework headroom.

---

## 1. Context

**Problem.** The sealed proof asserts names the brief never states. From
`docs/benchmark/genres/physics-puzzle/proof/physics-puzzle.playtest.json`:

| Assertion | Pinned value | Stated in `brief.md`? |
| --- | --- | --- |
| `subject` | `"player"` | no |
| `contacts[0]` | `entity: "player"`, `with: "solid-body"` | no |
| `contacts[1]` | `entity: "mission"`, `with: "goal"` | no |
| `settled[0]` | `entity: "crate"` | no |
| `states[0]` | `entity: "mission"`, `equals: "won"` | no |
| `resources[0]` | `id: "state"`, `path: "replayMatches"` | no |
| `world.seed` | `6132` | no |
| `steps` | `press: "ArrowRight"` | no |

The arm firewall forbids the builder from reading the proof. **These assertions are therefore
unpassable by any blind builder**, except by luck. Round 5 scored 2/10 and round 6 scored 0/10,
and the only difference was that round 5 happened to bind `ArrowRight` and name an entity
`player`.

A gate that measures naming luck is worse than no gate: it reports a number with the same
confidence as a real one. That is the same failure mode as the archive bug that voided three
rounds of functional-column results.

**Why this blocks the thing that matters.** Item 5 — one paired round on the repaired instrument —
is the point of the whole slate. Running it before this is settled spends a full paired round
measuring luck in its functional column. The strategy document's own execution order lists the
paired round *before* the naming contract; **its slicing section contradicts that and is right.**
This PRD runs first. That contradiction is flagged in the batch README.

**Files analysed.**

- `docs/benchmark/genres/physics-puzzle/brief.md` — 21 lines, no id, no seed, no key
- `docs/benchmark/genres/physics-puzzle/proof/physics-puzzle.playtest.json` — the table above
- `docs/benchmark/genres/{platformer,topdown-action,endless-runner,exploration,open-world}/` —
  five more genres with the same structure, unaudited for this defect
- `scripts/sweep-pair.ts`, `scripts/make-sandbox.ts` — `sealedProofHash`, `sealedProofFiles`:
  changing a proof changes its hash, which is recorded per round

## 2. The decision (Phase 0, blocking)

Two honest options. **Both void comparison of the functional column with every earlier round**,
because both change a sealed input. Neither is a formality and neither is mine to pick.

### Option A — State the contract in `brief.md`

Publish the entity ids, the resource path, the input key and `world.seed` in the brief.

- **Cost:** the brief now dictates naming, so the sweep no longer measures whether a builder
  *reaches for* a natural vocabulary. Some of the abstraction-fit signal is lost.
- **Benefit:** smallest edit; the proof is untouched; earlier rounds remain readable as
  *"scored under the old, unpassable contract"*.
- **Risk:** the brief becomes a checklist a builder can satisfy without the behaviour existing.
  Mitigate by stating names only, never structure.

### Option B — Assert observable behaviour instead of names

Rewrite the proof to assert what happened, not what things are called: the subject moves under
input; some body class is contacted by the subject and blocks it; another is passed through;
some pair of bodies reaches a terminal `won`-equivalent state through simulated contact; ≥30
bodies settle; a replay of the same inputs matches.

- **Cost:** larger rewrite, and it needs harness support that may not exist — assertions keyed on
  *any entity satisfying a predicate* rather than a named one. That support, if missing, is a
  `packages/playtest/` change and this PRD's size estimate is wrong.
- **Benefit:** measures the game, which is what the sweep is for. Survives every genre.
- **Risk:** a looser assertion is a weaker assertion. Each rewritten row needs a negative control
  proving it still fails against a build that does not do the thing.

### Option C — Both, scoped

Names in the brief for the ids a proof genuinely cannot infer (`world.seed`, the input key), and
behavioural rewriting for the rest.

**Record the decision, its reasoning and its date in §3 of this file before any other phase
starts.** No decision, no phase.

## 3. Decision record

> **Chosen option: C — both, scoped. (2026-08-14)**
>
> The brief will state only the irreducible harness inputs: `world.seed` and the input key.
> The proof will rewrite the remaining named-entity and named-state rows around observable
> behavior: movement under input, blocking versus pass-through contact, terminal success after
> contact, settling at least thirty bodies, and deterministic replay. This preserves the useful
> contract without asking a blind builder to guess vocabulary that the proof secretly requires.
>
> The cost is a sealed-contract discontinuity: functional-column scores before the revised proof
> hash are not comparable with scores after it. The old hash remains attached to the archived
> rounds, and the new round ledger records the replacement hash. The negative replay remains
> mandatory so the behavioral wording cannot become a vacuous pass.

## 4. Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | revised `brief.md` and/or proof | `scripts/make-sandbox.ts` (`sealedProofFiles`), `scripts/sweep-proof.ts` | the current sealed pair | replaced in Phase 1 — no second copy | a build that names nothing correctly but behaves correctly now passes; a build that does nothing still fails |
| 2 | recorded proof hash for the new contract | the round ledger row for the next round | the round-5/6 hash | old hash stays in old rounds, marked superseded | two rounds with different hashes are never compared in one column |
| 3 | the same audit applied to the other five genres | `docs/benchmark/genres/*/` | — | n/a | each genre's proof re-checked against its own brief |

## 5. Phases

### Phase 1 — Apply the decision to `physics-puzzle`, and prove it both ways

**Files:**

- `docs/benchmark/genres/physics-puzzle/brief.md` — EDIT (Option A or C)
- `docs/benchmark/genres/physics-puzzle/proof/physics-puzzle.playtest.json` — EDIT (Option B or C)
- `docs/verification/sealed-contract-2026-08-…md` — NEW: the before/after and the two runs below

**The two runs that make this honest**, and neither is optional:

1. **Positive.** Replay round 6's archived build against the revised proof. It behaved correctly
   and scored 0/10 on naming. **It must now score meaningfully above 0.** If it does not, the
   revision did not fix what this PRD claims.
2. **Negative.** Replay a build that does *not* satisfy the brief — round 5's archive, or a
   deliberately gutted copy of round 6's. **It must still fail.** A contract that passes anything
   is the vacuous pass the whole verification package exists to prevent.

Both archives exist under `docs/benchmark/sweeps/`. Both runs need
`sh scripts/xvfb.sh`; a run that never reaches its assertions exits `2` and is
recorded as **unmeasured**, never a pass and never a red.

### Phase 2 — Audit the other five genres

`platformer`, `topdown-action`, `endless-runner`, `exploration`, `open-world`. For each: list every
value the proof pins and whether the brief states it, and apply the same decision.

**Fail-closed requirement:** the audit is a script, not a reading.
`scripts/__tests__/sealed-contract.spec.ts` walks every genre and fails when a proof pins an
identifier, a seed or a key that its brief does not state. A genre added later inherits the gate.

**Negative control:** re-add one pinned-but-unstated id → the test goes red naming the genre and
the field.

### Phase 3 — Record the discontinuity

- `docs/verification/round-*.md` and the score docs gain one line: functional-column numbers
  before this contract are **not comparable** to numbers after it.
- The superseded proof hash is recorded so no future reader silently compares across it.

This is the same correction the archive bug already forced once. Making it explicit is cheaper
than discovering it again.

## 6. Criteria

| # | Criterion | Met? |
| --- | --- | --- |
| 1 | §3 contains a written, dated decision with its reasoning | **yes** — §3 records Option C, dated 2026-08-14, with the reasoning and the discontinuity it costs |
| 2 | Round 6's archive, replayed against the revised contract, scores meaningfully above 0/10 | **not satisfiable as written — run and recorded.** Round 6's framework source, re-sealed against the current hashes as `docs/benchmark/sweeps/physics-puzzle-2026-08-16`, scores 2/12 rows and 0/2 scenarios. The reason is not the contract: that build uses `world.seed` **90210** where the current brief requires **6132**, because the brief has moved twice since round 6 — `bdfb940a` → `d950471f` → `a2a40e96`. Replaying it measures brief drift, not whether the revised proof rewards behaviour. The criterion assumed the revision was a re-wording of one brief; it is now three briefs apart, and a number produced this way would be misleading rather than weak |
| 3 | A build that does not satisfy the brief still fails the revised contract — run and pasted | **yes** — `docs/benchmark/sweeps/physics-puzzle-2026-08-15-10`, the round-8 vanilla source with its movement input swallowed and nothing else changed. It boots, installs the bridge and reaches assertions, then fails `states.0`, `movement.distance`, `contact.1`, `contact.2` and `settled.0` — 7/12 rows against the intact arm's 10/12. `contact.0` still passes on crate-to-crate contact that happens without the player, which is honest: that row does not require the character |
| 4 | No value the proof pins is absent from its brief, for every one of the six genres | **yes** — `docs/verification/sealed-token-gate-2026-08-15.md`. Five surviving tokens in four genres, each dispositioned: `won` and `hub` published, `SECURE`, `north.archive` and `"7"` made behavioural |
| 5 | `scripts/__tests__/sealed-contract.spec.ts` fails when a pinned-but-unstated value is re-added | **yes**, across two gates — that file still covers identifiers, keys, resource ids/paths and seeds with its existing red controls; pinned *values* are covered by `sealed-proof-tokens.spec.ts`, observed red on all five tokens before any proof or brief was edited |
| 6 | The comparability discontinuity is written into the round ledger and the score docs | **yes** — `docs/verification/round-8-2026-08-15.md` records all four moved hashes, that its own archives are historical and not re-runnable, and that `sweep:proof` refuses the mismatch rather than re-scoring; `docs/verification/sealed-token-gate-2026-08-15.md` carries the same discontinuity from the change side |
| 7 | `pnpm typecheck && pnpm lint && pnpm test` green | **yes** at `9f7e28d5` — typecheck 0 errors, `biome check . --diagnostic-level=error` 0 errors, `pnpm test` exit 0 with 1,280 passed and 32 skipped |

Criterion 3 is the one that keeps criterion 2 from being bought with a weaker gate.

## 7. Evidence

| Gate | Command | Result |
| --- | --- | --- |
| Positive replay | `sh scripts/xvfb.sh pnpm sweep:proof …` (round 6 archive) | — |
| Negative replay | same, against the gutted/round-5 archive | — |
| Genre audit | `pnpm exec vitest run scripts/__tests__/sealed-contract.spec.ts` | — |
| Audit negative control | re-add one pinned id → same command | — |
| Typecheck / lint / test | `pnpm typecheck && pnpm lint && pnpm test` | — |

## 8. What this does not do

- **It does not run a round.** That is PRD-114, and it is blocked on §3.
- **It does not change the scoring rubric or the axis weights.** Only what the sealed proof asks
  for.
- **It does not touch `examples/abyss-vanilla/`.** Frozen benchmark control.
- **It does not make the proof easier to pass by lowering a threshold.** Thirty settled bodies
  stays thirty. The contract changes what is *knowable*, not what is *required*.
