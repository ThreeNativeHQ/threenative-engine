#!/usr/bin/env bash
set -uo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

status_path="${TN_GATE_STATUS_PATH:-$repository_root/artifacts/gates/status.json}"
run_id="${TN_GATE_RUN_ID:-tn-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
lease_owner="${TN_WORKTREE_OWNER:-${USER:-unknown}@$(hostname)}"
lease_pid="$$"
lease_registered=0
suite_started=0
run_status=0
resume_mode=0
resume_phase=""
heartbeat_pid=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --resume)
      resume_mode=1
      shift
      ;;
    --status-path)
      status_path="${2:-}"
      shift 2
      ;;
    --run-id)
      run_id="${2:-}"
      shift 2
      ;;
    --phase)
      resume_phase="${2:-}"
      shift 2
      ;;
    *)
      printf 'usage: run-test-suite.sh [--resume --status-path path --run-id id --phase phase]\n' >&2
      exit 2
      ;;
  esac
done

if [[ "$resume_mode" -eq 1 && -z "$resume_phase" ]]; then
  printf 'resume requires --phase\n' >&2
  exit 2
fi

suite_prebuilt="${TN_SUITE_PREBUILT:-0}"
case "$suite_prebuilt" in
  0|"")
    suite_prebuilt=0
    ;;
  1)
    ;;
  *)
    printf 'TN_SUITE_PREBUILT must be 0 or 1, got %q\n' "$suite_prebuilt" >&2
    exit 2
    ;;
esac

suite_tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/threenative-suite.XXXXXX")" || exit $?
export TN_SUITE_TMPDIR="$suite_tmp_root"
export TMPDIR="$suite_tmp_root"
suite_marker="$(mktemp "$suite_tmp_root/tn-suite-count.XXXXXX")" || {
  suite_allocation_status=$?
  rmdir -- "$suite_tmp_root"
  exit "$suite_allocation_status"
}
# Names this run so any legacy tag-aware temp guard also stays isolated from concurrent lanes.
export TN_TEST_TEMP_TAG="run${$}"
lease_branch="$(git symbolic-ref -q HEAD || true)"
lease_head="$(git rev-parse HEAD)"

cleanup() {
  if [[ "$heartbeat_pid" -gt 0 ]]; then
    kill "$heartbeat_pid" >/dev/null 2>&1 || true
    wait "$heartbeat_pid" >/dev/null 2>&1 || true
    heartbeat_pid=0
  fi
  if [[ "$lease_registered" -eq 1 && "$run_status" -eq 0 ]]; then
    pnpm exec tsx scripts/worktree-lifecycle.ts release --owner "$lease_owner" --pid "$lease_pid" >/dev/null 2>&1 || true
    lease_registered=0
  fi
  rm -f "$suite_marker"
  rm -rf -- "$suite_tmp_root"
}
trap cleanup EXIT

set +e
lease_phase="test"
if [[ "$resume_mode" -eq 1 ]]; then
  lease_phase="$resume_phase"
fi
pnpm exec tsx scripts/worktree-lifecycle.ts register \
  --phase "$lease_phase" \
  --owner "$lease_owner" \
  --pid "$lease_pid" \
  --run-id "$run_id"
register_status=$?
if [[ "$register_status" -ne 0 ]]; then
  run_status=2
  exit 2
fi
lease_registered=1

packages/playtest/__tests__/orphan-cleanup.sh --suite-start "$suite_marker"
start_status=$?
if [[ "$start_status" -ne 0 ]]; then
  run_status="$start_status"
  exit "$start_status"
fi
suite_started=1

executed_phases=()

