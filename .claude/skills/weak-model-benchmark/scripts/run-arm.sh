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
# A user trusts their own project once (`leanpi trust`, as Claude Code asks once). Untrusted, leanpi
# drops the project's `.mcp.json`, so the arm would see no engine tool for a reason no user hits twice.
LEANPI_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v leanpi)")")")"
XDG_CONFIG_HOME="$XDG" leanpi trust "$GAME" >/dev/null || { echo "leanpi trust failed (needs leanpi >= 0.1.23)" >&2; exit 2; }

# leanpi -p does not close its MCP children at the end, so it idles to the cap after its last
# answer. Stop the arm when the session's last message is a final `stop` and nothing was written
# for WM_IDLE_SECONDS.
UNIT="wm-arm-$$"
IDLE="${WM_IDLE_SECONDS:-300}"
# The arm builds as a developer would, on a machine that holds only its own project: round 2 read the
# sealed proof out of a repo checkout on this disk. Home and /tmp are empty inside the jail; only the
# sandbox, the toolchain a developer installs (leanpi patches its own vendor code at start, so it is
# writable), the arm's config and its session folder come back.
command -v bwrap >/dev/null || { echo "bwrap is required: an arm never runs unisolated" >&2; exit 2; }
SANDBOX="$(dirname "$GAME")"
mkdir -p "$OUT/session"
JAIL=(bwrap --die-with-parent --ro-bind / / --dev-bind /dev /dev --proc /proc --tmpfs /tmp --tmpfs "$HOME"
  --bind "$LEANPI_ROOT" "$LEANPI_ROOT"
  --ro-bind "$(dirname "$(command -v leanpi)")" "$(dirname "$(command -v leanpi)")"
  --ro-bind-try "$HOME/.nvm" "$HOME/.nvm"
  --ro-bind-try "$HOME/.config/leanpi" "$HOME/.config/leanpi"
  --ro-bind-try "$HOME/.cache/ms-playwright" "$HOME/.cache/ms-playwright"
  --bind-try "$HOME/.local/share/pnpm" "$HOME/.local/share/pnpm"
  --bind "$XDG" "$XDG" --bind "$SANDBOX" "$SANDBOX" --bind "$OUT/session" "$OUT/session"
  --chdir "$GAME")
# The agent's own config, never its history: ~/.pi/agent also holds every past session of every project.
# Without models-store.json and model.json the model loses its `max` thinking level (VOID run).
for f in .pi/agent/settings.json .pi/agent/models-store.json .pi/agent/auth.json .pi/agent/trust.json \
  .pi/agent/extensions .leanpi/model.json .leanpi/model-ids.json; do
  JAIL+=(--ro-bind-try "$HOME/$f" "$HOME/$f")
done
XDG_CONFIG_HOME="$XDG" systemd-run --user --scope -q --unit "$UNIT" -p MemoryMax=6G -p MemorySwapMax=1G \
  timeout "${MINUTES}m" setsid --wait "${JAIL[@]}" leanpi -p --approve \
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
wait "$ARM"; ARC=$?
# The cap kills only the wrapper: the agent and the servers it started (vite, Xvfb) live on in the
# scope, and a proof run beside them is void. The arm ends with its scope.
systemctl --user stop "$UNIT.scope" 2>/dev/null
echo "arm exit=$ARC (124 = hit the ${MINUTES} min cap, 143 = stopped idle after the final answer)" | tee -a "$OUT/arm.log"

SESSION="$(ls -t "$OUT"/session/*.jsonl 2>/dev/null | head -1)"
[ -n "$SESSION" ] || { echo "no session log in $OUT/session" >&2; exit 1; }
node "$HERE/friction.mjs" "$SESSION" >"$OUT/friction.json"; rc=$?
cat "$OUT/friction.json"; exit $rc
