# PRD-449 — The scaffold ships only what a new game needs

**Status:** IN REVIEW — Phases 1–3 shipped; open: AC-5's ≤ 8k line target (8,138 measured) is an owner call, and the full `pnpm test` box waits on CI (18 `runtime-native` tests need the opt-in native build, absent locally)
**Priority:** P2 — Remaining: AC-5 line-budget owner call, CI green, three pending owner vetoes.
**Complexity:** 1 (LOW)
**Owner:** João
**Depends on:** None

## Context

The owner opened a freshly generated game and found "a ton of files … many unrelated playwright
tests I haven't asked for". The count bears it out. The default template (`starter`,
`packages/create-threenative/src/index.ts:66`) plus the shared agent files it copies come to
**~144 files and ~24k text lines** before `node_modules`. The game's own code (`src/`, configs,
assets) is **~4.7k lines**.

There are no Playwright specs. `playwright` is a devDependency only because `threenative-playtest`
drives Chromium through it (`templates/starter/package.json` `pretest`). The "tests I haven't asked
for" are **24 playtest scenarios** in `templates/starter/playtests/`, and `pnpm test` runs every one
through the `playtests/*.playtest.json` glob. Every other template ships 3–9, except `platformer`,
which ships 22.

Weight a new project carries that nothing in it reads:

| Item | Size | Evidence |
|---|---|---|
| `capabilities.json` at the project root (`copyCapabilityManifest`, `src/index.ts:521`) | 1 file, 6.5k lines, 228 KB | `packages/engine-mcp/src/index.ts:220-252` prefers `node_modules/@threenative/core/capabilities.json`. Its own comment says a committed copy "drifts the moment the engine dependency moves". The project copy is read only when core is not installed. |
| `.claude/skills/*` (10 skills) | ~450 lines | byte-identical to `.agents/skills/*` (`diff -rq`, 2026-09-25) |
| `AGENT-ROLES.md` | 1 file | no reader: not in `src/`, not linked from any template's `AGENTS.md` |
| `agent-docs/*.md` (17 references) | 7.9k lines | read on demand by an agent following a link from `AGENTS.md:91-94`. `create-threenative` is already a devDependency of the game, so the same files are installed under `node_modules/`. |
| 21 of 24 starter scenarios | ~2.2k lines | only `survives` is pinned as "the durable scenario" (`__tests__/playtest.spec.ts:8`). Six (`hot-reload`, `models`, `textures`, `monitoring`, `zoom-pinch`, `zoom-wheel`) are named by nothing outside the template. |

Kept deliberately: `src/**`, root configs, `assets/`, `tools/look.mjs`, `AGENTS.md`/`CLAUDE.md`,
`.mcp.json`, the hooks, and `native-playtests/`. Native is half the product (desktop, Android and
iOS through one source), so its two proofs stay.

## Solution

Delete what nothing reads, and point to what an installed package already carries. No new
command, no new generator, no "add a test later" CLI.

1. Stop writing `capabilities.json` into the project. The MCP already reads the installed core
   copy.
2. Ship each skill once, in `.agents/skills/`. Write `.claude/skills` as a relative symlink to it,
   falling back to a copy only where a symlink fails (Windows without developer mode). Delete
   `AGENT-ROLES.md`.
3. Point the `AGENTS.md` reference links at
   `node_modules/create-threenative/agent-docs/references/…` instead of copying 17 files into the
   project. The package's `files` list already ships `agent-docs`, and the game already depends on
   `create-threenative`. The pages carry no per-project tokens: the `__THREENATIVE_*__` strings in
   `debug-surface.md` and `trace-a-slow-frame.md` are runtime global names, not
   `substituteTemplateVariables` keys.
4. Cut starter's scenarios to the three that prove a new game works: `survives` (the loop runs),
   `play` (input moves the player) and `production-readiness` (the build ships). The other 21 cover
   engine features, and the engine's own suites prove those (`pnpm test:templates` runs them
   today). Where a scenario still guards something, move it to the matching engine playtest instead
   of deleting it.

