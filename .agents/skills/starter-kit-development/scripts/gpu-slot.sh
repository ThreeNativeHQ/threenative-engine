#!/bin/bash
# Run one command while it holds one of two GPU slots, so at most two headed WebGPU runs share the GPU.
# Usage: gpu-slot.sh <command> [args...]
# The lock files go in $TN_GPU_SLOT_DIR (default: ${TMPDIR:-/tmp}).
set -u
dir="${TN_GPU_SLOT_DIR:-${TMPDIR:-/tmp}}"
while :; do
  for slot in a b; do
    flock -n -E 200 "$dir/tn-gpu-$slot.lock" "$@"
    rc=$?
    [ "$rc" -ne 200 ] && exit "$rc"
  done
  sleep 20
done
