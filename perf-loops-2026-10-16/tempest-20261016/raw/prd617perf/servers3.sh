#!/usr/bin/env bash
# usage: servers3.sh start|stop|restart <game:port ...>   default: rain:5500 rain-legacy:5501 rain-hr:5502
D=/tmp/prd617perf
cmd=$1; shift
pairs=${*:-"rain:5500 rain-legacy:5501 rain-hr:5502"}
stop() {
  for pair in $pairs; do p=${pair##*:}; lsof -ti tcp:$p | xargs -r kill; done
}
start() {
  for pair in $pairs; do g=${pair%%:*}; p=${pair##*:}
    rm -rf "${D:?}/${g:?}/node_modules/.vite"
    (cd "$D/$g" && nohup node node_modules/vite/bin/vite.js --host 127.0.0.1 --port $p --strictPort > $D/vite$p.log 2>&1 &)
  done
  for pair in $pairs; do p=${pair##*:}; until curl -s -o /dev/null http://127.0.0.1:$p/; do sleep 1; done; done
  echo up
}
case $cmd in
stop) stop;;
start) start;;
restart) stop; sleep 1; start;;
esac
