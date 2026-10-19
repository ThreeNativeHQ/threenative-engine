#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_directory/../../.." && pwd)"
cd "$repository_root"

owned_temp_root=0
suite_temp_root="${TN_SUITE_TMPDIR:-}"
# The suite markers measure the namespace the whole suite shares, and are the only modes that may
# read it. The browser run below measures what that one run created, so it takes a private
# namespace even inside the suite: `pnpm -r` runs package tests three at a time under the shared
# `TMPDIR`, and a sibling creating or removing a single directory moved this count and failed the
# run for a leak nobody had. It read `before 2, after 1` — a decrease, which no leak can produce.
if [[ -z "${1:-}" ]]; then
  suite_temp_root=""
fi
if [[ -z "$suite_temp_root" || ! -d "$suite_temp_root" ]]; then
  suite_temp_root="$(mktemp -d /tmp/threenative-orphan-suite.XXXXXX)"
  owned_temp_root=1
fi
export TMPDIR="$suite_temp_root"

cleanup_temp_root() {
  if [[ "$owned_temp_root" -eq 1 ]]; then
    rm -rf -- "$suite_temp_root"
  fi
}
trap cleanup_temp_root EXIT

count_temp_directories() {
  find "$suite_temp_root" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | wc -l
}

# Which processes on this machine belong to this run. Several agent lanes work in this repository
# at once and each can be driving its own browser, so every token here is anchored to something
# only this run owns: its port, its temporary namespace, its checkout. A bare
# `playwright_chromiumdev_profile-` and a bare `packages/playtest/dist/runner/cli.js` matched a
# neighbour's live browser and a neighbour's runner, and reported both as this run's leak — a red
# on a clean tree that no diff could clear. Playwright puts its profile under `TMPDIR`, which this
# script exports as the suite namespace, so a browser this run genuinely orphans still matches.
list_orphan_processes() {
  ps -eo pid=,args= | awk \
    -v baseline="$baseline_pids" \
    -v port_token="port $test_port" \
    -v profile_token="$suite_temp_root/playwright_chromiumdev_profile-" \
    -v runner_token="$repository_root/packages/playtest/dist/runner/cli.js" '
  BEGIN {
    count = split(baseline, pids, /[[:space:]]+/)
    for (idx = 1; idx <= count; idx += 1) if (pids[idx] != "") existing[pids[idx]] = 1
  }
  {
    if ($0 ~ /awk/) next
    pid = $1
    $1 = ""
    sub(/^[[:space:]]+/, "", $0)
    owned = index($0, port_token) || index($0, profile_token) || index($0, runner_token)
    if (owned && !existing[pid]) print pid " " $0
  }'
}

case "${1:-}" in
  --suite-start)
    if [[ "$#" -ne 2 ]]; then
      echo "usage: $0 --suite-start MARKER" >&2
      exit 2
    fi
    {
      echo "$suite_temp_root"
      count_temp_directories
    } >"$2"
    echo "suite temporary directory baseline recorded: $(<"$2")"
    exit 0
    ;;
  --suite-finish)
    if [[ "$#" -ne 2 || ! -f "$2" ]]; then
      echo "usage: $0 --suite-finish MARKER" >&2
      exit 2
    fi
    before_temp_directories="$(sed -n '2p' "$2")"
    after_temp_directories="$(count_temp_directories)"
    # Only growth is a leak. A directory that existed at the baseline and is gone by the end was
    # cleaned up by whoever owned it, which is the outcome this gate wants.
    if [[ "$after_temp_directories" -gt "$before_temp_directories" ]]; then
      echo "temporary directory count grew in suite namespace '$suite_temp_root': before $before_temp_directories, after $after_temp_directories" >&2
      exit 1
    fi
    echo "suite temporary directory count did not grow in '$suite_temp_root': before $before_temp_directories, after $after_temp_directories"
    exit 0
    ;;
  --list-orphans)
    # A test seam, and the only way the ownership rule is provable in milliseconds. The rule
    # decides which processes on a shared machine belong to this run, and a rule that can only be
    # exercised by a full browser launch is a rule nothing checks against a decoy.
    if [[ "$#" -ne 3 ]]; then
      echo "usage: $0 --list-orphans BASELINE_PID_FILE PORT" >&2
      exit 2
    fi
    baseline_pids="$(<"$2")"
    test_port="$3"
    list_orphan_processes
    exit 0
    ;;
  "")
    ;;
  *)
    echo "usage: $0 [--suite-start MARKER|--suite-finish MARKER]" >&2
    exit 2
    ;;
esac

if ! browser_path="$(cd -- "$script_directory/.." && node --input-type=module -e 'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath());')"; then
  echo "unverified: Playwright Chromium is not available" >&2
  exit 2
fi
if [[ ! -x "$browser_path" ]]; then
  echo "unverified: Chromium executable is not installed at $browser_path" >&2
  exit 2
