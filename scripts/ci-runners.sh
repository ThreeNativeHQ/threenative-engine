#!/usr/bin/env bash
# The `tn-local` self-hosted runner pool (PRD-480).
#
#   scripts/ci-runners.sh up [N]   build the image, run N disposable heavy runner containers plus
#                                  one light one, then set the TN_RUNNER and TN_RUNNER_LIGHT
#                                  repository variables so the routing expressions in ci.yml and
#                                  integration-*.yml send Linux jobs here
#   scripts/ci-runners.sh down     clear both variables first, then stop everything
#   scripts/ci-runners.sh status   what is set, what is running, what is online, what is on disk
#   scripts/ci-runners.sh prune    drop dangling images, stale build cache and stopped containers
#   scripts/ci-runners.sh install  one-time operator setup: check prerequisites, create the runner
#                                  worktree, install and start a boot service (Linux, systemd user)
#   scripts/ci-runners.sh uninstall stop the service, clear the variables, remove service + worktree
#
# Operator guide: tools/ci-runners/README.md. Contributors need none of this.
#
# `down` deletes the variables before it stops anything, so the kill switch is the same command as
# the teardown: jobs go back to hosted runners the moment it is deleted, whether or not the
# containers are still there.
#
# The operator's token lives in an untracked env file outside the repository and is never printed.
# It reaches the containers only through `docker run --env-file`, and the container's entrypoint
# unsets it before `run.sh` starts, so no job ever sees it.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."

IMAGE=tn-ci-runner
LABEL=tn-local
LIGHT_LABEL=tn-local-light
VARIABLE=TN_RUNNER
SLOTS_VARIABLE=TN_RUNNER_SLOTS
LIGHT_VARIABLE=TN_RUNNER_LIGHT
ENV_FILE="${TN_RUNNERS_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/threenative/runners.env}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/threenative/ci-runners"
DEFAULT_SLOTS=3
CORES_PER_SLOT=3
LIGHT_CORES=1
# 3 x 9 GB heavy + 3 x 2 GB light caps the pool at 33 GB.
SLOT_MEMORY=9g
# Cores never given to a slot, so the owner's desktop stays responsive under a full board.
HOST_CORES=2
ONLINE_TIMEOUT_SECONDS=300
# The host's own disk floor. Below this the next image build, container layer or job checkout can hit
# ENOSPC, and a job fails as a mystery compile error instead of a disk report: on 2026-10-18 the
# laptop runner sat at 98-100% and `test-native` died with ENOSPC in runs 39168826685 and
# 39175816222. The pool withdraws its slots and prunes before a job can find out the hard way.
MIN_FREE_GB="${TN_RUNNER_MIN_FREE_GB:-20}"
# How stale a build-cache layer must be before `prune` may drop it. A rebuild of the runner image is
# seconds; the owner's own day-to-day use of this docker daemon is not CI's to evict.
PRUNE_UNTIL="${TN_RUNNER_PRUNE_UNTIL:-72h}"
# How often the balancer re-reads the runner list and the host's free space. Overridable because the
# disk pause is testable only if a poll is not 20 seconds long.
BALANCE_POLL_SECONDS="${TN_RUNNER_POLL_SECONDS:-20}"
# The three short join slots share a physical core, separate from heavy and host cores.
# Each retains a one-CPU quota, 2 GB, and the highest OOM score under memory pressure.
LIGHT_SHAPE="--cpus 1 --memory 2g --memory-swap 2g --oom-score-adj 900"
# Several light slots: an ephemeral runner needs 30-60 s to re-register after each job, and every
# board brings ~7 joins, so one light slot serialised every pull request's scope and verdict.
LIGHT_SLOTS=3
# `/dev/kvm` for the heavy slots, and only where the host has one: `android-emulator-parity` boots a
# checksum-locked APK under `reactivecircus/android-emulator-runner`, which reads the device for
# read and write and otherwise falls back to a software boot. No KVM, no flag — a host without it
# still runs the pool, just without hardware acceleration, which that lane already reports instead
# of asserting. The light lane never gets it: nothing it runs emulates anything.
KVM_SHAPE=""
if [ -e /dev/kvm ]; then
  KVM_SHAPE="--device /dev/kvm"
