---
prd_contract: v1
---

# PRD-920 — Capability and reference search accuracy, hybrid evaluation, and self-describing CLI schemas

**Status:** NOT STARTED
**Priority:** P1 — Every Studio plan and build turn depends on `engine_search_capabilities`, `engine_search_references`, and `call.mjs`; AC-1 through AC-5 are open while substring false positives (`"street"`→`bakeVegetation`, `"billboard"`→`mario-party-1`), stem collisions (`"leaves"`+`"scene"`→`leaveScene`, `"closed"`→`ctx.quit`), missed core mechanics (countdown, night lighting, `Heightfield` in long queries), and schema-less `call.mjs` output degrade agent discovery.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (+1), new offline hybrid benchmark/scorer module (+2), crosses engine npm/bundle release boundary (+2); risk override: none.
**Owner:** João
**Depends on:** PRD-865 (DONE; builds on its frozen 150-query gold set and `scripts/capability-search-ab.ts`)

## Context

Measured 2026-11-25 across `threenative-live-studio` local loop traces (`gpt-6.2-sol`, `deepseek-v4.1-flash`, `inkling-2-mini`, `mix-gpt-6.2-sol+deepseek-v4.1-flash`, `claude-opus-5-5`) against `packages/engine-mcp/src/index.ts` and `packages/core/mcp/call.mjs`:

1. **Substring `phraseBonus` without word boundaries (`packages/engine-mcp/src/index.ts:662-667`, `916-919`):**
   `scorePhrase` checks `phrase.join(" ").includes(queryText) || queryText.includes(phrase.join(" ")) ? 1 : 0` and bypasses `matched === 0` (`if (total === 0 || (matched === 0 && phraseBonus === 0)) return undefined;`). Because `phraseBonus > 0` also forces `isDistinctivePhrase` true (`line 671`), raw substring hits earn a flat `score = 1.00`:
   - `"street"` contains `"tree"` (stem of `bakeVegetation` alias `'trees'`). Every racing query mentioning `"street"` — `scope: "request"`, `"bloom ... dark street"`, `"wet asphalt ... street lighting"`, `"spline asphalt street circuit"` — ranked `bakeVegetation` at `1.00`, displacing real rendering/city results.
   - `"billboard"` contains `"board"` in `searchReferences` (which reuses `scoreReadableSituations`, `line 1437`): `"neon signs and glowing billboards on city buildings at night"` returned `mario-party-1` (`board-camera-follow`, `board-chain-cursor`, `board-space-graph`) at `score = 1.00`.
2. **Stemmed false positives & dropped single-word symbols (`packages/engine-mcp/src/index.ts:805-847`):**
   - In `copper-cascade` (`scope: "request"`), `"lush tropical leaves"` + `"scene"` stemmed to `leav` + `scen`, hitting `leaveScene` via `nameWords` (`lines 841-846`) and ranking `leaveScene` #2 (`score = 2.03`) ahead of `defineGame` and `WaveField`.
   - `"closed spline..."` stemmed `"closed"` to `"clos"`, matching `ctx.quit` (`"close the app"`, `score = 0.45` in mechanic scope, `0.79` in request scope).
   - A 15-word `copper-cascade` query containing verbatim `"Heightfield"` missed `Heightfield` in the top 5 because single-word symbol leads require `share >= 0.3` (`SINGLE_WORD_SHARE_FLOOR`, `line 797`).
