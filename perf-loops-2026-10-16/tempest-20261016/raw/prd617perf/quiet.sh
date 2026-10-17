#!/usr/bin/env bash
# wait until the shared GPU is idle: util <= 8% on 4 consecutive 2 s samples and load1 <= 12
ok=0
while [ $ok -lt 4 ]; do
  u=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -1)
  l=$(cut -d' ' -f1 /proc/loadavg)
  if [ "$u" -le 8 ] && awk -v l=$l 'BEGIN{exit !(l<=12)}'; then ok=$((ok+1)); else ok=0; fi
  sleep 2
done
echo "util=$u load1=$l"
