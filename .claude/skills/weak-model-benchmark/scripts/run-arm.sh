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
XDG_CONFIG_HOME="$XDG" systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=1G \
  timeout "${MINUTES}m" setsid --wait leanpi -p --approve \
  --model opencode-go/deepseek-v4.1-flash:max --session-dir "$OUT/session" \
  "$PROMPT" </dev/null >"$OUT/arm.log" 2>&1
echo "arm exit=$? (124 = hit the ${MINUTES} min cap)" | tee -a "$OUT/arm.log"

SESSION="$(ls -t "$OUT"/session/*.jsonl 2>/dev/null | head -1)"
[ -n "$SESSION" ] || { echo "no session log in $OUT/session" >&2; exit 1; }
node "$HERE/friction.mjs" "$SESSION" >"$OUT/friction.json"; rc=$?
cat "$OUT/friction.json"; exit $rc
