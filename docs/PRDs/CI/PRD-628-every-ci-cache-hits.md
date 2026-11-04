# PRD-628 — Everything CI can cache is cached, and the cache hits

**Status:** IN PROGRESS — Phase 1 boxes 1-3 and Phase 3 box 2 implemented and verified locally on
2026-11-03. Round 4 read four CI runs on 2026-11-03 and measured every remaining box: the payload
restored in 1.4 s, a cancelled build resumed at 1724 edges instead of 3519, `test-native` reported
21.28% ccache against 100% in three lanes, one full cache table and the cache budget at
8.63 → 9.28 GiB. Each open box now names the one run that would close it. Round 6 (2026-11-04)
closed the `test-native` ccache box (100% on a same-commit rerun, 96.47% on the next commit) and
found the cache janitor has not run yet, because `workflow_run` reads `main`'s copy of the file.
**Priority:** P0 — The release PR #493 waited 70+ minutes on a cold Android V8 build and lost two in-progress V8 builds to cancellation; open boxes below remove those waits from every release head.
**Complexity:** MEDIUM (cache keys, scopes and save rules in existing workflows; no new workflow file)
**Owner:** CI tooling
**Depends on:** none (PRD-480 runner pool, PRD-481 do-each-piece-once and PRD-550 merge-in-30 are context)

## Context

Theme (owner, 2026-10-19): everything that can be cached is cached, and the cache works. A cache that
exists but misses is the same as no cache. Each finding below was observed on PR #493 on 2026-10-18/19.
Re-checked against today's `.github/` on 2026-11-03; the evidence column now carries what the newest
runs show.

| # | Finding | Evidence |
|---|---|---|
| 1 | The Android V8 payload key hashed all of `download-deps.mjs`. Any edit to that file (most are not about V8) changed the key and cold-built V8. | PR #493 edited `download-deps.mjs` (+29/-11) and run 39184795139 built from source. Still true on 2026-11-03: `hashFiles(… download-deps.mjs …)` was the key. Fixed here with `scripts/v8-recipe-hash.mjs`. |
| 2 | Pull-request runs use the `refs/pull/<n>/merge` cache scope, so they cannot read a payload a `workflow_dispatch` or push run on the head branch saved. | The release asset already covers every ref and it hit on 2026-11-02 (run 41441113316, job 125263650939: payload `e8c0b81…` came from `ci-v8-android` in 1.6 s). What no ref could read was a payload a *pull request* built: that entry is scoped to its own merge ref. Fixed here with a workflow artifact, which has no ref scope. |
| 3 | A superseded PR run is cancelled, and the resumable V8 source state was not saved for a cancelled `pull_request`. Every push threw the in-progress build away. | 39179447093: V8 ran 63 min, then cancelled by the next push. 39164145931: 62 min, cancelled. The action still refused to save on a cancelled pull request on 2026-11-03. |
| 4 | ccache almost never hit in the native jobs. | Two causes were fixed since: `restore-source-mtimes.mjs` dates sources by their commit, and the `native-build` tree restores the compiled host. The newest full board (run 41441113316, `test-native`) reports `Hits: 256 / 459 (55.77%)`. The run after it (41575174097) restored no compiler cache at all and reports `0.46%`, because that 20 MB entry had been evicted. |
| 5 | The repository Actions cache is 10 GiB shared by every lane, so large entries evict each other. | 2026-11-03: 56 live entries measured 10.00 GiB (`gh api …/actions/caches`). The 3.2 GB source state is the largest entry after `native-build` (1.5 GB, two copies). |
| 6 | Self-hosted runner hosts fill their disk with stale images, build cache and checkouts, and jobs then fail with ENOSPC instead of caching. | Laptop runner 98-100% full: `test-native` ENOSPC on 39168826685 and 39175816222; 2026-10-18 cleanup freed 767 MB -> 65 GB. `scripts/ci-runners.sh` had no prune and no free-space gate on 2026-11-03. |

