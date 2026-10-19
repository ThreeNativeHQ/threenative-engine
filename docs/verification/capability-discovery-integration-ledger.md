# PRD-157 integration ledger

Date: 2026-08-19

This file fills the source PRD's five integration rows with callers, consumers, revert checks,
and observed negative controls.

| # | New thing | Live caller (`file:line`, non-test) | Consumer census | Revert check and observed red control |
|---|---|---|---|---|
| 1 | `scripts/build-capability-manifest.ts` | Root [`package.json:13`](../../package.json) runs the generator before recursive package builds; [`scripts/check-budgets.ts:335`](../../scripts/check-budgets.ts) and `:340` verify freshness. | `package.json` build; budgets; the committed manifest; all scaffold copies. | Pre-tag generator run exited 1 and named every untagged public export; full output is in [`capability-manifest-negative-control.md`](capability-manifest-negative-control.md). Unit controls cover an untagged export and stale/missing artifact. |
| 2 | `packages/create-threenative/capabilities.json` | [`packages/create-threenative/src/index.ts:216`](../../packages/create-threenative/src/index.ts) copies the committed file into a real scaffold; [`packages/engine-mcp/src/index.ts:224`](../../packages/engine-mcp/src/index.ts) loads it before serving. | Seven templates receive the file; `threenative-engine-mcp` searches and details it offline; the generator and budgets consume its source-of-record relationship. | `checkCapabilityManifest` on a missing/stale file and engine-MCP loading on a missing/unparseable file both throw with the path. The focused negative-control tests observed those failures. |
| 3 | `packages/engine-mcp/` (`threenative-engine-mcp`) | [`packages/engine-mcp/src/index.ts:224`](../../packages/engine-mcp/src/index.ts) is the executable server; [`packages/engine-mcp/src/index.ts:123`](../../packages/engine-mcp/src/index.ts) and `:153` are its two read-only query callers. | All seven template `.mcp.json` entries; the copied scaffold manifest; Claude sessions' MCP tool lists; package build/publint. | Renaming/removing the manifest is covered by the missing/unparseable tests and throws rather than returning `[]`. Situation regressions observed `NavigationAgent3D` and `attachToBone` in the top three; GroundSnap detail exposed `enabled`. |
| 4 | Engine `.mcp.json` entry ×7 | Every template has `threenative-engine` at `.mcp.json:15–17`; `createProject` validates it through [`packages/create-threenative/src/index.ts:226`](../../packages/create-threenative/src/index.ts) and `:255`. | `action-rpg`, `defense`, `minimal`, `platformer`, `racing`, `shooter`, and `starter`; each pins `threenative-engine-mcp` at its `package.json` devDependencies; the seven-template scaffold test starts each server and performs offline search. | The existing scaffold negative control for a missing engine server observes the fail-closed error; the all-template integration test also checks the exact two-tool list. Removing one entry or its dependency makes the scaffold validator/test fail. |
| 5 | “Ask before you write a system” rule | Engine [`AGENTS.md:20`](../../AGENTS.md) and all seven template `AGENTS.md` files (the first rule is at `:7` or `:10`, depending on template); `pnpm sync:agents` generates their `CLAUDE.md` mirrors. | Eight source authoring guides; 15 generated mirrors; the three fresh repair-4 Claude sessions read the rule and called the engine search tool before authoring. | `pnpm sync:agents --check` passes with the rule present. The final repair-4 measurement is preserved in [`capability-discovery-after.md`](capability-discovery-after.md): **2/3** navigation-subpath imports, **2/3** `attachToBone` imports, and **0/3** hand-written A*/path-search LOC. Transcripts: [run 1](capability-discovery-after-repair-4-valid-run-1.jsonl), [run 2](capability-discovery-after-repair-4-valid-run-2.jsonl.gz), [run 3](capability-discovery-after-repair-4-valid-run-3.jsonl). Earlier failed cohorts remain in the after report. |

## Export consumer census

The new `GroundSnap` export is emitted from [`packages/core/src/index.ts:88`](../../packages/core/src/index.ts), discovered by the generator, copied in the manifest, and returned by the MCP detail tool. Its enabled override is asserted by the engine-MCP regression test and its behavior is exercised by the core grounding test. The existing `attachToBone` and navigation exports are consumed by the same generator/manifest/MCP path and by the real authoring sessions recorded above. No export is silently filtered; the allowlist is empty.

## Real scaffold and agent evidence

The integration test scaffolded all seven templates and started each local server from the copied
manifest, including a local `@threenative/physics` link for the source import and a local built
engine-MCP link for offline execution. The final authoring cohort used three additional fresh
shooter scaffolds with the same offline server; their full transcripts are linked from the after
report. The disposable asset and sculpt servers were unavailable in that harness, but the engine
server connected in all three counted sessions.

## Lane history

This ledger was first written from the PRD-157 lane before the broader PRD-156 implementation was
integrated. The final delivery combines both lanes; the full PRD-156 caller and proving-ground
evidence is recorded in that PRD's completion record and repair evidence.
