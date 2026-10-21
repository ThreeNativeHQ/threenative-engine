#!/bin/sh
# Run a network download step at most three times, with a growing pause between attempts.
#
# Only a download goes through this script: an apt install, an sdkmanager package, a toolchain
# fetch. A test, a budget or a threshold never does, because a retry there would hide a real
# failure. The exit status of the last attempt is the exit status of the step (PRD-629).
#
#   sh scripts/retry-download.sh sudo apt-get install -y ninja-build
#
# TN_RETRY_DELAY is the base pause in seconds (default 15), so a unit test can set it to 0.
attempt=1
while :; do
  "$@" && exit 0
  status=$?
  [ "$attempt" -lt 3 ] || exit "$status"
  echo "retry-download: attempt $attempt failed with exit $status: $*" >&2
  sleep $((attempt * ${TN_RETRY_DELAY:-15}))
  attempt=$((attempt + 1))
done
