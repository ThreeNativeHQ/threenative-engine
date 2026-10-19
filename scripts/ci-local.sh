#!/usr/bin/env bash
# Run what CI runs, here, so a red is found in minutes instead of a push-and-wait cycle.
#
# Every job below is the same command the workflow invokes. Two caveats the output repeats, because
# a local pass is not a CI pass:
#   - this machine has a real GPU and more cores, so timing-shaped failures (an operation budget, a
#     job timeout) can pass here and fail there;
#   - `native-platforms` is not run: it needs the hosted matrix.
# Everything else — spec drift, hash drift, doc links, lint, budgets — reproduces exactly.
set -u
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
only=""
affected=false
target="${TN_CI_TARGET:-$(git config --get threenative.integrationBranch || echo main)}"
base="${TN_CI_BASE:-}"
head="${TN_CI_HEAD:-HEAD}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --affected) affected=true ;;
    --full) affected=false ;;
    --base|--head|--target)
      if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
        echo "TN_CI_LOCAL_ARGUMENT: $1 requires a value" >&2; exit 2
      fi
      case "$1" in --base) base="$2" ;; --head) head="$2" ;; --target) target="$2" ;; esac
      shift ;;
    --*) echo "TN_CI_LOCAL_ARGUMENT: unknown option $1" >&2; exit 2 ;;
    *) if [ -n "$only" ]; then echo 'TN_CI_LOCAL_ARGUMENT: only one focused job is allowed' >&2; exit 2; fi; only="$1" ;;
  esac
  shift
done
if [ "$affected" = true ] && [ -n "$only" ]; then
  echo 'TN_CI_LOCAL_ARGUMENT: use a focused job or --affected, not both' >&2; exit 2
fi
base="${base:-origin/$target}"
log_root="${TN_CI_LOCAL_LOGS:-$(mktemp -d /tmp/tn-ci-local.XXXXXX)}"
mkdir -p "$log_root"
echo "logs: $log_root"

# One classifier for hosted and local runs. Dirty/unresolved inputs select the full board.
scope_args=(--full)
if [ "$affected" = true ]; then
  scope_args=(--event pull_request --target "$target" --base "$base" --head "$head" --local)
fi
if ! node scripts/ci-change-scope.mjs "${scope_args[@]}" --format json > "$log_root/selection.json"; then exit 2; fi
if ! node scripts/ci-change-scope.mjs --validate-plan "$(cat "$log_root/selection.json")"; then exit 2; fi
selection="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).selection)' "$log_root/selection.json")" || exit 2
case "$selection" in full|prose|instructions|ci|template|native-engine) ;; *) echo 'TN_CI_LOCAL_INVALID_SELECTION' >&2; exit 2 ;; esac

declare -a names=() cmds=()
add() { names+=("$1"); cmds+=("$2"); }

if [ "$selection" = full ]; then
  add build     'pnpm build && pnpm exec tsx scripts/check-core-boundary.ts'
  add typecheck 'pnpm typecheck'
  add lint      'pnpm lint'
  add budgets   'pnpm budgets && pnpm quality && pnpm sync:agents --check'
  add test      'TN_SUITE_PREBUILT=1 TN_SUITE_PHASES=docs,package-test,unit pnpm test'
  add benchmark 'pnpm tsx scripts/count-loc.ts --check && pnpm --filter abyss-vanilla build && pnpm exec vitest run scripts/__tests__/count-loc.spec.ts scripts/__tests__/score-blind.spec.ts'
  add test-playtest 'pnpm test:playtest:ci'
  add test-browser  'sh scripts/xvfb.sh pnpm test:browser'
  add golden-path   'TN_PLAYTEST_ALLOW_SOFTWARE=1 pnpm verify:golden-path'
  add visuals       'pnpm visuals'

elif [ "$selection" = ci ] || [ "$selection" = template ]; then
  add build 'pnpm build'
  add typecheck 'pnpm typecheck'
  add lint 'pnpm lint'
  add budgets 'pnpm budgets'
  if [ "$selection" = ci ]; then
    add test 'pnpm exec vitest run scripts/__tests__/ci-*.spec.ts'
  else
    export TN_CI_CONTRACTS="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).checks.ci)' "$log_root/selection.json")"
    add test 'pnpm exec vitest run packages/create-threenative/__tests__ scripts/__tests__/verify-golden-path.spec.ts && if [ "$TN_CI_CONTRACTS" = true ]; then pnpm exec vitest run scripts/__tests__/ci-*.spec.ts; fi'
    selected_templates="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).templateMatrix.template.join(","))' "$log_root/selection.json")"
    export TN_GOLDEN_PATH_TEMPLATES="$selected_templates"
    add golden-path 'TN_PLAYTEST_ALLOW_SOFTWARE=1 pnpm verify:golden-path'
    export TN_TEMPLATE_ONLY="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).templateMatrix.template.filter(name => !["starter", "platformer"].includes(name)).join(","))' "$log_root/selection.json")"
    if [ -n "$TN_TEMPLATE_ONLY" ]; then add templates 'pnpm test:templates'; fi
  fi
else
  add lint 'pnpm lint'
  add docs 'pnpm check:docs && pnpm exec vitest run scripts/__tests__/check-doc-links.spec.ts scripts/__tests__/evidence-budget.spec.ts scripts/__tests__/evidence-citations.spec.ts scripts/__tests__/sync-agent-docs.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts'
  if [ "$selection" = instructions ]; then
    add agents 'pnpm build && pnpm sync:agents --check && pnpm exec vitest run scripts/__tests__/instruction-budget.spec.ts scripts/__tests__/primary-docs.spec.ts scripts/__tests__/check-template-conventions.spec.ts scripts/__tests__/check-template-quality.spec.ts packages/playtest/__tests__/doc-drift.spec.ts packages/core/__tests__/constraints.spec.ts'
  fi
fi

case "$only" in
  ""|build|typecheck|lint|budgets|test|benchmark|test-playtest|test-browser|golden-path|visuals)
    ;;
  *)
    printf 'TN_CI_LOCAL_UNKNOWN_JOB: %s\n' "$only" >&2
    exit 2
    ;;
esac

should_run() {
  local name="$1"
  [[ -z "$only" || "$only" == "$name" || ( "$only" == "test" && "$name" == "build" ) ]]
}

status=0
build_status=0
for index in "${!names[@]}"; do
  name="${names[$index]}"
  should_run "$name" || continue
  if [ "$name" = "test" ] && [ "$build_status" -ne 0 ]; then
    printf '%-16s skipped (build failed)\n' "$name"
    continue
  fi
  printf '%-16s ' "$name"
  start=$(date +%s)
  if eval "${cmds[$index]}" >"$log_root/$name.log" 2>&1; then
    printf 'pass  %3ss\n' "$(( $(date +%s) - start ))"
  else
    printf 'FAIL  %3ss   %s\n' "$(( $(date +%s) - start ))" "$log_root/$name.log"
    status=1
    [ "$name" = "build" ] && build_status=1
  fi
  if [ "$name" = "build" ] && [ "$build_status" -ne 0 ]; then
    continue
  fi
done

echo
echo "A local pass is not a CI pass: this machine has a GPU and more cores, so a budget or timeout"
echo "that fits here can still fail there. native-platforms is not covered."
exit "$status"
