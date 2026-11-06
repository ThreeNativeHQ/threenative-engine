#!/usr/bin/env bash
# Regenerate every generated artifact, then say which ones moved.
#
# Four separate pushes were blocked in one session for the same reason in different files: a
# generated thing was stale and nobody knew until a gate said so, one at a time, each costing a
# cycle. They are all derived from source, so none of them needs to be discovered — they need to be
# regenerated together before the gates run.
#
#   capabilities.json + capability reference   `pnpm build`     (public surface)
#   native coverage digest                     native:coverage  (C++ source digest)
#   native census                              `pnpm census`    (line counts)
#   CLAUDE.md mirrors                          `pnpm sync:agents`
#   alpha-bar table                            `pnpm alpha:bar --write`
#
# Scaffold hashes are deliberately absent: they pin bytes a human should look at before accepting,
# and a script that silently rewrites them would turn a real regression into a green diff.
set -u
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
before=$(git status --porcelain)
step() { printf '%-22s ' "$1"; shift; if "$@" >/dev/null 2>&1; then echo ok; else echo "FAILED — $*"; fi; }
step "capabilities"  pnpm build
step "native coverage" pnpm --filter @threenative/runtime-native native:coverage
step "census"        pnpm census
step "agent mirrors" pnpm sync:agents
# `alpha:bar --write` exits non-zero whenever a row of the bar is failing, which is its normal
# state and not a generator error. Regenerate the table, ignore the verdict.
printf '%-22s ' "alpha bar"; pnpm alpha:bar --write >/dev/null 2>&1; echo "ok (verdict ignored)"
after=$(git status --porcelain)
echo
if [ "$before" = "$after" ]; then
  echo "nothing regenerated — every generated artifact was already current"
else
  echo "regenerated (commit these with the change that moved them):"
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep '^>' | sed 's/^> /  /'
fi
echo
echo "next: pnpm ci:fast"
