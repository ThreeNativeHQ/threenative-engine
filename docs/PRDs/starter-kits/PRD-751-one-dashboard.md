# PRD-751 — One dashboard: `pnpm dashboard` holds every KPI tab

**Status:** NOT STARTED
**Priority:** P2 — the owner cannot see what the loops do from one place: CI speed and asset perf still render separate pages, and the kit-loop KPIs have no view (all phases open)
**Complexity:** 2 (LOW) — 6–10 files +2; risk override: none
**Owner:** João Paulo Furtado
**Depends on:** None
**PR:** the PRD-750 epic PR (owner, 2026-10-26)

## Context

Owner ask (2026-10-26): "i also need a kpi dashboard to keep track of wtf is being done", then "there
are existing performance dashboards somewhere on codebase. maybe merge them all? kill redundant. But
just leave only one to rule them all".

Dashboards found at `origin/pr563-followup` 369e57e5a:

| Dashboard | Data | Disposition |
| --- | --- | --- |
| `pnpm perf:live` (`scripts/perf-live.ts`, `scripts/perf-live.html`) | live tabs: bench:engines reports, Midway (`scripts/midway-bench/dashboard.ts`), Shadows vs Unreal (`scripts/shadow-perf/dashboard.ts`) | **keep** — renamed `pnpm dashboard`, the hub |
| `docs/ci-speed/index.html`, written by `scripts/ci-speed-loop.mjs` | `docs/ci-speed/ledger.json` | fold in as a tab; stop writing the page |
| `docs/asset-perf/index.html`, written by `scripts/asset-perf-loop.mjs` | its ledger | fold in as a tab; stop writing the page |
| `.agents/skills/native-performance-loop/references/dashboard.md` | tells a campaign to generate its own HTML page | point it at a hub tab |
| `docs/PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.html` | the Unreal port order | keep — a plan, not a KPI view |
| `prd-dashboard` (port 4319, its own repo) | live agent sessions across repos | out of scope — cross-repo telemetry |

## Solution

- Rename `perf:live` to `dashboard` in `package.json` and every doc that names it.
- Add three tabs, each a small reader like `shadow-perf/dashboard.ts` (reads one ledger, writes
  nothing, fails closed: missing = `pending`, malformed = `invalid`): **CI speed**, **Asset perf**,
  **Kit loop** (PRD-750 `docs/kit-loop/ledger.json`).
- `ci-speed-loop.mjs` and `asset-perf-loop.mjs` keep writing their ledgers and stop writing HTML;
  delete the two `index.html` files and update their consumers (root `AGENTS.md` CI paragraph,
  `scripts/__tests__/ci-efficiency.spec.ts`, the CI-speed skill, PRD-550 and PRD-729 links).
- The native-performance-loop skill reference names the hub tab instead of a per-campaign page.

## Acceptance Criteria

See the phase boxes. Each box names its proof.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| One KPI hub | `pnpm dashboard` → `scripts/perf-live.ts` server → tabs | replaces `docs/ci-speed/index.html`, `docs/asset-perf/index.html` | AC-1..AC-4 |

## Decisions

- 2026-10-26 (owner): `perf:live` becomes the single dashboard; the static pages and the skill's per-campaign HTML go.

## Execution Phases

#### Phase 1: The hub and its two folded tabs

**Status:** NOT STARTED
**Files:** `package.json`, `scripts/perf-live.ts`, `scripts/perf-live.html`, `scripts/ci-speed-loop.mjs`, `scripts/asset-perf-loop.mjs`, the two deleted `index.html` files and their consumers.

- [ ] AC-1 [local]: `pnpm dashboard` serves the existing tabs plus CI speed and Asset perf, read from their ledgers; a missing or malformed ledger shows `pending` or `invalid`. proof: `pnpm exec vitest run scripts/__tests__/perf-live.spec.ts`
- [ ] AC-2 [local]: no tracked file writes or links a removed page. proof: `rg -n "ci-speed/index.html|asset-perf/index.html|perf:live" --glob '!docs/PRDs/done/**'` empty, `pnpm check:docs`, `pnpm exec vitest run scripts/__tests__/ci-efficiency.spec.ts`
- [ ] AC-3 [local]: the hub renders all tabs in a real browser with no console error. proof: headed screenshot per tab on the PR

#### Phase 2: The kit-loop tab and the skill pointer

**Status:** NOT STARTED
**Files:** `scripts/perf-live.ts` (kit-loop reader), `.agents/skills/native-performance-loop/references/dashboard.md`.

- [ ] AC-4 [local]: the kit-loop tab plots K1–K4 per iteration against the PRD-750 baseline and targets. proof: `pnpm exec vitest run scripts/__tests__/perf-live.spec.ts -t kit-loop`
- [ ] AC-5 [local]: the native-performance-loop skill reference sends a campaign to a hub tab, not a new page. proof: `pnpm sync:agents --check`, `pnpm check:docs`