## Phases

### Phase 1 — the V8 payload hits on every PR

- [x] The V8 payload key hashes only the V8 recipe: the `v8-android` entry of `download-deps.mjs` (version, URL, checksum, build args), `build-android-v8.mjs`, the 16 KB check and `gradle.properties`. An edit elsewhere in `download-deps.mjs` keeps the key. proof: unit spec in `packages/runtime-native/__tests__/` that edits an unrelated dependency and asserts the same key, and edits the V8 pin and asserts a new key — **DONE 2026-11-03.** `packages/runtime-native/scripts/v8-recipe-hash.mjs` hashes the `v8-android` DEPS entry (a brace scanner that skips comments and strings) plus `build-android-v8.mjs`, `check-android-16kb-alignment.mjs` and `android/gradle.properties`. `.github/actions/android-v8-source/action.yml` runs it in place of `hashFiles(…)`. `packages/runtime-native/__tests__/android-v8-recipe-hash.spec.ts`: 6 cases, red first (module absent), then green, and a mutation of the hot-key rule fails the spec. Covered: unrelated `wgpu` bump keeps the key; a non-recipe file keeps it; a changed `v8-android` version, builder `recipe`, a GN arg, the 16 KB check and `gradle.properties` each change it; the action carries no `hashFiles(`. Verified `pnpm exec vitest run packages/runtime-native/__tests__/android-v8-recipe-hash.spec.ts` (6 passed). ⚠️ The hash algorithm changes once, so the first trusted-ref run after merge publishes one new asset (25 MB) and the run before it still has the payload on disk; `ci-v8-android` holds four assets under the old keys.
- [ ] A PR run whose V8 key has no published asset reuses a payload built for the same key by any run of that PR (dispatch, push or earlier PR run), through a scope the PR can read (for example a release asset or a key written from the base scope). proof: two consecutive PR runs on one recipe; the second restores in under 5 min (CI run ids) — **IMPLEMENTED, PROOF PENDING.** The release asset already covers every ref (`v8-android-e8c0b81…tgz` downloaded in 1.6 s in run 41441113316, job 125263650939). New in the action: a step downloads `v8-android-<recipe>` as a *workflow artifact* — no ref scope, so a payload a PR or a dispatch run on the head branch built is readable by that PR's later runs — and a step publishes it after the receipt verification, once per recipe, retained 7 days. `pipeline-cache.yml` gained `actions: read` for the lookup. The artifact store is the one any run can write, a fork's PR run included, so the trust rules are explicit: only a pull request reads it, `v8-artifact-pick.mjs` admits only this repository's own head on main, develop or the run's own PR head branch, a payload that fails `--verify` is thrown away and cold-built, and `publish-android-v8` requires the action's `trusted` output (this run built the payload, or a push restored it from that ref's own Actions cache) — a downloaded artifact and a pull request's cache never become the trusted release asset. The CI proof needs two runs after this lands: look for `Restored the payload run <id> published for v8-android-<hash>` in `native-platforms / Android V8 source payload`.
  **Round 4 measurement, 2026-11-03.** The recipe-keyed payload cache restores. Run 41688813459
  (`workflow_dispatch`, head `3a96313df`, job 126104730648) logged `No published
  v8-android-6d7f399f….tgz`. Then `v8.artifact` reported **skipped**, because that step is
  pull-request-only. Then `Cache not found for input keys: android-v8-payload-…-6d7f399f…`. It
  compiled from 18:18:44Z to 20:03:42Z (1 h 45 min), saved that key, and published artifact
  13268070999 (27,451,905 bytes). The next run on the same recipe, 41718807432 (`workflow_dispatch`,
  job 126206823706), logged `Cache hit for: android-v8-payload-Linux-X64-6d7f399f…` and restored it
  in **1.4 s**; the build step skipped and the verify step took 150 ms. Both runs use
  `refs/heads/goal/prd-p0-p1-1102`, so this proves the same-ref half only. It does not touch the
  pull-request scope this box exists for: `refs/pull/<n>/merge` cannot read that branch. The artifact
  half is verified read-only, not by a run: `gh api …/actions/artifacts?name=v8-android-6d7f399f…`
  returns one live artifact (run 41688813459, branch `goal/prd-p0-p1-1102`, `expired=false`), and
  `node packages/runtime-native/scripts/v8-artifact-pick.mjs --branches "main develop
  goal/prd-p0-p1-1102"` prints `41688813459`. No `pull_request` run has executed the job: runs
  41688824813, 41719032843 and 41720079075 all report `native-platforms skipped` (thin review lane),
  and a `merge_group` run never reads the artifact by design. **The run that still proves the
  claim:** a `pull_request` run whose selection keeps `native-platforms` and whose head branch
  published the artifact. In practice that is the `develop -> main` promotion PR run after a
  `develop` push cold-built a new recipe. Its log must carry `Restored the payload run <id> published
  for v8-android-<hash>` and the job must finish in under 5 min.
