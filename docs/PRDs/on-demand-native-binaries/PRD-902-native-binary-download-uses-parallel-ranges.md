# PRD-902 — Native binary download uses parallel ranges

**Status:** IN PROGRESS — AC-1 and AC-2 verified locally; AC-3 (paired timing against the real release) is running.
**Priority:** P2 — AC-1 to AC-3 are open: when GitHub serves one connection at 219 KB/s, one native binary takes about 9 minutes to download, and an agent loop with a 10-minute install limit builds nothing. Not P1: PRD-783 removes the download from a web-only install, so after PRD-783 only native builds pay this cost.
**Complexity:** 1 (LOW) — score: 1 implementation file (`install-prebuilt.mjs`) +1. No new module, no state change, no new boundary.
**Owner:** João
**Depends on:** PRD-783 (order only). Both PRDs edit `packages/runtime-native/scripts/install-prebuilt.mjs`. Land PRD-783 first, or rebase this one on it. This PRD does not need PRD-783 to work.

## Context

On 2026-11-19 a local agent loop got stuck on `pnpm install`. The `install` script of `@threenative/runtime-native` downloads three Linux binaries (about 385 MiB, PRD-783 M8) from the GitHub release. Each binary uses one HTTP connection. GitHub served each connection at 219 KB/s, so the install passed the loop's 10-minute limit and the run built nothing.

The downstream loop now uses a local mirror. It downloads each binary once per version with 32 parallel `Range` requests, checks each sha256, and points the installer at it with `THREENATIVE_PREBUILT_MANIFEST`. A fresh install went from more than 10 minutes to 5.5 s. That fix lives outside this repository, so every other consumer still downloads on one connection.

On 2026-11-01 PRD-783 M6 measured 1 s for the 117.5 MiB engine player on this host. GitHub speed per connection changes by a factor of about 500 between days. Parallel ranges make the download time depend less on the speed of one connection.

Files inspected:

- `packages/runtime-native/scripts/install-prebuilt.mjs:352` — `downloadReleaseArtifact`: one `fetch(release.url)`, then `arrayBuffer()`, then `verifyChecksum` and a size check. The lock gives `size` and `sha256` for each artifact.
- Callers of `downloadReleaseArtifact`: `installPrebuilt` (desktop runtime, tools, engine player, `install-prebuilt.mjs:420-421`), `package-android.mjs:755`, `package-ios.mjs:597`. All native downloads go through this one function.

## Solution

Change only `downloadReleaseArtifact`. Keep its signature and its return value (a verified `Buffer`).

1. When the lock gives `release.size` above 8 MiB, split the file into a fixed number of byte ranges (start with 16; the measurement in AC-3 picks the final value) and fetch them in parallel with `Range: bytes=<start>-<end>`. Write each part at its offset in one `Buffer.allocUnsafe(release.size)`.
2. Each part must answer `206` with a body of exactly the requested length. A `200` answer means the server ignores ranges: accept that one body as the whole file and cancel the other requests. Any other status fails the download with an error that names the key, the URL and the byte range.
3. After all parts arrive, run the existing `verifyChecksum` and size check unchanged. The sha256 check over the whole file stays the only trust decision.
4. A file of 8 MiB or less, or a lock with no `size`, uses today's single `fetch`.

Memory use does not change: today the function already holds the whole file in memory.

Reused: the lock `size` and `sha256` fields, `verifyChecksum`, the loopback fixture server and `THREENATIVE_ALLOW_INSECURE_PREBUILT=1` from `tests/distribution.test.mjs`.

Risks:

- GitHub redirects a release asset to a signed object-storage URL. Each range request follows the redirect again. The downstream mirror proved that ranges work on that path (32 parts, 5.5 s). AC-3 runs it again from this repository.
- More connections give more chances for one to fail. This PRD adds no retry: one failed part fails the download with a named error (see Decisions).

## Non-Goals

- Removing the download from `pnpm install`. That is PRD-783.
- Stripping or compressing the release binaries (PRD-783 follow-up 1).
- A shared per-user cache or a mirror server inside this repository.
- Removing the downstream mirror. Its owning repository decides that after this PRD ships.

## Acceptance Criteria

