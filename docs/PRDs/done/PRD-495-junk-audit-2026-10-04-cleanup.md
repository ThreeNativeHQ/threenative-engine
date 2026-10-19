---
prd_contract: v1
---

# PRD-495 — junk-audit 2026-10-04: every finding dispositioned

**Status:** DONE — all three phases executed; AC-2 and its Phase 2 box close on CI run
[37255318117](https://github.com/ThreeNativeHQ/threenative/actions/runs/37255318117) at head
`346afd02717e079874280eab2a39ce3db21f2068`, terminal success, which covers the same four
`run-test-suite` phases and the same package scope as the local gate (see AC-2)
**Complexity:** 5 → MEDIUM (3 for 11+ implementation files, +2 for touching two independent
build boundaries — the scaffolder's pinned scaffold-tree hashes and the runtime-native
CMake/Android source sets; every item is a deletion, a comment fix or a doc pointer, so risk
is mechanical).
**Owner:** João
**Depends on:** none
**Task:** branch `chore/junk-cleanup-2026-10-04`, worktree `.worktrees/junk-cleanup`, base
`origin/develop` at `f24f6243e`, since merged forward to `64aed30fe` (#416). The audit input
`junk-audit-2026-10-04.md` stays untracked.

## Context

`junk-audit-2026-10-04.md` (90 findings, five appendices, read-only arms) claims ~575 lines in
`packages/core`, ~480 in physics/ui/playtest/assets, 1,635 safe-now tracked lines in
`runtime-native` + small packages, ~379 in templates/examples and ~2 MB + ~2,900 lines in
docs/scripts. It reaches no published npm tarball; the cost is clone weight, agent friction
in generated templates, and misleading surface.

This PRD dispositions **all 90** findings — deleting what is provably dead, and recording why
the rest stay. Nothing here changes behaviour: every executed item is a zero-reader deletion,
a stale comment, or a doc pointer, and no gameplay/render value moves.

## Solution

Execute every finding whose only tracked references are its own definition or a comment that
contradicts the code — the **70 changes** listed under `### Executed` below, counted from the diff
itself. Three of the original 73 came back after the independent Opus-5.5 review on 2026-10-05:
the live benchmark was a definite false positive; the manual proof and distinct audit were
retained conservatively. Each is now a `### Retained` row with the reason (see the review
correction under `## Verification notes`). Retain the rest with a named reason (`### Retained`, one
row per group; several rows cover more than one numbered audit finding, so they carry no count).
Defer the duplicate-helper refactors
that touch live code for a ~21-line net win, leaving them to
[PRD-208](../tech-debt-code-quality/PRD-208-tier-four-hygiene-sweep.md), which already owns single-sourcing debt.

## Acceptance Criteria

- [x] AC-1 [local]: `packages/core` reports zero unused-local and zero unused-parameter diagnostics. The 24-diagnostic baseline is the audit input's measurement, not one re-taken here. proof: `cd packages/core && ../../node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json` — Evidence: exit 0, empty output.
- [x] AC-2 [local, CI]: the deletions keep the contracts that read them intact — the workspace typechecks and lints, the unit and contract suites stay green, and the one pinned expectation that had to move (the scaffolder's `PRD_201_PARENT_SCAFFOLD_HASHES`) was restamped to the templates' new measured bytes. The per-symbol "no remaining tracked reader" claim is the audit's own independently checked caller census, dispositioned row by row in `## Disposition`; typecheck and the unit suite are the contracts preserved afterwards, not a reference search over the tree. proof:  `pnpm typecheck && pnpm lint && pnpm test` — Evidence: `pnpm typecheck` exit 0, `pnpm lint` exit 0 (1074 warnings). The final full board (`taskset -c 0,1,2,3 TN_SUITE_PACKAGE_CONCURRENCY=1 pnpm test`, 1424s) is **exit 1**: `docs`, `build` and `package-test` phases all green (runtime-native 134 files / 1548 tests + Rust parity + publint; `scaffold.spec.ts` 66 tests green), unit phase `4 failed | 7933 passed | 13 skipped (7950)`. Every failure is wall-clock on a box at load 27–44 across 24 cores — `template-assets-compile-1` racing (60s), `template-assets-compile-2` shooter (60s), `template.spec.ts` pristine-scaffold typecheck (180s), `desktop-playtest.spec.ts` native screenshot wait (`native host output: none captured`, the file's other 38 tests green) — with no failed assertion. The same four files alone on the four idlest cores: 4 files / 117 tests, exit 0, 227s. That literal local `pnpm test` is not claimed green. The gate closes instead on CI run [37255318117](https://github.com/ThreeNativeHQ/threenative/actions/runs/37255318117), head `346afd02717e079874280eab2a39ce3db21f2068`, terminal **success**: `typecheck`, `lint`, `test`, `test-native`, `test-unit` shards 1/4–4/4 and `ci-required` all green. That is the same verification method at full scope, not narrower acceptance — `pnpm test`'s default is the four phases `docs,build,package-test,unit` (`scripts/run-test-suite.sh:277`) and CI runs all four across three jobs, a partition `scripts/__tests__/ci-structure.spec.ts` computes from the workflow rather than trusting (see the CI-coverage note under `## Verification notes`).
- [x] AC-3 [local]: the scaffolder still ships every template its contract specs name, with the pinned scaffold-tree hashes restamped for exactly the templates that changed (10 of 13; `platformer`, `snow`, `starter` unchanged), restamped again for the 2026-10-05 develop merge, and restamped once more for `rain` alone when the review restored `templates/rain/tools/verify-noise-volume.mjs`. proof:  `pnpm --filter @threenative/create-threenative test` — Evidence: green in the workspace suite before the merge; the four affected specs alone: 4 files / 93 tests, exit 0, 205s. On the merged tree `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts` is 66 tests, exit 0,
  34.6s; after the rain restoration the whole file is 66 tests, exit 0, 11.0s, with the
  byte-stability test first failing and printing its measured `rain` hash `637afd24…92255` before
  the restamp — see the merge-integration and review-correction notes under `## Verification notes`.
- [x] AC-4 [local]: the runtime-native contract and source-list gates stay green after the never-packaged Android sample JS and the orphan Metal shader go. proof:  `pnpm --filter @threenative/runtime-native test` — Evidence: exit 0 — 134 files / 1548 tests passed, 62 skipped; Rust physics parity 21 + 2; publint clean. Required a compiled host first (`pnpm native:build` exit 0); every pre-build failure was an `is not built` assertion, and no C++ source or JS-engine file this PRD touches appears in any of them.
- [x] AC-5 [local]: documentation links and primary-doc command names stay resolvable after the stale round-ledger pointers are corrected. proof:  `pnpm check:docs && pnpm exec vitest run scripts/__tests__/check-doc-links.spec.ts scripts/__tests__/primary-docs.spec.ts` — Evidence: `pnpm check:docs` exit 0 — "Checked 2323 relative documentation links across 1216 Markdown files"; both specs pass inside the green `scripts/__tests__` lane (143 files / 1944 tests, exit 0).
- [x] AC-6 [local]: `examples/abyss-framework` no longer dirties the tree with a committed build report. proof: `pnpm --filter abyss-framework build` then `git check-ignore -v examples/abyss-framework/dist.build-report.json` — Evidence: build exit 0 (it rewrites the report on disk), `git check-ignore` reports `.gitignore:8:*.build-report.json`, and `git status --porcelain examples/abyss-framework` after the build lists only this lane's three staged deletions.

## Verification notes

- The native host was built locally to run AC-4 (`packages/runtime-native/build/` and `.runtime/`
  are gitignored build output, ~10 min for the deps + compile). Nothing tracked changed for it.
- Every red this lane has recorded is a wall-clock failure on a shared box, and none is a
  behavioural assertion:
  1. Two `pnpm test` runs at default concurrency: five scaffolder-spec **timeouts** (60s, 60s, 60s,
     180s, 180s) with `7932 passed / 13 skipped / 5 failed`, box load 55–70 across 24 cores. The
     same four files alone: 4 files / 93 tests, exit 0, 205s.
  2. One `pnpm test` run pinned to **two** CPUs (`taskset -c 0,1`, `TN_SUITE_PACKAGE_CONCURRENCY=1`)
     to force `maxWorkers` 1: `package-test` stopped the run at 1 failure,
     `runtime-native/tests/production-profile.test.mjs:1970` `assert.ok(elapsed < 2_000)` — the test
     took 4313 ms. Run alone under the same pin it passes in 374 ms, and the rest of that test
     (status `FAIL`, exit code 1, the budget code) held. The two pinned CPUs are shared with
     unpinned neighbour lanes — `ps` showed their node processes sitting on CPUs 2 and 3 — so a
     2 s CPU-bound assertion cannot hold on them. The clean run therefore widens the window to four
     CPUs (`maxWorkers` 3) instead of narrowing the box further.
  3. The final full board on those four CPUs and the serial package walk (`taskset -c 0,1,2,3
     TN_SUITE_PACKAGE_CONCURRENCY=1 pnpm test`, 1424s): `docs`, `build` and `package-test` green,
     unit phase `4 failed | 7933 passed | 13 skipped`. The same four files, alone, on the four
     idlest cores: 4 files / 117 tests, exit 0, 227s.
- **CI repair (2026-10-04, budgets job 111567118048).** The CI red this diff caused:
  `TN_TEMPLATE_CONVENTIONS_FAILED` for the `shooter` kit. The `normaliseToMetres` and
  `attachToBone` cells of the applicability table still named `src/entities/Enemy.ts:863` and `:869`,
  which this lane's dead-comment deletion moved 15 lines up to `:848` and `:854`. Both cells now
  name the measured calls; `pnpm exec tsx scripts/check-template-conventions.ts` ran red with those
  two findings and is green after the fix. The `shooter` scaffold hash needed no restamp — the
  measured `createProject` no-install tree equals `PRD_201_PARENT_SCAFFOLD_HASHES.shooter`, and
  `pnpm sync:agents` wrote 0 mirrors. Focused checks, all green:
  `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts -t "keeps every
  no-install scaffold tree byte-stable"` (1 passed); the scripts prose lane
  (`check-template-conventions`, `check-doc-links`, `sync-agent-docs`, `evidence-budget`,
  `evidence-citations`, `ci-structure`, `ci-needs`) 7 files / 250 tests exit 0; `pnpm check:docs`
  exit 0; `git diff --check` clean. AC-2 stayed unticked at this point — the full board as written
  still ran red on wall-clock, which this change does not touch.
- **CI red this diff did not cause (2026-10-05, `native-platforms / Windows desktop core`, job
  111566787292 of run 37246919707, head `0ae683546`).** The full board's Windows leg exits 2 in
  "Collect bounded desktop performance evidence" with `TN_PROD_PLAYTEST_FAILED`,
  `TN_PROD_RENDER_SAMPLES_INCOMPLETE`, `TN_PROD_MARKER_MISSING` and status `BLOCKED`. The run's own
  artifact names the cause: `performance-contract/Windows/artifacts/c928a7ef….json` carries
  `TN_PLAYTEST_OPERATION_TIMEOUT` — "Device mailbox operation '3' exceeded 35000ms". The manifest
  agrees: `markers: ["run-start"]`, one `runWindows` entry with `sampleCount: 0` and
  `durationSeconds: 0`, `startupMs: 1091`. The host itself is healthy in the same job — the earlier
  desktop-core step rendered 300 frames in 18183 ms (`desktop-win32.log`) and its report passed.
  **Not this lane, and not a cleanup regression:** the identical fingerprint
  (`markers: ["run-start"]`, `sampleCount: 0`, `startupMs` ~1.1 s, exit 2) is on runs 37241861419
  (head `1015b95bc`) and 37245076840 (head `6a41767e7`), and `git merge-base --is-ancestor` says
  `5678ba241`, `0ae683546` and `06754fd00` are in neither head, plus run 37065619655 (head
  `af7e25333`, 2026-10-02T21:14Z). The job's last green run is 36960041733 (2026-10-02T03:24Z), so
  the stall has been continuous for four hosted Windows runs and predates this PRD by two days.
  **Layer: engine**, in the `packages/playtest` file-mailbox transport and the native host's poll
  loop. No file this PRD deletes is in that path, so this lane did not cause the stall — and that
  is a statement about cause only, **not** a finding that no bounded fix exists.
  - **Exact cause, corrected 2026-10-05.** An earlier reading of this bullet blamed the missing
    first `sample`. That was the symptom. 35000 ms is exact for a **warmup `advance(60)`**:
    `advanceTimeoutMs(60)` = 5000 (`protocol.ts:37`) + 15000 (`protocol.ts:31`) + 60×250
    (`protocol.ts:24`), computed at `bridgeClient.ts:62-78`; `warmupFrames: 60` comes from
    `--warmup 1` (`profile-production.mjs:537-538,556`); and `androidRunner.ts:241` issues that
    advance **before** the startup wait. `describe`/`ready`/`sample` carry
    `config.timeoutMs` = 105000 there, so only an advance can report 35000. Operation id 3 confirms
    it: the green sibling artifact from the same job numbers `1 describe`, `2 ready`, then the
    advance. The host does not answer because its frame pump is silent for 38.3 s during first-use
    compile (`maxGapMs: 38332`, `startup.compileSettledMs observed 41907.94`), and the mailbox poll
    rides rAF (`three/device.ts:139`). `startupReady.ts:116-125,172-186` deliberately swallows
    `TN_PLAYTEST_OPERATION_TIMEOUT` there, so every other call on that path tolerates the stall; the
    warmup advance is the one pre-observation call with no such tolerance. The bounded fix is
    `packages/playtest`: issue `scenario.warmupFrames` after `waitForStartupReady`. It is a
    native-lane change with its own proof and **is not dispatched from here**.
  - **CI policy: this leg is not selected for this branch, so it is not this branch's merge gate.**
    `.github/workflows/native-platforms.yml:1058` gates the macOS/Windows `desktop` job on
    `needs.scope.outputs.native_tier == 'full'` (the iOS simulator leg on the same tier at `:2061`),
    and an ordinary pull request into `develop` is classified `reduced` — `validationProfile` in
    `scripts/ci-change-scope.mjs:610-618` returns `reduced` for a `develop` target with native work,
    which native-platforms.yml:67-69 records as the PRD-380 phase 2 owner call. Verified for this
    pull request rather than assumed: replaying the classifier with run 37251931881's own inputs
    (`--target develop --event-name pull_request --base 64aed30fe --head 504626b48`) prints
    `selection=full`, `native_tier=reduced`, and run 37251931881 shows
    `native-platforms / ${{ matrix.platform }} desktop core` as **skipped** while its Linux legs ran
    green. `scripts/__tests__/ci-efficiency.spec.ts:252-253,348` locks that condition, so it is
    policy, not an accident of this run. The earlier self-imposed line here ("it must be green before
    this branch merges") was this PRD adding a gate the repo's policy does not set for a develop pull
    request, and it is withdrawn. The Windows red itself is real and stays recorded: the manual full
    native-platforms audit that ran all four platforms is **red**, and nothing here turns it green.
- **Develop merge (2026-10-05, `64aed30fe` #416 backlight/dark defaults).** `origin/develop` was
  merged in with a plain `git merge` (no rebase, no force) because the merge queue requires a
  current base. #416 is one commit and 1,087 files; two of them also carried cleanup edits, so
  exactly one conflict: `PRD_201_PARENT_SCAFFOLD_HASHES` in
  `packages/create-threenative/__tests__/scaffold.spec.ts`.
  - **Resolution, measured not chosen.** Neither side's hash block was kept. The merged tree was
    measured through the installed generator — `pnpm exec vitest run
    packages/create-threenative/__tests__/scaffold.spec.ts -t "keeps every no-install scaffold tree
    byte-stable"` — and its failing assertion printed all thirteen actual values; those are what
    the constant now carries. Ten moved (the ten templates this sweep edited, since #416 also
    touched them), `platformer`, `snow` and `starter` kept #416's values untouched by either side.
    Re-run after the restamp: 1 passed; the whole file 66 tests, exit 0, 34.6s.
  - **Auto-merge audited, not trusted.** The other overlapping file,
    `templates/puzzle/src/scenes/Play.ts`, merged clean: `git diff 64aed30fe --` on it shows
    exactly this lane's `const unwatch = seal.watch({` → `seal.watch({` and none of #416's
    material-lighting wiring, and #416's diff against the base shows exactly its wiring and none
    of ours. Both sides' behaviour survives. Whole-file deletions: all 14 of this lane's are
    absent from the merged tree (`git diff --name-status --diff-filter=D 64aed30fe`), and every
    file #416 added is present.
  - **Focused proof on the merged tree** — `pnpm typecheck` exit 0; `pnpm lint` exit 0 (1,101
    warnings, 0 errors, after `biome format` on the restamped constant); `pnpm sync:agents
    --check` exit 0, 22 mirrors; `pnpm exec tsx scripts/check-template-conventions.ts` green, so
    the restamped shooter applicability cells still name live calls on the merged tree;
    `pnpm check:docs` exit 0, 2,393 links across 1,230 files; the scripts lane
    (`check-doc-links`, `primary-docs`, `evidence-budget`, `evidence-citations`, `sync-agent-docs`,
    `ci-structure`, `ci-needs`, `search-path`) 8 files / 260 tests exit 0; `pnpm budgets` exit 0.
    `pnpm budgets` first failed on a **stale build artefact**, not on merged source —
    `CAPABILITY_BUILT_SYMBOL_MISSING: @threenative/playtest/capture#collectRegionalTone` — because
    `packages/playtest/dist` predated #416's `collectRegionalTone`. `pnpm --filter
    @threenative/playtest build` exit 0 (publint clean) and budgets is then exit 0. It also
    reported native census drift; `pnpm census` exit 0 regenerated the ten cells, of which
    `android/` 3,187 → 1,814 is this lane's deleted sample JS and the orphan Metal shader.
  - **AC-2 stayed unticked here.** The merged tree had not run a full board, and none was rolled
    from this lane: the box is shared and oversubscribed, and a fourth red wall-clock reading would
    not be new evidence. AC-2 turned green later, on CI run 37255318117 at the new head rather than
    on a local board.
- **Independent review (2026-10-05, `claude-opus-5-5 --effort high`) and its restorations.** The
  review checked each removal for readers and required the benchmark restoration; the other two
  restorations conservatively preserve useful manual proof and history:
  the physics allocation bench (open PRD-191 still names it as its Phase 3 EDIT target and
  verification step 2; its "NOT STARTED" status is stale because `91e46d34f` did that work and left
  a record showing the bench run at exit 0),
  `templates/rain/tools/verify-noise-volume.mjs` (an owner's manual storm-volume proof that needs
  an external `tempest.html`), and `plans/technical-debt-audit-2026-08-20.md` (a distinct audit of
  `d75f4644`, not a duplicate). All three are restored byte-identical to `origin/develop`
  (`64aed30fe`). Focus checks on the restored tree: `pnpm exec vitest run
  packages/create-threenative/__tests__/scaffold.spec.ts -t "keeps every no-install scaffold tree
  byte-stable"` — the assertion first failed and printed the measured `rain` hash
  `637afd24…92255` (the restored verifier file reaches every rain scaffold), restamped, then 1
  passed; `NODE_OPTIONS=--expose-gc pnpm --filter @threenative/physics exec tsx
  scripts/bench-allocations.ts` — exit 0, full JSON census, 156.3 s (it is a manual bench, not a CI
  gate, so a restored bench is not a new CI obligation); `pnpm --filter create-threenative typecheck`
  exit 0 (the restored bench sits outside every package tsconfig — `packages/physics/tsconfig.json`
  includes `src/**/*.ts` only — so running it is its own proof, as PRD-191 does);
  `pnpm exec tsx
  scripts/check-template-conventions.ts` green; `pnpm check:docs` exit 0; `pnpm sync:agents --check`
  exit 0; the prose/CI lane 8 files / 303 tests exit 0, including `ci-efficiency.spec.ts`, which
  locks the `native_tier` condition above; `git diff --check` clean. The count of executed changes
  drops 73 → 70.
- **What CI covers of AC-2, checked on this pull request rather than assumed.** `pnpm test` is four
  phases — `docs,build,package-test,unit` (`scripts/run-test-suite.sh:277`) — and CI runs all four
  across three jobs: `test` runs `docs,build,package-test` with `@threenative/runtime-native`
  excluded (`ci.yml:196,200`), `test-native` runs that one excluded package
  (`ci.yml:529`), and `test-unit` runs `unit` in four shards (`ci.yml:246-247`).
  `scripts/__tests__/ci-structure.spec.ts:2617-2645` computes that partition from
  the workflow rather than trusting it, and `:2652` holds the script's own default. `typecheck` and
  `lint` are separate green jobs. So the phase and package scope of AC-2 is covered on hosted
  runners, at full scope rather than a narrower substitute.
  **Executed green 2026-10-05 at head `346afd02717e079874280eab2a39ce3db21f2068`:**
  [run 37255318117](https://github.com/ThreeNativeHQ/threenative/actions/runs/37255318117), terminal
  `success` — `typecheck` (job 111594404786), `lint` (111591273243), `test` (111591273307),
  `test-native` (111594404758), `test-unit` 1/4–4/4 (111594404946, 111594404960, 111594404852,
  111594404832) and `ci-required` (111600105931), whose `selection` was `full`. Its
  `native-platforms / ${{ matrix.platform }} desktop core` leg is **skipped** under the reduced
  `native_tier` policy below, not waived here. AC-2 is ticked on that receipt, not on the
  oversubscribed local box.
- **PR unit failure (2026-10-05, run 37251931881, job 111583180400).** Shard `3/4`
  timed out at 60 s in `world-gpu-scene.spec.ts:913`, the GPU-main-pass regroup/refilter test.
  The exact test alone passed locally: 1 passed / 69 skipped, 25.13 s (26.52 s total), using
  `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts -t 'spends no regroup and no refilter, feeds the source buffer, and dresses every main key'`.
  The core unused-local/parameter command in AC-1 was also rerun on the merged source: exit 0,
  empty output. No assertion or timeout changed. Those focused results did not turn the failed
  shard into a pass; run 37251931881 was superseded and cancelled by the new head, and the shard
  is green on run 37255318117 (`test-unit` 3/4, job 111594404852).
- **Pacing decision (2026-10-04, this lane).** That is the third run to fail on wall-clock alone, so
  the fourth was not attempted: at launch every core was ≥59% busy (mean 77%) with no quiet set of
  four to move to, and another 24-minute run would only add foreign contention to the box it is
  trying to measure. The isolated four-file re-run above is the minimal honest retry — it separates
  "these specs are slow" from "these specs are wrong" without re-rolling the board a fourth time.
  What would settle AC-2 is one full board on a box whose cores are not oversubscribed, not another
  knob here.
- No tracked runner, config or test was changed to reach any of these results; the concurrency
  knobs used (`TN_SUITE_PACKAGE_CONCURRENCY`, `taskset`) are execution-time inputs the suite already
  reads.

## Blocked on

Nothing here blocks the sweep: every item below was **retained**, not deferred, so no box above
waits on it. They are listed because a retained row needs a named owner to un-retire it, not
because the safe cleanup is stuck.

- Owner calls on six decide-first items — `packages/core/scripts/vsm-proof/` (466 lines), the
  `runtime-native` native-glTF C++ island (622 lines), `conformance/scenes/shared/spectral-ocean.js`
  (217 lines), the `castDistance` shim in `world-cells.ts` (PRD-458 ties it to an external
  consumer), the four orphan docs, and the ~18.5 GB untracked disk. Each stays under the 2026-10-04
  working assumption recorded in `## Decisions` until the owner rules; retaining them is the safe
  reading, and deleting them is a separate decision with its own proof burden.
- `examples/native-smoke`'s uncalled `parseHttpsUrl` is a game-layer defect, not junk; wiring it
  changes example behaviour, so it is reported here, not fixed. Fixing it is its own change.
- The `native-platforms / Windows desktop core` leg is red on the manual full-platform audit with a
  35 s device-mailbox timeout on the **warmup `advance(60)`** that `androidRunner.ts:241` issues
  before the tolerant startup wait — the missing first `sample` is the symptom, not the fault. It
  predates this sweep by two days and no file this PRD deletes is in that path. It does not block
  the sweep, and this branch's own CI does not select it: the leg needs `native_tier == 'full'`
  (`native-platforms.yml:1058`) and a develop pull request is classified `reduced`
  (`scripts/ci-change-scope.mjs:610-618`, verified for this pull request — see the Windows bullet
  under `## Verification notes`). The broader full-platform audit is still red and is recorded as
  such; the fix is a `packages/playtest` change with its own proof, not dispatched here.

## Integration Ledger

Integration: unchanged — no consumer path, CLI form, render stage, capability-manifest entry or
scenario changes. Deleted symbols have zero tracked readers; the one consumer-visible effect is
that generated projects stop shipping template files nothing imports. The scaffolder's
`PRD_201_PARENT_SCAFFOLD_HASHES` is the only pinned expectation that must move, and it moves to
the new measured bytes of the templates this PRD touches — three times: once for the sweep, once for
the 2026-10-05 merged-tree measurement after #416, and once more for `rain` alone when the review
restored `templates/rain/tools/verify-noise-volume.mjs`. One further pinned record moves with it:
`docs/verification/native-runtime-census-2026-08-16.md`, regenerated by `pnpm census` because the
native tree lost the Android sample JS and the orphan Metal shader.

## Decisions

- 2026-10-04 (**working assumption, pending owner reply — not an owner decision**): retain every
  decide-first item and all untracked disk; keep tested interfaces even when only a spec reads them;
  keep `parseHttpsUrl`'s validation and report the defect instead of adding a runtime change here.
  João was never asked to choose this default. It is the conservative reading of the audit and each
  retained item is reversible on its own, so the sweep proceeds on it instead of stalling; the items
  it covers stay listed in `## Blocked on` until the owner rules on them.
- 2026-10-04 (this PRD): a published barrel re-export (`assets` `WRAP_REPEAT`,
  `WRAP_MIRRORED_REPEAT`) is a public contract, not dead code, even with no in-repo reader.
- 2026-10-04 (this PRD): `stamp:template-loading` stays: the audit called it a duplicate entry
  point, but the function it wraps is called from nothing else, so deleting it removes a capability.
- 2026-10-04 (this PRD): `core/__tests__/seed.spec.ts` stays: it is the only assertion that a
  different seed diverges, which the 1,000-draw equality test cannot see.
- 2026-10-04 (this PRD): the two playtest compat facades (`src/assertions.ts`,
  `src/evaluators/helpers.ts`) are still imported by 10 modules, so they are live re-export
  surfaces, not dead files; collapsing them is a refactor with a ~35-line win, not junk removal.
- 2026-10-04 (review correction, parent): audit finding 29 (`examples/quarry/src/game.ts`, the
  unreferenced `QuarryScene` class-expression name) is **not** executed. The first pass inlined it;
  parent review reverted that, because `Constructor.name` is what scene diagnostics print and a class
  name that names its scene is diagnostic value, while dropping one identifier cleans up nothing.
  The finding moves to `### Retained`.
- 2026-10-05 (independent review correction, Opus 5.5 at `--effort high`): three deletions came
  back, byte-identical to `origin/develop` — the physics allocation bench, the rain noise-volume
  verifier and the 2026-08-20 plans audit. The benchmark was a definite false positive; the rain
  verifier was an owner-decision item and the audit was distinct history. Preserve the latter two
  conservatively under the owner's "fix otherwise" request. The remaining 70 deletions stand.

## Disposition — every finding

### Executed (70 changes, counted from the diff)

| Area | Deleted | Count |
| --- | --- | --- |
| core (A) | `IBackendDataLike`, `IRenderObjectContext` (pipeline-census); `#presentsUnreadable` and its two writes (frame-budget); `#groundSpeedOf` (animation); `#random` and its two writes (game.ts); `members` (geometry-capture); `#renderer` with its write/clear, `attachRenderer`'s parameter now `_renderer` (gpu-scene-bvh); `colorValueOf` (projection-uniform); `BATCHED_PREVIOUS_MATRICES_PROPERTY` (render/batched-velocity); `WebGLRendererContract` (renderer); `ObserverConstructor` (ui-hit-regions); `Spans`' `forEach` id parameter → `_id` (playtest.ts) and `#attribute`'s `id` parameter (profiling/Spans); `evictGeometryMembers`' `workspace` parameter (projection-plan); `#sharedFor`/`#disableFar`/`#restoreFar` `cell` parameters (world-cells.ts); unused imports `IAssetLoader`, `zenithTransmittance`, `nodeObject`, `float`, `vec4`, `Box3`, `Matrix3`; an unused loop index over `regions.entries()` (world-gpu-scene.ts); 2 `eslint-disable-next-line no-console` in a Biome repo (`__tests__/world-tiles-cost.spec.ts`); the false "engine-server.mjs is gitignored" comment (mcp/blender.mjs) | 24 |
| physics / ui / playtest / assets (B) | `renderChainAssertionIsMeaningful` (playtest evaluators), `MIN_QUALITY` and `MAX_QUALITY` (assets audio-pcm), the `allowedXvfbRunMentions` entry naming the deleted analysis script (playtest `__tests__/display-advice.spec.ts`) | 4 |
| runtime-native + small (C) | `android/.../assets/scripts/{gltf-viewer,glb-parser}.js` (Gradle replaces the asset source set), `src/raytracing/shaders/raytracing.metal` (no build rule compiles it; `metal_rt.mm:323` embeds only `raytracingKernel`, and the `shadowRayKernel`/`cornellBoxKernel` this file also holds were never built), 3 module-only `export` keywords across `raw-unreal/{bulk-source-model,raw-mesh}.ts` | 4 |
| templates (D) | the shooter's `SCALE_EXPECTATIONS`/`SizeCheck`/`SizeAxis`/`DOOR_HEIGHT` scale-audit table and its false `tools/scale-audit.mjs` pointer, `swallowtail`, `hoardingGeometry`, `pointOnTrack`, `curbBlock`, `vanFootprint`, `halfWithMirrors`, `RainIntent`, the unused `PresetName`/`QualityName`/`WeatherKey` imports (`VISIBILITY_INTENT` stays: `rain/src/game.ts:7,60` still reads it), `LOS_INTERVAL_SECONDS`+`losStagger` and their false comments, `_repair`, `padAt`, `aimBasis`, `MUZZLE_HEIGHT`, `scratchAxisY`, `TRACK_LAYER`, `clearProgress`, the unused `unwatch` binding, the file `minimal/src/scenes/Boot.ts` | 19 |
| examples (D) | `abyss-framework/src/entities/{Crate,Player}.ts`, the committed `abyss-framework/dist.build-report.json` (+ `*.build-report.json` in `.gitignore`), `reparentHome` (native-cpu-load-test), `ROUTE_WARMUP_FRAMES`, `ROUTE_LENGTH_METRES`, `RouteMark` (quarry), `FIRE_SPRITE_TEXTURE` (vfx-gallery) | 9 |
| docs / scripts (E) | `docs/product/{ThreeNative_Lean_Product_Playbook_Report,ThreeNative_Product_Playbook}.pdf`, `analyze-prd-exp-002.mjs`, `analyze-prd-075-render-advisor.mjs`, `ICitationScan` (evidence-citations), `GATE_HEARTBEAT_INTERVAL_MS` and `writeGateStatus` (gate-status), `RoundDisposition` (round-ledger), `RealismEffectsExport`/`RealismEffectsPlatform` (realism-effects-coverage), 2 stale round-ledger pointers in `docs/README.md` | 10 |

### Retained

| Finding | Reason |
| --- | --- |
| A1 `packages/core/scripts/vsm-proof/` | owner call; it is the proof harness for a live feature and a publish gate asserts it stays unpublished |
| A3 `core/__tests__/seed.spec.ts` | not a duplicate after all: `random.spec.ts` proves a repeat seed matches, only this file proves a *different* seed diverges, which a seeded RNG ignoring its seed would pass |
| A9 `IMPOSTOR_SURFACE_PARALLAX` | a tested interface, not dead code |
| A24 `castDistance` shim | PRD-458 keeps it until the external `machinefall` consumer drops it |
| A25 19 export-only-for-tests symbols | each is read by a spec; un-exporting them is an interface change, not a deletion |
| B4 `WRAP_REPEAT`/`WRAP_MIRRORED_REPEAT` | published barrel re-exports of the `assets` package |
| B5 `playtest/src/assertions.ts`, B6 `evaluators/helpers.ts` | live compat facades, still imported by 10 modules |
| C1 `packages/*.tgz`, C2 native-glTF island, C4 `spectral-ocean.js` | owner decision (see `## Blocked on`) |
| D7 `parseHttpsUrl` | a real defect in an example: keep the validation, report the missing call |
| D29 `QuarryScene` class-expression name | restored on parent review: `Constructor.name` reaches scene diagnostics, so the name is diagnostic surface, not dead weight |
| E6–E9 four orphan docs | only the inbound link is provably missing; the content is a deliberate record |
| E16–E22 untracked disk (`packages/*.tgz`, `release-native/`, `artifacts/`, `.linchpin/`, `notify.log`, `site/`, `test-results/`) | this lane deletes no local disk; untracked and gitignored, no repo effect |
| E23 `stamp:template-loading` | not unreachable junk, and not deleted: `restampTemplateLoadingCopies` has no other caller in the tree, so this entry point is the only way to apply a canonical `loading.ts` change to the tracked templates — the exact role its sibling `stamp:template-render.ts` plays for shared render sources, and that sibling is itself a contract-tested input (`scripts/__tests__/ci-template-selection.spec.ts`). The audit's premise ("manual-only duplicate entry point") holds only if the function it wraps is reachable some other way; it is not |
| B `packages/physics/scripts/bench-allocations.ts` | **restored 2026-10-05** — the audit called it unused because it read PRD-191 as NOT STARTED (`docs/PRDs/performance/PRD-191-physics-feature-frames-reuse-crossing-storage.md:7`). That status is stale: commit `91e46d34f` did the PRD-191 work (296 added bench lines) and its verification record shows `NODE_OPTIONS=--expose-gc pnpm --filter @threenative/physics exec tsx scripts/bench-allocations.ts — exit 0`. The open PRD still names the bench as its Phase 3 EDIT target and verification step 2 (`PRD-191-*.md:20,83,96`). Deleting it would have removed the measurement PRD-191 still has to run |
| D `templates/rain/tools/verify-noise-volume.mjs` | **restored 2026-10-05** — an owner's manual proof that the storm noise volume matches byte for byte. It needs `tempest.html`, which exists only on the owner's disk, so nothing in the repo runs it; done `docs/PRDs/done/starter-kits/PRD-473-rain-starter-kit.md` and `docs/PRDs/production-readiness/RELEASE-READINESS-2026-09-23.md:23` cite it as history. Retained under "fix otherwise" rather than dropped: a useful proof that needs an external input is not junk |
| E `plans/technical-debt-audit-2026-08-20.md` | **restored 2026-10-05** — the audit called it a duplicate. It is a distinct audit of `d75f4644`, not a copy of `junk-audit-2026-10-04.md`, and its items are still tracked: P0-2 (`:57`, libuv handle storage) by `docs/PRDs/BLOCKED/requires-asan-libuv-source-build/PRD-177-*.md` and `PRD-184-*.md`, P0-4 (`:83`, failure-atomic startup and teardown) by `docs/PRDs/done/PRD-180-core-lifecycle-failure-atomicity.md`. A historical record with live follow-ups is not proven junk |

### Deferred (4)

`isRecord` ×3, `isObject` ×3, `now()` ×5 and `fail()` ×2 in `packages/core/src` are duplication,
not dead code: every copy has live callers, so collapsing them rewrites live modules for ~21
net lines. PRD-208 owns that single-sourcing debt; `isRecord` ×6 in `scripts/` is already its item.

## Execution Phases

#### Phase 1: engine layer

**Status:** DONE — both boxes green.
**Files:** `packages/core/{src,__tests__,mcp}`, `packages/playtest/{src,__tests__}`, `packages/assets/src`, `packages/raw-unreal/src`, `packages/runtime-native/{android,src}` (`packages/physics/scripts` dropped from this list on 2026-10-05: its only finding, the allocation bench, was restored)
**Implementation:** remove the compiler-proven unused declarations and their now-unused
arguments; delete the never-packaged Android sample JS and the orphan Metal shader; drop three
module-only `export` keywords; fix the one stale comment.
**Verification:** AC-1, AC-2, AC-4 — `tsc --noUnusedLocals --noUnusedParameters` on core, then
`pnpm --filter @threenative/runtime-native test` and the workspace gates.
- [x] `packages/core` unused-local and unused-parameter diagnostics reach 0. The 24-diagnostic baseline is the audit input's own measurement (`junk-audit-2026-10-04.md:7`), not re-measured here. proof: `cd packages/core && ../../node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json` — Evidence: exit 0, no output at all.
- [x] runtime-native source-list and contract gates stay green without the Android sample JS and the orphan shader. proof: `pnpm --filter @threenative/runtime-native test` — Evidence: exit 0 — 134 files / 1548 tests passed, 62 skipped; Rust physics parity 21 + 2 passed; publint clean. Reaching it needed the compiled host the failures name: `pnpm native:build` exit 0, then `cmake --build build/tn-linux --target threenative-canvas2d-dirty-test threenative-crash-handler-policy-test threenative-timestamp-query-test threenative-rg11b10-renderable-test`, plus the on-demand `tn-linux-quickjs` arm (`cmake --preset tn-linux -B build/tn-linux-quickjs -DMYSTRAL_USE_QUICKJS=ON -DMYSTRAL_USE_V8=OFF`) and its two test targets. Before those builds every one of the failures was an `is not built` assertion on a missing executable; none touched C++ sources or the JS engine, and none referenced a file this PRD deletes.

#### Phase 2: game layer (templates and examples)

**Status:** DONE — all three boxes green; the workspace gate verified on CI at head `346afd02`.
**Files:** `packages/create-threenative/templates/{shooter,sailing,racing,rain,action-rpg,rts,tower-defense,runner,puzzle,minimal}`, `examples/{abyss-framework,quarry,native-cpu-load-test,vfx-gallery}`
**Implementation:** delete each zero-reader helper with its doc comment, drop the false
`LOS_INTERVAL_SECONDS`/`losStagger` comments, delete `minimal/src/scenes/Boot.ts`, remove
`abyss-framework/dist.build-report.json` and gitignore it, and restamp
`PRD_201_PARENT_SCAFFOLD_HASHES` for exactly the templates whose bytes moved (10 of 13;
`platformer`, `snow` and `starter` keep their values).
**Verification:** AC-2, AC-3, AC-6 — the scaffolder contract specs, the workspace gates, and the
example build.
- [x] The scaffolder's template contract specs pass with the hashes restamped for the 10 changed templates. proof: `pnpm --filter @threenative/create-threenative test` — Evidence: green inside the workspace suite; the four scaffolder specs the restamp touches (`scaffold`, `template-assets-compile-1`, `template-assets-compile-2`, `template`) re-run on their own: 4 files / 93 tests, exit 0, 205s.
- [x] The workspace typecheck, lint and unit suite stay green over the deleted helpers. proof: `pnpm typecheck && pnpm lint && pnpm test`, or the same four phases on hosted runners — Evidence: `pnpm typecheck` exit 0; `pnpm lint` exit 0 (1074 warnings). The final `pnpm test` (`taskset -c 0,1,2,3 TN_SUITE_PACKAGE_CONCURRENCY=1`, 1424s) is **exit 1**: `docs`, `build` and `package-test` green — `package-test` including runtime-native 134 files / 1548 tests + Rust parity 21 + 2 + publint and the scaffolder's own `scaffold.spec.ts` at 66 tests — and the unit phase `4 failed | 7933 passed | 13 skipped (7950)`. All four are `Test timed out` on the three heaviest specs in the repo plus one native screenshot wait: `template-assets-compile-1` racing (60s), `template-assets-compile-2` shooter (60s), `template.spec.ts` pristine-scaffold typecheck (180s), and `desktop-playtest.spec.ts` "desktop screenshot outlives the unpicked-request wait" (`TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE … native host output: none captured`, its other 38 tests green). Not one behavioural assertion. This box is shared with other agents' worktrees and ran at load 27–44 on 24 cores; the same four files alone on the four idlest cores are green — 4 files / 117 tests, exit 0, 227s. Left unticked at the time because the gate as written ran red; see the pacing decision under `## Verification notes` for why it was not rolled a fourth time. It closes on CI run 37255318117 at head `346afd02` — `typecheck`, `lint`, `test`, `test-native` and all four `test-unit` shards green — which runs the same four phases over the same package scope, as AC-2 records.
- [x] `examples/abyss-framework` no longer dirties the tree on build. proof: `pnpm --filter abyss-framework build` then `git check-ignore -v examples/abyss-framework/dist.build-report.json` — Evidence: build exit 0 and rewrites the report; `git check-ignore` → `.gitignore:8:*.build-report.json`; `git status --porcelain examples/abyss-framework` after the build lists only this lane's three staged deletions.

#### Phase 3: repo surface (docs and scripts)

**Status:** DONE — deleted and re-pointed; both boxes green.
**Files:** `docs/product/*.pdf`, `docs/README.md`, `scripts/{analyze-prd-exp-002,analyze-prd-075-render-advisor}.mjs`, `scripts/{gate-status,evidence-citations,round-ledger,realism-effects-coverage}.ts`, `packages/playtest/__tests__/display-advice.spec.ts` (`plans/technical-debt-audit-2026-08-20.md` dropped from this list on 2026-10-05: the review proved it a distinct audit, not a duplicate)
**Implementation:** delete the unreferenced PDFs and the two unreachable
analysis scripts; drop the five dead exports; correct the two stale round-ledger pointers.
`scripts/stamp-template-loading.ts` and its `package.json` entry point are **kept** — see the E23
row under `### Retained` and the 2026-10-04 decision: the wrapped function has no other caller, so
removing the entry point removes the capability rather than a duplicate of it.
**Verification:** AC-2, AC-5 — the docs lane plus the script specs.
- [x] Doc links and primary-doc command names stay resolvable after the pointer fix and the deletions. proof: `pnpm check:docs && pnpm exec vitest run scripts/__tests__/check-doc-links.spec.ts scripts/__tests__/primary-docs.spec.ts` — Evidence: `pnpm check:docs` exit 0, "Checked 2323 relative documentation links across 1216 Markdown files"; the two named specs pass inside the `scripts/__tests__` run below.
- [x] The scripts lane stays green after the two analysis scripts and five dead exports go. proof: `pnpm exec vitest run scripts/__tests__` — Evidence: 143 files, 1944 tests, exit 0 (142 files green in the lane run + `fluid-collision-view.spec.ts`, which failed there only because it was run concurrently with the suite's own `build` phase and `@threenative/core/dist` was mid-rewrite; re-run alone, exit 0, 1 test).
