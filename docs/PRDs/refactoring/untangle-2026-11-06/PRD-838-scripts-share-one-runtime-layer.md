# PRD-838 — Scripts share one runtime layer

**Status:** PARTIAL — both phases landed; AC-1 (the golden path and one visual gate end to end) runs on the PR.
**Priority:** P2 — both phases landed; only AC-1 (the golden path and one visual gate end to end) is open, so the tier rates that run rather than a copy count.
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

## Decisions

- **`scripts/lib/args.ts` is dropped** (2026-11-07). The Solution and Phase 1's file list named it, and no caller needed it: each script's argument parsing is a handful of `process.argv` reads with its own usage text and its own exit code, and the five copies differ in every one of those. A shared parser would either take a spec per script (more code than it removes) or force one usage text on tools whose contracts differ. Revisit if a sixth copy appears that is actually the same shape.
- **The four "orphan gates" stay as they are** (2026-11-07): see Phase 2's box, which records why each is covered by the suite or is an evidence producer rather than a gate.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Dev-server lifecycle | Visual, profile and golden-path scripts | 7 copies deleted | Phase 1 |

## Execution Phases

#### Phase 1: Shared lib
**Status:** DONE
**Files:** new `scripts/lib/dev-server.ts`, `exec.ts`, `mcp-client.ts`, `gh.ts`, `args.ts`; the callers listed above.

