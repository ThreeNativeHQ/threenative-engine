#!/bin/sh
# Runs Midway's scripted flight on one arm (legacy or native), headed WebGPU, and for a native arm
# grades its frames against the legacy runs (parity.ts). A failing grade exits 3: do not time that build.
#
#   MIDWAY_LEGACY_DIR=... MIDWAY_NATIVE_DIR=... MIDWAY_PARITY_REFS="<legacy run> <legacy run>" \
#     sh scripts/midway-bench/flight.sh native <tag>
#
# The desktop engine player is a third arm: `flight.sh desktop <tag>` runs flight-bench-desktop.playtest.json
# on the packaged player (MIDWAY_PLAYER_DIR, the output of package-engine-desktop.mjs) and grades it the same way.
#
# Env: MIDWAY_PLAYER_DIR   desktop arm only: the packaged engine player directory
#      MIDWAY_LEGACY_DIR, MIDWAY_NATIVE_DIR  game copies (same game commit; engine "legacy" and "native")
#      MIDWAY_RUNS         where runs are written (default ${XDG_CACHE_HOME:-~/.cache}/midway-runs)
#      MIDWAY_PARITY_REFS  two or more legacy run dirs, required for a native run
#      MIDWAY_SCENARIO     scenario file (default: flight-bench.playtest.json beside this script)
#      TN_HEAVY_LOCK       flock file serializing GPU-heavy work, when other lanes share the machine
#      TN_VK_ICD, TN_VK_LIB  Vulkan ICD json and library dir, for a per-process GPU driver override
set -u
ARM=${1:?usage: flight.sh <legacy|native|desktop> <tag>}
TAG=${2:?usage: flight.sh <legacy|native> <tag>}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
case $ARM in
  native) GAME=${MIDWAY_NATIVE_DIR:?set MIDWAY_NATIVE_DIR} ;;
  legacy) GAME=${MIDWAY_LEGACY_DIR:?set MIDWAY_LEGACY_DIR} ;;
  desktop) GAME=${MIDWAY_PLAYER_DIR:?set MIDWAY_PLAYER_DIR} ;;
  *) echo "arm must be legacy, native or desktop" >&2; exit 2 ;;
esac
if [ "$ARM" != legacy ] && [ "$(echo "${MIDWAY_PARITY_REFS:-}" | wc -w)" -lt 2 ]; then
  echo "native runs need MIDWAY_PARITY_REFS with two legacy run dirs" >&2
  exit 2
fi
RUNS=${MIDWAY_RUNS:-${XDG_CACHE_HOME:-$HOME/.cache}/midway-runs}
OUT=$RUNS/$TAG-$ARM
SCENARIO=${MIDWAY_SCENARIO:-$HERE/flight-bench.playtest.json}
[ "$ARM" = desktop ] && SCENARIO=${MIDWAY_SCENARIO:-$HERE/flight-bench-desktop.playtest.json}
mkdir -p "$OUT"
cd "$GAME" || exit 2
LOCK=${TN_HEAVY_LOCK:+flock $TN_HEAVY_LOCK}
GPU_ENV=${TN_VK_ICD:+VK_ICD_FILENAMES=$TN_VK_ICD}
# A loaded host stalls the page's `describe` past the playtest's default operation timeout, so give it room.
if [ "$ARM" = desktop ]; then
  # shellcheck disable=SC2086
  $LOCK env -u DISPLAY $GPU_ENV ${TN_VK_LIB:+LD_LIBRARY_PATH=$TN_VK_LIB} \
    node "$REPO/packages/playtest/dist/runner/cli.js" "$SCENARIO" --target desktop \
    --executable "$GAME/tn-native-engine-player-v8" --host-arg "$GAME/game.js" \
    --headed --timeout 240000 --artifacts "$OUT" > "$OUT/run.log" 2>&1
else
# shellcheck disable=SC2086
$LOCK env -u DISPLAY $GPU_ENV ${TN_VK_LIB:+LD_LIBRARY_PATH=$TN_VK_LIB} \
  node_modules/.bin/threenative-playtest --scenario "$SCENARIO" \
  --browser-recipe webgpu --timeout 180000 --headed --artifacts "$OUT" \
  --server-command 'pnpm dev --host 127.0.0.1 --port $PORT --strictPort' > "$OUT/run.log" 2>&1
fi
STATUS=$?
echo "$ARM exit $STATUS"
tail -30 "$OUT/run.log"
[ "$STATUS" = 0 ] || exit "$STATUS"
if [ "$ARM" != legacy ]; then
  # shellcheck disable=SC2086
  (cd "$REPO" && pnpm exec tsx scripts/midway-bench/parity.ts "$OUT" $MIDWAY_PARITY_REFS) | tee "$OUT/parity.json" | tail -1
  [ "$(tail -1 "$OUT/parity.json")" = "PARITY PASS" ] || { echo "PARITY FAIL: do not time this build"; exit 3; }
fi