3. **Short-phrase coverage bias & missing mechanic aliases (`packages/engine-mcp/src/index.ts:658-667`, `1079-1168`):**
   Dividing matched token weight by the situation phrase's own total weight (`coverage = matched / total`) lets 2–4 word generic situations (`ctx.quit` `"close the app"`, `bakeTerrain` `"before a game starts"`, `onLaunchFailure`) outrank multi-word core mechanics in long queries:
   - `"countdown before race start, begin on GO"` returned `['VehicleBody3D', 'bakeTerrain']` (missed `Scheduler`); `"countdown before the race starts, its numbers ticking then controls unlock at GO"` returned `playtestStepHoldTicks` / `playtestStepWaitTicks` / `bakeTerrain` (missed `Scheduler`).
   - `"night scene lighting, exposure and fog with emissive neon signage and wet reflective asphalt"` returned `['ProbeVolume', 'SkyCapture', 'SurfaceCache', 'createStormLightning', 'Daylight']` (missed `WorldEnvironment`, `ssr`, `TracedReflections`, `bloom`, `bakeCity`).
   - Racing `scope: "request"` returned `['UiLayer', 'Scheduler', 'bakeVegetation', 'onLaunchFailure', 'ctx.quit']` plus 3 Ocarina of Time reference stubs.
4. **Corpus scale:** `capabilities.json` holds 636 entries (version 2, 14 `starterKits`, 6 `notOwned`) and the references `index.json.gz` holds 48 games / 1,363 stubs (130 KB gz). Startup must remain offline and fast with zero network dependency for capabilities.
5. **Schema-less `call.mjs` & terse argument errors (`packages/core/mcp/call.mjs:86-90`, `packages/engine-mcp/src/index.ts:1507-1598`):**
   `call.mjs <server>` prints only `toolName: first line of description`, hiding parameter schemas so shell-fallback subagents burn 5–15 failed calls probing shapes (`reference_sample_palette '{}'`, `sculpt_spec_gate '{"spec":{}}'`, or writing ad-hoc JSON-RPC scripts). Meanwhile, MCP arg mistakes seen in traces (`query` instead of `situation`, missing `kind` on `engine_reference_detail`, `beforeRender` instead of `ctx.beforeRender`) return errors without hinting the expected field or nearest symbol.

## Solution

1. **Fielded BM25F + word-boundary lexical upgrade (zero runtime dependencies, both engines):**
   - Replace raw `.includes()` `phraseBonus` in `scorePhrase` and `notOwnedSituationScore` with a whole-token subsequence check (`hasTokenSubsequence`).
   - Replace ad-hoc phrase coverage with **fielded BM25F** over separate channels (`symbol` exact/camelCase > `aliases` > best-matching `situation` > `summary` for capabilities; `title`/`name` > `tags` > `summary` for references), with length saturation (`b`, `k1`) and query-coverage weighting so 3-word generic situations do not dominate long queries.
   - Tighten stemming/identifier matching so `"leaves"`/`"closed"` do not trigger `leaveScene`/`ctx.quit`, while verbatim PascalCase/camelCase identifiers (`Heightfield`, `WorldEnvironment`, `VehicleBody3D`) keep an exact-case identifier boost even inside long queries (keeping generic lowercase English words like `view`/`scene` bounded).
   - For `scope: "request"`, split clauses and down-weight lifecycle/exit hooks (`ctx.quit`, `onLaunchFailure`, `leaveScene`) unless the request explicitly asks for quit/exit/error screens.
   - Add missing `@alias` / `@situation` JSDoc tags on core exports (countdown/race start on `Scheduler`, night lighting/fog/exposure on `WorldEnvironment`, camera follow framing) and rebuild `capabilities.json` via `pnpm capabilities:sync`.
2. **Measured hybrid semantic search gate (Model2Vec static vectors + BM25F via RRF):**
   - Extend `scripts/capability-search-ab.ts` with a Nov 25 trace-regression split alongside the frozen PRD-865 gold set.
   - Benchmark a lightweight offline static-subword embedding model (quantized Model2Vec, pure JS dot product over precomputed int8/f16 corpus vectors, <5 ms query, zero ONNX/WASM/network) fused with BM25F via Reciprocal Rank Fusion (RRF).
   - Ship pure BM25F if lexical + alias hygiene reaches `>= 0.72` held-out `recall@1` and `>= 0.85` `recall@5`; ship the static-vector hybrid only if it delivers `>= +0.05` held-out `recall@1` within `<50 ms` cold start and `<10 MB` asset budget.