fi

fail() {
  local code="$1"
  shift
  printf 'TN_CI_RUNNERS: %s\n' "$*" >&2
  exit "$code"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail 2 "$1 is not on PATH"
}

# Fail closed before anything is built or started. A pool that came up without a token would
# register nothing and leave TN_RUNNER set for hosted jobs that never arrive.
load_config() {
  [ -n "$ENV_FILE" ] || fail 2 "TN_RUNNERS_ENV is empty"
  [ -f "$ENV_FILE" ] || fail 2 "no runner env file at $ENV_FILE; set TN_RUNNERS_ENV or create it with RUNNER_ADMIN_TOKEN=..."
  set -a
  # shellcheck disable=SC1090 # the operator's own untracked file
  . "$ENV_FILE"
  set +a
  # Read once for validation, then drop it: the token travels to the containers through
  # `--env-file`, never through this process's environment.
  [ -n "${RUNNER_ADMIN_TOKEN:-}" ] || fail 2 "RUNNER_ADMIN_TOKEN is unset or empty in $ENV_FILE"
  unset RUNNER_ADMIN_TOKEN
}

repo_name() {
  gh api 'repos/{owner}/{repo}' --jq .full_name 2>/dev/null \
    || fail 2 "gh could not resolve this checkout's owner/repo"
}

# One slot is a host-side loop, not a compose service: `docker run --rm` gives each job a fresh
# container filesystem and a fresh hostname, which `restart: always` on a long-lived container
# cannot. The loop is what makes the pool survive the exit. `shape` carries the docker resource
# flags word-split on purpose (there is no array to expand through `bash -c`), and `labels` is the
# one label the container registers with — `--no-default-labels` means that label is all it has.
start_slot() {
  local slot="$1" state="$2" env_file="$3" repo="$4" shape="$5" labels="$6"
  setsid nohup bash -c '
    while [ ! -e "$1/stop" ]; do
      docker run --rm \
        --label tn-ci-runner=1 \
        $4 \
        --env-file "$2" \
        -e TN_RUNNER_REPO="$3" \
        -e TN_RUNNER_LABELS="$5" \
        tn-ci-runner || sleep 10
    done
  ' _ "$state" "$env_file" "$repo" "$shape" "$labels" >"$state/$slot.log" 2>&1 &
  echo "$!" >"$state/$slot.pid"
}

