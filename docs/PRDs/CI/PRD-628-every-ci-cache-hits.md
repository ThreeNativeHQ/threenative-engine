# PRD-628 — Everything CI can cache is cached, and the cache hits

**Status:** IN PROGRESS — Phase 1 boxes 1-3 and Phase 3 box 2 implemented and verified locally on
2026-11-03; the four boxes whose proof is a CI run id stay open with the exact log line each needs.
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
- [ ] A PR run whose V8 key has no published asset reuses a payload built for the same key by any run of that PR (dispatch, push or earlier PR run), through a scope the PR can read (for example a release asset or a key written from the base scope). proof: two consecutive PR runs on one recipe; the second restores in under 5 min (CI run ids) — **IMPLEMENTED, PROOF PENDING.** The release asset already covers every ref (`v8-android-e8c0b81…tgz` downloaded in 1.6 s in run 41441113316, job 125263650939). New in the action: a step downloads `v8-android-<recipe>` as a *workflow artifact* — no ref scope, so a payload a PR or a dispatch run on the head branch built is readable by that PR's later runs — and a step publishes it after the receipt verification, once per recipe, retained 7 days. `pipeline-cache.yml` gained `actions: read` for the lookup. The artifact store is the one any run can write, a fork's PR run included, so the trust rules are explicit: only a pull request reads it, `v8-artifact-pick.mjs` admits only this repository's own head on main, develop or the run's own PR head branch, a payload that fails `--verify` is thrown away and cold-built, and `publish-android-v8` requires the action's `built` output — a payload a run downloaded never becomes the trusted release asset. The CI proof needs two runs after this lands: look for `Restored the payload run <id> published for v8-android-<hash>` in `native-platforms / Android V8 source payload`.
- [ ] A cancelled or superseded run keeps its V8 progress: the resumable source state saves on cancel for `pull_request` too, under a bounded key that evicts its own older entries. proof: cancel a cold V8 build mid-compile; the next run resumes from the saved Ninja state (CI run ids, target counts) — **IMPLEMENTED, PROOF PENDING.** `Save resumable V8 source state` now saves on `cancelled` for a pull request as well; the bound is the new `scripts/ci-cache-prune.mjs` rule that keeps one `android-v8-source-*` entry per (os, arch, recipe), run by `prune-cache` in `ci-janitor.yml` after every CI run. `packages/runtime-native/tests/native-platform-workflow.test.mjs` pins the new guard (green: 325 tests in that package's workflow set).

### Phase 2 — compiler and dependency caches hit

- [ ] ccache hits on a warm native job: stable source mtimes or `CCACHE_SLOPPINESS`, a base-dir that removes the checkout path, and a key that a PR can restore. proof: `test-native` reports at least 80% ccache hits on a second run of the same commit (job log "Hits" line) — **PARTIAL 2026-11-03.** Stable mtimes are already there (`restore-source-mtimes.mjs` plus the `native-build` tree). New: `CCACHE_BASEDIR: ${{ github.workspace }}` in all five ccache jobs (`ci.yml` `test-native` and `native-engine`, `native-platforms.yml` `desktop-parity`, `desktop` and `starter-linux`), so one runner's objects hash the same as another's. `CCACHE_SLOPPINESS` stays out on purpose: run 33714810237 showed the setting made SDL3's PCH objects eligible and produced no extra hits. Measured 2026-11-02, run 41441113316 `test-native`: `Cache hit for restore-key: native-ccache-ci-test-native-…-41430297261` (the previous develop run's entry, so a non-merge ref does restore) and `Hits: 256 / 459 (55.77%)`. The next warm develop run (41575174097) restored nothing — `Cache not found for input keys: native-ccache-ci-test-native-…` — and reports `Hits: 5 / 1076 (0.46%)`, because that 20 MB entry had been evicted; the janitor in Phase 3 is what keeps it. 80% still needs the second run after this lands.
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

### Phase 3 — the cache stays healthy

- [ ] The cache budget fits: large entries (V8 source state, native build trees) stay inside a stated share of the 10 GiB, and no lane evicts another lane's hot key during a full run. proof: `gh cache list` before and after one full run; no hot key evicted — **MECHANISM DONE, PROOF PENDING.** Stated budget: `CACHE_BUDGET_BYTES` = 9 GiB, under the 10 GiB GitHub evicts at; `android-v8-source-*` may hold 3.5 GiB (one state per recipe); the hot keys — `node-cache-`, `native-ccache-`, `playwright-`, `workspace-dist-`, `android-v8-payload-`, `cargo-v1-`, `wgpu-cache-`, `pipeline-cache-host-deps-` — are never the entry the plan drops, and a bounded family is bounded per ref as well as per recipe, because caches are ref-scoped. `prune-cache` in `ci-janitor.yml` (after every CI run, `actions: write`) applies it. Plan on the live list, 2026-11-03: 56 entries, 10.00 GiB -> 8.51 GiB, 2 deletions — the merge-queue-scoped `native-build-…-6cb61af1…` (1518 MB) and `native-engine-web-wasm-v2-…` (2 MB); every develop-scoped hot key kept. Pending: the same `gh api …/actions/caches` before and after a full board.
- [x] Self-hosted runner hosts stay inside their disk budget without manual cleanup: the runner service prunes dangling images, build cache and stale offload checkouts, and pauses its slots before a job could hit ENOSPC. proof: runner-host spec plus `laptop-runners.sh status` showing the prune and the free-space gate — **DONE 2026-11-03** (the script is `scripts/ci-runners.sh`; there is no `laptop-runners.sh`). `prune` drops dangling images, build cache older than `TN_RUNNER_PRUNE_UNTIL` (72 h) and stopped `tn-ci-runner=1` containers, and records the time; `up` prunes, then measures the filesystem the docker daemon fills (`docker info --format '{{.DockerRootDir}}'`) and refuses to start under `TN_RUNNER_MIN_FREE_GB` (20 GB); the balancer re-checks that floor on every poll, prunes at most once per ten minutes, withdraws `TN_RUNNER`, `TN_RUNNER_SLOTS` and `TN_RUNNER_LIGHT` while it is breached, and re-advertises when the space returns; the generated systemd unit runs `prune` as `ExecStartPre`. Spec: `scripts/__tests__/ci-runners-disk.spec.ts`, 4 cases against stubbed `docker`/`gh`/`df`/`lscpu`/`nproc` — status verdict, refusal under the floor naming the numbers and reaching no job, the exact three prune commands plus the recorded time, and the balancer pausing the slots without re-advertising (green). Real host, 2026-11-03: `bash scripts/ci-runners.sh prune` prints `prune: 349 GB -> 349 GB free on /var/lib/docker (floor 20 GB)`, and `bash scripts/ci-runners.sh status` then prints `disk: 349 GB free on /var/lib/docker (floor 20 GB): ok` and `prune: 04:46:04Z (0 min ago)`. Operator docs: `tools/ci-runners/README.md` "The host disk budget".

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
  that fails `--verify` cold-builds, and the release write needs the action's `built` output, so a
  downloaded payload is never republished under the trusted name.
