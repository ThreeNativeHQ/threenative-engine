---
prd_contract: v1
---

# PRD-480 — Linux CI runs on the owner's machine

**Status:** PARTIAL — phases 1 and 3 verified (#404, #410); AC-1 green; AC-2 measured, needs the owner's call
**Priority:** P1 — AC-2 open: prove queue waiting time meets budget; runs waited up to 239 minutes.
**Complexity:** 5 (HIGH)
**Owner:** CI tooling
**Depends on:** None

Complexity: 5 → MEDIUM (about 8 files +2, new system +2, GitHub runner API +1); risk override → HIGH because a
public repository gains a code-execution path onto a private machine.

## Context

CI's critical path is the queue, not the work. On 2026-10-02 the runs were:

| Run | Job work | Waiting for a runner | Longest wait for one job |
|---|---|---|---|
| 37043413533 (PRD-475 PR) | 146 min | 239 min | 19.3 min |
| 37047989282 (`develop` PR) | 266 min | 127 min | 17.6 min |

`ThreeNativeHQ/threenative` is public and has 0 self-hosted runners. Every job therefore shares
the org's hosted concurrency cap with every other open PR. A full board is about 45 jobs. The branch-local
`integration-*.yml` workflows (decals, exposure, exposure cold boot, …) started 124 runs since
2026-10-01, against 72 `CI` runs, and they draw on the same pool.

Job setup is already cheap (install 4 s, `workspace-dist` 81 s), so trimming jobs moves little. The
pool size is the lever. [PRD-380](PRD-380-a-pull-request-never-starves-the-runner-pool.md) narrows what a
PR spends runners on. This PRD adds runners.

Files inspected: `.github/workflows/ci.yml` (19 Linux `runs-on`), `.github/workflows/native-platforms.yml`
(Linux jobs plus `macos-15`, `windows-2025`, `ubuntu-24.04-arm`), `.github/workflows/integration-*.yml`,
`.github/actions/playwright-chromium/action.yml` (`--with-deps` runs apt), `scripts/ci-local.sh`,
`scripts/__tests__/ci-structure.spec.ts`.

## Solution

Ephemeral GitHub Actions runners run in Ubuntu 24.04 containers on the owner's machine, registered
**to this repository only** with the label `tn-local`. Every Linux job that can move picks its runner
from one expression:

```yaml
runs-on: ${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER) && 'ubuntu-24.04' || vars.TN_RUNNER }}
```

- **Kill switch:** delete the `TN_RUNNER` repository variable and every job goes back to hosted
  runners. `scripts/ci-runners.sh up` sets `TN_RUNNER` after the runners come online, and `down` clears it
  before they stop. After a crash or power loss, recover with `gh variable delete TN_RUNNER`.
- **Fork guard:** a PR from a fork always runs on hosted runners and never reaches the machine.
- **Same verdicts, no caching:** the job still runs inside the workflow, on a fresh checkout of the
  candidate SHA, and `ci-required` is unchanged. The rule "Never cache test verdicts" stands.
- **One full run per candidate:** while `TN_RUNNER` is set, agents run only the focused checks for what
  they changed (the touched spec, the affected playtest), then push. The full board runs once, on
  `tn-local`. Today the agent runs `pnpm test` or `pnpm ci:local --full` here, then CI repeats the same
  board, so this removes the duplicate. With `TN_RUNNER` unset, CI is hosted and slow again, and the
  local full run before pushing comes back.
- **Comparable timing:** each container is pinned (`--cpuset-cpus`) to two whole cores, four threads,
  the CPU shape of a hosted `ubuntu-24.04` runner, so `nproc` reads 4 and every worker pool sizes itself
  to that. A `--cpus 4` quota is not enough: `nproc` still reads every host CPU and vitest ran 8 workers
  in a 4-core budget. This is a controlled starting point, not a promise of identical timing.
- **Host stays stable:** five slots by default, and two cores are never given to a slot. Each slot gets
  `--memory 12g --memory-swap 12g --oom-score-adj 800`, so under memory pressure the kernel kills a CI
  job before the owner's processes.
- **Light lane:** `scope`, `ci-required`, `run-summary` and other small joins run on one more,
  unpinned `tn-local-light` runner (`--cpus 1`, 2 GB) that heavy jobs never select. Otherwise a 20-minute
  build on every heavy slot holds a 10-second join in the queue.
- **Runs itself:** the operator installs `scripts/ci-runners.sh up`/`down` as a boot service (a user
  service with lingering on Linux) that first checks out the latest `develop`. So the pool starts with
  the machine, takes image fixes on the next start, and clears `TN_RUNNER` on shutdown. `up` and `down`
  also delete offline `tn-local*` registrations: an idle runner that is stopped never deregisters.
  `pnpm ci:runners:install` does the whole setup; the operator guide is
  [tools/ci-runners/README.md](../../../tools/ci-runners/README.md).
- **Ephemeral:** each container takes one job, exits and is recreated by a host-side `docker run --rm`
  loop. No `/tmp`, port, Xvfb display or workspace state crosses jobs.

**Stays hosted:** `native-platforms` macOS, Windows, iOS and `linux-arm64` legs; the `supply-chain`
job (its gitleaks step needs `docker run`, and mounting the Docker socket would give jobs root on the
host); release workflows; `site-docs`.

```mermaid
flowchart LR
  E[PR push / dispatch] --> X{fork PR or<br/>TN_RUNNER unset?}
  X -- yes --> H[hosted ubuntu-24.04]
  X -- no --> L[tn-local container<br/>4 CPU / 16 GB, ephemeral]
  L --> R[ci-required]
  H --> R
  E --> N[macOS / Windows / iOS / arm64] --> H
```

**Image:** `ghcr.io/actions/actions-runner` (Ubuntu 24.04 base with passwordless sudo) plus what the
moving jobs take from the hosted image: build-essential, cmake, ninja, ccache, clang, xvfb, and the
Playwright Chromium system dependencies. Phase 3 adds JDK 17, the Android SDK and emulator, with
`/dev/kvm` passed through.

**Credential:** ephemeral runners re-register for every job, so the stack mints registration
tokens with an owner-supplied fine-grained token (this repository, "Administration: read & write").
The token lives in an untracked env file outside the repo and is never printed.

**Risks:** a timing-shaped test that passes or fails only under the 4-CPU cap. Shared host disk filling
from container layers (see the btrfs and tmpfs notes in the owner's memory). The machine sleeping
while `TN_RUNNER` is set: jobs queue until the switch is cleared.

## Acceptance Criteria

- [x] AC-1 [shared]: proof: CI run id plus `runner_name` per job from `gh api …/runs/<id>/jobs`. A non-draft
  PR's `CI` run executes every Linux job except `supply-chain` on a `tn-local` runner, and `ci-required`
  passes. Evidence: pending.
  Evidence: CI run 37070815769 (PR #404, head 94732de65, 2026-10-02): conclusion success, `ci-required` success. 39 jobs succeeded: 33 on `tn-local`, 5 on `tn-local-light`, 1 hosted (`supply-chain`); `native-platforms` skipped by scope.
- [ ] AC-2 [shared]: proof: per-job `started_at − created_at` summed with the baseline's script. Total time
  jobs spent waiting for a runner on a full-board PR drops below 60 min (baseline 239 min, run
  37043413533). Measured, not met: run 37070815769 waited 317 min in total across 40 jobs on 5 heavy +
  1 light slots, with 42 min wall against the baseline's 39 min wall and zero hosted minutes. A 40-job board on
  six slots queues by construction, so this criterion needs either more slots or overflow to hosted
  runners. Owner decision pending.

## Blocked on

- Fork PR workflow approval set to "Require approval for all outside collaborators" (the API reads
  `first_time_contributors` on 2026-10-02; it must read `all_external_contributors`) — unblocked by João.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Linux CI job runs on the owner's machine | PR push → `ci.yml` job `runs-on` expression → `tn-local` container; fill `file:line` | Hosted `ubuntu-*` stays as the fallback branch of the same expression | AC-1 |
| Runner lifecycle and kill switch | `scripts/ci-runners.sh up/down` → compose stack + `TN_RUNNER` variable | New | Phase 1 |

## Decisions

- 2026-10-03 (measured): the pool is overflow capacity, not the default. The repository is public, so
  hosted runners cost nothing and run ~20 jobs at once; routing every Linux job to 5 local slots made
  boards slower (run 37099132853: 20 min in, 15 jobs queued locally). A balancer advertises
  `TN_RUNNER`/`TN_RUNNER_LIGHT` only while a runner is idle (two polls in a row) and withdraws them at once
  when none is.

- 2026-10-02 (João, during the first live runs): use more of the machine, but never at the cost of
  desktop stability. Five pinned slots of two cores each, two cores reserved for the host, 12 GB caps
  with CI as the OOM victim, and a reserved light lane (review by Astra the same day).

- 2026-10-02 (João): the runner registration token exists. It is a fine-grained token on
  `ThreeNativeHQ/threenative` only, with Administration read & write, stored in the operator's untracked
  runner env file. Verified by listing the repository's runners (0).

- 2026-10-02 (João): self-hosted runners rather than local runs vouching for a commit. A self-hosted
  runner gives the same offload with no forgeable status and no stale merge-ref verdict, and it keeps
  "Never cache test verdicts".
- 2026-10-02 (João): the cost is accepted. Actions minutes on public repositories stay free on
  self-hosted runners; GitHub's announced $0.002/min self-hosted charge is postponed and exempted
  public repos.
- 2026-10-02 (João): the runner must also remove the duplicate run, not only the queue. Agents stop
  running the full board locally while `TN_RUNNER` is set. Skipping a CI job because an identical tree
  already passed it would break "Never cache test verdicts", so it is out of scope; it would be its own PRD.

## Execution Phases

#### Phase 1: The runner stack comes up and takes jobs
**Status:** COMPLETE — `pnpm ci:runners:install` runs it as a boot service
**Files:** NEW `tools/ci-runners/Dockerfile`, NEW `tools/ci-runners/entrypoint.sh`, NEW
`scripts/ci-runners.sh` (`up [N]`, `down`, `status`; default N = 4, read from the env file).

Deviation from the plan below, owner-approved 2026-10-02: **no compose.yml.** A host-side loop of
`docker run --rm` replaces the compose service, because `restart: always` restarts the *same*
container — same filesystem, same hostname — and the ephemeral claim here is a fresh one of both
per job.

**Implementation:** Ubuntu 24.04 runner image with the tool set above. One loop per slot
(`setsid nohup`), `cpus 4`, `memory 16g`, and ephemeral repo-scoped registration with labels
`tn-local`. `up` waits for N online runners via `gh api repos/{owner}/{repo}/actions/runners`
before `gh variable set TN_RUNNER --body tn-local`. `down` deletes the variable first, then stops
the stack. The script fails closed when the env file or token is missing.


- [x] `scripts/ci-runners.sh up` brings 4 runners online with label `tn-local`. proof:
  `scripts/ci-runners.sh status` lists 4 online runners. Evidence: 2026-10-02, `up` printed "4 online;
  TN_RUNNER=tn-local" and `status` listed tn-23e70acfd553, tn-365ab3636a2e, tn-4d83d32a4c75 and
  tn-6071a30e949e, all online. The first `up` timed out with 0 online (wrong WORKDIR), cleared the
  variable and stopped the pool, which is the fail-closed path working. Not started: `status` reports
  `TN_RUNNER=unset`, 0 containers, 0 online runners on 2026-10-02.
- [x] A runner container recreates itself after its job and keeps no state from it. proof: two
  consecutive dispatched jobs report different container hostnames and an empty `/tmp`.
  Not started: the image's `/tmp` is empty in a fresh container (`ls -A /tmp | wc -l` → 0), which
  is one container's worth of the claim.
  Evidence: CI run 37070815769 (PR #404, head 94732de65, 2026-10-02): 38 `tn-local*` jobs ran on 38 distinct runner names (`tn-<container id>`) from 6 slots, so every job got a fresh container; each starts from the image, whose `/tmp` is empty (`ls -A /tmp | wc -l` = 0 in the smoke).

#### Phase 2: `ci.yml` and the integration workflows route through the switch

**Status:** COMPLETE
**Files:** EDIT `.github/workflows/ci.yml`, `.github/workflows/integration-*.yml`,
`scripts/__tests__/ci-structure.spec.ts`; the `integration-*.yml` template wherever agents copy it from;
`AGENTS.md` ("Nearest lane first, CI last") plus its regenerated `CLAUDE.md` mirror.
**Implementation:** Replace each movable Linux `runs-on` with the routing expression. `supply-chain` keeps
`ubuntu-latest`. Extend `ci-structure.spec.ts` so every Linux job in these workflows either uses the
exact expression or is on a named hosted allow-list (`supply-chain`), and no macOS, Windows or arm64
job ever does. 23 lines routed (18 in `ci.yml`, one each in five `integration-*.yml`); `supply-chain`
and `integration-decals.yml`'s `ubuntu-24.04-arm` job are the only Linux `runs-on` left hosted, and
`native-platforms.yml` is untouched until Phase 3.

- [x] Structure spec enforces the routing. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts`
   — 142 passed, 0 failed. Red first: with no workflow edited the new test failed on
   `.github/workflows/ci.yml scope runs on 'runs-on: ubuntu-latest'`; after routing, setting `budgets`
   (ci.yml:1051) back to `ubuntu-latest` failed it again on that job and it was restored. Also green:
   `pnpm lint` (exit 0), `pnpm check:docs` (2496 links), `pnpm sync:agents --check` (22 mirrors).
   One pre-existing assertion had to be narrowed: `template-nonvisual` forbade the substring
   `pull_request` anywhere in the job, which the routing expression mentions without gating on it.

- [x] With `TN_RUNNER` set, a PR run lands its Linux jobs on `tn-local`. proof: AC-1 run.
  Evidence: CI run 37070815769 (PR #404, head 94732de65, 2026-10-02), as AC-1.
- [x] `AGENTS.md` says focused checks then push, not the full board, while `TN_RUNNER` is set. proof:
  `pnpm sync:agents --check` and `pnpm exec vitest run scripts/__tests__/sync-agent-docs.spec.ts` pass.
  Land it only after the AC-1 run is green.
  Evidence: landed after AC-1; `pnpm sync:agents` + sync-agent-docs, primary-docs and instruction-budget specs, 24 passed (2026-10-02).
- [x] Light jobs never wait behind heavy ones (proof: `ci-structure.spec.ts` case, plus a full-board run
  whose `ci-required` starts within 60 s of its last `needs` finishing): `scope`, `golden-path`, `build`,
  `ci-required` and `run-summary` route to `tn-local-light`, and no heavy job can.
  Evidence: ci-structure.spec.ts routing case (red with `typecheck` on the light lane), and CI run 37070815769 (PR #404, head 94732de65, 2026-10-02): `ci-required` started 22:48:50Z, 3 s after the last job it needs finished at 22:48:47Z.
- [x] With `TN_RUNNER` unset, the same workflow runs fully hosted. proof: `workflow_dispatch` run id with
  every `runner_name` hosted.
  Evidence: `workflow_dispatch` run 37093694594 on `develop` with both variables deleted: all 43 jobs that started
  ran hosted (38 `ubuntu-24.04`, 1 `ubuntu-latest`, 1 arm64, 2 macOS, 1 Windows), none on `tn-local`. Cancelled
  after that proof so it would stop holding the hosted pool.

#### Phase 3: The Linux `native-platforms` legs move too

**Status:** COMPLETE — Linux legs on `tn-local`; the Android emulator stays hosted (measured exception)
**Files:** EDIT `.github/workflows/native-platforms.yml`, `tools/ci-runners/Dockerfile` (JDK 17, Android
SDK, emulator, `/dev/kvm`), `scripts/__tests__/ci-structure.spec.ts`.
**Implementation:** Route `web-reference`, `desktop-parity`, `android-emulator-parity`, `release-reports`,
the remaining `ubuntu-24.04` jobs and the `linux-x64` rows of the `desktop` and `starter-linux` matrices.
Keep `macos-15`, `windows-2025`, `ubuntu-24.04-arm` and `ios-simulator` hosted. The `android-emulator-runner`
action needs `/dev/kvm` access inside the container.

Decisions this phase had to make, 2026-10-02:

- **`publish-android-v8` stays hosted.** It is the release write itself — `permissions: contents: write`
  and a `gh release upload` — and no pool container is handed a token that can publish.
  `android-v8-source` does move: it needs no secret, it is a published-asset download on every run but
  a cold one, and its own action records a two-core cold build finishing inside the 210-minute ceiling,
  which is this pool's slot shape.
- **Light lane: `scope` and `networking-matrix` only.** Both are a script with no `pnpm install` and no
  toolchain. `performance-coverage` and `release-reports` are joins too, but each installs the workspace
  and `performance-coverage` has a five-minute ceiling, so they take a heavy slot.
- **`desktop` has no Linux row.** Its matrix is `macOS` and `Windows` only; the movable Linux matrix row
  is `starter-linux/linux-x64`.
- **The KVM step had to stop asserting udev.** In the container there is no udev and `/sys` is read-only,
  so `udevadm control --reload-rules` and `udevadm trigger` both exit 1 and took the whole emulator lane
  with them. They are now `|| true`, which is what the step's own "report the mode, never assert it"
  rule already says; `scripts/ci-runners.sh` passes `--device /dev/kvm` and the image's entrypoint sets
  the node's mode before the job can read it.
- **The image carries the pinned SDK, not the emulator.** `cmdline-tools` 16.0 with licenses accepted,
  `platform-tools`, `platforms;android-35`, `platforms;android-36` (`compileSdk` in
  `android/app/build.gradle.kts`), `build-tools;35.0.0` and `ndk;28.2.13676358` (`ndkVersion` there,
  and what the workflows' own `sdkmanager` line installs), owned by `runner` because sdkmanager writes
  into `ANDROID_HOME` at job time. `android-emulator-runner` installs `emulator` and the system image
  itself, which is the only job that wants them. Image: 9.28 GB against the pool's 5.25 GB.

- [x] A `native-platforms` run passes with its Linux legs on `tn-local`. proof: run id plus per-job
  `runner_name`.
  Exception, measured: `android-emulator-parity` stays hosted. SwiftShader renders its GPU on the CPU, and on a
  4-thread slot run 37082733117 spent 41 of the job's 45 minutes still running APKs, where hosted takes ~30.
  Evidence: CI run 37089715252 (PR #404, merged d99a6281c), latest attempt: every native-platforms leg success.
  On `tn-local`: starter linux-x64, Android V8 source payload, web conformance reference, desktop web/native
  parity, release evidence reports, collector coverage. On `tn-local-light`: caller selection, networking
  matrix. Hosted as designed: macOS, Windows, iOS, linux-arm64, and the emulator exception above.
- [ ] Waiting time meets AC-2. proof: the AC-2 measurement on a full-board PR after this phase.
