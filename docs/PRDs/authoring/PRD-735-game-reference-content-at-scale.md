# PRD-735 — Reverse-engineer references at scale: the repo rename, the full list, the classics and the scout pipeline

**Status:** NOT STARTED
**Priority:** P1 — AC-0 to AC-5 are open, and the PRD-750 kit loop (P1) needs their references past its first row; today the release holds one Tier-1 game (SM64).
**Complexity:** 4 (MEDIUM) — separate data release +2, external API +1, 1–5 files +1; risk override: none.
**Owner:** João Paulo Furtado
**Depends on:** PRD-734 (done: the reference tools, the schema and the `v0.1` release)
**PR:** the PRD-750 epic PR (owner, 2026-10-26)

## Context

PRD-734 ships the reference tools and one Tier-1 game, Super Mario 64. This PRD fills the data repo
`threenative-game-refs` so the references cover what users actually ask for:

- **Tier 2:** an index row for each project in
  <https://github.com/Carter54git/Greates-Games-Decompilations-List> (2,359 on 2026-10-20).
- **Tier 1:** about 20 classic repos with a full map and full cards, in the order of the PRD-750
  genre list (its candidate reference per row), then Ocarina of Time for Lantern Vale and the other
  classics.
- **Promotion:** saved Tier-2 cards that users contribute through `engine_save_reference` are
  reviewed and merged.

The schema, the borrow-not-copy guardrail and the pinned-SHA rule come from PRD-734 and do not
change here.

## Solution

- **Rename** (owner, 2026-10-26: "we should rename ... threenative-game-refs to
  threenative-reverse-engineer-mcp"). The data repo moves to
  `ThreeNativeHQ/threenative-reverse-engineer-mcp`. `REFERENCES_URL` and `CONTRIBUTION_REPO` in
  `packages/engine-mcp/src/references.ts` follow it. The tools stay in `threenative-engine-mcp`,
  and their descriptions carry "reverse engineer" so a search for those words finds them. GitHub
  redirects the old release URL, so installed games keep working.
- **Import script** in the data repo. It parses the list README into Tier-2 rows (title, platform,
  repo URL), gives each row a stable kebab-case id and keeps the ids of rows that already exist.
- **Scout pipeline.** A scout is a cheap agent (the `ds` harness, V4.1-Flash max) that clones one
  repo at a pinned SHA, writes the map, then writes the cards for each mechanic node. It gets a
  fixed brief: the schema, the guardrail and the unit rule. Each constant states its unit and its
  timestep, for example "per frame at 30 Hz". The PRD-734 `validate` job checks every path,
  function and line against the pinned clone. A full review then reads each card before merge,
  because a wrong constant misleads every user.
- **Tier-1 order:** OoT first, then a ranked list of about 20 classics, kept in the data repo
  README. Each choice must have a mature decomp and a mechanic that users ask for.
- **Contributions:** an issue made by `engine_save_reference` is validated by the same job, reviewed
  and promoted to Tier 1 when its game is complete enough.

## Acceptance Criteria

See the phase boxes below. Each box names its proof.

## Blocked on

- The repo transfer to the `ThreeNativeHQ` org needs org admin rights on the owner's `gh` login — unblocked by the owner's token (try it first; AC-0 records the result).

## Integration Ledger

Integration: the release URL and contribution repo in `packages/engine-mcp/src/references.ts` change with the rename (AC-0). The PRD-734 tools read the new releases with no other code change.

## Decisions

- 2026-10-26 (owner): rename the data repo to `threenative-reverse-engineer-mcp`; the tools stay in engine-mcp with "reverse engineer" as search words, not a separate server.
- 2026-10-26 (owner): this PRD lands before the PRD-750 loop runs past its first row.
- 2026-10-24 (agent): split from PRD-734 to keep both PRDs within the 3-phase cap. Content at scale does not change the tool contract.

## Execution Phases

#### Phase 1: The rename and Tier 2 for the full list

**Status:** NOT STARTED
**Files:** `packages/engine-mcp/src/references.ts`; the data repo: import script, release workflow.

- [ ] AC-0 [local]: an installed project's MCP fetches the release from `ThreeNativeHQ/threenative-reverse-engineer-mcp`, and `engine_search_capabilities "reverse engineer"` returns the reference tools. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/references.spec.ts packages/engine-mcp/__tests__/search.spec.ts`
- [ ] AC-1 [shared]: the release index holds one Tier-2 row per list project, and a second import keeps every existing id. proof: data repo `import` job, row count against the list README count
- [ ] AC-2 [local]: engine-mcp searches a Tier-2 title from the new release and returns its repo with the explore guidance. proof: `THREENATIVE_REFERENCES_URL=<release> pnpm exec vitest run packages/engine-mcp/__tests__/references.spec.ts -t live`

#### Phase 2: Scout pipeline and Ocarina of Time

**Status:** NOT STARTED
**Files:** the data repo: scout brief, scout runner script.

- [ ] AC-3 [shared]: OoT has a reviewed map and at least 10 reviewed cards at a pinned SHA, each constant with its unit and timestep, and the `validate` job passes. proof: data repo `validate` job

#### Phase 3: The classics and the contribution path

**Status:** NOT STARTED
**Files:** the data repo: the ranked Tier-1 list, the contribution issue template.

- [ ] AC-4 [shared]: about 20 Tier-1 games each have a reviewed map and at least 10 reviewed cards, and the `validate` job passes. proof: data repo `validate` job, Tier-1 count in the release index
- [ ] AC-5 [shared]: one issue made by `engine_save_reference` passes `validate`, is reviewed and appears in the next release. proof: data repo issue, `validate` run and release diff