run_phase() {
  local phase="$1"
  executed_phases+=("$phase")
  shift
  local command_text="$*"
  local guard_status=0
  local status_start=0
  local child_status=0
  local status_finish=0
  local child_pid=0

  pnpm exec tsx scripts/worktree-lifecycle.ts verify --phase "$phase" --owner "$lease_owner" --pid "$lease_pid"
  guard_status=$?
  if [[ "$guard_status" -ne 0 ]]; then
    return "$guard_status"
  fi

  node scripts/gate-records.mjs start \
    --status-path "$status_path" \
    --run-id "$run_id" \
    --phase "$phase" \
    --owner "$lease_owner" \
    --pid "$lease_pid" \
    --command "$command_text"
  status_start=$?
  if [[ "$status_start" -ne 0 ]]; then
    return "$status_start"
  fi

  "$@" &
  child_pid=$!
  (
    while kill -0 "$child_pid" >/dev/null 2>&1; do
      sleep "${TN_GATE_HEARTBEAT_INTERVAL_SECONDS:-5}"
      if ! kill -0 "$child_pid" >/dev/null 2>&1; then
        break
      fi
      node scripts/gate-records.mjs heartbeat \
        --status-path "$status_path" \
        --run-id "$run_id" \
        --phase "$phase" \
        --owner "$lease_owner" \
        --pid "$lease_pid" >/dev/null 2>&1 || exit 0
      pnpm exec tsx scripts/worktree-lifecycle.ts heartbeat \
        --run-id "$run_id" \
        --phase "$phase" \
        --owner "$lease_owner" \
        --pid "$lease_pid" >/dev/null 2>&1 || exit 0
    done
  ) &
  heartbeat_pid=$!

  wait "$child_pid"
  child_status=$?
  kill "$heartbeat_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" >/dev/null 2>&1 || true
  heartbeat_pid=0

  node scripts/gate-records.mjs finish \
    --status-path "$status_path" \
    --run-id "$run_id" \
    --phase "$phase" \
    --owner "$lease_owner" \
    --pid "$lease_pid" \
    --exit-code "$child_status"
  status_finish=$?
  if [[ "$child_status" -ne 0 ]]; then
    return "$child_status"
  fi
  return "$status_finish"
}

# Which packages the `package-test` phase walks. Empty by default, so `pnpm test` on a developer
# machine still runs every package and this file stays the whole gate. CI splits the walk in two:
# the native contract suite needs a compiled C++ host and nothing else in the run does, so it gets
# its own job and this one is told to skip it. `scripts/__tests__/ci-structure.spec.ts` asserts the
# two halves partition the workspace, because a filter that names a package neither job runs is a
# gate that goes green by running less.
# One package at a time was a machine-independent number, and every machine this runs on has more
# than one core. The packages' own `test` scripts are publint, small vitest runs and the playtest
# orphan sweep — independent of each other, and measured at 26s serial against 11s at four, stable
# over three consecutive runs. The ceiling is deliberate: several of these drive real browsers, and
# oversubscribing a two-core runner is how this repository's heavy specs start failing on timing
# rather than on behaviour, which is the same reason `vitest.config.ts` caps its worker pool.
# `TN_SUITE_PACKAGE_CONCURRENCY` overrides it, and 1 restores exactly the old behaviour.
package_test_concurrency="${TN_SUITE_PACKAGE_CONCURRENCY:-}"
if [[ -z "$package_test_concurrency" ]]; then
  detected_cores="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
  if [[ ! "$detected_cores" =~ ^[0-9]+$ ]] || [[ "$detected_cores" -lt 2 ]]; then
    package_test_concurrency=1
  elif [[ "$detected_cores" -gt 4 ]]; then
    package_test_concurrency=3
  else
    package_test_concurrency=$(( detected_cores - 1 ))
  fi
fi
package_test_command=(pnpm -r --filter '!.' --workspace-concurrency="$package_test_concurrency")
if [[ -n "${TN_SUITE_EXCLUDE_PACKAGES:-}" ]]; then
  IFS=',' read -r -a tn_excluded_packages <<< "$TN_SUITE_EXCLUDE_PACKAGES"
  for tn_excluded_package in "${tn_excluded_packages[@]}"; do
    [[ -n "$tn_excluded_package" ]] || continue
    package_test_command+=(--filter "!$tn_excluded_package")
  done
fi
if [[ "$suite_prebuilt" -eq 1 ]]; then
  # These package test scripts deliberately rebuild outputs for standalone developers. The build
  # phase already produced them here, so CI runs their pure checks below instead of hiding a second
  # build behind the recursive test walk.
  for tn_prebuilt_package in \
    @threenative/assets \
    @threenative/ueformat \
    @threenative/raw-unreal \
    @threenative/metahuman; do
    package_test_command+=(--filter "!$tn_prebuilt_package")
  done
fi
package_test_command+=(--if-present run test)

