# PRD-628 — Everything CI can cache is cached, and the cache hits

**Status:** NOT STARTED
**Priority:** P0 — The release PR #493 waited 70+ minutes on a cold Android V8 build and lost two in-progress V8 builds to cancellation; open boxes below remove those waits from every release head.
**Complexity:** MEDIUM (cache keys, scopes and save rules in existing workflows; no new workflow file)
**Owner:** CI tooling
**Depends on:** none (PRD-480 runner pool, PRD-481 do-each-piece-once and PRD-550 merge-in-30 are context)

## Context

Theme (owner, 2026-10-19): everything that can be cached is cached, and the cache works. A cache that
exists but misses is the same as no cache. Each finding below was observed on PR #493 on 2026-10-18/19.

| # | Finding | Evidence |
|---|---|---|
| 1 | The Android V8 payload key hashes all of `download-deps.mjs`. Any edit to that file (most are not about V8) changes the key, misses the published `ci-v8-android` asset, and cold-builds V8 (60-120 min). | PR #493 edits `download-deps.mjs` (+29/-11); job "Android V8 source payload" in run 39184795139 built from source from 01:26 UTC. |
| 2 | Pull-request runs use the `refs/pull/<n>/merge` cache scope. They cannot read caches saved by a `workflow_dispatch` or push run on the head branch, so a green dispatch run does not warm the PR run. | Dispatch run 39168826685 restored V8 in 1 min on attempt 2; PR runs 39175816222, 39179447093, 39184795139 cold-built. |
| 3 | A superseded PR run is cancelled (`cancel-in-progress` for `pull_request` in `ci.yml`), and the resumable V8 source state is not saved for a cancelled `pull_request`. Every push throws the in-progress build away. | 39179447093: V8 ran 63 min, then cancelled by the next push. 39164145931: 62 min, cancelled. |
| 4 | ccache almost never hits in the native jobs. | `test-native` 117810504667: 5/1072 hits (0.47%); 117819802723: 3/614 (0.49%). |
| 5 | The repository Actions cache is 10 GiB shared by every lane, so large entries evict each other (the V8 source state is 3.2 GB). | `.github/actions/android-v8-source/action.yml` comments; 2026-09-28 eviction. |
| 6 | Self-hosted runner hosts fill their disk with stale images, build cache and checkouts, and jobs then fail with ENOSPC instead of caching. | Laptop runner 98-100% full: `test-native` ENOSPC on 39168826685 and 39175816222; 2026-10-18 cleanup freed 767 MB -> 65 GB. |

## Phases

### Phase 1 — the V8 payload hits on every PR

- [ ] The V8 payload key hashes only the V8 recipe: the `v8-android` entry of `download-deps.mjs` (version, URL, checksum, build args), `build-android-v8.mjs`, the 16 KB check and `gradle.properties`. An edit elsewhere in `download-deps.mjs` keeps the key. proof: unit spec in `packages/runtime-native/__tests__/` that edits an unrelated dependency and asserts the same key, and edits the V8 pin and asserts a new key
- [ ] A PR run whose V8 key has no published asset reuses a payload built for the same key by any run of that PR (dispatch, push or earlier PR run), through a scope the PR can read (for example a release asset or a key written from the base scope). proof: two consecutive PR runs on one recipe; the second restores in under 5 min (CI run ids)
- [ ] A cancelled or superseded run keeps its V8 progress: the resumable source state saves on cancel for `pull_request` too, under a bounded key that evicts its own older entries. proof: cancel a cold V8 build mid-compile; the next run resumes from the saved Ninja state (CI run ids, target counts)

### Phase 2 — compiler and dependency caches hit

- [ ] ccache hits on a warm native job: stable source mtimes or `CCACHE_SLOPPINESS`, a base-dir that removes the checkout path, and a key that a PR can restore. proof: `test-native` reports at least 80% ccache hits on a second run of the same commit (job log "Hits" line)
- [ ] Every remaining cacheable input has a working cache, measured by hit rate: pnpm store, Playwright browsers, Gradle, Cargo, emsdk, third_party native deps. proof: a table of cache key and hit/miss per job from one full warm run, every row a hit

### Phase 3 — the cache stays healthy

- [ ] The cache budget fits: large entries (V8 source state, native build trees) stay inside a stated share of the 10 GiB, and no lane evicts another lane's hot key during a full run. proof: `gh cache list` before and after one full run; no hot key evicted
- [ ] Self-hosted runner hosts stay inside their disk budget without manual cleanup: the runner service prunes dangling images, build cache and stale offload checkouts, and pauses its slots before a job could hit ENOSPC. proof: runner-host spec plus `laptop-runners.sh status` showing the prune and the free-space gate

## Blocked on

- Nothing.

## Decisions

- 2026-10-19 (João): P0. "everything that can be cached should be cached, and cache should work fine. thats the theme". Filed while PR #493 waited on a cold V8 build.