3. **Self-describing `call.mjs` & actionable MCP errors:**
   - Update `packages/core/mcp/call.mjs` so `call.mjs <server>` prints required/optional parameter names inline alongside each tool description, and `call.mjs <server> <tool> --schema` prints the tool's full JSON `inputSchema`.
   - Update `handleToolCall` errors in `packages/engine-mcp/src/index.ts` to hint `situation` when `query` is supplied, list `kind: "node" | "card"` with valid args on `engine_reference_detail`, and suggest nearest exported symbol names (`ctx.beforeRender` for `beforeRender`) on `engine_capability_detail` misses.
   - Rebuild the bundled `packages/core/mcp/engine-server.mjs` (`node packages/core/scripts/bundle-engine-mcp.mjs`).

## Non-Goals

- Online/API embedding calls or native/ONNX/WASM runtime dependencies inside `threenative-engine-mcp`.
- Editing or unfreezing the PRD-865 held-out split (`heldoutSha256` remains unchanged).
- Studio subagent frontmatter, `roles.ts`, or Studio prompt changes (covered by `threenative-live-studio` PRD-103).

## Acceptance Criteria

- [ ] AC-1 [local]: Zero substring/stem false positives on the Nov 25 trace regression suite (`"street"` never matches `bakeVegetation` via `'trees'`; `"billboard"` never matches `mario-party-1` via `'board'`; `"lush tropical leaves ... scene"` excludes `leaveScene`; `"closed spline"` excludes `ctx.quit`). proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts packages/engine-mcp/__tests__/references.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: Mechanic plus verbatim-symbol recall passes on Nov 25 trace queries (`"countdown before race start, begin on GO"` ranks `Scheduler` top-3; `"night scene lighting, exposure and fog with emissive neon signage"` ranks `WorldEnvironment` top-5; long query with `"Heightfield"` ranks `Heightfield` top-3). proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: Frozen PRD-865 held-out gold floor holds (`recall@1 >= 0.65`, `recall@5 >= 0.80`, 20/20 exact-symbol rank 1) while the Model2Vec+BM25F vs BM25F-only A/B result is recorded in `artifacts/capability-search-ab.json` plus `## Decisions`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search-gold.spec.ts && pnpm tsx scripts/capability-search-ab.ts --base HEAD` — Evidence: pending.
- [ ] AC-4 [local]: `node packages/core/mcp/call.mjs <server>` prints required/optional parameter hints per tool, while `call.mjs <server> <tool> --schema` prints valid JSON `inputSchema`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/server.spec.ts` — Evidence: pending.
- [ ] AC-5 [local]: Bundled `packages/core/mcp/engine-server.mjs` plus `packages/core/capabilities.json` stay in sync, returning actionable hints for wrong arg aliases (`query`→`situation`), missing `kind`, or near-miss symbol names (`beforeRender`→`ctx.beforeRender`). proof: `pnpm capabilities:check && pnpm exec vitest run packages/engine-mcp` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Capability search | Agent / `call.mjs` → `tools/call engine_search_capabilities` → `handleToolCall` → `searchCapabilities` (`packages/engine-mcp/src/index.ts`, bundled into `packages/core/mcp/engine-server.mjs`) | Replaces raw `.includes()` `phraseBonus` and coverage-biased scoring with word-boundary fielded BM25F (+ optional RRF static vectors if Phase 2 A/B wins) | AC-1, AC-2, AC-3, AC-5 |
| Reference search | Agent → `tools/call engine_search_references` / `engine_search_capabilities` → `searchReferences` (`packages/engine-mcp/src/index.ts`) | Replaces substring `phraseBonus` with word-boundary token subsequence and fielded scoring across `name`, `summary`, `tags`, `title` | AC-1, AC-5 |
| Self-describing MCP CLI & errors | Shell subagent → `node node_modules/@threenative/core/mcp/call.mjs <server> [<tool> --schema]` (`packages/core/mcp/call.mjs`); `handleToolCall` (`packages/engine-mcp/src/index.ts`) | Replaces description-first-line-only listing and bare error strings with inline parameter summaries, `--schema`, and arg/symbol hints | AC-4, AC-5 |

