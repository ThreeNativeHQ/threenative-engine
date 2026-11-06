# PRD-829 — An existing game receives the current authoring layer

**Status:** IN PROGRESS
**Priority:** P1 — AC-1..AC-6 are open, and until they land every authoring fix (PRD-825, PRD-827, #616) reaches new scaffolds only, not one of the 40 sandbox games
**Complexity:** 4 (MEDIUM) — 3 implementation files in one package (`doctor.ts`, `index.ts`, `threenative.ts`); risk override: none (writes are limited to scaffold-owned files and fail closed on edits)
**Owner:** João Paulo Furtado
**Depends on:** None (PRD-825 AC-8 is independent; this PRD ships whatever router is current)

## Context

The authoring layer is the files `create-threenative` copies at scaffold time: `AGENTS.md`/`CLAUDE.md`
from `templates/<kit>/`, everything under `agent-files/` (skills, `.claude/settings.json`, hooks,
subagents, `scripts/`), and the per-host MCP configs from `writeHostMcpConfigs`. The copy happens once
(`packages/create-threenative/src/index.ts:943` `copyAgentFiles`). No command copies it again. The
`threenative` CLI has `build` and `doctor` only (`src/threenative.ts:52-55`).

Measured on 2026-11-06 in `/home/joao/projects/threenative/sandbox`:

| Fact | Evidence |
|---|---|
| 40 games pin 8 different `create-threenative` versions, 0.2.6 to 0.2.17; 29 of them are on 0.2.6 | `grep '"create-threenative"' */package.json` |
| Their `AGENTS.md` ranges from 86 to 566 lines; the current router caps a kit file at 120 | `wc -l */AGENTS.md`; PRD-825 AC-4 |
| Starlance (0.2.15, the active game) has none of the PRD-827 wiring: no `enabledMcpjsonServers`, no `discovery-gate.mjs` hook | `starlance/.claude/settings.json` vs `agent-files/.claude/settings.json` |
| Starlance's agent files are byte-identical to its 0.2.15 scaffold, so nothing game-owned blocks an update | `diff -r node_modules/create-threenative/agent-files/.agents .agents` → empty; `AGENTS.md` same |
| Starlance lanes call the engine through `call.mjs` (`.agent/LANES.md` rule 4), the path PRD-825 AC-6 replaces with in-folder `ToolSearch` | `starlance/.agent/LANES.md:20-23` |

PRD-825 and PRD-827 were written **from Starlance transcripts** (`dfe8f9ce`: the existing-game route
skipped capability search for every change). Both fixes merged in #619 and Starlance still runs the
behaviour they fixed. An authoring fix that reaches only the next `create-threenative` run is invisible
to the owner, who works in existing games.

What the stale layer cost, from the Starlance transcripts (10 sessions, 49 subagent transcripts,
2026-11-05 22:21 → 2026-11-06 20:21 UTC; counts deduplicated by `tool_use` id, approximate):

| Signal | Count |
|---|---|
| `Skill` calls for any `threenative-*` skill (AGENTS.md calls `threenative-capabilities` a "critical authoring gate") | 0 |
| `engine_search_capabilities` calls; the first heavy use was an after-the-fact audit (`96d50d32` 03:49) that found hand-rolled loading `loadAll` already covers, and `Math.random` in 7 places | ~8 |
| MCP schema misread (`{"query": …}` instead of `situation`) through `call.mjs` | 2 sessions (`5b86bab5` 22:28) |
| `threenative-sculpt`, `threenative-animation` calls | 0 |
| Bash calls in the same window | ~2,090 |

PRD-827's gate and auto-loaded servers target exactly these counts. AC-6 re-measures them on Starlance.

## Solution

Reuse the scaffold's own writers on an existing game, behind the existing `doctor` verb. No new CLI
verb: the charter's closed list forbids bespoke CLI vocabulary, and `--fix` is borrowed (ESLint,
`expo install --fix`).