- [ ] A cancelled or superseded run keeps its V8 progress: the resumable source state saves on cancel for `pull_request` too, under a bounded key that evicts its own older entries. proof: cancel a cold V8 build mid-compile; the next run resumes from the saved Ninja state (CI run ids, target counts) — **IMPLEMENTED, PROOF PENDING.** `Save resumable V8 source state` now saves on `cancelled` for a pull request as well; the bound is the new `scripts/ci-cache-prune.mjs` rule that keeps one `android-v8-source-*` entry per (os, arch, recipe), run by `prune-cache` in `ci-janitor.yml` after every CI run. `packages/runtime-native/tests/native-platform-workflow.test.mjs` pins the new guard (green: 325 tests in that package's workflow set).
  **Round 4 measurement, 2026-11-03.** The mechanism ran for real, on a dispatch run. Run 41670763005
  (`workflow_dispatch`, head `b190cdb3`) had its payload job 126039739267 cancelled at 16:28:17Z
  mid-compile at `[1781/3519]`. `Save resumable V8 source state` then ran and saved
  `android-v8-source-Linux-X64- 6d7f399f…-41670763005-1` at 16:29:47Z. Run 41688813459 restored that
  key (`Cache hit for restore-key: …`). Its first Ninja phase planned **1724 edges, not 3519**
  (3519 − 1781 = 1738). A second phase of 3529 followed, so it finished the payload the cancelled run
  started. The `pull_request` arm stays unproven. No pull-request run has been cancelled with this
  recipe, and a pull-request run of a develop-bound PR does not run the job at all
  (`native-platforms skipped`). **The run that still proves it:** cancel a `pull_request` run that
  does run the job — a `develop -> main` promotion PR run — 10 to 20 min into the payload build. Then
  read the next run of the same recipe for `android-v8-source-…-<that run id>-1` in a `Cache hit for
  restore-key:` line, with a planned edge count below the full one.

### Phase 2 — compiler and dependency caches hit

- [x] ccache hits on a warm native job: stable source mtimes or `CCACHE_SLOPPINESS`, a base-dir that removes the checkout path, and a key that a PR can restore. proof: `test-native` reports at least 80% ccache hits on a second run of the same commit (job log "Hits" line) — **DONE 2026-11-04** (round 6 below). **PARTIAL 2026-11-03.** Stable mtimes are already there (`restore-source-mtimes.mjs` plus the `native-build` tree). New: `CCACHE_BASEDIR: ${{ github.workspace }}` in all five ccache jobs (`ci.yml` `test-native` and `native-engine`, `native-platforms.yml` `desktop-parity`, `desktop` and `starter-linux`), so one runner's objects hash the same as another's. `CCACHE_SLOPPINESS` stays out on purpose: run 33714810237 showed the setting made SDL3's PCH objects eligible and produced no extra hits. Measured 2026-11-02, run 41441113316 `test-native`: `Cache hit for restore-key: native-ccache-ci-test-native-…-41430297261` (the previous develop run's entry, so a non-merge ref does restore) and `Hits: 256 / 459 (55.77%)`. The next warm develop run (41575174097) restored nothing — `Cache not found for input keys: native-ccache-ci-test-native-…` — and reports `Hits: 5 / 1076 (0.46%)`, because that 20 MB entry had been evicted; the janitor in Phase 3 is what keeps it. 80% still needs the second run after this lands.
  **Round 4 measurement, 2026-11-03.** `test-native` still does not reach 80%. In run 41688813459
  attempt 1 it restored nothing — `Cache not found for input keys:
  native-ccache-ci-test-native-Linux-X64-gcc-ccb139…-41688813459, …-ccb139…-` — and reports
  `Hits: 229 / 1076 (21.28%)`, then saved a 20 MB entry at 18:57:47Z. Three other lanes in the same
  board restored a run-41670763005 entry under the same cmake hash and report **100%**:
  `native-engine` `Hits: 256 / 256`, `starter-linux` Linux-X64 `280 / 280`, Linux-ARM64
  `312 / 312`. So the mechanism reaches the target where an entry survives. `test-native` has none
  to restore: the cmake hash is part of its key, this tree's hash differs from the `develop` and
  `main` copies (`…-ccb139…` here against `…-3ea15707…` and `…-d2c019c3…` there), so every lane on
  this branch starts cold once per hash. Run 41718807432 was the second run that would warm it, and
  its `test-native` was cancelled 5 min in, before the cache steps, and that run was itself cancelled
  at 55 of its 78 jobs. Run 41688813459 attempt 2 is not a measurement either: it re-ran only the
  failed jobs (`gh run rerun --failed`), so `test-native` did not run again. **The run that closes this
  box:** a rerun of `test-native` on a ref that already holds its `native-ccache-ci-test-native-…`
  entry; the job log must carry a `Cache hit for restore-key:` line and `Hits: ≥ 80%`.
  **Round 5 fix, commit `5b8113f05`.** Two causes, both in this tree. (a) The `test-native`
  `restore-keys` repeated the key's own `hashFiles()` over `CMakeLists.txt` and every `*.cmake`, so a
  native change produced a prefix no saved entry could match: this tree hashed to `…-gcc-ccb139…`
  while the entry the develop run had saved was `…-gcc-3ea15707…`. The prefix now stops at the lane
  (`native-ccache-ci-test-native-${os}-${arch}-gcc-`) and the exact key still carries the hash and
  the run id last. ccache keys every object by compiler, flags and source, so a restored object
  from another tree is identical or a miss. (b) `prune-cache` protected the newest copy of the whole
  `native-ccache-` prefix per ref, so a ref that runs all seven ccache lanes kept one of them. On
  the live list of 2026-11-03 it planned to delete `native-ccache-ci-test-native-…-ccb139…`
  (19.6 MiB, `goal/prd-p0-p1-1102`) and `native-ccache-ci-native-engine-…` on `develop`
  (148.3 MiB). Protection is per lane per ref now, and an older copy of one lane stays evictable.
  Specs: `scripts/__tests__/ci-cache-keys.spec.ts` (red first: 3 failed) and three cases in
  `ci-cache-prune.spec.ts` (red first: 2 failed); both green. The hit rate still needs the run.
  **Round 6 measurement, 2026-11-04 — box closed.** Develop push run 41833465433 (`d692aaa89`,
  job 126588105066) restored `native-ccache-ci-test-native-…-gcc-ccb139…-41818164715`, a 20 MB entry
  from main's scheduled run, and reports `Hits: 233 / 1076 (21.65%)`, then saved 39 MB as
  `…-41833465433`. The same commit, rerun as attempt 2 (job 126648784152), restored that entry and
  the exact `native-build-…-288a51…-4e1a…` tree and reports `Hits: 459 / 459 (100.0%)`. The next
  develop push, run 41842254378 (`f129102dc`, 138 files changed, job 126622179941), missed
  `native-build` on its changed tree, restored the same ccache entry, and reports
  `Hits: 1038 / 1076 (96.47%)` (100% on each of the three build steps). Both are over 80%.
