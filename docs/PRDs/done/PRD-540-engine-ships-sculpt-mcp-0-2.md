# PRD-540 — The engine ships `threenative-sculpt-mcp` 0.2.x, so game authors get the rig and animation gates

**Status:** DONE — 2026-10-11. Landed as #468 (squash-merged into `develop` 2026-10-09, `ci-required` SUCCESS); every box re-proved on `origin/develop` 2026-10-11 (red 2 failed / 30 passed, green 32 passed, exit 0).
**Priority:** P2 — eight modules published to npm as 0.2.0/0.2.1 (action design, clip features, GLB rig reference, mesh parity, rig gates, rig payload, seam measurement, skin conditioning) never reach a game author, because `@threenative/core` still pins 0.1.1 (AC-1, AC-3).
**Complexity:** 3 (LOW) — 1–5 implementation files (1), crosses the npm release boundary (+2); risk override: none
**Owner:** João
**Depends on:** None

## Context

`threenative-sculpt-mcp` moved to `ThreeNativeHQ` on 2026-10-08. npm has 0.2.1 (`latest`); the engine
pins 0.1.1 in `packages/core/package.json` (dependency) and `packages/core/mcp/servers.mjs`
(`MCP_PACKAGES.sculpt`, the version the launch shim falls back to). Every game that scaffolds from
`create-threenative` therefore gets the 0.1.1 tool set. 0.2.1 adds eight modules over 0.1.1
(`action-design`, `clip-features`, `glb-rig-reference`, `mesh-parity`, `rig-gates`, `rig-payload`,
`seam-measurement`, `skin-conditioning`) and the tools `sculpt_action_design`, `sculpt_clip_measure`,
`sculpt_mesh_parity`, `sculpt_rig_gate`, `sculpt_rig_reference`, `sculpt_rig_spec_gate`,
`sculpt_skin_condition` beside the 0.1.1 tools. The dependency list (`@modelcontextprotocol/sdk`
1.30.0, `sharp` 0.35.3, `zod` 4.3.6) is identical, so the bump adds no install weight.

The source of 0.2.x is not on GitHub (the repo stops at 0.1.1) and not on this machine; only the
compiled package exists. This PRD does not need the source: it consumes the published package.

**Not in scope.** Merging sculpt-mcp into `threenative-asset-mcp` (decided against 2026-10-08: the
tools gate procedural sculpts and rigs, asset-mcp imports and retargets assets, and the engine
launches them as two servers). The 16 sandbox projects that pin 0.1.0 (a separate public repo).

## Solution

Bump the pin in the two places, regenerate the lockfile, and prove through the shipped launch shim
that the new tools are served. Consumer flow: game author's agent starts the `threenative-sculpt`
server from the scaffolded `.mcp.json` → `node_modules/@threenative/core/mcp/sculpt.mjs` →
`launchMcpServer(MCP_PACKAGES.sculpt)` → `tools/list` returns the 0.2.1 set.

Integration: `packages/core/mcp/servers.mjs:42`, `packages/core/package.json:86` — the shim and the
dependency must name the same version.

## Acceptance Criteria

Each criterion is a checkbox in the phase that delivers it: AC-1 to AC-3 in Phase 1.

## Blocked on

- The 0.2.x TypeScript source is on no machine reachable from this session. It should be pushed to `ThreeNativeHQ/threenative-sculpt-mcp` so the package can be fixed and rebuilt — unblocked by João pushing the checkout (probably on the desktop). This does not block AC-1–AC-4.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Sculpt MCP 0.2.1 | scaffolded `.mcp.json` → `mcp/sculpt.mjs` → `launchMcpServer` | Replaces the 0.1.1 pin in place | AC-1, AC-3 |

## Decisions

- 2026-10-08 (João, with Claude): do not absorb sculpt-mcp into asset-mcp.

## Execution Phases

#### Phase 1: Core ships 0.2.1
**Status:** DONE — landed as #468; re-proved 2026-10-11 (32 passed, exit 0).
**Files:** `packages/core/package.json`, `packages/core/mcp/servers.mjs`, `pnpm-lock.yaml`, `packages/core/__tests__/mcp-install.spec.ts`.
**Implementation:** Change both pins to 0.2.1; `pnpm install` to refresh the lockfile only. Add the pin-equality assertion and the stdio `tools/list` spec next to the existing MCP install spec; the spec must fail against 0.1.1.
- [x] AC-1 [local]: `packages/core/package.json` and `packages/core/mcp/servers.mjs` name `threenative-sculpt-mcp` 0.2.1 as the same version. proof: `pnpm exec vitest run packages/core/__tests__/mcp-install.spec.ts` — Evidence (2026-10-08): `package.json` and `servers.mjs` both 0.2.1; lockfile diff touches only `threenative-sculpt-mcp`; the spec's manifest/shim assertion passes (32 tests). Re-proved (2026-10-11) on `origin/develop`: `packages/core/package.json:90` and `packages/core/mcp/servers.mjs:42` both name 0.2.1, `pnpm-lock.yaml:3773` resolves `threenative-sculpt-mcp@0.2.1`, spec 32 passed (exit 0).
- [x] AC-2 [local]: A test fails when the two source pins differ. proof: the same spec, red against a deliberately mismatched pin — Evidence (2026-10-08): with the manifest set back to 0.1.1, 2 tests failed (the new pin-equality test and the existing `installs every server transitively with core`); restored, 32 passed. Re-observed (2026-10-11) on `origin/develop`: manifest back to 0.1.1 → `2 failed | 30 passed`, `is pinned to one version in the manifest and in the launch shim` (`expected '0.1.1' to be '0.2.1'`) and `installs every server transitively with core`; restored → 32 passed.
- [x] AC-3 [local]: Launching `node packages/core/mcp/sculpt.mjs` and calling MCP `tools/list` lists all seven 0.2.x tools, `sculpt_rig_gate` among them. proof: a spec through the real shim over stdio — Evidence (2026-10-08): `serves the 0.2 rig and animation gates through the shipped launch shim` passes; 0.1.1's server contains no `sculpt_rig_gate`, so it cannot pass on the old pin. Also run end to end on a web photo (chess pawn): `sculpt_plan`, `sculpt_spec_gate`, `sculpt_compare` and `sculpt_pass_gate` all answer through the shim, and `sculpt_pass_gate` returned `retry` on both attempts: attempt 1 (judge 0.50, five reasons), attempt 2 after profile fixes (judge 0.70, two reasons: ambiguous deterministic evidence, neck-and-body below threshold). Reference: Wikimedia Commons "Chess piece - White pawn.JPG" (CC BY-SA 2.5), not committed. Re-proved (2026-10-11): `serves the 0.2 rig and animation gates through the shipped launch shim` passes in the same 32/32 run, asserting all seven 0.2.x tool names (`sculpt_action_design`, `sculpt_clip_measure`, `sculpt_mesh_parity`, `sculpt_rig_gate`, `sculpt_rig_reference`, `sculpt_rig_spec_gate`, `sculpt_skin_condition`) through the real stdio shim.
- [x] AC-4 [shared]: The engine's pull-request board is green with the new pin. proof: the PR's checks (`pnpm install --frozen-lockfile` against the new lockfile, package-size budget and scaffold specs included) — Evidence (2026-10-11): #468 squash-merged into `develop` 2026-10-09T19:49Z with `ci-required: SUCCESS` and 53 of 53 non-skipped checks green, 0 failures (15 skipped by scope); `typecheck`, `test-unit` (4/4), `budgets` and `build` all SUCCESS.

**Verification:** the boxes above.