stop_slots() {
  local pid_file
  for pid_file in "$STATE_DIR"/*.pid; do
    [ -f "$pid_file" ] || continue
    kill "$(cat "$pid_file")" 2>/dev/null || true
  done
  # No `rm -rf` anywhere near a path built from a variable: the stop file is what stops the loops.
  : >"$STATE_DIR/stop"
  docker ps -q --filter label=tn-ci-runner=1 | xargs -r docker stop
}

# A runner stopped while idle stays registered offline forever: ephemeral runners deregister only
# after taking a job. Delete those so the runner list shows real capacity.
forget_offline() {
  gh api "repos/$1/actions/runners" --paginate --jq \
    '.runners[] | select(.status == "offline") | select(any(.labels[]; .name | startswith("tn-local"))) | .id' \
    2>/dev/null | while read -r id; do
      gh api -X DELETE "repos/$1/actions/runners/$id" >/dev/null 2>&1 || true
    done
}

online_count() {
  gh api "repos/$1/actions/runners" --paginate --jq "
    [.runners[] | select(.status == \"online\") | select(any(.labels[]; .name == \"$2\"))] | length
  " 2>/dev/null || echo 0
}

# The filesystem the docker daemon actually fills: dangling images, layer cache and stopped
# containers all land there, which is not always the checkout's filesystem.
disk_path() {
  local root
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || root=""
  printf '%s\n' "${root:-${HOME:-/}}"
}

# Whole GB free, so the floor reads the same on every host and in every log line. Fails when the
# filesystem cannot be read at all, because an unanswerable `df` is not "0 GB free".
free_gb() {
  df -Pk "$1" | awk '
    NR == 2 && $4 ~ /^[0-9]+$/ { printf "%d\n", $4 / 1048576; measured = 1 }
    END { exit measured ? 0 : 1 }'
}

# Free space for the routing decision, or the floor when the filesystem cannot be read: an
# unanswerable `df` must not read as "0 GB free" and pause every slot. Says which of the two it was.
free_gb_or_floor() {
  local disk="$1" free
  if free="$(free_gb "$disk" 2>/dev/null)"; then
    printf '%s\n' "$free"
    return 0
  fi
  printf '%s cannot read free space on %s; keeping the current routing\n' \
    "$(date -u +%H:%M:%S)" "$disk" >&2
  printf '%s\n' "$MIN_FREE_GB"
}

# What `prune` removes: layers no image references, build cache older than PRUNE_UNTIL, and
# containers a killed loop left behind. Never a tagged image in use, never a running container.
prune() {
  need docker
  docker info >/dev/null 2>&1 || fail 2 "docker is not usable without sudo; add ${USER:-$(id -un)} to the docker group and log in again"
  local before after
  # The two numbers below are the report, not a decision: a host whose `df` fails still prunes.
  before="$(free_gb "$(disk_path)")" || before="?"
  docker image prune --force >/dev/null
  docker builder prune --force --filter "until=$PRUNE_UNTIL" >/dev/null
  docker container prune --force --filter label=tn-ci-runner=1 >/dev/null
  after="$(free_gb "$(disk_path)")" || after="?"
  mkdir -p "$STATE_DIR"
  date +%s >"$STATE_DIR/last-prune"
  printf 'prune: %s GB -> %s GB free on %s (floor %s GB)\n' \
    "${before:-?}" "${after:-?}" "$(disk_path)" "$MIN_FREE_GB"
}

# Refuse to advertise slots on a host that cannot hold a job. Called by `up` and by the balancer, so
# a host that fills up mid-board pauses its slots instead of failing the job that arrives.
require_free_space() {
  local free
  free="$(free_gb "$(disk_path)")" || fail 1 "TN_CI_RUNNERS_DISK: cannot read free space on $(disk_path)"
  [ "$free" -ge "$MIN_FREE_GB" ] && return 0
  fail 1 "TN_CI_RUNNERS_DISK: $free GB free on $(disk_path), under the $MIN_FREE_GB GB floor; run 'scripts/ci-runners.sh prune' and free space before starting the pool"
}

# Read-only plan: group the CPUs by actual socket/core identity, keeping all SMT siblings
# together. Refuse inherited restricted affinity rather than allocate CPUs we cannot use.
plan() {
  local slots="${1:-${TN_RUNNERS:-$DEFAULT_SLOTS}}" topology cpu_count cores=() slot first cpus
  case "$slots" in ''|*[!0-9]*) fail 2 "N must be a positive integer" ;; esac
  [ "$slots" -ge 1 ] || fail 2 "N must be at least 1"
  topology="$(lscpu -p=CPU,CORE,SOCKET,ONLINE)" || fail 2 "cannot read CPU topology"
  cpu_count="$(awk -F, '
    $1 !~ /^#/ {
      if (NF != 4 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ ||
          $3 !~ /^[0-9]+$/ || $4 !~ /^(Y|N)$/ || seen[$1]++) bad=1
      if ($4 == "Y") n++
    }
    END {if (bad || !n) exit 2; print n}
  ' <<< "$topology")" || fail 2 "invalid or duplicate CPU topology"
  [ "$cpu_count" -eq "$(env -u OMP_NUM_THREADS -u OMP_THREAD_LIMIT nproc)" ] || fail 2 "restricted affinity: online topology does not match available CPUs"
  mapfile -t cores < <(awk -F, '
    $1 !~ /^#/ && $4 == "Y" {
      key=$3 ":" $2
      if (!(key in cpus)) order[++n]=key
      cpus[key]=cpus[key] (cpus[key] == "" ? "" : ",") $1
    }
    END {for (i=1;i<=n;i++) print cpus[order[i]]}
  ' <<< "$topology")
  [ $(( slots * CORES_PER_SLOT + LIGHT_CORES + HOST_CORES )) -le "${#cores[@]}" ] \
    || fail 2 "$slots slots need $CORES_PER_SLOT whole physical cores each plus light/host reserves; only ${#cores[@]} exist"
  for slot in $(seq 1 "$slots"); do
    first=$(( (slot - 1) * CORES_PER_SLOT ))
    cpus="$(IFS=,; echo "${cores[*]:$first:$CORES_PER_SLOT}")"
    printf 'heavy:%s:%s\n' "$slot" "$cpus"
  done
  first=$(( ${#cores[@]} - HOST_CORES - LIGHT_CORES ))
  cpus="$(IFS=,; echo "${cores[*]:$first:$LIGHT_CORES}")"
  printf 'light:%s\n' "$cpus"
  first=$(( ${#cores[@]} - HOST_CORES ))
  cpus="$(IFS=,; echo "${cores[*]:$first:$HOST_CORES}")"
  printf 'host:%s\n' "$cpus"
}

up() {
  local slots="${1:-${TN_RUNNERS:-$DEFAULT_SLOTS}}"
  case "$slots" in ''|*[!0-9]*) fail 2 "N must be a positive integer, got '$slots'" ;; esac
  [ "$slots" -ge 1 ] || fail 2 "N must be at least 1, got '$slots'"
  local allocation
  allocation="$(plan "$slots")" || return $?
  need docker
  need gh
  # Free the host before measuring it, then refuse rather than let the first job hit ENOSPC.
  prune
  require_free_space
  load_config
  local repo
  repo="$(repo_name)"

  forget_offline "$repo"
  docker build -t "$IMAGE" tools/ci-runners
  mkdir -p "$STATE_DIR"
  # A leftover stop file from a previous teardown would make every loop exit before it starts.
  rm -f "$STATE_DIR/stop"

  # Heavy slots have whole physical cores; light joins never share their SMT siblings.
  local kind slot cpus light_cpus
  while IFS=: read -r kind slot cpus; do
    if [ "$kind" = heavy ]; then
      start_slot "slot-$slot" "$STATE_DIR" "$ENV_FILE" "$repo" \
        "--cpuset-cpus $cpus --memory ${SLOT_MEMORY} --memory-swap ${SLOT_MEMORY} --oom-score-adj 800 $KVM_SHAPE" \
        "$LABEL"
    elif [ "$kind" = light ]; then
      light_cpus="$slot"
    fi
  done <<< "$allocation"
  for slot in $(seq 1 "$LIGHT_SLOTS"); do
    start_slot "light-$slot" "$STATE_DIR" "$ENV_FILE" "$repo" \
      "--cpuset-cpus $light_cpus $LIGHT_SHAPE" "$LIGHT_LABEL"
  done
  printf '%s heavy + %s light runner container(s) starting; logs in %s\n' "$slots" "$LIGHT_SLOTS" "$STATE_DIR"

  # Only advertise the labels once the runners are really there: TN_RUNNER set with an empty pool
  # is a queue that never drains. Both labels wait, because a light runner that never came online
  # leaves its jobs queued behind the heavy pool forever. On timeout, take the whole thing back down
  # rather than leaving half a pool registered.
  local deadline=$(( $(date +%s) + ONLINE_TIMEOUT_SECONDS )) online light_online
  while :; do
    online="$(online_count "$repo" "$LABEL")"
    light_online="$(online_count "$repo" "$LIGHT_LABEL")"
    if [ "$online" -ge "$slots" ] && [ "$light_online" -ge "$LIGHT_SLOTS" ]; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      gh variable delete "$VARIABLE" --repo "$repo" 2>/dev/null || true
      gh variable delete "$SLOTS_VARIABLE" --repo "$repo" 2>/dev/null || true
      gh variable delete "$LIGHT_VARIABLE" --repo "$repo" 2>/dev/null || true
      stop_slots
      fail 1 "$online of $slots $LABEL and $light_online $LIGHT_LABEL runner(s) came online within ${ONLINE_TIMEOUT_SECONDS}s"
    fi
    sleep 10
  done

  # The balancer owns the routing variables from here: it advertises a label only while that pool
  # has an idle runner, so a full pool overflows new jobs to hosted runners instead of queueing them.
  setsid nohup bash scripts/ci-runners.sh balance >"$STATE_DIR/balance.log" 2>&1 &
  echo "$!" >"$STATE_DIR/balance.pid"
  printf '%s %s + %s %s online; the balancer routes jobs here while a runner is idle\n' \
    "$online" "$LABEL" "$light_online" "$LIGHT_LABEL"
}

# Hosted runners are free for a public repository and run ~20 jobs at once; this pool adds a few
# more. Routing every Linux job here funnelled the team's CI into 5 slots and made boards slower
# (run 37099132853 sat 20 min with 15 jobs queued). So the pool is overflow-in-reverse: a label is
# advertised while it has an idle runner and withdrawn the moment it has none.
balance() {
  need gh
  local repo want_heavy want_light have_heavy have_light have_slots slots_value heavy_slots idle present token
  local seen_heavy=0 seen_light=0
  local disk last_prune=0 free
  repo="$(repo_name)"
  while [ ! -e "$STATE_DIR/stop" ]; do
    # A host that fills mid-board withdraws both labels before a job lands on it: a queued job can
    # wait, a job that dies of ENOSPC takes a re-run and reports the wrong thing. Prune at most once
    # per ten minutes while the floor is breached, then re-check the same poll.
    # The docker root is read again every poll: this loop runs for hours, and a daemon whose root
    # moves must be measured where it is now. `free_gb_or_floor` never answers 0 for an unreadable
    # filesystem, so a broken `df` cannot pause the whole pool.
    disk="$(disk_path)"
    free="$(free_gb_or_floor "$disk")"
    if [ "$free" -lt "$MIN_FREE_GB" ]; then
      if [ $(( $(date +%s) - last_prune )) -ge 600 ]; then
        printf '%s disk low: %s GB free on %s, pruning\n' "$(date -u +%H:%M:%S)" "$free" "$disk" >&2
        last_prune=$(date +%s)
        # A subshell: `prune` calls `fail`, which exits, and that must end the prune and not the
        # balancer — a host with a dead docker daemon still has to withdraw its slots.
        ( prune ) >&2 || true
        free="$(free_gb_or_floor "$disk")"
      fi
      if [ "$free" -lt "$MIN_FREE_GB" ]; then
        printf '%s disk %s GB free, under the %s GB floor: slots paused\n' \
          "$(date -u +%H:%M:%S)" "$free" "$MIN_FREE_GB" >&2
        gh variable delete "$VARIABLE" --repo "$repo" 2>/dev/null || true
        gh variable delete "$SLOTS_VARIABLE" --repo "$repo" 2>/dev/null || true
        gh variable delete "$LIGHT_VARIABLE" --repo "$repo" 2>/dev/null || true
        sleep "$BALANCE_POLL_SECONDS"
        continue
      fi
    fi
    # One runners read answers both routing questions: which idle lanes exist, and how many heavy
    # runners are idle. gh rejects --slurp together with --jq, so the filter runs per page and the
    # heavy total is a line count across every page, not an aggregate jq expression. Each idle
    # runner contributes its one matching label, so a line count is a runner count.
    idle="$(gh api "repos/$repo/actions/runners" --paginate --jq \
      ".runners[] | select(.status == \"online\" and .busy == false) | ([.labels[].name | select(. == \"$LABEL\" or . == \"$LIGHT_LABEL\")] | unique)[]" \
      2>/dev/null)" || { seen_heavy=0; seen_light=0; sleep "$BALANCE_POLL_SECONDS"; continue; }
    heavy_slots=0
    while IFS= read -r token; do
      if [ "$token" = "$LABEL" ]; then heavy_slots=$((heavy_slots + 1)); fi
    done <<< "$idle"
    # Space-separated names let the case patterns below match a whole label token, not a substring.
    idle="${idle//$'\n'/ }"
    # Read the variables, not a cache: a cached value misses a change made outside this loop. Report
    # the name alone for the exact expected label and NAME:invalid otherwise, so a wrong label is
    # still visible without ever printing a value into a token. The slots integer is emitted as
    # NAME=value, because its value is what tells the loop whether the count changed.
    present="$(gh api "repos/$repo/actions/variables" --paginate --jq \
      ".variables[] | select(.name == \"$VARIABLE\" or .name == \"$LIGHT_VARIABLE\" or .name == \"$SLOTS_VARIABLE\") | if (.name == \"$VARIABLE\") then (if .value == \"$LABEL\" then .name else .name + \":invalid\" end) elif (.name == \"$LIGHT_VARIABLE\") then (if .value == \"$LIGHT_LABEL\" then .name else .name + \":invalid\" end) else .name + \"=\" + .value end" \
      2>/dev/null)" || { seen_heavy=0; seen_light=0; sleep "$BALANCE_POLL_SECONDS"; continue; }
    # A teardown that began during the reads must never be followed by an advertise.
    if [ -e "$STATE_DIR/stop" ]; then break; fi
    have_heavy=off; have_light=off; have_slots=off; slots_value=""
    while IFS= read -r token; do
      case "$token" in
        "$VARIABLE") have_heavy=on ;;
        "$VARIABLE:invalid") have_heavy=invalid ;;
        "$LIGHT_VARIABLE") have_light=on ;;
        "$LIGHT_VARIABLE:invalid") have_light=invalid ;;
        "$SLOTS_VARIABLE="*) have_slots=on; slots_value="${token#*=}" ;;
      esac
    done <<< "$present"
    # Off at once when no runner is idle; on only after two polls in a row (~40 s) found one. A runner
    # that just re-registered in a saturated pool is idle for seconds before it takes a queued job, and
    # that blip must not route more work here.
    case " $idle " in *" $LABEL "*) seen_heavy=$((seen_heavy + 1)) ;; *) seen_heavy=0 ;; esac
    case " $idle " in *" $LIGHT_LABEL "*) seen_light=$((seen_light + 1)) ;; *) seen_light=0 ;; esac
    want_heavy=off; want_light=off
    [ "$seen_heavy" -ge 2 ] && want_heavy=on
    [ "$seen_light" -ge 2 ] && want_light=on
    # Fail-closed publication order: while TN_RUNNER is on, TN_RUNNER_SLOTS is already set, so a
    # consumer never reads the label without its integer capacity. Enable slots then label; disable
    # label then slots. The count is refreshed even when the label stays on.
    if [ "$want_heavy" = on ]; then
      if [ "$have_slots" != on ] || [ "$slots_value" != "$heavy_slots" ]; then
        gh variable set "$SLOTS_VARIABLE" --body "$heavy_slots" --repo "$repo"
        printf '%s %s=%s\n' "$(date -u +%H:%M:%S)" "$SLOTS_VARIABLE" "$heavy_slots"
        have_slots=on; slots_value="$heavy_slots"
      fi
      if [ "$have_heavy" != on ]; then
        gh variable set "$VARIABLE" --body "$LABEL" --repo "$repo"
        printf '%s %s=%s\n' "$(date -u +%H:%M:%S)" "$VARIABLE" on
      fi
    else
      if [ "$have_heavy" != off ]; then
        gh variable delete "$VARIABLE" --repo "$repo" 2>/dev/null || true
        printf '%s %s=%s\n' "$(date -u +%H:%M:%S)" "$VARIABLE" off
      fi
      if [ "$have_slots" = on ]; then
        gh variable delete "$SLOTS_VARIABLE" --repo "$repo" 2>/dev/null || true
        printf '%s %s=%s\n' "$(date -u +%H:%M:%S)" "$SLOTS_VARIABLE" off
      fi
    fi
    if [ "$want_light" != "$have_light" ]; then
      if [ "$want_light" = on ]; then gh variable set "$LIGHT_VARIABLE" --body "$LIGHT_LABEL" --repo "$repo"
      else gh variable delete "$LIGHT_VARIABLE" --repo "$repo" 2>/dev/null || true; fi
      printf '%s %s=%s\n' "$(date -u +%H:%M:%S)" "$LIGHT_VARIABLE" "$want_light"
    fi
    sleep "$BALANCE_POLL_SECONDS"
  done
}

down() {
  need gh
  local repo
  repo="$(repo_name)"
  # Stop the balancer before clearing the variables, or it could re-advertise a pool on its way out.
  if [ -f "$STATE_DIR/balance.pid" ]; then kill "$(cat "$STATE_DIR/balance.pid")" 2>/dev/null || true; fi
  # Then the variables, so no job is ever routed to a pool that is on its way out.
  local variable
  for variable in "$VARIABLE" "$SLOTS_VARIABLE" "$LIGHT_VARIABLE"; do
    gh variable delete "$variable" --repo "$repo" 2>/dev/null \
      || printf 'TN_CI_RUNNERS: %s was already unset\n' "$variable" >&2
  done
  mkdir -p "$STATE_DIR"
  stop_slots
  forget_offline "$repo"
  printf '%s and %s cleared; runners stopping\n' "$VARIABLE" "$LIGHT_VARIABLE"
}

status() {
  need gh
  local repo
  repo="$(repo_name)"
  local variable label
  for variable in "$VARIABLE" "$LIGHT_VARIABLE"; do
    printf '%s=%s\n' "$variable" "$(gh variable get "$variable" --repo "$repo" 2>/dev/null || echo unset)"
  done
  printf 'containers: %s\n' "$(docker ps -q --filter label=tn-ci-runner=1 | wc -l | tr -d ' ')"
  # The disk report is half of what this command is for: the pool pauses itself under the floor, so
  # an operator reading `status` must see the same number the balancer acts on.
  local disk free last
  disk="$(disk_path)"
  free="$(free_gb "$disk" 2>/dev/null || echo unknown)"
  last="$(cat "$STATE_DIR/last-prune" 2>/dev/null || echo never)"
  printf 'disk: %s GB free on %s (floor %s GB): %s\n' "$free" "$disk" "$MIN_FREE_GB" \
    "$([ "$free" = unknown ] || [ "$free" -ge "$MIN_FREE_GB" ] && echo ok || echo 'below floor, slots pause')"
  if [ "$last" = never ]; then
    printf 'prune: never\n'
  else
    printf 'prune: %s (%s min ago)\n' "$(date -u -d "@$last" +%H:%M:%SZ 2>/dev/null || echo "$last")" \
      "$(( ($(date +%s) - last) / 60 ))"
  fi
  for label in "$LABEL" "$LIGHT_LABEL"; do
    printf 'online %s runners (name, status, busy):\n' "$label"
    gh api "repos/$repo/actions/runners" --paginate --jq \
      ".runners[] | select(any(.labels[]; .name == \"$label\")) | \"  \\(.name)  \\(.status)  busy=\\(.busy)\"" \
      2>/dev/null || echo "  none reported"
  done
}

SERVICE=threenative-ci-runners.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# The checkout every worktree belongs to, so the service never runs from a lane that gets deleted.
primary_root() {
  dirname -- "$(cd "$(git rev-parse --git-common-dir)" && pwd)"
}

install() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 \
    || fail 2 "install needs Linux with a systemd user session; elsewhere run 'up'/'down' by hand"
  need docker
  need gh
  need git
  docker info >/dev/null 2>&1 || fail 2 "docker is not usable without sudo; add ${USER:-$(id -un)} to the docker group and log in again"
  gh auth status >/dev/null 2>&1 || fail 2 "gh is not logged in; run 'gh auth login' first"
  load_config
  local branch root worktree
  branch="$(git config --get threenative.integrationBranch || echo develop)"
  root="$(primary_root)"
  worktree="$root/.worktrees/ci-runners"
  git -C "$root" fetch -q origin "$branch"
  if [ ! -d "$worktree" ]; then
    git -C "$root" worktree add -q --detach "$worktree" "origin/$branch"
  fi
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$SERVICE" <<UNIT
[Unit]
Description=ThreeNative tn-local GitHub Actions runner pool (PRD-480)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$worktree
Environment=PATH=/usr/local/bin:/usr/bin:/bin
# Start from the latest $branch, so runner image and script fixes deploy on the next start.
ExecStartPre=/usr/bin/env git fetch -q origin $branch
ExecStartPre=/usr/bin/env git checkout -q --detach origin/$branch
# The host's disk, not the pool's: a full disk fails the first job as a mystery compile error. The
# prune runs before `up` measures the floor it refuses to start under.
ExecStartPre=-/usr/bin/env bash scripts/ci-runners.sh prune
ExecStart=/usr/bin/env bash scripts/ci-runners.sh up
# down clears TN_RUNNER first, so jobs fall back to hosted runners whenever this pool is not up.
ExecStop=/usr/bin/env bash scripts/ci-runners.sh down
TimeoutStartSec=1200
TimeoutStopSec=300
# gh may keep its token in a desktop keyring that is locked until login; retry until it opens.
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
UNIT
  # Lingering starts user services at boot, before anyone logs in.
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
    loginctl enable-linger "$USER" 2>/dev/null \
      || printf 'TN_CI_RUNNERS: run "sudo loginctl enable-linger %s" so the pool starts at boot\n' "$USER" >&2
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE" >/dev/null 2>&1
  if systemctl --user is-active --quiet "$SERVICE"; then
    printf 'Service already running. Apply changes when no job is running:\n  systemctl --user restart %s\n' "$SERVICE"
  else
    systemctl --user start "$SERVICE"
  fi
  printf 'Installed: %s runs %s from %s at every boot.\n' "$SERVICE" "origin/$branch" "$worktree"
  status
}

uninstall() {
  if [ -f "$UNIT_DIR/$SERVICE" ]; then
    systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$SERVICE"
    systemctl --user daemon-reload
  fi
  down
  local worktree
  worktree="$(primary_root)/.worktrees/ci-runners"
  if [ -d "$worktree" ]; then
    git -C "$(primary_root)" worktree remove "$worktree" \
      || printf 'TN_CI_RUNNERS: %s has local changes; remove it yourself once checked\n' "$worktree" >&2
  fi
  printf 'Uninstalled; every job now runs on hosted runners.\n'
}

case "${1:-}" in
  plan) shift; plan "${1:-}" ;;
  up) shift; up "${1:-}" ;;
  down) down ;;
  status) status ;;
  prune) prune ;;
  balance) balance ;;
  install) install ;;
  uninstall) uninstall ;;
  *) fail 2 "usage: ci-runners.sh plan [N] | up [N] | down | status | prune | balance | install | uninstall" ;;
esac