- [ ] Every remaining cacheable input has a working cache, measured by hit rate: pnpm store, Playwright browsers, Gradle, Cargo, emsdk, third_party native deps. proof: a table of cache key and hit/miss per job from one full warm run, every row a hit — **PARTIAL 2026-11-03.** Table below is from full develop board run 41441113316 (2026-11-02, per-job logs, cache lines). One row missed and it is a key-input change, not a broken cache: `workspace-dist-v2-…-0fbb7f5f…` missed and saved because PR #597 had changed `pnpm-lock.yaml`. `test-native`'s `native-build-…` also missed on run 41575174097 because the runner image version had changed, and the key covers it on purpose.

| Cache key | Jobs | Result in run 41441113316 |
|---|---|---|
| `node-cache-<os>-<arch>-pnpm-<lock hash>` | every JS job (build-artifacts, test, test-unit, test-browser, test-native, benchmark, native-engine, every template lane) | hit, every job |
| `playwright-<os>-<arch>-<version>` + `playwright-debs-v1-…` | test, test-unit, test-browser, test-native, golden-path-template, template-nonvisual | hit, every job |
| `native-engine-emsdk-<os>-<arch>-6.0.11` | build-artifacts, test, native-engine | hit |
| `native-engine-web-wasm-v2-…` | build-artifacts | hit |
| `native-third-party-<os>-<arch>-<deps hash>` | test-native, starter-linux | hit |
| `native-ccache-<lane>-<os>-<arch>-gcc-<cmake hash>-<run id>` | test-native (55.77%), native-engine, starter-linux | hit via `restore-key` on the previous develop run |
| `native-build-<os>-<arch>-<toolchain identity>-<source hash>` | test-native | hit (restored in 29 s) |
| `cargo-v1-…` | starter-linux | hit |
| `gradle-<os>-<image>` · `cargo-android-…` · `wgpu-cache-…` · `native-android-third-party-…` | android-v8-source, android-emulator-parity (from `gh api …/actions/caches`, 489 MB and 153–203 MB live) | present; the emulator leg was cancelled in that run, not measured |
| `v8-android-<recipe>` release asset | android-v8-source | hit in 1.6 s (job 125263650939, 0 steps of build) |
| `workspace-dist-v2-<os>-<arch>-<node>-<manifest hash>` | build-artifacts | **miss**, saved: PR #597 changed the pnpm lockfile |

