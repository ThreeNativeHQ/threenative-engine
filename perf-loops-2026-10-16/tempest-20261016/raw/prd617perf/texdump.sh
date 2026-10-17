#!/usr/bin/env bash
CLI=/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd617-perf/packages/playtest/dist/runner/cli.js
unset TN_PLAYTEST_HOST_DISPLAY; export CAPTURE_LOCK_TIMEOUT_MS=2400000
for a in O:rain:5500 L:rain-legacy:5501; do IFS=: read arm g p <<<"$a"
 rm -rf "/tmp/prd617perf/runs/tex-${arm:?}"
 node $CLI /tmp/prd617perf/short.playtest.json --project /tmp/prd617perf/$g --url "http://127.0.0.1:$p/?dumpwgsl=1" --browser-recipe webgpu --headed --artifacts /tmp/prd617perf/runs/tex-$arm > /tmp/prd617perf/runs/tex-$arm.log 2>&1
 python3 - $arm <<'PY'
import json,sys
arm=sys.argv[1]
c=json.load(open(f"/tmp/prd617perf/runs/tex-{arm}/console.json"))
print("==",arm)
for e in c:
    if e["text"].startswith("TEXDUMP"):
        d=json.loads(e["text"][8:])
        s=d["s"]; 
        w=s[0] if isinstance(s,list) else s.get("width"); 
        if w is not None and w>=300: print(d)
PY
done
