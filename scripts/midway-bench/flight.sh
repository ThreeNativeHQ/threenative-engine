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
#      MIDWAY_PARITY_REFS  visual-only legacy run dirs, required for a native run
#      MIDWAY_BROWSER_CLOCK  wall-clock (default timing) or fixed-step (visual references)
#      MIDWAY_SCENARIO     scenario file (default: flight-bench.playtest.json beside this script)
#      TN_HEAVY_LOCK       flock file serializing GPU-heavy work, when other lanes share the machine
#      TN_VK_ICD, TN_VK_LIB  Vulkan ICD json and library dir, for a per-process GPU driver override
set -u
ARM=${1:?usage: flight.sh <legacy|native|desktop> <tag>}
TAG=${2:?usage: flight.sh <legacy|native> <tag>}
case ${MIDWAY_CPU_PROFILE:-0} in
  0|1) PROFILE=${MIDWAY_CPU_PROFILE:-0} ;;
  *) echo "MIDWAY_CPU_PROFILE must be 0 or 1" >&2; exit 2 ;;
esac
[ "$PROFILE" = 1 ] && MIDWAY_MATCHED_CPU=1
case ${MIDWAY_MATCHED_CPU:-0} in
  0|1) MATCHED_CPU=${MIDWAY_MATCHED_CPU:-0} ;;
  *) echo "MIDWAY_MATCHED_CPU must be 0 or 1" >&2; exit 2 ;;
esac
DEFAULT_CLOCK=wall-clock
if [ "$MATCHED_CPU" = 1 ]; then
  DEFAULT_CLOCK=fixed-step
  [ "${MIDWAY_BROWSER_CLOCK:-fixed-step}" = fixed-step ] || { echo "matched CPU requires fixed-step, not wall-clock" >&2; exit 2; }
fi
case ${MIDWAY_BROWSER_CLOCK:-$DEFAULT_CLOCK} in
  wall-clock) BROWSER_CLOCK_ARG=--live-clock ;;
  fixed-step) BROWSER_CLOCK_ARG= ;;
  *) echo "MIDWAY_BROWSER_CLOCK must be wall-clock or fixed-step" >&2; exit 2 ;;
esac
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
# Profile overhead is diagnostic: keep these runs outside the dashboard's top-level timing inputs.
[ "$PROFILE" = 1 ] && OUT=$RUNS/profiles/$TAG-$ARM
SCENARIO=${MIDWAY_SCENARIO:-$HERE/flight-bench.playtest.json}
[ "$ARM" = desktop ] && SCENARIO=${MIDWAY_SCENARIO:-$HERE/flight-bench-desktop.playtest.json}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
if [ "$MATCHED_CPU" = 1 ]; then
  CPU_LABELS='["released-stick-climb","canopy-and-instruments","gun-view"]'
  node --input-type=module - "$SCENARIO" "$OUT/matched-cpu.playtest.json" "$CPU_LABELS" <<'JS' || exit 2
import { readFileSync, writeFileSync } from "node:fs";
const scenario = JSON.parse(readFileSync(process.argv[2], "utf8"));
const labels = JSON.parse(process.argv[4]);
for (const [i, label] of labels.entries()) {
  const steps = scenario.steps.filter((step) => step.label === label);
  if (steps.length !== 1 || steps[0].kind !== "wait" || steps[0].screenshot !== ["takeoff.png", "cockpit.png", "reargun.png"][i]) throw new Error(`missing/nonunique screenshot wait: ${label}`);
  steps[0].waitTicks = 1000;
}
writeFileSync(process.argv[3], JSON.stringify(scenario, null, 2) + "\n");
JS
  SCENARIO=$OUT/matched-cpu.playtest.json
fi
: > "$OUT/run.log"
[ "$PROFILE" = 1 ] && rm -f "$OUT/flight.cpuprofile" "$OUT/profile-owners.json"
# The host's load around the run: the dashboard leaves a run flown on a loaded host out of its ms trends.
loadnow() { echo "load $(cut -d' ' -f1 /proc/loadavg)" >> "$OUT/host-load.txt"; }
echo "cores $(nproc)" > "$OUT/host-load.txt"
loadnow
LEGACY=${MIDWAY_LEGACY_DIR:?set MIDWAY_LEGACY_DIR for matched provenance}
NATIVE=${MIDWAY_NATIVE_DIR:?set MIDWAY_NATIVE_DIR for matched provenance}
COMMIT=$(sh "$HERE/install.sh" "$LEGACY" --verify "${MIDWAY_PLAYER_DIR:-}" "$NATIVE") || exit 2
BUILD_MODE=production
[ "$ARM" = desktop ] && BUILD_MODE=desktop-bundle
echo "arm=$ARM buildMode=$BUILD_MODE engineCommit=$COMMIT" > "$OUT/run.log"
cd "$GAME" || exit 2
if [ "$ARM" != desktop ]; then
  if [ "$PROFILE" = 1 ]; then
    pnpm run build:web --sourcemap >> "$OUT/run.log" 2>&1 || { tail -30 "$OUT/run.log" >&2; exit 2; }
  else
    pnpm run build:web >> "$OUT/run.log" 2>&1 || { tail -30 "$OUT/run.log" >&2; exit 2; }
  fi
  sh "$HERE/install.sh" "$GAME" --verify-web "${MIDWAY_PLAYER_DIR:-}" >> "$OUT/run.log" 2>&1 || { tail -30 "$OUT/run.log" >&2; exit 2; }
