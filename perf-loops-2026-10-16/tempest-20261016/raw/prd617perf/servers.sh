#!/usr/bin/env bash
# usage: servers.sh start|stop
D=/tmp/prd617perf
case $1 in
stop) for f in $D/vite5500.pid $D/vite5501.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "${f:?}"; done
      for p in 5500 5501; do lsof -ti tcp:$p | xargs -r kill; done;;
start) for pair in rain:5500 rain-legacy:5501; do g=${pair%%:*}; p=${pair##*:}
  rm -rf "${D:?}/${g:?}/node_modules/.vite"
  (cd "$D/$g" && nohup node node_modules/vite/bin/vite.js --host 127.0.0.1 --port $p --strictPort > $D/vite$p.log 2>&1 & echo $! > $D/vite$p.pid); done
  for p in 5500 5501; do until curl -s -o /dev/null http://127.0.0.1:$p/; do sleep 1; done; done; echo up;;
esac