fi

# The capture mutex intentionally retains its coordination root and empty queue after release.
# Initialize only this run's private infrastructure before counting; still require no lease or
# queue entry after SIGTERM, so a real lock/process/profile leak cannot become a green count.
capture_coordination_root="$suite_temp_root/threenative-playtest-capture"
mkdir -p -- "$capture_coordination_root/queue"
capture_coordination_empty() {
  [[ ! -e "$capture_coordination_root/lock" && ! -L "$capture_coordination_root/lock" ]] || return 1
  if [[ -d "$capture_coordination_root/queue" && ! -L "$capture_coordination_root/queue" ]]; then
    [[ -z "$(find "$capture_coordination_root/queue" -mindepth 1 -maxdepth 1 -print -quit)" ]]
  else
    [[ ! -e "$capture_coordination_root/queue" && ! -L "$capture_coordination_root/queue" ]]
  fi
}
before_temp_directories="$(count_temp_directories)"

set +e
run_log="$(mktemp)"
trap 'cleanup_temp_root; rm -f "$run_log"' EXIT
baseline_pids="$(ps -eo pid=)"
test_port="$(node --input-type=module -e '
  import { createServer } from "node:net";
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") process.exit(1);
    process.stdout.write(String(address.port));
    server.close();
  });
')"
timeout 5s node packages/playtest/dist/runner/cli.js \
  --scenario examples/abyss-framework/playtest/moves.json \
  --project . \
  --url "http://127.0.0.1:$test_port" \
  --server-command "pnpm --filter abyss-framework dev --host 127.0.0.1 --port $test_port --strictPort" >"$run_log" 2>&1
run_code=$?
set -e

if [[ "$run_code" -ne 124 && "$run_code" -ne 2 ]]; then
  echo "orphan gate did not receive the expected timeout or signal exit (code $run_code)" >&2
  exit 1
fi
unverified=0
if [[ "$run_code" -eq 2 ]] && rg -q "TN_PLAYTEST_(BROWSER_UNAVAILABLE|SERVER_FAILED|PAGE_UNREACHABLE|RUNNER_FAILED|SCENARIO_|CLI_USAGE)" "$run_log"; then
  echo "unverified: the run failed before signal teardown could be exercised" >&2
  unverified=1
fi

# Teardown is asynchronous: the runner kills the browser, and Playwright removes its profile and
# artifact directories a moment later. A fixed sleep made this gate a race — it passed on a quiet
# machine and failed on a loaded CI runner with `before 1, after 3`, reporting a leak that cleaned
# itself up a second after the count was taken. Poll to a deadline instead, and fail only when the
# state never settles. That still catches a real leak: a process or directory that is genuinely
# orphaned is still there when the deadline passes.
readonly settle_deadline_seconds="${TN_ORPHAN_SETTLE_SECONDS:-30}"

orphans=""
after_temp_directories="$before_temp_directories"
settle_started="$SECONDS"
while true; do
  sleep 1
  orphans="$(list_orphan_processes)"
  after_temp_directories="$(count_temp_directories)"
  if [[ -z "$orphans" && "$after_temp_directories" -le "$before_temp_directories" ]] && capture_coordination_empty; then
    break
  fi
  if (( SECONDS - settle_started >= settle_deadline_seconds )); then
    break
  fi
done

if [[ -n "$orphans" ]]; then
  echo "orphan processes remain after ${settle_deadline_seconds}s:" >&2
  echo "$orphans" >&2
  exit 1
fi

if ! capture_coordination_empty; then
  echo "owned capture lease or queue entries remain after ${settle_deadline_seconds}s in '$capture_coordination_root'" >&2
  find "$capture_coordination_root" -mindepth 1 -maxdepth 2 -print >&2 2>/dev/null || true
  exit 1
fi

if [[ "$after_temp_directories" -gt "$before_temp_directories" ]]; then
  echo "temporary directory count grew in suite namespace '$suite_temp_root' and did not settle within ${settle_deadline_seconds}s: before $before_temp_directories, after $after_temp_directories" >&2
  find "$suite_temp_root" -mindepth 1 -maxdepth 1 -type d -print >&2 2>/dev/null || true
  # A directory that outlives the deadline is either genuinely orphaned or still owned by a
  # process this gate's own filter did not match — a browser zygote carries none of the tokens
  # `list_orphan_processes` looks for. Naming the survivors is what tells those two apart, and
  # without it the failure reads as a leak in every case.
  echo "processes still mentioning the suite namespace or a browser profile:" >&2
  ps -eo pid=,args= | grep -E "$suite_temp_root|chromium|chrome" | grep -v grep >&2 || \
    echo "  none — no process holds these directories, so this is a real leak" >&2
  exit 1
fi

if [[ "$unverified" -eq 1 ]]; then
  exit 2
fi

echo "no orphans"
