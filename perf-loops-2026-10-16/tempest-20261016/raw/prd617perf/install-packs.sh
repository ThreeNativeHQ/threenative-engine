#!/usr/bin/env bash
# usage: install-packs.sh <packs-dir> ; replaces three packages' content in both game copies
set -e
PK=$1
for game in rain rain-legacy; do
  for pair in "threenative-three-native-0.3.4.tgz:@threenative/three-native" "threenative-runtime-native-0.3.4.tgz:@threenative/runtime-native" "create-threenative-0.2.8.tgz:create-threenative" "threenative-core-0.3.4.tgz:@threenative/core"; do
    tgz=${pair%%:*}; name=${pair##*:}
    dir=$(readlink -f /tmp/prd617perf/$game/node_modules/$name)
    [ -d "$dir" ] || { echo "missing $dir"; exit 1; }
    find "$dir" -mindepth 1 -maxdepth 1 -not -name node_modules -exec rm -rf {} +
    tar xzf $PK/$tgz -C "$dir" --strip-components=1
  done
done
echo installed from $PK
