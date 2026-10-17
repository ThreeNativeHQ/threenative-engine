#!/usr/bin/env bash
# usage: full.sh "<urlq>" : one gated diag run of ours, prints the whole PASSPROF table
t="f$(echo "$1" | tr -c 'a-z0-9\n' '_')"; TAG=$t ROUNDS=1 ARMS=O URLQ="$1" /tmp/prd617perf/pp.sh
python3 - $t <<'PY'
import json,sys
c=json.load(open(f"/tmp/prd617perf/runs/{sys.argv[1]}-O1/console.json"))
l=[e["text"] for e in c if "PASSPROF" in e["text"]]
print(" ".join(x.strip() for x in l[-1].split(" | ")[1:]))
PY
