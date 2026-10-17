#!/usr/bin/env bash
# usage: TAG=n2 VARIANTS="n1 n2" ROUNDS=3 altpair.sh   (ours only, engine gpuMs from TN_FRAME_BUDGET; quiet-GPU gated)
D=/tmp/prd617perf; : > $D/runs/$TAG.alt.tsv
for i in $(seq 1 ${ROUNDS:-3}); do for v in $VARIANTS; do
  WASM_DIR=$D/wasm-$v $D/install-wasm.sh > /dev/null
  q=$($D/quiet.sh)
  out=$D/runs/$TAG-$v$i
  TAG=$TAG-$v$i SCEN=${SCEN:-$D/noperf.playtest.json} ARMS=O ROUNDS=1 URLQ="${URLQ:-}" $D/paired.sh2 >/dev/null 2>&1
  cat $D/runs/$TAG-$v$i.tsv | sed "s/^/$v\t/" >> $D/runs/$TAG.alt.tsv
done; done
