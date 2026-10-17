#!/usr/bin/env bash
# Per-pass paired runs with a quiet-GPU gate. usage: TAG=x ROUNDS=3 ARMS="L O" URLQ="" pp.sh
D=/tmp/prd617perf
CLI=/home/joao/projects/threenative/threenative-engine/.claude/worktrees/prd617-perf/packages/playtest/dist/runner/cli.js
unset TN_PLAYTEST_HOST_DISPLAY; export CAPTURE_LOCK_TIMEOUT_MS=2400000
TAG=${TAG:-pp}; ARMS=${ARMS:-"L O"}; mkdir -p $D/runs; : > $D/runs/$TAG.tsv
for i in $(seq 1 ${ROUNDS:-3}); do for arm in $ARMS; do
  case $arm in L) proj=$D/rain-legacy; port=5501;; O) proj=$D/rain; port=5500;; H) proj=$D/rain-hr; port=5502;; S) proj=$D/rain-hr2; port=5503;; esac
  q=$($D/quiet.sh); out=$D/runs/$TAG-$arm$i
  for try in $(seq 1 30); do
    rm -rf "${out:?}"; node $CLI ${SCEN:-$D/passms.playtest.json} --project $proj --url "http://127.0.0.1:$port/${URLQ:-}" --browser-recipe webgpu --headed --artifacts $out > $out.log 2>&1; rc=$?
    [ $rc -ne 75 ] && break
  done
  python3 - "$arm" "$i" "$q" "$rc" "$out" >> $D/runs/$TAG.tsv <<'PY'
import json,sys,re
arm,i,q,rc,out=sys.argv[1:]
try:
    c=json.load(open(out+"/console.json"))
    cls=[e["text"] for e in c if e["text"].startswith("TN_GPU_CLASS")]
    ad="nvidia/turing" if cls and '"architecture":"turing"' in cls[0] and '"vendor":"nvidia"' in cls[0] else "NOT-NVIDIA"
    fb=[json.loads(e["text"].split(":",1)[1]) for e in c if e["text"].startswith("TN_FRAME_BUDGET:")]
    pres=fb[-1]["presented"]["p50"] if fb else None
    if arm in ("O","H","S"):
        l=[e["text"] for e in c if "PASSPROF" in e["text"]]
        parts=l[-1].split(" | ")[1:]
        d={p.split("=")[0]:float(re.match(r"[\d.]+",p.split("=")[1]).group()) for p in parts if "=" in p}
        sc=max((v for k,v in d.items() if k!="SUM"),default=0); tot=d.get("SUM")
    else:
        d={"gpuMs":fb[-1].get("gpuMs")}; sc=0; tot=fb[-1].get("gpuMs")
    print(f"{arm}{i}\t{q}\trc={rc}\t{d}\tmain={sc:.1f}\ttotal={tot:.1f}\tpres_p50={pres}\t{ad}")
except Exception as e:
    print(f"{arm}{i}\t{q}\trc={rc}\tERR {e}")
PY
done; done