## Decisions

- Filed as PRD-920 because PRD-917 already identifies the merged VFX capability work in engine PR #736. The search PRD retains its original acceptance criteria.

- 2026-11-25 (architect): Start with zero-dependency word-boundary fielded BM25F + alias hygiene as the default path (fixing why PRD-865's flat BM25 prototype scored 35% vs 62%), and gate Model2Vec static-vector hybrid + RRF behind a measured held-out A/B (`>= +0.05` `recall@1`, `<50 ms` cold start, `<10 MB` asset budget).

## Verification Plan

All implementation phases are verified against concrete before/after evidence before marking completion:

1. **Red-first trace regression control (Phase 1):** Before modifying `packages/engine-mcp/src/index.ts`, run the new Nov 25 trace regression specs (`"street"`→`bakeVegetation`, `"leaves"`/`"closed"` stem collisions, verbatim `"Heightfield"` single-word drop, `scope: "request"` exit-hook domination, missing `@alias`/`@situation` lookups) and confirm they fail on `HEAD`, then verify green after `pnpm capabilities:sync` and the scorer changes.
2. **Anti-self-comparison offline A/B & gold gate (Phase 2):** Run `pnpm tsx scripts/capability-search-ab.ts --base <pinned-pre-917-commit>` and inspect printed base vs. head index SHA-256 hashes (must differ), verify frozen `heldoutSha256` (`0cb517f250f2965a6c37fbb487a8d95b98277893dfe8389f7e57f52c199aa78c`) is unchanged, require held-out `recall@1 >= 0.65` and `recall@5 >= 0.80` with `<= 1` top-5 drop, and only ship Model2Vec + RRF if it gains `>= +0.05` `recall@1` with `<50 ms` cold start, `<5 ms` p95 latency, and `<10 MB` asset footprint.
3. **Bundled server & live CLI consumer probes (Phase 3):** Rebuild `packages/core/mcp/engine-server.mjs` with `pnpm --filter @threenative/core build`, then run `node packages/core/mcp/call.mjs` directly against the bundled server: list `engine-mcp` tools to check inline parameter hints, run `--schema` on `engine_search_capabilities` and `reference_inspect` to check JSON `inputSchema`, submit malformed payloads (`{"query":"driving"}`, missing `kind`) to confirm exit code `1` with actionable fix hints, and replay Nov 25 failing queries end-to-end.
4. **Full repository gates:** Run `pnpm capabilities:check && pnpm caps:recall && pnpm typecheck && pnpm lint && pnpm exec vitest run packages/engine-mcp`.

## Execution Phases

#### Phase 1: Word-boundary fielded BM25F scorer and alias hygiene
**Status:** NOT STARTED
**Files:** `packages/engine-mcp/src/index.ts`, `packages/engine-mcp/__tests__/search.spec.ts`, `packages/engine-mcp/__tests__/references.spec.ts`, JSDoc `@alias`/`@situation` tags on core exports (e.g. `Scheduler`, `WorldEnvironment`) + `packages/core/capabilities.json` via `pnpm capabilities:sync`.
**Implementation:**
- Replace raw `.includes()` `phraseBonus` in `scorePhrase` and `notOwnedSituationScore` with word-boundary token-sequence matching (`hasTokenSubsequence`).
- Implement fielded BM25F across `symbol`, `aliases`, best `situation`, and `summary` (and `name`/`tags`/`summary`/`title` in `searchReferences`), add verbatim PascalCase/camelCase identifier boost for long queries (`Heightfield`), guard stemmed false positives (`leaves`→`leaveScene`, `closed`→`ctx.quit`), and split clauses / down-weight exit hooks on `scope: "request"`.
- Add missing `@alias`/`@situation` JSDoc tags, run `pnpm capabilities:sync`, and write red-green regressions for every Nov 25 false positive and miss.
**Verification:** Confirm Nov 25 regression tests fail red against unmodified `index.ts`, sync metadata via `pnpm capabilities:sync`, and pass `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts packages/engine-mcp/__tests__/references.spec.ts`.
- [ ] Word-boundary fielded BM25F plus alias hygiene pass all capability/reference regression cases — proof: `pnpm capabilities:sync && pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts packages/engine-mcp/__tests__/references.spec.ts` — covers AC-1, AC-2.

#### Phase 2: Offline hybrid semantic benchmark (Model2Vec + RRF) and A/B gate
**Status:** NOT STARTED
**Files:** `scripts/capability-search-ab.ts`, `packages/engine-mcp/__tests__/search-gold.spec.ts`, and (only if the A/B gate wins) a quantized static-vector table + RRF fusion in `packages/engine-mcp/src/index.ts`.
**Implementation:**
- Extend `scripts/capability-search-ab.ts` with a Nov 25 trace-regression split while keeping the frozen PRD-865 `heldoutSha256` untouched.
- Benchmark pure BM25F vs BM25F + Model2Vec static subword embeddings fused with Reciprocal Rank Fusion (RRF), measuring held-out `recall@1`, `recall@5`, MRR, cold-start load time, query latency, and asset bytes; keep static vectors only if held-out `recall@1` improves by `>= +0.05` within `<50 ms` cold start and `<10 MB`.
- Lock updated held-out floor (`recall@1 >= 0.65`, `recall@5 >= 0.80`) in `search-gold.spec.ts` and record A/B results in `## Decisions`.
**Verification:** Run `pnpm exec vitest run packages/engine-mcp/__tests__/search-gold.spec.ts && pnpm tsx scripts/capability-search-ab.ts --base <pinned-commit>`, verify distinct base/head index SHA-256 hashes and untouched `heldoutSha256`, and log measured `recall@1`, `recall@5`, cold-start ms, p95 ms, and byte footprint in `## Decisions`.
- [ ] Frozen gold floor holds while the Model2Vec+BM25F vs BM25F-only A/B decision is measured — proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search-gold.spec.ts && pnpm tsx scripts/capability-search-ab.ts --base HEAD` — covers AC-3.

#### Phase 3: Self-describing `call.mjs` schemas, error hints, and bundled server rebuild
**Status:** NOT STARTED
**Files:** `packages/core/mcp/call.mjs`, `packages/engine-mcp/src/index.ts`, `packages/engine-mcp/__tests__/server.spec.ts`, `packages/core/mcp/engine-server.mjs` (rebuilt via `packages/core/package.json` `build` script).
**Implementation:**
- Update `packages/core/mcp/call.mjs` to print required/optional parameter names in `call.mjs <server>` listings and full JSON `inputSchema` on `call.mjs <server> <tool> --schema`.
- Update `handleToolCall` in `packages/engine-mcp/src/index.ts` to emit actionable error hints (`query`→`situation`, `kind` options, near-miss symbol suggestions like `ctx.beforeRender` for `beforeRender`).
- Rebuild `packages/core/mcp/engine-server.mjs`, run `pnpm capabilities:check`, and run the full `engine-mcp` test suite.
**Verification:** Run `pnpm --filter @threenative/core build`, exercise `node packages/core/mcp/call.mjs` (tool listing hints, `--schema`, invalid-arg exit code `1` hints, and Nov 25 trace query replay), then run `pnpm capabilities:check && pnpm caps:recall && pnpm typecheck && pnpm lint && pnpm exec vitest run packages/engine-mcp`.
- [ ] Self-describing `call.mjs`, error hints, capabilities check, plus bundled `engine-server.mjs` pass — proof: `pnpm --filter @threenative/core build && pnpm capabilities:check && pnpm exec vitest run packages/engine-mcp` — covers AC-4, AC-5.
