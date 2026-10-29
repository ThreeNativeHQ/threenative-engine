# Self-hosted CI runners (`tn-local`)

Linux CI jobs can run on one owner machine instead of GitHub's hosted runners. Hosted runners stay the
fallback for everything, so **contributors need none of this**: a clone, a fork or a pull request works
the same with or without it. The design and its measurements are in
[PRD-480](../../docs/PRDs/CI/PRD-480-linux-ci-runs-on-the-owner-machine.md).

## How routing works

CPU-heavy Linux jobs pick their runner from one expression, gated on a canonical instance id:

```yaml
runs-on: ${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER || !contains(fromJSON(needs.scope.outputs.runner_admission || '[]'), 'ci:typecheck')) && 'ubuntu-24.04' || vars.TN_RUNNER }}
```

- `TN_RUNNER` (repository variable) set to `tn-local` → the job can run on this pool. Unset → hosted.
- `TN_RUNNER_SLOTS` (repository variable) is the number of heavy runners the balancer saw idle. The
  `scope` job admits at most that many eligible heavy instances and publishes the one admitted array
  (`runner_admission`). A job runs on the pool only when its own id (`ci:typecheck`, `integration:csg`,
  `native:starter-linux:linux-x64`, …) is in the array; anything else stays hosted.
- The array is one shared budget for `ci.yml`, `integration.yml` and `native-platforms.yml` together,
  never one budget per workflow. A missing count, an unset runner or a fork PR leaves the array empty,
  so CPU-heavy lanes stay hosted.
- A pull request from a fork always runs hosted, so outside code never reaches the machine. The fork
  and missing-runner guards stay in every heavy selector, even if a supplied plan is malformed.
- A malformed nonempty count or plan fails the `scope` job closed instead of routing a partial board.
- Optional `TN_RUNNER_GPU` names a separately provisioned, isolated hardware-GPU runner. Only
  `strata`, `benchmark`, and the Racing `template-nonvisual` row use it; forks stay hosted.
  `TN_RUNNER_GPU_HEAD` optionally pins that route to one pull-request head SHA. When set, the GPU
  label is selected only when `github.event.pull_request.head.sha` matches; an unset pin preserves
  the ordinary configured route. Non-pull-request events and mismatched heads fall through to the
  unchanged CPU admission/hosted route. These instances do not consume `TN_RUNNER_SLOTS` while GPU
  routing is effective for that head/event. The existing pool and balancer do not manage these
  variables or runner.
  For a temporary run, set `TN_RUNNER_GPU_HEAD` first and `TN_RUNNER_GPU` second, before creating the
  ready PR run. Verify that the exact run attempt has queued all intended GPU jobs on the expected
  label. Restore the prior `TN_RUNNER_GPU` state first and the prior `TN_RUNNER_GPU_HEAD` state
  second after labels are fixed, before registering the runner; delete a variable that was absent
  beforehand. An existing run created from an older workflow revision has no pin guard, so inventory
  it separately. A head pin does not replace exact run/attempt and label preflight. For shared
  desktop qualification, wrap each complete GPU job in the host capture lease; a container-local
  lock cannot coordinate a different PID namespace. Coordinate other hardware captures through
  that same host lease.
- Small join jobs (`scope`, `ci-required`, summaries) use `TN_RUNNER_LIGHT` the same way, so they never
  queue behind a 20-minute build.
- macOS, Windows, iOS and linux-arm64 have no local counterpart and always run hosted.
- `supply-chain` always runs hosted: it drives Docker, which would need the host socket.
- The Android emulator lane always runs hosted (measured slower on a local slot).
- V8 payload publishers (`publish-android-v8`, `publish-linux-arm64-v8`) always run hosted:
  they hold `contents: write`, which pool containers never receive.
- Every other Linux job routes to idle tn-local first (PRD-620), with hosted fallback.

**The pool is extra capacity, not a replacement.** This repository is public, so hosted runners are free
and run about 20 jobs at once, against 3 heavy plus 3 light pool slots. A balancer (`ci-runners.sh balance`, started by `up`) advertises each
label only after 2 consecutive polls (~40 s) see an idle runner, and withdraws it immediately when
none is idle. It publishes `TN_RUNNER_SLOTS` before the label turns on and removes it after the label
turns off, so a consumer never reads the label without its integer capacity.

The count and the variable snapshot are best-effort, not an atomic reservation. A pool slot can be
taken by another run between the snapshot and the job's start, and a stale or cross-run plan can name a
slot that is no longer free; the overflow then waits on the pool rather than failing over to hosted at
once. There is no per-job failover and no queued-job reassignment. Fork pull requests and macOS,
Windows, iOS, linux-arm64, `supply-chain`, emulator, and V8 publisher jobs always run hosted. Routing
every Linux job here without a budget funnelled the team's CI into 5 slots and made boards slower.
`down` stops the balancer and clears `TN_RUNNER`, `TN_RUNNER_SLOTS` and `TN_RUNNER_LIGHT`, so a pool
that is down never strands a job.

