#!/usr/bin/env bash
# The pre-push tier: bounded drift checks, and nothing that needs a fresh workspace build, GPU or a
# clock (three drift specs import packages' dist, so a never-built checkout needs one workspace build first).
# Full local verification remains `pnpm ci:local`.
#
# Chosen by what actually broke `main` in one session: a spec pinning a template's old contract,
# a scaffold hash not recomputed with the bytes it hashes, relative links left dangling by a folder
# move, a manifest rewritten without Biome's formatting, and a stale generated census. Every one of
# those reproduces here in seconds and cost a 15-minute push-and-wait cycle to discover instead.
#
# Deliberately NOT here: whole-workspace typecheck and budgets, `test`, `test-browser`,
# `test-playtest`, `golden-path`, `visuals`, and `template.spec.ts`, whose scaffold typecheck reads the
# packages' built `dist` and so goes red on any checkout whose build is stale (it runs in CI's `test`
# job and `ci:local`). They are minutes to tens of minutes, and a hook people
# skip is worse than no hook — it manufactures confidence without providing it. They live in
# `pnpm ci:local`, and this bounded hook never proves runtime correctness.
set -u
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
log_root="${TN_CI_FAST_LOGS:-$(mktemp -d /tmp/tn-ci-fast.XXXXXX)}"
mkdir -p "$log_root"

# Report the same complete-diff decision as CI without pretending this bounded hook runs it.
target="${TN_CI_TARGET:-$(git config --get threenative.integrationBranch || echo main)}"
if ! node scripts/ci-change-scope.mjs --event pull_request --target "$target" \
  --base "${TN_CI_BASE:-origin/$target}" --head "${TN_CI_HEAD:-HEAD}" --local; then exit 2; fi
echo 'ci:fast is bounded drift verification only; use ci:local --affected or --full for selected local checks. Native platforms are not executed here.'

# A fresh worktree has no `dist`, and three drift specs import packages through it: say so plainly
# instead of failing with three "Failed to resolve entry" stacks.
for pkg in assets physics create-threenative; do
  [ -d "packages/$pkg/dist" ] || {
    echo "ci:fast: packages/$pkg/dist is missing; this checkout needs one workspace build before it can push." >&2
    exit 2
  }
done

declare -a names=() cmds=()
add() { names+=("$1"); cmds+=("$2"); }
add lint      'pnpm lint'
add docs      'pnpm check:docs'
add agents    'pnpm sync:agents --check'
add drift     'pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts packages/create-threenative/__tests__/playtest.spec.ts packages/create-threenative/__tests__/platformer.spec.ts scripts/__tests__/package-list-drift.spec.ts scripts/__tests__/api-surface.spec.ts scripts/__tests__/xvfb.spec.ts scripts/__tests__/ci-structure.spec.ts'

# Stages share nothing, so they run at once and the hook costs its slowest stage.
status=0
pids=()
for index in "${!names[@]}"; do
  name="${names[$index]}"
  (
    start=$(date +%s)
    if eval "${cmds[$index]}" >"$log_root/$name.log" 2>&1; then
      printf '%-12s pass  %3ss\n' "$name" "$(( $(date +%s) - start ))"
    else
      printf '%-12s FAIL  %3ss   %s\n' "$name" "$(( $(date +%s) - start ))" "$log_root/$name.log"
      exit 1
    fi
  ) &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
exit "$status"