1. **Stamp.** Scaffold writes `.threenative/agent-files.json`: `{ createThreenative: "<version>",
   kit: "<kit.json name>", files: { "<path>": "<sha256>" } }` for every file it copied or rendered from
   the authoring layer. The stamp is committed (it is the game's record, not local state).
2. **Check.** `threenative doctor` gains one `authoring layer` row: `ok` when the stamp version equals
   the installed `create-threenative` and every stamped hash still matches; `warn` with the version gap
   and the stale file count otherwise. A game with no stamp (all 40 today) compares its files with
   what the installed package would render; any difference is `warn`.
3. **Fix.** `threenative doctor --fix` re-renders the authoring layer from the installed package into
   the game through the same functions scaffold uses (`copyAgentFiles`, `renderTemplate`,
   `writeHostMcpConfigs`, `assertMcpConfig`, `assertReferenceBundle`, `installAuthoringGitignore`).
   - A file whose bytes match its stamped hash (unedited) is overwritten.
   - A file the game edited is kept, listed with its path, and the run exits 1. `--force` overwrites
     it; git is the undo. With no stamp, every differing file counts as edited unless `--force`.
   - Files removed from the package since the stamp (for example the 0.2.6 `agent-docs/` copy that
     PRD-449 moved into `node_modules`) are deleted only when unedited.
   - It writes the new stamp and prints one line per written, kept and deleted path.
4. **Docs.** The router's convention index and `threenative doctor --help` name the flow:
   `pnpm up create-threenative @threenative/*` then `pnpm exec threenative doctor --fix`.

```
owner: "pnpm exec threenative doctor --fix"
  → threenative.ts → doctor.ts authoring-layer row → index.ts scaffold writers (shared)
  → game files rewritten + .threenative/agent-files.json → next agent session reads the router
```

Risks: a game that hand-edited `AGENTS.md` (the sandbox root says each game's `AGENTS.md` owns its
subtree) is never overwritten silently — it is kept and reported. `--fix` touches no `src/`,
`assets/`, `playtests/` or `package.json`; dependency bumps stay with the package manager.

## Acceptance Criteria

- [x] AC-1 [local]: a fresh scaffold writes `.threenative/agent-files.json` whose hashes match the files on disk, and `threenative doctor` reports `authoring layer: ok`. proof: red-green `packages/create-threenative/__tests__/scaffold.spec.ts` (new case) — Evidence: case "stamps the authoring layer it wrote, and doctor reports it ok (PRD-829)". Red (2026-11-06): the 8 new cases failed with `ENOENT ... .threenative/agent-files.json` and `doctor: unknown option '--fix'`. Green: `scaffold.spec.ts` 79 passed.
- [x] AC-2 [local]: a scaffold made by the previous published `create-threenative` reports `authoring layer: warn` naming both versions and the stale file count. proof: red-green `__tests__/doctor.spec.ts` fixture — Evidence: `doctor.spec.ts` case "warns on an authoring layer an older create-threenative stamped" asserts `stamp 0.2.15, installed create-threenative 0.2.17 (starter kit): 1 stale file`. Red (2026-11-06): the 8 new cases failed with `ENOENT ... .threenative/agent-files.json` and `doctor: unknown option '--fix'`. Green: 98 passed in `doctor.spec.ts`. No published version writes a stamp yet (npm latest is 0.2.15), so the fixture is a current scaffold with an older stamp. Real check: `npx create-threenative@0.2.15 fox --template minimal --no-install`, then `authoringLayerStatus` reads `{"installed":"0.2.17","kit":"minimal"}` with 9 stale files and no stamp, so the row reads `stamp absent, installed create-threenative 0.2.17 (minimal kit): 9 stale files`.
- [x] AC-3 [local]: `doctor --fix` on that fixture leaves it byte-equal to a fresh scaffold of the current version (same kit, same project name), and `doctor` then reports `ok`. proof: `__tests__/doctor-fix.spec.ts` tree diff — Evidence: case "leaves an older game byte-equal to a fresh scaffold, and the status then reads current": 3 files written, the dropped `agent-docs/old.md` deleted, every stamped file and the stamp byte-equal to a fresh scaffold. Red (2026-11-06): the 8 new cases failed with `ENOENT ... .threenative/agent-files.json` and `doctor: unknown option '--fix'`. Green: `doctor-fix.spec.ts` 6 passed. Real check on the 0.2.15 `minimal` scaffold: `--fix` wrote 1 and kept 8 (no stamp, so every differing file counts as edited), `--fix --force` wrote 8. Then 24 of 24 layer files and the stamp equal a fresh 0.2.17 scaffold, and the status reads `stamped 0.2.17`, 0 stale. `diff -rq` shows changes only in the authoring layer, the MCP host configs and `.gitignore`.
- [x] AC-4 [local]: an edited `AGENTS.md` survives `--fix` unchanged, is listed as kept, and the run exits 1; `--force` overwrites it. proof: same spec, two cases — Evidence: cases "keeps an AGENTS.md the game edited and lists it; --force overwrites it" and "exits 1 with TN_AUTHORING_LAYER_EDITED when a file was kept" (stderr `kept AGENTS.md`, exit 1 through `runDoctorCommand`). Red (2026-11-06): the 8 new cases failed with `ENOENT ... .threenative/agent-files.json` and `doctor: unknown option '--fix'`. Green: 6 passed.
- [ ] AC-5 [local]: `--fix` on Starlance (0.2.15, no stamp) through the packed tarball installs the PRD-827 hooks and `enabledMcpjsonServers`, the 120-line router, and changes no file outside the authoring layer. proof: `git -C sandbox/starlance diff --stat` after `pnpm exec threenative doctor --fix --force`, plus `claude mcp get threenative-engine` in that folder shows no pending approval — Evidence: pending.
- [ ] AC-6 [local]: after AC-5, a cold `claude -p` session in Starlance asked for a new gameplay file calls `engine_search_capabilities` through the loaded MCP tool (not `call.mjs`) before its first `src/` write. proof: `pnpm kit:loop record <dir>` counts on that transcript (the PRD-825 AC-1 counter) — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Authoring-layer stamp | `create-threenative` scaffold → `src/index.ts` after `copyAgentFiles` | new | AC-1 |
| Stale authoring-layer report | `threenative doctor` → `src/doctor.ts` new row | new | AC-2 |
| In-place authoring-layer update | `threenative doctor --fix` → `src/threenative.ts` → shared scaffold writers in `src/index.ts` | replaces hand copies between games (Starlance `tasks.json` id 1 copied `capture-lock.sh` from `../caravel`) | AC-3, AC-5 |

## Decisions

- 2026-11-06 (agent): `doctor --fix`, not a new `threenative agents sync` verb. Reason: the closed list forbids bespoke CLI vocabulary, and the doctor already owns "is this project what the tools assume".
- 2026-11-06 (agent): edited files are kept unless `--force`; no three-way merge. Reason: git is the merge tool in every sandbox game, and a merge engine costs more code than the problem.
- 2026-11-06 (agent): phases 1 and 2 land in one commit. Reason: the scaffold, the status row and `--fix` share one renderer (`renderedAuthoringLayer`), so a phase-1-only commit would need a second code path.
- 2026-11-06 (agent): the shared writer is `renderedAuthoringLayer(target, kit, root)`, not `writeAuthoringLayer(target, kit)`. It copies the kit router pair, runs `copyAgentFiles` and `renderTemplate` into a temporary folder and returns each path's hash. The scaffold stamps those hashes. `--fix` copies from that folder, then runs `linkClaudeSkills`, `writeHostMcpConfigs`, `assertMcpConfig`, `installAuthoringGitignore` and `assertReferenceBundle` on the game. Reason: the scaffold already renders the whole template tree in one pass, so it needs only the list and hashes.
- 2026-11-06 (agent): the stamp records the package's bytes for every path, also for a kept file. Reason: a kept edit must read as edited on the next run, or the next `--fix` overwrites it silently.
- 2026-11-06 (agent): the game's kit comes from the stamp, else the `kit.json` that scaffolds before PRD-826 copied, else the router title (`the shooter kit`, or the last word of `# AGENTS.md — starlance minimal`). Reason: 0.2.6-0.2.15 games carry `kit.json`, and 0.2.17 scaffolds carry only the title. With none, the row warns and `--fix` fails with `TN_AUTHORING_LAYER_KIT`.
- 2026-11-06 (agent): the MCP host configs and `.gitignore` are written by their existing merge writers, not stamped. Reason: `@threenative/core` postinstall also writes the configs, so a stamped hash would read as an edit after every install.
- 2026-11-06 (agent): `--force` also deletes a dropped file the game edited. Reason: `--force` means "the package wins", and git is the undo.
- 2026-11-06 (agent): `--fix` prints its lines to stderr. Reason: stdout keeps the JSON report that `doctor` prints by default.
- 2026-11-06 (agent): the router names the flow as one Commands line, `npx threenative doctor --fix  # refresh agent files`, not a convention row. Reason: it is a command, not a convention with an override, and the `action-rpg` router is at 1,200 of 1,200 words after this line. `threenative doctor --help` names `pnpm up create-threenative @threenative/*` first.
- 2026-11-06 (agent): no version bump. Reason: npm latest is 0.2.15 and the tree is at 0.2.17, which is not published, so this change rides the 0.2.17 cohort.
- 2026-11-06 (agent): `tsup` keeps `./index.js` external. Reason: `threenative.js` now imports the scaffolder, and an inlined copy would run the scaffolder's entry check against `threenative.js` and scaffold a project.

## Execution Phases

#### Phase 1: Stamp and report
**Status:** NOT STARTED
**Files:** `packages/create-threenative/src/index.ts` (write the stamp after the writers), `src/doctor.ts` (the row), tests.
**Implementation:** hash every authoring-layer path the scaffold wrote; the stamp lists paths, not globs. The doctor row reads the stamp, or renders the current layer into a temp dir to compare when there is none.
**Verification:** `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts packages/create-threenative/__tests__/doctor.spec.ts` — AC-1, AC-2.
- [x] Phase 1 done: stamp written by scaffold, `authoring layer` doctor row (AC-1, AC-2). proof: scaffold.spec.ts and doctor.spec.ts. Evidence: AC-1 and AC-2 above. The scaffold hash test now skips the stamp (it records bytes the test already hashes). The allowlist spec names `.threenative/agent-files.json`. All 16 tree hashes were re-measured for the new router line.

#### Phase 2: `doctor --fix`
**Status:** NOT STARTED
**Files:** `src/threenative.ts` (flag and help text), `src/index.ts` (export the writers as one `writeAuthoringLayer(target, kit)` used by both scaffold and fix), `src/doctor.ts`.
**Implementation:** scaffold calls `writeAuthoringLayer`; `--fix` renders it into a temp dir, then copies per the keep/overwrite/delete rules above. Fails closed with `TN_AUTHORING_LAYER_EDITED` on kept files.
**Verification:** `pnpm exec vitest run packages/create-threenative/__tests__/doctor-fix.spec.ts`, then `pnpm typecheck && pnpm lint && pnpm test` in the engine — AC-3, AC-4.
- [x] Phase 2 done: `doctor --fix` and `--force` through the shared writers (AC-3, AC-4). proof: doctor-fix.spec.ts. Evidence: AC-3 and AC-4 above. Related specs: `doctor-fix`, `doctor`, `scaffold`, `cli`, `cli-bin`, `consumer-cli`, `scaffold-file-allowlist`, `scaffold-mcp`, `publication`, `discovery-gate`, `template`, `template-conventions`, `sync-agent-docs`, `kit-conventions`, `instruction-budget`: all pass. `pnpm typecheck` exit 0, `pnpm lint` exit 0. The built `dist/threenative.js` imports `./index.js` as its own module, and `threenative doctor --text` in an empty folder writes nothing.

#### Phase 3: Starlance proof
**Status:** NOT STARTED
**Files:** pack per sandbox `AGENTS.md` (content-hashed tarball name), Starlance `package.json` repoint, Starlance authoring files (generated).
**Implementation:** pack `create-threenative`, repoint Starlance, `pnpm install`, `pnpm exec threenative doctor --fix --force`, commit Starlance's regenerated files on their own.
**Verification:** AC-5 diff and MCP check; AC-6 cold session counted by `kit:loop`.
- [ ] Phase 3 done: Starlance refreshed through the packed tarball (AC-5, AC-6). proof: Starlance git diff and kit:loop record. Evidence: pending.
