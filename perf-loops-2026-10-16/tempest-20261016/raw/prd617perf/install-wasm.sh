#!/usr/bin/env bash
set -e
W=${WASM_DIR:-/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd617-perf/packages/runtime-native/build/web}
for game in rain rain-legacy; do
  d=$(readlink -f /tmp/prd617perf/$game/node_modules/@threenative/runtime-native)/build/web
  [ -d "$d" ] || { echo "missing $d"; exit 1; }
  rm -f "${d:?}/tn-native-engine-web.mjs" "${d:?}/tn-native-engine-web.wasm"
  cp "$W/tn-native-engine-web.mjs" "$W/tn-native-engine-web.wasm" "$d/"
done
/tmp/prd617perf/servers.sh stop; /tmp/prd617perf/servers.sh start
