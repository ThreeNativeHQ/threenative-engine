# PRD-881 — A weak model builds the sealed platformer and fps briefs

**Status:** PARTIAL — phase 1 in progress
**Priority:** P1 — remote sessions run DeepSeek V4.1 Flash on leanpi, and a cold scaffold gave it no engine tool (Phase 1 open boxes).

The `weak-model-benchmark` skill (`.claude/skills/weak-model-benchmark/SKILL.md`) runs DeepSeek V4.1
Flash max on leanpi against a sealed brief in a user-like sandbox. This PRD owns that loop for the
`platformer` (kit `platformer`) and `fps` (kit `shooter`) genres. Each failure becomes a framework
fix with a red-green test, then the same brief runs again. Budget: 4 rounds.

### Phase 1 — the arm can reach the engine tools

Probe 2026-11-13 in `../sandbox/wm-probe` (`leanpi -p --approve`, JEV off, as `run-arm.sh` pins it):
a trusted project still answered `NO_ENGINE_TOOL`. Three gates stood in the way, read in
`lean-pi/src/mcp/`: an untrusted project drops its MCP configs (`trust.ts`), with JEV off only
`default` or pinned servers are offered (`select.ts` `fallbackServers`), and no tool is admitted
without a cached schema (`select.ts` `hydrate`). A `tools` hint alone fills only the catalog row.

- [x] Core seeds leanpi's engine tools. proof: `pnpm exec vitest run packages/core/__tests__/mcp-install.spec.ts`
  — RED 4 failed, GREEN 38/38; scaffolder specs (`scaffold-mcp`, `scaffold-file-allowlist`,
  `doctor`) 168/168. `.leanpi/mcp.json` marks the engine server as the one `default` server, and the
  postinstall seeds `.leanpi/cache/mcp-catalog.json` from the bundled server's `toolDefinitions()`.
- [x] `run-arm.sh` acts like a user's leanpi. proof: two probe arms in the scratchpad — VALID,
  capability searches 1 and 3, 0 tool errors. It grants project trust (`/permissions trust
  project`), stops leanpi once the session ends on `stop` and goes idle, and friction counts the
  `mcp/call.mjs` shell route as a capability search.
- [ ] A fresh scaffold searches before it writes. proof: `friction.json`
  `capabilitySearchesBeforeFirstWrite >= 1` on `wm-platformer-1`, with no hand edit to the scaffold.

### Phase 2 — platformer floor

- [ ] Two consecutive VALID platformer runs pass the full sealed proof. proof: `pnpm sweep:proof`
  on each `wm-platformer-<n>` archive.

### Phase 3 — fps floor

- [ ] Two consecutive VALID fps runs pass the full sealed proof. proof: `pnpm sweep:proof` on each
  `wm-fps-<n>` archive.

## Acceptance criteria

- [ ] Skill stop rule 1 holds for platformer: two VALID runs in a row pass the full sealed proof. proof: the Rounds table.
- [ ] Skill stop rule 1 holds for fps: two VALID runs in a row pass the full sealed proof. proof: the Rounds table.

## Rounds

| Run | Verdict | Proof | First src write | Searches before write | Tool errors | Internal reads | Typecheck / playtest | Cost | Fix |
|---|---|---|---|---|---|---|---|---|---|
| wm-platformer-1 | VALID, discarded: shared sandbox root, the arm ran a sibling game's scripts (calls 11-19) | 0/2 (GPU headed: attach timeout) | call 50 | 0 | 9 | 21 | 2 / 33 | $0.156 | own sandbox root per run; kit coin moved off the spawn |
| control (pristine kit) | n/a | 1/2: run fails `coins` trivial, `goalReached` false | - | - | - | - | - | - | - |

## Decisions

- 2026-11-13 (lead): the proof step is `pnpm sweep:capture` (headed). `pnpm sweep:proof` runs
  headless and fails every run on SwiftShader (`TN_PLAYTEST_SOFTWARE_ADAPTER`).
- 2026-11-13 (lead): the kit level is not reshaped to the sealed run's input (hold ArrowRight 6 s).
  That fits the benchmark, not a real game. Only the spawn-coin defect is fixed in the kit.

- 2026-11-13 (lead): the cache seed, not `tools` hints in `.mcp.json`, is the fix. Hints fill only
  the catalog row; leanpi refuses a tool without a cached schema. Claude Code's `.mcp.json` stays
  free of leanpi-only keys.

## Blocked on

- lean-pi: `leanpi -p` never calls `McpPool.disconnectAll()` (`src/mcp/client.ts:490` has no
  caller), so a run that connected an MCP server idles to its cap after the last answer (probe:
  answer at +22 s, exit 124 at 180 s). `run-arm.sh` works around it; the root fix is in lean-pi.
