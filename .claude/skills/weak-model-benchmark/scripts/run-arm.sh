#!/usr/bin/env bash
# Run one DeepSeek V4.1 Flash max builder arm in a scaffolded sandbox game.
# Usage: run-arm.sh <game-dir> <out-dir> [prompt]
# Writes <out-dir>/session/*.jsonl, <out-dir>/arm.log and <out-dir>/friction.json.
# Exit: 0 VALID run, 1 VOID run (wrong model or thinking level), 2 bad input.
set -u
GAME="$(realpath "${1:?game dir}")"; OUT="$(realpath -m "${2:?out dir}")"
PROMPT="${3:-Build the game described in brief.md so it looks like reference.png. It is done when it plays from the spawn.}"
MINUTES="${WM_ARM_MINUTES:-90}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$GAME/package.json" ] || { echo "not a scaffolded game: $GAME" >&2; exit 2; }
mkdir -p "$OUT/session"

# leanpi's Auto router can escalate to Claude Opus. Pin every role to DeepSeek flash in a private config.
XDG="${WM_XDG:-$HOME/.cache/tmp-tn/weak-model/xdg}"
if [ ! -f "$XDG/leanpi/leanpi.config.yaml" ]; then
  SRC="${LEANPI_CONFIG_DIR:-$HOME/.config/leanpi}"
  mkdir -p "$XDG/leanpi"
  for f in credentials.json permissions.json ui.json; do ln -sf "$SRC/$f" "$XDG/leanpi/$f"; done
  ln -sfn "$HOME/.config/gh" "$XDG/gh"
  YAML="$(dirname "$(readlink -f "$(command -v leanpi)")")"
  while [ ! -f "$YAML/package.json" ]; do YAML="$(dirname "$YAML")"; done
  node -e '
    const { createRequire } = require("node:module");
    const yaml = createRequire(process.argv[1] + "/package.json")("yaml");
    const fs = require("node:fs");
    const cfg = yaml.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (!cfg.backends?.["opencode-go"]) throw new Error("leanpi config has no opencode-go backend");
    cfg.models = Object.fromEntries(Object.keys(cfg.models ?? { quick: 0 }).map((k) => [k, { backend: "opencode-go", model: "deepseek-v4.1-flash" }]));
    cfg.jev = { mode: "disabled" };
    cfg.capability = { roles: { strong: { pin: "deepseek-v4.1-flash" } } };
    fs.writeFileSync(process.argv[3], yaml.stringify(cfg));
  ' "$YAML" "$SRC/leanpi.config.yaml" "$XDG/leanpi/leanpi.config.yaml" || exit 2
fi

cd "$GAME" || exit 2
# A user trusts their own project once (`/permissions trust project`). Untrusted, leanpi drops the
# project's MCP configs, so the arm would see no engine tool for a reason no user hits twice.
LEANPI_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v leanpi)")")")"
NODE=""
for c in "$(command -v node)" "$HOME"/.nvm/versions/node/v*/bin/node; do
  "$c" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null && { NODE="$c"; break; }
done
[ -n "$NODE" ] || { echo "no Node >= 22.19 for the leanpi trust grant" >&2; exit 2; }
XDG_CONFIG_HOME="$XDG" "$NODE" --input-type=module -e '
  const { grantTrust } = await import(process.argv[1] + "/dist/permissions/trust.js");
  const r = grantTrust(process.cwd(), process.env);
  if (!r.trusted) throw new Error(`trust grant failed: ${r.reason}`);
' "$LEANPI_ROOT" || exit 2

# leanpi -p does not close its MCP children at the end, so it idles to the cap after its last
# answer. Stop the arm when the session's last message is a final `stop` and nothing was written
# for WM_IDLE_SECONDS.
UNIT="wm-arm-$$"
IDLE="${WM_IDLE_SECONDS:-300}"
XDG_CONFIG_HOME="$XDG" systemd-run --user --scope -q --unit "$UNIT" -p MemoryMax=6G -p MemorySwapMax=1G \
  timeout "${MINUTES}m" setsid --wait leanpi -p --approve \
  --model opencode-go/deepseek-v4.1-flash:max --session-dir "$OUT/session" \
  "$PROMPT" </dev/null >"$OUT/arm.log" 2>&1 &
ARM=$!
while kill -0 "$ARM" 2>/dev/null; do
  sleep 15
  S="$(ls -t "$OUT"/session/*.jsonl 2>/dev/null | head -1)"
  [ -n "$S" ] || continue
  if [ $(( $(date +%s) - $(stat -c %Y "$S") )) -ge "$IDLE" ] && grep '"type":"message"' "$S" | tail -n 1 | grep -q '"stopReason":"stop"'; then
    echo "arm idle ${IDLE}s after a final stop; stopping $UNIT" >>"$OUT/arm.log"
    systemctl --user stop "$UNIT.scope" 2>/dev/null
  fi
done
wait "$ARM"
echo "arm exit=$? (124 = hit the ${MINUTES} min cap, 143 = stopped idle after the final answer)" | tee -a "$OUT/arm.log"

SESSION="$(ls -t "$OUT"/session/*.jsonl 2>/dev/null | head -1)"
[ -n "$SESSION" ] || { echo "no session log in $OUT/session" >&2; exit 1; }
node "$HERE/friction.mjs" "$SESSION" >"$OUT/friction.json"; rc=$?
cat "$OUT/friction.json"; exit $rc