Flow: `pnpm create threenative my-game` → `copyTemplate` / `copyAgentFiles` → files on disk → an
agent reads `AGENTS.md` and follows its links into the installed `create-threenative`, and
`pnpm test` runs the kept scenarios.

Risk: an agent following a reference link hits a dead path. Mitigation: `assertReferenceBundle`
(`src/index.ts`) checks every named page against the package's own bundle directory and fails
closed.

## Acceptance Criteria

- [x] AC-1 [local]: A fresh `starter` scaffold contains no `capabilities.json` and no
  `AGENT-ROLES.md`, and `engine_search_capabilities` still answers from inside it — proof: scaffold
  spec plus an `engine-mcp` smoke run from the generated project's root — Evidence: 2026-09-25,
  `scaffold.spec.ts` asserts both files absent; `scaffold-mcp.spec.ts` probes the real engine MCP
  from each scaffold root with core linked and reads the installed-core manifest (6 files / 199
  tests green).
- [x] AC-2 [local]: Each skill exists once on disk, and both Claude Code (`.claude/skills`) and
  Codex (`.agents/skills`) resolve it — proof: `pnpm exec vitest run
  packages/create-threenative/__tests__/template.spec.ts` — Evidence: 2026-09-25, red first
  (`scaffold.spec.ts` "store each skill once": `file-engine-bug is a second stored copy`), green
  after `linkClaudeSkills` (relative per-skill symlinks, EPERM/EACCES copy fallback).
- [x] AC-3 [local]: Every `agent-docs` link in each template's `AGENTS.md` resolves to a file the
  installed `create-threenative` carries — Evidence (open until the `pnpm sandbox` install runs): 2026-09-25, `pnpm pack` + tar listing shows
  the 17 pages at `package/agent-docs/references/`, and a scan of the packed bytes resolves all 356
  backticked links across the 10 templates' `AGENTS.md`/`CLAUDE.md` and every `SKILL.md` with zero
  missing; `build.spec.ts` pins each template's `create-threenative` devDependency;
  `scaffold.spec.ts` scaffolds a kit, asserts no `agent-docs/` and re-checks every link against
  the bundle, and still fails closed on a page the package does not ship. Sandbox, 2026-09-25:
  `pnpm sandbox --genre platformer --out <private dir>` (starter, tarball install) — 66 distinct
  `node_modules/create-threenative/agent-docs/references/…` links across `AGENTS.md`, `CLAUDE.md`
  and every `SKILL.md` all resolve (0 missing); no `agent-docs/`, `capabilities.json` or
  `AGENT-ROLES.md` in the project; `.claude/skills/*` are symlinks; and
  `engine_search_capabilities` answers over stdio from the game root through
  `node_modules/@threenative/core/mcp/engine.mjs` (AC-1).
- [x] AC-4 [local]: `pnpm test` in a fresh starter runs exactly 3 scenarios, all green — proof:
  `pnpm test:templates` (starter) — Evidence, 2026-09-25: `pnpm test` in the tarball-installed
  sandbox starter ran exactly `survives`, `play`, `starter-production-readiness`, exit 0.
  `test:templates` skips starter (`ALREADY_BOOTED_TEMPLATES`); the lane that runs starter's full
  suite is `verify:golden-path`, which now copies the 21 guards back in:
  `TN_GOLDEN_PATH_TEMPLATES=starter pnpm verify:golden-path` ran all 24 — 20 green, and `play`,
  `textures`, `touch-controls`, `zoom-pinch` died with "Target page, context or browser has been
  closed" at machine load ~18; the same 4 re-run in the sandbox starter at load ~9: all green.