## Set it up (once, on the runner machine)

Needs: Linux with systemd, Docker usable without `sudo`, `gh` logged in with admin rights on the repo,
and enough cores for the slots (3 whole physical cores each; 2 whole cores stay free for the desktop).

1. Create a fine-grained token for this repository only, with **Administration: Read and write**. It
   mints runner registration tokens. Add **Variables: Read and write** too if the pool must also start
   before anyone logs in (see Troubleshooting).
2. Store it outside the repository, readable only by you:

   ```sh
   mkdir -p ~/.config/threenative
   printf 'RUNNER_ADMIN_TOKEN=%s\n' '<token>' > ~/.config/threenative/runners.env
   chmod 600 ~/.config/threenative/runners.env
   ```

3. In the repository settings, set Actions → General → "Fork pull request workflows from outside
   collaborators" to **Require approval for all outside collaborators**.
4. Install:

   ```sh
   pnpm ci:runners:install
   ```

   It checks the prerequisites and creates `.worktrees/ci-runners` (a checkout the service owns). It
   then installs and starts a systemd user service, `threenative-ci-runners`, enabling lingering so the
   service starts at boot. The pool comes up and the variables are set. Nothing else to run, now or
   after a reboot.

## Day to day

`bash scripts/ci-runners.sh plan [N]` prints the CPU allocation without credentials or mutations.
It groups actual socket/core identities and refuses restricted inherited affinity or insufficient
whole cores. Activation uses the existing service restart only after the pool is drained and the
reviewed script is on `develop`; a restart cancels active jobs.

| Want | Run |
|---|---|
| What is running, what is routed | `pnpm ci:runners status` (balancer log: `~/.local/state/threenative/ci-runners/balance.log`) |
| Pick up a runner image or script change from `develop` | `systemctl --user restart threenative-ci-runners` (when no job is running; a restart kills in-flight jobs) |
| Send CPU and join jobs to hosted runners now | `gh variable delete TN_RUNNER && gh variable delete TN_RUNNER_SLOTS && gh variable delete TN_RUNNER_LIGHT` |
| Retire the separate GPU route | `gh variable delete TN_RUNNER_GPU` then `gh variable delete TN_RUNNER_GPU_HEAD` before stopping its owned runner |
| Stop the pool | `systemctl --user stop threenative-ci-runners` |
| Remove everything | `pnpm ci:runners uninstall` |
| Run without the service (any OS with Docker) | `pnpm ci:runners up [N]` / `pnpm ci:runners down` |

Every start re-checks out the latest `develop`, so fixes to `tools/ci-runners/` deploy on the next
restart or reboot.

## What a slot is

- An ephemeral container per job (`docker run --rm`): fresh filesystem, fresh hostname, no state
  shared between jobs. The image is Ubuntu 24.04 plus what hosted `ubuntu-24.04` jobs rely on: Node 20,
  `gh`, Rust, JDK 17, Android SDK and platform-tools, build tools, Xvfb and Playwright's dependencies.
- 3 heavy slots of 3 whole physical cores each (6 threads on a two-way SMT host), with 9 GB of memory
  and no extra swap. Sibling threads stay in one slot. This halves job concurrency while keeping the
  heavy pool's total CPU allocation; compare board throughput after activation.
- 3 light slots: 1 CPU quota and 2 GB each, sharing a separate physical core, for joins only.
  These three slots contend for two logical CPUs on a two-way SMT host. One slot serialised every pull request's scope and
  verdict, because an ephemeral runner takes 30-60 s to re-register after each job.
- The admin token mints one registration token per container and is unset before the job starts, so no
  job can read it.

## Troubleshooting

- **The pool did not come up after a reboot.** `gh` may keep its token in a desktop keyring that stays
  locked until you log in. The service retries every minute and comes up at login; until then jobs run
  hosted. For starts before login, give the runner token Variables write (step 1).
- **Jobs are stuck "Waiting for a runner" with the machine off.** The machine went down without a clean
  stop (power loss, crash), so `TN_RUNNER` is still set. Run the kill switch above, or boot the machine.
- **A template lane fails with a capture or GPU-device error.** `tower-defense` and `rain` are known
  flaky on both pools (see `docs/PRDs/CI/EXECUTION-ORDER.md`). Rerun the failed jobs once.
- **The runner list shows offline `tn-*` runners.** Runners stopped while idle stay registered. `up` and
  `down` delete them.
- **Timing.** The pool adds 3 heavy slots plus 3 light slots to hosted's ~20; with several boards in flight both pools
  saturate, and wall time follows total demand.
