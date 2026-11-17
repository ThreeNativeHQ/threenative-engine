# PRD-898 — The upgrade proof runs on the release pull request, before the merge

**Status:** NOT STARTED
**Priority:** P1 — today the proof that decides whether a release may ship runs only after the merge, so a red proof costs a merged develop and a spent release slot; the 0.3.15 candidate is red for a server timeout nobody saw until the ship job.
**Complexity:** 6 (MEDIUM)
**Owner:** CI tooling
**Depends on:** PRD-896, PRD-897

## Context

`pnpm release --prove-upgrade` (PRD-896) proves the previous registry `latest` upgrades onto the
packed candidate, publishing nothing. It exists, and `release:ship` runs it before the tag — but
**only after the merge**, inside `npm-release.yml`'s `ship` job. So every upgrade regression is still
found on `main`, where the answer costs a merged develop, a release slot and an hour of evidence and
release-candidate work (`proveUpgradeFromLatest`, `scripts/release.ts`).

The proof can run on the release pull request's board instead: it packs from that tree and installs
the previous `latest` around it, so nothing it needs has to be tagged or public. Two facts settle
that it is possible: installing a candidate `runtime-native` tarball before its release exists only
warns (`PREBUILT_RELEASE_MISSING`, `packages/runtime-native/scripts/install-prebuilt.mjs`), and the
proof claims the web lane.

Two blockers are owned by PRD-896's sibling work on the release branch, not by this PRD:

- the clean room cooks the starter's assets cold (~21 s) against `--server-timeout`'s 15 s default,
  which is `TN_PLAYTEST_SERVER_FAILED`; `scripts/verify-registry-install.ts` is getting
  `--server-timeout 120000`;
- the reinvention lint rows (2026-11-13) reject 0.3.13-generated code; `create-threenative`'s
  `qualityConfig` is getting an opt-in `reinventions` flag.

Until both land, a board job running this proof would be red for reasons that belong to that
branch's diff, which is the one thing a required check must never do.

### Phase 1 — the lane exists and is cheap enough to run on tag day

- [ ] `ci.yml` gains one job, gated on `github.base_ref == 'main'`, that builds the workspace, prepares the native runtime dependencies and runs `pnpm release --prove-upgrade --skip-gates` against the pull request's tree, publishing nothing. proof: a green run of that job on a develop -> main pull request.
- [ ] Its wall time is measured and recorded, with the build restored from the shared artifact rather than repeated. proof: the job's timing in the pull request's run, beside the target of at most 45 minutes.

### Phase 2 — the board actually needs it

- [ ] `scripts/ci-change-scope.mjs` marks the job required for a pull request into `main`, and `ci-required` rejects a run where it is missing, skipped or cancelled — the same fail-closed rule the other required jobs get. proof: `scripts/__tests__/ci-needs.spec.ts` and `ci-required` cases, plus a deliberate skip on a scratch pull request that goes red.
- [ ] A red proof turns the pull request red with the proof's own report attached as an artifact, so the author sees which template and which step failed without opening the release lane. proof: one scratch branch that breaks a template pin, whose run is red and carries the report.

### Phase 3 — no second bill on tag day

- [ ] `release:ship` keeps its pre-tag proof (PRD-896) but reuses the board's green one when its commit is the merge commit the board proved, instead of proving twice. proof: `scripts/__tests__/release-ship.spec.ts`, and one release whose ship job skips the proof with a line naming the board run.

## Acceptance criteria

- [ ] The next develop -> main release pull request runs the upgrade proof before the merge, and an upgrade regression is red on the pull request, not on `main`. proof: the first release pull request opened after this lands — unrun, so this box stays open.

## Decisions

- 2026-11-16 (agent): filed as **the follow-up PRD** the orchestrator asked for on 2026-11-16
  ("If it can run on the develop -> main release PR board ... add it there; otherwise put it in the
  follow-up PRD"), and not built inside PRD-896, because
  the job is a new lane with a full build, a browser and the native dependencies — minutes of setup
  that no unit test can prove — and because the two failures it would surface today are being fixed
  on the release branch (`scripts/verify-registry-install.ts`, `create-threenative`'s
  `qualityConfig`), which this work may not edit.

## Blocked on

- The release branch's two fixes landing: the clean room's server timeout and the reinvention lint
  rows.