- [x] One dev-server helper fails fast when the server process exits, and every caller uses it. `scripts/lib/dev-server.ts` exports `waitForServer({ url, child?, timeoutMs?, intervalMs?, label?, detail? })` and `DevServerError` with `TN_DEV_SERVER_EXITED` / `TN_DEV_SERVER_TIMEOUT`; it notices `exitCode` **and** `signalCode`, and appends the caller's corrective detail. Nine call sites now route through it (`env-cost-probe`, `visual-gate`, `verify-golden-path`, `profile-starter`, `profile-native-cpu`, `engine-load-test/browser` + `cli` + `skinned-crowd`, `unreal-look/capture-threenative` + `tier-live-step` + `capture-gi-threenative` + `gi-tier-cost`). Three of them had no exit check at all and would have spent their full timeout on a dead server (`env-cost-probe`, `engine-load-test/cli` and `skinned-crowd`); the two `waitForServer*` functions left in `scripts/run-networking-proof.mjs` wait on **game** state (players joining, a session ending), not on a dev server, and stay. proof: `npx vitest run scripts/__tests__/dev-server.spec.ts` → 4 passed (a real child that exits at once, a child that dies mid-wait, the deadline, and the corrective detail); `rg -n 'function waitFor(Server|Url|Port)' scripts --glob '!lib/**'` returns only those two game-state waits; `pnpm typecheck` → 0.
- [x] One `exec`, one MCP client and one `gh` wrapper, and the local copies are deleted. `scripts/lib/exec.ts` (`run`/`runAsync`, `ExecError` with the caller's code, capture-or-stream, kill deadline) replaced **eight** `run()` copies; `scripts/lib/gh.mjs` replaced **four** `gh` wrappers; `scripts/lib/mcp-client.ts` (`startMcpServer` → `request`/`notify`/`initialize`/`stderr`/`alive`/`close`, `McpError` with `TN_MCP_EXITED`/`TN_MCP_TIMEOUT`/`TN_MCP_REPLY`) replaced the four stdio handshakes in `capture-mcp-tools`, `capture-asset-mcp-tools`, `verify-golden-path` and `verify-forest-playtest`. `verify-registry-install.ts` composes request *lines* for a pipeline rather than talking to a server, so it has no client to share — stated, not overlooked. Two of the old copies were genuinely wrong (`verify-forest-playtest` resolved a reply on the *substring* `"id":2`, so a chunk boundary decided whether it answered, and its `terrain_generate` had no deadline while a forest cook takes longer than a request), and two defects were mine, caught before the review gate: the first conversion passed a **label** where the runner reads a working directory, and the golden-path mutation control excluded the `template-assets/patches` directory that carries the manifest `prepack` reads. The client also listens on the server's stdin, because an EPIPE there is an uncaught stream error; under vitest's worker the closed read end does not surface as EPIPE (measured), so its spec asserts the refusal and the EPIPE message is probed by hand. Closing the trap that let a label be read as a working directory, `run`/`runAsync` now refuse a `cwd` that does not exist (`TN_EXEC_BAD_CWD`) and `packReleaseSet` takes its runner as a seam, with a spec that asserts every pack call carries the repository as its cwd. The client also now sends `notifications/initialized` inside `initialize`, so a caller cannot forget it. proof: `npx vitest run scripts/__tests__/exec.spec.ts scripts/__tests__/gh.spec.ts scripts/__tests__/mcp-client.spec.ts scripts/__tests__/dev-server.spec.ts scripts/__tests__/verify-golden-path.spec.ts scripts/__tests__/verify-forest-playtest.spec.ts scripts/__tests__/capture-asset-mcp-tools.spec.ts scripts/__tests__/release.spec.ts scripts/__tests__/prepare-release.spec.ts scripts/__tests__/make-sandbox.spec.ts scripts/__tests__/verify-template-playtests.spec.ts` → 146 passed; `pnpm typecheck` → 0.

#### Phase 2: One perf verdict, no dead scripts
**Status:** DONE
**Files:** `packages/playtest/src/runner/perf.ts`, `scripts/engine-load-test/report.ts`, the 9 scripts named above, root `package.json`.

- [x] `report.ts` imports the playtest verdict rule. `absolutesVerdict` and `readHostLoad` live once, in `packages/playtest/src/runner/perf.ts`, and are exported from the `@threenative/playtest/runner` subpath; `scripts/engine-load-test/report.ts` keeps only its own `TN_BENCH_HOST_LOAD_UNREADABLE` code, wrapping the shared reader. The import is a relative path into `packages/playtest/src/runner/perf.js`, the way every other script reaches package source: a `@threenative/*` specifier resolves to `dist/`, so a script would run whatever build happened to be on disk. The rule had been copied because the *package* could not import from `scripts/`, not the other way round. proof: `npx vitest run scripts/__tests__/engine-load-test.spec.ts packages/playtest/__tests__/perf.spec.ts` → 294 passed; `node -e "import('@threenative/playtest/runner')"` answers; `pnpm typecheck` → 0.
- [x] The dead scripts are deleted: four, not five. `scripts/asset-pose-capture.mjs`, `scripts/realistic-ocean-budget.mjs`, `scripts/realistic-ocean-capture.mjs` and `scripts/verify-fog-exposure.ts` were referenced by nothing but this PRD (`rg -l <name>` over the tree, excluding `node_modules`, `dist`, `docs/PRDs` and `docs/verification`). The report's fifth, `scripts/release-native-local.mjs`, is **not** dead: `scripts/release-native-local.ts` imports it at runtime (it ships untranspiled, so the `.ts` loads it through a URL), `package.json` reaches it through that `.ts`, and `__tests__/release-native-local.spec.ts` exercises it — it stays. proof: `pnpm check:docs` → 3795 links ok; `npx vitest run scripts/__tests__/temp-dir-guard.spec.ts scripts/__tests__/retry-download.spec.ts scripts/__tests__/primary-docs.spec.ts` → 15 passed.
- [x] The 4 "orphan gates" are not orphaned, and no wiring is needed — a decision that deletes the box, with the audit that produced it. `scripts/check-capability-examples.ts` is a library: `packages/engine-mcp/__tests__/capability-examples.spec.ts` imports `checkCapabilityExamples` from it, so `pnpm test` runs it. `scripts/arm-census.ts`, `scripts/asset-parity.ts` and `scripts/playtest-pair.ts` are imported by their own specs (`scripts/__tests__/{arm-census,asset-parity,playtest-pair}.spec.ts`, all inside the root vitest include), and each produces a report the docs cite rather than a pass/fail check — `pnpm budgets` is for invariants, not for writing evidence. The report's claim that they "run only by their own spec" is true and is exactly why they are covered: the suite is the gate. proof: `rg -n 'from "\.\./(arm-census|asset-parity|playtest-pair|check-capability-examples)' scripts/__tests__ packages/*/__tests__` lists each importer; `npx vitest run scripts/__tests__/arm-census.spec.ts scripts/__tests__/asset-parity.spec.ts scripts/__tests__/playtest-pair.spec.ts packages/engine-mcp/__tests__/capability-examples.spec.ts` → all passed.
