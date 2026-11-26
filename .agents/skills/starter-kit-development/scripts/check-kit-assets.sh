#!/bin/bash
# Prove the minimal-asset rule on a kept scaffold: its assets/ holds only mannequin-combat.glb.
# Usage: check-kit-assets.sh <kept scaffold root>   (the TN_TEMPLATE_KEEP root, or one kit inside it)
set -eu
root="${1:?usage: check-kit-assets.sh <kept scaffold root>}"
status=0
while IFS= read -r assets; do
  extra=$(find "$assets" -type f ! -name mannequin-combat.glb | sort)
  if [ -n "$extra" ]; then
    echo "FAIL ${assets}: files beyond mannequin-combat.glb:"
    echo "$extra"
    status=1
  else
    echo "ok   ${assets}"
  fi
done < <(find "$root" -type d -name assets -not -path "*/node_modules/*" -not -path "*/dist/*")
exit "$status"