- [ ] AC-5 [local]: Fresh starter is ≤ 95 files and ≤ 8k text lines, excluding `node_modules`,
  `dist`, lockfile and the MCP host configs written by core's install (was ~144 / ~24k; the cuts
  above remove 52 files and ~17k lines) — proof: `find` count on the sandbox scaffold, recorded
  here — Evidence, 2026-09-25 (sandbox starter, also excluding the sandbox's own `brief.md`,
  `reference.png`, `sweep.json`): **files met, lines missed by 138.** 87 regular files (+10
  `.claude/skills` symlinks, no bytes) and **8,138** text lines. Before, measured from git at the
  base: 87 + 1 + 1 + 10 + 17 + 23 = 139 files and 8,138 + 6,548 (`capabilities.json`) + 26
  (`AGENT-ROLES.md`) + 475 (skill copies) + 7,884 (`agent-docs`) + 1,535 (moved scenarios) ≈
  24.6k lines, so the cut is 52 files / 16.5k lines as planned; the ≤ 8k line target came from the
  ~4.7k game-code estimate, which left out the kept 682-line `patches/three@0.185.1.patch` and the
  1,087 lines of `scripts/reference.mjs` + `scripts/visual-loop.mjs`. Left open for the owner:
  accept 8.1k or name a further cut (nothing in the PRD's "kept deliberately" list was touched).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Capability search in a new game | `.mcp.json` → `engine-mcp` `resolveManifest` (`packages/engine-mcp/src/index.ts:220`) | project copy deleted; installed-core copy is the only path | AC-1 |
| Skills | host reads `.claude/skills` / `.agents/skills` | duplicate copy → symlink | AC-2 |
| Reference docs | `AGENTS.md:91-94` links | project copy → installed `create-threenative` copy | AC-3 |
| Starter scenarios | `pnpm test` glob (`package.json`) | 24 → 3; the other 21 moved to `create-threenative/template-playtests/starter/` and are copied in by `runTemplatePlaytests` and by CI's `template-nonvisual` lane, so the guards run without shipping | AC-4 |

## Decisions

- 2026-09-25 (Claude, pending owner veto): `native-playtests/` and `test:native` stay. They are the
  only in-project proof of the second runtime.
- 2026-09-25 (Claude, pending owner veto): the six per-host MCP configs (`.cursor/`, `.gemini/`,
  `.vscode/`, `.zed/`, `opencode.json`, `.codex/config.toml`) stay. They come from `@threenative/core`'s
  install step (`packages/core/mcp/install.mjs:42` `MCP_HOSTS`), not the scaffold, so they are that
  step's scope.
- 2026-09-25 (Claude): `platformer`'s 22 scenarios are out of scope. It is an opt-in genre kit, not
  the default the owner generated. Apply the Phase 3 rule there in a follow-up if it proves out on
  starter.

## Execution Phases

#### Phase 1: Delete what nothing reads
**Status:** DONE
**Files:** `packages/create-threenative/src/index.ts` (drop `copyCapabilityManifest`; skills
symlink with copy fallback in `copyAgentFiles`), `agent-files/.claude/skills/` (delete),
`agent-files/AGENT-ROLES.md` (delete), `__tests__/scaffold.spec.ts` and `__tests__/template.spec.ts`
(update the pinned paths).
- [x] No `capabilities.json` or `AGENT-ROLES.md` in the scaffold; the MCP answers from the project root (AC-1). `githooks/pre-commit` and `scripts/verify-golden-path.ts` no longer name the removed copies.
- [x] Skills stored once and resolved by both hosts; red first, from the test asserting a single copy (AC-2). Builder/verifier stay subagent-only for Claude Code (`.claude/agents/`).

#### Phase 2: References come from the installed package
**Status:** DONE
**Files:** `src/index.ts` (`copyReferenceBundle` deleted, `assertReferenceBundle` re-pointed at
the package bundle), each `templates/*/AGENTS.md` reference line, the seven
`agent-files/.agents/skills/*/SKILL.md` reference links, the three reference pages that cross-link
each other, `scripts/instruction-budget.ts` (reference-target budget), `scripts/not-owned-capabilities.ts`
(guidance text), `__tests__/publication.spec.ts:337`.
- [x] Every template's reference links resolve in the package the project installs (AC-3).
  `pnpm build` repacks `capabilities.json`; `vitest run packages/create-threenative` scaffolds every
  kit and fails closed when a link names a page the package does not ship
  (45 files / 739 tests green, 2026-09-25).
- [x] `pnpm sync:agents` and the instruction-budget spec are green — 19 mirrors written, all ten
  templates OK, `sync:agents --check` clean, 2026-09-25.
- [x] Red first: `scaffold.spec.ts:784` rejected the promise wrongly — `lstat(<target>/agent-docs)`
  resolved because the scaffold still copied the bundle. Green after `copyReferenceBundle` went.

#### Phase 3: Starter proves the game, not the engine
**Status:** PARTIAL — the cut, the readers and all three engine lanes are done; AC-4 green; AC-5 files
met, lines 138 over (owner call); full `pnpm test` waits on CI's native build.
**Files:** `templates/starter/playtests/` (3 kept), `template-playtests/starter/` (21 scenarios + 2
baselines, never published), `scripts/verify-template-playtests.ts:88` (copies the guards into the
scaffold before `pnpm test`), `.github/workflows/ci.yml` `template-nonvisual` (same copy),
`scripts/__tests__/ci-structure.spec.ts:1200` (classifies the union), `scaffold.spec.ts:513`
`STARTER_PATHS`, `template.spec.ts`, `playtest.spec.ts`, `looks.spec.ts`, two starter comments.
- [x] The 21 scenarios and both baselines moved to `template-playtests/starter/`, and nothing is
  deleted: `npm pack --dry-run` in the package lists 0 `template-playtests` entries and exactly
  `templates/starter/playtests/{play,production-readiness,survives}.playtest.json` (623 entries).
- [x] The engine sweep still runs all 24: `runTemplatePlaytests` copies
  `template-playtests/<template>/` into `<target>/playtests/` between `create(...)` and
  `execute("pnpm", ["test"])`, and a new assertion in
  `scripts/__tests__/verify-template-playtests.spec.ts` fails if the copy has not landed by the
  time `run` is called (7 files / 7 tests green).
- [x] The per-PR `template-nonvisual` CI lane copies the same directory into its scaffold, so the
  21 keep their every-PR proof. Without it the starter has 1 non-visual scenario and its 3 shards
  select nothing in 2 legs (the classifier reads 14 with the guards, 1 without);
  `ci-structure.spec.ts` classifies the same union (119 files / 1454 tests green).
- [x] Every reader repointed (`STARTER_PATHS` + the new "exactly three" `readdir` assertion,
  `template.spec.ts` ×3, `playtest.spec.ts` ×2, `looks.spec.ts`), and the two starter comments
  naming a moved scenario reworded. `platformer/src/entities/Character.ts` and
  `platformer/src/scenes/Level.ts` are left alone: they name scenarios that kit still ships.
  Red first: `scaffold.spec.ts:1117` listed 24 files where 3 were expected.
- [x] Starter runs exactly 3 scenarios, green (AC-4) — sandbox `pnpm test`, 3 scenarios, exit 0.
  `scripts/verify-golden-path.ts` copies `template-playtests/<template>/` into the scaffold too,
  since golden-path (not `test:templates`) is where starter's GPU scenarios run.
- [ ] Size target met and recorded (AC-5) — recorded, not met: 87 files ✓, 8,138 lines vs ≤ 8k ✗ (see AC-5).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green; `pnpm budgets` clean. 2026-09-25:
  `typecheck`, `lint` and `budgets` all exit 0, and `pnpm test` is green except 18 tests in
  `packages/runtime-native` that fail with "executable is not built. Run: cmake --build …" — the
  opt-in native build is absent in this worktree, and no native path is in this diff.

**Verification:** `pnpm exec vitest run packages/create-threenative`, `pnpm test:templates`, and one
`pnpm sandbox` scaffold counted with `find`. CI's `golden-path` and `template-nonvisual` jobs rerun
the same scaffold on push.