Second full warm board, run 41688813459 attempt 1 (2026-11-03, `workflow_dispatch` on
`goal/prd-p0-p1-1102`, head `3a96313df`: 70 job logs, 181 cache lines). Same verdict: every named
family hits except Gradle.

| Cache key | Jobs | Result in run 41688813459 attempt 1 |
|---|---|---|
| `node-cache-<os>-<arch>-pnpm-<lock hash>` — one hash over the workspace lockfile, a second over the template manifests | 53 jobs | hit, every job (both hashes) |
| `playwright-<os>-<arch>-<version>` + `playwright-debs-v1-…` | 38 jobs | hit, every job |
| `native-third-party-<os>-<arch>-<deps hash>` | 8 jobs | hit |
| `cargo-v1-…` | 7 jobs | hit (Linux X64, Linux ARM64, Windows) |
| `native-engine-emsdk-<os>-<arch>-6.0.11` | 4 jobs | hit |
| `native-engine-web-wasm-v2-…` | 3 jobs | hit |
| `native-ccache-<lane>-<os>-<arch>-gcc-<cmake hash>-<run id>` | 5 jobs | 3 hit, 2 **miss** |
| `workspace-dist-v2-…` | 4 jobs | 3 hit, 1 **miss** (`build-artifacts`, new manifest hash) |
| `android-v8-source-…` | 1 job | hit via `restore-key` (`…-41670763005-1`) |
| `native-build-…` | 1 job | **miss**, saved by `test-native` |
| `android-v8-payload-…` | 1 job | **miss**, saved after the 1 h 45 min build |
| `gradle-<os>-<image>` | 1 job | **miss** (`android-emulator-parity`), saved 499 MB after a full re-download |
| `cargo-android-…` | 1 job | **miss**, saved |
| `native-android-third-party-…` | 1 job | **miss**, saved |