verify_prebuilt_outputs() {
  local missing=()
  local config=""
  local package_directory=""
  local output=""

  for config in packages/*/tsup.config.ts; do
    package_directory="${config%/tsup.config.ts}"
    output="$package_directory/dist/index.js"
    if [[ ! -f "$output" ]]; then
      missing+=("$output")
    fi
  done
  [[ -f packages/playtest/dist/runner/cli.js ]] || missing+=("packages/playtest/dist/runner/cli.js")

  if [[ "${#missing[@]}" -gt 0 ]]; then
    printf 'TN_SUITE_PREBUILT_MISSING: %s\n' "${missing[*]}" >&2
    return 2
  fi
}

run_prebuilt_package_tests() {
  verify_prebuilt_outputs || return $?
  "${package_test_command[@]}" || return $?

  pnpm --filter @threenative/assets exec publint --strict || return $?
  pnpm --filter @threenative/ueformat exec vitest run --root ../.. ueformat/__tests__ || return $?
  pnpm --filter @threenative/ueformat exec publint --strict || return $?
  pnpm --filter @threenative/raw-unreal exec vitest run --root ../.. raw-unreal/__tests__ || return $?
  pnpm --filter @threenative/raw-unreal exec publint --strict || return $?
  pnpm --filter @threenative/metahuman exec vitest run --root ../.. metahuman/__tests__ || return $?
  pnpm --filter @threenative/metahuman exec publint --strict || return $?
}


# Which phases this invocation runs, and which slice of the unit suite.
#
# Unset, both are the whole thing: `pnpm test` on a developer machine runs all four phases and
# every test, and this file stays the gate it has always been. CI splits the work across jobs
# because the unit run is the longest single thing in the repository's longest job, and it shards
# cleanly — but the split is only ever safe while the pieces add back up, so
# `scripts/__tests__/ci-structure.spec.ts` asserts the phases and the shards both partition.
suite_phases="${TN_SUITE_PHASES:-docs,build,package-test,unit}"
unit_command=(vitest run)
if [[ -n "${TN_SUITE_UNIT_SHARD:-}" ]]; then
  if [[ ! "${TN_SUITE_UNIT_SHARD}" =~ ^[1-9][0-9]*/[1-9][0-9]*$ ]]; then
    printf 'TN_SUITE_UNIT_SHARD must look like 2/3, got %q\n' "${TN_SUITE_UNIT_SHARD}" >&2
    exit 2
  fi
  unit_command+=(--shard "${TN_SUITE_UNIT_SHARD}")
fi

runs_phase() {
  [[ ",${suite_phases}," == *",$1,"* ]]
}

test_status=0
if [[ "$resume_mode" -eq 1 ]]; then
  case "$resume_phase" in
    docs)
      run_phase docs pnpm run check:docs || test_status=$?
      ;;
    build)
      run_phase build pnpm run build || test_status=$?
      ;;
    unit)
      run_phase unit "${unit_command[@]}" || test_status=$?
      ;;
    package-test)
      if [[ "$suite_prebuilt" -eq 1 ]]; then
        run_phase package-test run_prebuilt_package_tests || test_status=$?
      else
        run_phase package-test "${package_test_command[@]}" || test_status=$?
      fi
      ;;
    *)
      printf 'cannot resume unknown phase %q\n' "$resume_phase" >&2
      test_status=2
      ;;
  esac
else
  if runs_phase docs; then
    run_phase docs pnpm run check:docs || test_status=$?
  fi
  if [[ "$test_status" -eq 0 ]] && runs_phase build; then
    run_phase build pnpm run build || test_status=$?
  fi
  if [[ "$test_status" -eq 0 ]] && runs_phase package-test; then
    if [[ "$suite_prebuilt" -eq 1 ]]; then
      run_phase package-test run_prebuilt_package_tests || test_status=$?
    else
      run_phase package-test "${package_test_command[@]}" || test_status=$?
    fi
  fi
  if [[ "$test_status" -eq 0 ]] && runs_phase unit; then
    run_phase unit "${unit_command[@]}" || test_status=$?
  fi
  # A selection that ran nothing is a green report on an empty set.
  if [[ "$test_status" -eq 0 ]] && [[ "${#executed_phases[@]}" -eq 0 ]]; then
    printf 'TN_SUITE_NO_PHASES: %q selected none of docs, build, package-test, unit\n' \
      "$suite_phases" >&2
    test_status=2
  fi
fi

finish_status=0
if [[ "$suite_started" -eq 1 ]]; then
  packages/playtest/__tests__/orphan-cleanup.sh --suite-finish "$suite_marker"
  finish_status=$?
fi

if [[ "$test_status" -ne 0 ]]; then
  run_status="$test_status"
  exit "$test_status"
fi
run_status="$finish_status"
exit "$finish_status"
