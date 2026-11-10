# PRD-838 — Scripts share one runtime layer

**Status:** NOT STARTED
**Priority:** P2 — open Phase 1 replaces 4 helper families copied 5 to 11 times. Five of the 7 dev-server waits burn their full timeout when the server dies at start.
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** PRD-832 (its Phase 1 creates `scripts/lib/repo-inventory.ts`, the first shared module)
**Batch:** [Untangle report, 2026-11-06](README.md) — N1

## Context

Report ids G1, G5, G6, G7. `scripts/` holds about 178 000 lines and one library file
(`scripts/lib/step-cost.ts`).

| Helper family | Copies | Where (sample) |
| --- | --- | --- |
| Dev-server start, wait and stop | 7. Polls of 100 to 500 ms, deadlines of 90 to 240 s. Only 2 check `child.exitCode`. | `scripts/env-cost-probe.ts:81`, `engine-load-test/browser.ts:222`, `visual-gate.ts:371`, `verify-golden-path.ts:1068`, `profile-starter.ts:208`, `profile-native-cpu.ts:590`, `unreal-look/capture-threenative.ts:321` |
| `run()` / exec | 8, two of them verbatim | `verify-one-template.ts:13`, `verify-template-playtests.ts:25`, `make-sandbox.ts:97`, `prepare-release.ts:335` |
| MCP stdio handshake | 5 | `capture-mcp-tools.ts:89`, `capture-asset-mcp-tools.ts:140`, `verify-registry-install.ts:302`, `verify-golden-path.ts:651`, `verify-forest-playtest.ts:146` |
| `gh` wrapper | 4, with different error rules | `ci-change-scope.mjs:624`, `ci-queue-watch.mjs:75`, `ci-merge-latency.mjs:130`, `native-release-reuse.mjs:14` |
| Perf verdict rule | 2 homes, one in a shipped package | `packages/playtest/src/runner/perf.ts:208-232`, `scripts/engine-load-test/report.ts:944-967` |
| Dead or orphan scripts | 5 unreferenced files, 4 gates run only by their own spec | `scripts/release-native-local.mjs`, `asset-pose-capture.mjs`, `realistic-ocean-budget.mjs`, `realistic-ocean-capture.mjs`, `verify-fog-exposure.ts`; `check-capability-examples.ts`, `arm-census.ts`, `asset-parity.ts`, `playtest-pair.ts` |

## Solution

`scripts/lib/{dev-server,exec,mcp-client,gh,args}.ts`, one implementation each. The strictest variant
wins: check the child's exit, throw on non-zero, retry `gh` once. Every local copy is deleted. The perf
verdict moves into `@threenative/playtest`, and `report.ts` imports it. Dead scripts are deleted, and
each orphan gate is wired into `pnpm budgets` or deleted.

## Acceptance Criteria

- [ ] AC-1 [local]: The golden path and one visual gate still run end to end. proof: `pnpm tsx scripts/verify-golden-path.ts` plus `pnpm visuals` on the starter

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Dev-server lifecycle | Visual, profile and golden-path scripts | 7 copies deleted | Phase 1 |

## Execution Phases

#### Phase 1: Shared lib
**Status:** NOT STARTED
**Files:** new `scripts/lib/dev-server.ts`, `exec.ts`, `mcp-client.ts`, `gh.ts`, `args.ts`; the callers listed above.

- [ ] One dev-server helper fails fast when the server process exits, and every caller uses it. proof: a unit spec under `scripts/__tests__/` with a server that exits at once, plus `rg -n 'function waitFor(Server|Url|Port)' scripts --glob '!lib/**'` returns nothing
- [ ] One `exec`, one MCP client and one `gh` wrapper, and the local copies are deleted. proof: `pnpm exec vitest run scripts/__tests__/verify-golden-path.spec.ts scripts/__tests__/ci-integration-scope.spec.ts`

#### Phase 2: One perf verdict, no dead scripts
**Status:** NOT STARTED
**Files:** `packages/playtest/src/runner/perf.ts`, `scripts/engine-load-test/report.ts`, the 9 scripts named above, root `package.json`.

- [ ] `report.ts` imports the playtest verdict rule. proof: `pnpm exec vitest run scripts/__tests__/engine-load-test.spec.ts` plus `pnpm --filter @threenative/playtest exec vitest run __tests__/perf.spec.ts`
- [ ] The 5 dead scripts are deleted, and the 4 orphan gates are wired into `pnpm budgets` or deleted. proof: `pnpm budgets` exit 0, plus `pnpm check:docs` for links