The three ccache hits in that board report `Hits: 256 / 256` (`native-engine`), `280 / 280`
(`starter-linux` Linux-X64) and `312 / 312` (`starter-linux` Linux-ARM64). Their keys carry the same
cmake hash as the run they restored from, so the second run on those native inputs hit 100%.
`test-native` and `desktop-parity` missed (`Cache not found for input keys: native-ccache-…`), and so
did `native-build`. The Gradle, `cargo-android` and `native-android-third-party` keys live only under
the two refs that saved them (`refs/heads/develop`, `refs/heads/goal/prd-p0-p1-1102`), so any run on
another ref re-downloads all three; the emulator job's copies under the PR branch carry
`createdAt` 20:41:09Z, this job's own save. The newest board, run 41718807432, misses the same ccache
rows plus `native-engine-web-wasm-v2` and `workspace-dist-v2` (new manifest hash, then saved by
`build-artifacts` and hit by that run's later jobs), and it hits `android-v8-payload-…` in 1.4 s.
Box stays open: Gradle does not hit.
**Round 5, commit `5b8113f05`.** The save side already runs on develop. Develop push run 41703997856
(job 126163329535) restored none of the three at 19:55:20Z to 19:55:21Z and saved all three at
20:34:55Z, 20:35:01Z and 20:35:05Z under `refs/heads/develop`, so a pull request into develop can
restore them from its base branch and nothing has to move. The miss on that same run is eviction:
`prune-cache` protected no `gradle-`, `cargo-android-` or `native-android-third-party-` entry, so
the largest entries a board writes went first. All three are hot keys now (499.6 MiB + 153.6 MiB +
139.5 MiB per ref). The key shape also lost a defect: a folded `>-` block put a space between the
platform and the hash (`native-android-third-party-Linux-X64- 4c553d1e…`, the save line of that same
job), and the key is one line now, which invalidates the one live 139.5 MiB entry once. A
`workflow_dispatch` on a non-default branch and a `merge_group` run read only their own ref and
`main`, so they still miss develop's copies; that is GitHub's scope rule, not a workflow rule, and
the runs that prove this box are a PR board and a develop board after merge.

**Round 6, 2026-11-04.** Still partial. In develop runs 41833465433 and 41842254378 `test-native`
missed only `native-build-Linux-X64-288a51…-<tree hash>`: that key is the exact hash of the
runtime-native sources with no restore key, so every commit that changes them misses by design,
and ccache carries the reuse (96.47%, box above). The same-commit rerun hit it
(`Cache restored from key: native-build-…-4e1a…`). A full table with every row a hit needs a full
board on an unchanged tree, which this round did not run.

### Phase 3 — the cache stays healthy

- [ ] The cache budget fits: large entries (V8 source state, native build trees) stay inside a stated share of the 10 GiB, and no lane evicts another lane's hot key during a full run. proof: `gh cache list` before and after one full run; no hot key evicted — **MECHANISM DONE, PROOF PENDING.** Stated budget: `CACHE_BUDGET_BYTES` = 9 GiB, under the 10 GiB GitHub evicts at; `android-v8-source-*` may hold 3.5 GiB (one state per recipe); a hot key `node-cache-`, `native-ccache-`, `playwright-`, `workspace-dist-`, `android-v8-payload-`, `cargo-v1-`, `wgpu-cache-`, `pipeline-cache-host-deps-` — keeps its newest copy per lane per ref and no more (round 5: per lane, because seven ccache lanes shared one slot), so a stale copy another key replaced is evictable while the copy a run would restore never is, and a bounded family is bounded per ref as well as per recipe, because caches are ref-scoped. `prune-cache` in `ci-janitor.yml` (after every CI run, `actions: write`) applies it. Plan on the live list, 2026-11-03: 56 entries, 10.00 GiB -> 8.51 GiB, 2 deletions — the merge-queue-scoped `native-build-…-6cb61af1…` (1518 MB) and `native-engine-web-wasm-v2-…` (2 MB); every develop-scoped hot key kept. Pending: the same `gh api …/actions/caches` before and after a full board.
  **Round 4 measurement, 2026-11-03.** Two `gh cache list --limit 200` snapshots while two full boards
  ran — 41718807432 at 21:06:55Z and merge-group run 41718838521 at 21:07:07Z, both cancelled
  mid-flight at 55 and 42 of their 78 jobs. Before, 21:19:40Z: 70 entries, **8.63 GiB**. After, 22:07:51Z: 86
  entries, **9.28 GiB** — above the stated 9 GiB budget and 0.7 GiB under GitHub's ceiling. The growth
  is `native-ccache-*`: 26 entries and 1.31 GiB became 40 entries and 1.95 GiB, because five refs
  (`develop`, `main`, `prd/632-filmic-exposure`, `gh-readonly-queue/develop/pr-606-…`,
  `goal/prd-p0-p1-1102`) each keep their own copy. Shares of the 10 GiB at the after snapshot: V8
  0.02 GiB (the payload only; **no `android-v8-source` entry is live**, so the 3.2 GB family this
  finding names currently holds nothing), native trees 5.21 GiB — `native-ccache` 1.95,
  `native-build` tree 1.48, `native-engine` emsdk/wasm 0.94, `native-third-party` 0.57,
  `native-android-third-party` 0.27. The rest: `cargo` 1.37, `node-cache` 1.35, `gradle` 0.98 (two
  500 MB copies, one per ref), `playwright` 0.30, `workspace-dist` 0.04. **No key was evicted, and
  none was evicted and re-saved**, between the two lists: their diff is 16 new entries and zero
  removals. That settles the no-eviction half for this hour. The box stays open because no full board
  completed in the window — something outside this lane cancelled both — and 9.28 GiB is above the
  9 GiB the janitor holds. Proof still owed: the same pair of lists around one full board that runs
  to completion.
  **Round 5, commit `5b8113f05`.** The janitor's protection was per prefix per ref, so the seven
  `native-ccache` lanes shared one slot. It is per lane per ref now. Added hot: `gradle-`
  (499.6 MiB), `cargo-android-` (153.6 MiB), `native-android-third-party-` (139.5 MiB) and
  `native-engine-web-wasm-v2-` (2.5 MiB). Size on the live list of 2026-11-03 (87 entries,
  9.43 GiB): protected bytes 1325.4 MiB in 19 entries before, 5498.0 MiB in 61 entries after,
  +4172.6 MiB — the price of one restorable copy of each lane on each ref. That leaves 3.6 GiB
  evictable. The plan then deletes 11 entries (0.51 GiB) to 8.93 GiB, and every one of them is an
  older copy of a lane another key replaced: two on `prd/632-filmic-exposure` for
  `native-ccache-ci-native-engine-…`, macOS/Windows/desktop-parity/starter-linux older copies, and
  old `workspace-dist-v2` hashes. No key is deleted while it is a lane's only copy on its ref. If a
  future board leaves only protected entries over the budget, the step prints `STILL OVER BUDGET` and
  deletes nothing, and GitHub's own least-recently-used eviction takes over — visible, not silent.
  The run that closes this box is the same one.
  **Round 6, 2026-11-04 — the janitor never ran.** Every `ci-janitor.yml` `workflow_run` run since
  #605 merged reports `skipped` (for example 41842431461: `retry-flakes skipped`, `cancel skipped`).
  A `workflow_run` event runs the default branch's copy of the file, and `main` (`827d5689a`) has
  no `prune-cache` job yet. So GitHub's least-recently-used eviction still decides: the list held
  62 entries and 10.14 GiB before develop run 41833465433 and 56 entries and 9.32 GiB after it,
  and the evicted entries include main's only `native-ccache-Windows-…` copy and main's
  `native-build-…` tree. The proof needs the next `develop -> main` promotion, then the same two
  `gh cache list` snapshots around one full board.
- [x] Self-hosted runner hosts stay inside their disk budget without manual cleanup: the runner service prunes dangling images, build cache and stale offload checkouts, and pauses its slots before a job could hit ENOSPC. proof: runner-host spec plus `laptop-runners.sh status` showing the prune and the free-space gate — **DONE 2026-11-03** (the script is `scripts/ci-runners.sh`; there is no `laptop-runners.sh`). `prune` drops dangling images, build cache older than `TN_RUNNER_PRUNE_UNTIL` (72 h) and stopped `tn-ci-runner=1` containers, and records the time; `up` prunes, then measures the filesystem the docker daemon fills (`docker info --format '{{.DockerRootDir}}'`) and refuses to start under `TN_RUNNER_MIN_FREE_GB` (20 GB); the balancer re-checks that floor on every poll, prunes at most once per ten minutes, withdraws `TN_RUNNER`, `TN_RUNNER_SLOTS` and `TN_RUNNER_LIGHT` while it is breached, and re-advertises when the space returns; the generated systemd unit runs `prune` as `ExecStartPre`. Spec: `scripts/__tests__/ci-runners-disk.spec.ts`, 7 cases against stubbed `docker`/`gh`/`df`/`lscpu`/`nproc` — status verdict, refusal under the floor naming the numbers and reaching no job, the exact three prune commands plus the recorded time, and the balancer pausing the slots without re-advertising (green); the balancer's routing fixture in `scripts/__tests__/ci-runners.spec.ts` stubs `df` too, so its 17 cases no longer read the host's own free space (2026-11-03: before that stub they failed on any host under the floor, which is what a 12 GB-free `/tmp` produced). Real host, 2026-11-03: `bash scripts/ci-runners.sh prune` prints `prune: 349 GB -> 349 GB free on /var/lib/docker (floor 20 GB)`, and `bash scripts/ci-runners.sh status` then prints `disk: 349 GB free on /var/lib/docker (floor 20 GB): ok` and `prune: 04:46:04Z (0 min ago)`. Operator docs: `tools/ci-runners/README.md` "The host disk budget".

## Blocked on

- Nothing.

## Decisions

- 2026-10-19 (João): P0. "everything that can be cached should be cached, and cache should work fine. thats the theme". Filed while PR #493 waited on a cold V8 build.
- 2026-11-03 (lane 628): the stated cache budget is 9 GiB (under GitHub's 10 GiB) with one resumable
  V8 state per recipe, because GitHub evicts by last access and the cheapest victim is the small hot
  key: run 41575174097 restored no compiler cache while a 1.5 GB build tree stayed. The payload is
  published as a workflow artifact as well as a release asset, because an artifact is the only store
  with no ref scope and the release write stays on trusted refs. 2026-11-03 (review): the artifact
  read is pull-request-only and filtered to this repository's own head on a trusted branch, a payload
  that fails `--verify` cold-builds, and the release write needs the action's `trusted` output — this
  run built the payload, or a push restored it from that ref's own cache — so a downloaded artifact
  and a pull request's cache are never republished under the trusted name.
