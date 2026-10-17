#!/usr/bin/env bash
# Alternating L,O paired runs. usage: TAG=name ROUNDS=3 paired.sh   (ARMS="L O" default)
D=/tmp/prd617perf
CLI=/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd617-perf/packages/playtest/dist/runner/cli.js
unset TN_PLAYTEST_HOST_DISPLAY
export CAPTURE_LOCK_TIMEOUT_MS=2400000
SCEN=${SCEN:-$D/noperf.playtest.json}
TAG=${TAG:-paired}; ARMS=${ARMS:-"L O"}
mkdir -p $D/runs; : > $D/runs/$TAG.tsv
for i in $(seq 1 ${ROUNDS:-3}); do
  for arm in $ARMS; do
    if [ $arm = L ]; then proj=$D/rain-legacy; port=5501; else proj=$D/rain; port=5500; fi
    while :; do l=$(cut -d' ' -f1 /proc/loadavg); awk -v l=$l 'BEGIN{exit !(l<=12)}' && break; sleep 10; done
    out=$D/runs/$TAG-$arm$i
    for try in $(seq 1 30); do
      rm -rf "${out:?}"; node $CLI $SCEN --project $proj --url http://127.0.0.1:$port --browser-recipe webgpu --headed --artifacts $out > $out.log 2>&1; rc=$?
      [ $rc -ne 75 ] && break
    done
    python3 - "$arm" "$i" "$l" "$rc" "$out" >> $D/runs/$TAG.tsv <<'PY'
import json,sys
arm,i,load,rc,out=sys.argv[1:]
try:
    c=json.load(open(out+"/console.json"))
    fb=[json.loads(e["text"].split(":",1)[1]) for e in c if e["text"].startswith("TN_FRAME_BUDGET:")]
    cls=[e["text"] for e in c if e["text"].startswith("TN_GPU_CLASS")]
    j=fb[-1]
    ad="turing/nvidia" if cls and '"architecture":"turing"' in cls[0] and '"vendor":"nvidia"' in cls[0] else "NOT-NVIDIA:"+(cls[0][:80] if cls else "none")
    print(f"{arm}{i}\tload1={load}\trc={rc}\tfps={j['fps']}\tframe_p95={j['frame']['p95']}\tpres_p50={j['presented']['p50']}\tgpuMs={j.get('gpuMs')}\tgpu_p95={j['gpu']['p95'] if 'gpu' in j else None}\twin={len(fb)}\t{ad}")
except Exception as e:
    print(f"{arm}{i}\tload1={load}\trc={rc}\tERR {e}")
PY
  done
done
echo done >> $D/runs/$TAG.tsv