fi
PROFILE_PATH=
[ "$PROFILE" = 1 ] && PROFILE_PATH=$OUT/flight.cpuprofile
LOCK=${TN_HEAVY_LOCK:+flock $TN_HEAVY_LOCK}
GPU_ENV=${TN_VK_ICD:+VK_ICD_FILENAMES=$TN_VK_ICD}
# The runner paints on a private Xvfb unless TN_PLAYTEST_HOST_DISPLAY asks for the session's display.
NO_DISPLAY="-u DISPLAY"
[ -n "${TN_PLAYTEST_HOST_DISPLAY:-}" ] && NO_DISPLAY=
# A loaded host stalls the page's `describe` past the playtest's default operation timeout, so give it room.
if [ "$ARM" = desktop ]; then
  [ "$MATCHED_CPU" = 1 ] && export TN_PLAYER_METRICS=1 TN_PLAYER_MAIN_THREAD_CPU=1
  # shellcheck disable=SC2086
  $LOCK env -u TN_PLAYTEST_CPU_WINDOW_LABELS $NO_DISPLAY $GPU_ENV ${TN_VK_LIB:+LD_LIBRARY_PATH=$TN_VK_LIB} \
    ${CPU_LABELS:+TN_PLAYTEST_CPU_WINDOW_LABELS=$CPU_LABELS} \
    node "$REPO/packages/playtest/dist/runner/cli.js" "$SCENARIO" --target desktop \
    --executable "$GAME/tn-native-engine-player-v8" --host-arg "$GAME/game.js" \
    --headed --timeout 240000 --artifacts "$OUT" ${PROFILE_PATH:+--cpu-prof "$PROFILE_PATH"} >> "$OUT/run.log" 2>&1
else
# shellcheck disable=SC2086
$LOCK env -u TN_PLAYTEST_CPU_WINDOW_LABELS $NO_DISPLAY $GPU_ENV ${TN_VK_LIB:+LD_LIBRARY_PATH=$TN_VK_LIB} \
    ${CPU_LABELS:+TN_PLAYTEST_CPU_WINDOW_LABELS=$CPU_LABELS} \
  node_modules/.bin/threenative-playtest --scenario "$SCENARIO" \
  --browser-recipe webgpu --timeout 180000 --headed --artifacts "$OUT" \
  $BROWSER_CLOCK_ARG ${PROFILE_PATH:+--cpu-prof "$PROFILE_PATH"} \
  --server-command 'pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort' >> "$OUT/run.log" 2>&1
fi
STATUS=$?
loadnow
echo "$ARM exit $STATUS"
tail -30 "$OUT/run.log"
[ "$STATUS" = 0 ] || exit "$STATUS"
sh "$HERE/install.sh" "$LEGACY" --verify "${MIDWAY_PLAYER_DIR:-}" "$NATIVE" > /dev/null 2>> "$OUT/run.log" || { tail -30 "$OUT/run.log" >&2; exit 2; }
if [ "$ARM" != desktop ]; then
  sh "$HERE/install.sh" "$GAME" --verify-web "${MIDWAY_PLAYER_DIR:-}" > /dev/null 2>> "$OUT/run.log" || { tail -30 "$OUT/run.log" >&2; exit 2; }
  node --input-type=module - "$OUT/run.log" >> "$OUT/run.log" 2>&1 <<'JS' || { tail -30 "$OUT/run.log" >&2; exit 2; }
import { readFileSync } from "node:fs";
const log = readFileSync(process.argv[2], "utf8");
const start = log.lastIndexOf('\n{');
const report = JSON.parse(log.slice(start < 0 ? 0 : start + 1));
const requests = report.acquisition?.requestUrls;
if (!Array.isArray(requests) || !requests.length || requests.some((url) => typeof url !== "string")) throw new Error("missing/malformed acquisition request evidence");
if (requests.some((url) => decodeURIComponent(new URL(url).pathname).endsWith("/@vite/client"))) throw new Error("production flight loaded /@vite/client");
JS
fi
if [ "$ARM" != legacy ]; then
  # shellcheck disable=SC2086
  (cd "$REPO" && pnpm exec tsx scripts/midway-bench/parity.ts "$OUT" $MIDWAY_PARITY_REFS) | tee "$OUT/parity.json" | tail -1
  [ "$(tail -1 "$OUT/parity.json")" = "PARITY PASS" ] || { echo "PARITY FAIL: do not time this build"; exit 3; }
fi

if [ "$MATCHED_CPU" = 1 ]; then
  node --import "$REPO/node_modules/tsx/dist/loader.mjs" --input-type=module - "$OUT/run.log" "$HERE/dashboard.ts" <<'JS' || exit 2
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { matchedCpuWindows, terminalReport } = await import(pathToFileURL(process.argv[3]).href);
const log = readFileSync(process.argv[2], "utf8");
const arm = /^arm=(\w+)/m.exec(log)?.[1];
if (terminalReport(log)?.runtime !== (arm === "desktop" ? "native" : "web") || !matchedCpuWindows(log)) throw new Error("matched CPU acquisition unavailable/invalid: require three fixed-step windows with 1000 frames/updates/renders and positive OS counters");
JS
fi

if [ "$PROFILE" = 1 ]; then
  SOURCE=$GAME
  ARTIFACT=$GAME/dist
  if [ "$ARM" = desktop ]; then SOURCE=$NATIVE; ARTIFACT=$GAME; fi
  node --import "$REPO/node_modules/tsx/dist/loader.mjs" "$HERE/profile-owners.ts" \
    "$OUT" "$SOURCE" "$ARTIFACT" "$REPO" "$ARM" || exit 2
fi