- [x] AC-1 [local]: A loopback server that supports ranges receives N parallel range requests for a file above 8 MiB, and `downloadReleaseArtifact` returns the exact bytes. A server that ignores ranges (answers `200`) still gives the exact bytes. proof: `pnpm --filter @threenative/runtime-native exec node --test tests/distribution.test.mjs` — new cases; red first: the request-count assertion fails on today's single `fetch`. — Evidence: done 2026-11-19. The proof command in this box names `node --test`, but this file is a vitest suite (`import { test } from "vitest"`), so the runner is `vitest run tests/distribution.test.mjs`. New case "a large release asset downloads as parallel byte ranges and assembles exactly": a 9 MiB fixture with a per-4 KiB pattern, 16 requests observed, every one a distinct `bytes=<start>-<end>`, assembled bytes equal to the release. New case "a server that ignores Range still yields the exact bytes from one body": every request answered `200`, the assembled bytes equal the release, and the siblings are aborted once the whole body arrives, so the file is not downloaded 16 times. Red control: on `origin/develop` the same fixture records **1** request with no `Range` header, which is exactly the assertion that fails.
- [x] AC-2 [local]: One corrupt part fails with the existing `Checksum verification failed` error, and one part that answers `500` fails with an error that names the key and the byte range. No binary and no `ok: true` status stays on disk after either failure. proof: same command, new cases. — Evidence: done 2026-11-19. "a corrupt range fails at the checksum, and no binary or success status is left behind": the second range's first byte is flipped, `installPrebuilt` rejects with `/Checksum verification failed/`, the output file does not exist and the recorded status is `ok: false`. "a range that answers 500 fails closed naming the key and the byte range": rejects with `/linux-x64.*HTTP 500 for byte range \d+-\d+/`. The existing failure-case texts are unchanged: the 64 cases of `distribution.test.mjs` that do not need `pnpm pack` still pass.
- [ ] AC-3 [local]: Against the real GitHub release on this host, in the same time window, 3 paired runs of the engine-player download (old function against new function) show the new function at least 4 times faster, or both under 10 s. The parallel count that gives the result is recorded in `## Decisions`. proof: `node` script in the scratchpad that imports both versions of `downloadReleaseArtifact` for the published `linux-x64-engine-player` key and prints seconds per run. — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Parallel range download of a native binary | `installPrebuilt` (install script today, first desktop build after PRD-783), `package-android.mjs:755`, `package-ios.mjs:597` → `downloadReleaseArtifact` (`install-prebuilt.mjs:352`) | The single `fetch` stays only for files of 8 MiB or less and for locks with no `size` | AC-1, AC-3 |

## Decisions

- 2026-11-18 (PRD author): No retry for a failed part. Reason: no AC needs it, and a retry hides a bad server. Add one when a measured run fails on one part.
- 2026-11-18 (PRD author): A separate PRD from PRD-783, not new boxes in it. Reason: PRD-783 already has 9 boxes, and download speed is independent of download timing.

## Execution Phases

#### Phase 1: The download uses parallel ranges and still checks every byte
**Status:** DONE (2026-11-19)
**Files:** `packages/runtime-native/scripts/install-prebuilt.mjs` (`downloadReleaseArtifact`), `packages/runtime-native/tests/distribution.test.mjs` (new cases).
**Implementation:** Write the AC-1 and AC-2 cases first and see them fail. Then change `downloadReleaseArtifact` as the Solution says. Keep error text for the existing failure cases unchanged, because other tests match it.
- [x] AC-1 and AC-2 pass, and the existing `distribution.test.mjs` cases still pass. Ticked with the evidence above. proof: `pnpm --filter @threenative/runtime-native exec node --test tests/distribution.test.mjs` — Evidence: pending.

#### Phase 2: The real release downloads faster
**Status:** NOT STARTED
**Files:** none in the repository. The timing script stays in the scratchpad.
**Implementation:** Run AC-3. Pick the parallel count from the measurement and write it into `## Decisions`. If the new function is not faster on the real release, record the numbers and stop. Do not tune against one run.
- [ ] AC-3 passes on the real GitHub release. proof: the timing script, 3 paired runs — Evidence: pending.
