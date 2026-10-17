#!/usr/bin/env bash
# usage: dump.sh <tag>  -> runs/wgsl-<tag>-N.wgsl for ours
CLI=/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd617-perf/packages/playtest/dist/runner/cli.js
unset TN_PLAYTEST_HOST_DISPLAY; export CAPTURE_LOCK_TIMEOUT_MS=2400000
tag=$1
rm -rf "/tmp/prd617perf/runs/${tag:?}-art"
node $CLI /tmp/prd617perf/short.playtest.json --project /tmp/prd617perf/rain --url "http://127.0.0.1:5500/?dumpwgsl=1" --browser-recipe webgpu --headed --artifacts /tmp/prd617perf/runs/$tag-art > /tmp/prd617perf/runs/$tag.log 2>&1
python3 - $tag <<'PY'
import json,sys
tag=sys.argv[1]
c=json.load(open(f"/tmp/prd617perf/runs/{tag}-art/console.json"))
mods=[e["text"] for e in c if e["text"].startswith("WGSLDUMP")]
big=max(range(len(mods)),key=lambda i:len(mods[i]))
open(f"/tmp/prd617perf/runs/wgsl-{tag}.wgsl","w").write(mods[big])
print(tag,len(mods),"largest",len(mods[big]))
PY
