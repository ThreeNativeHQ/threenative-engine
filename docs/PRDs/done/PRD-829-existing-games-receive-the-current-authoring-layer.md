# PRD-829 — An existing game receives the current authoring layer

**Status:** DONE (2026-11-07) — the authoring-layer refresh (AC-1 to AC-7) and the boot on the pair `--fix` leaves (Phase 3) are proved.
**Priority:** P1. Before this PRD, an authoring fix (PRD-825, PRD-827, #616) reached new scaffolds only, not one of the 40 sandbox games.
**Complexity:** 4 (MEDIUM) — 3 implementation files in one package (`doctor.ts`, `index.ts`, `threenative.ts`); risk override: none (writes are limited to scaffold-owned files and fail closed on edits and on a mismatched engine pair)
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
   Before it writes anything it fails closed on two facts about the install: the installed
   `@threenative/core` is the release this `create-threenative` pairs with (`TN_AUTHORING_LAYER_PAIR`,
   naming `pnpm up create-threenative @threenative/*`), and every MCP server entry file the config
   names exists in the project.
   - A file whose bytes match its stamped hash (unedited) is overwritten.
   - A file the game edited is kept, listed with its path, and the run exits 1. `--force` overwrites
     it; git is the undo. With no stamp, every differing file counts as edited unless `--force`.
   - Files removed from the package since the stamp (for example the 0.2.6 `agent-docs/` copy that
     PRD-449 moved into `node_modules`) are deleted only when unedited.
   - It writes the new stamp and prints one line per written, kept and deleted path.
4. **Docs.** The router's convention index and `threenative doctor --help` name the flow:
   `pnpm up --latest create-threenative @threenative/*` then `pnpm exec threenative doctor --fix`.

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
- [x] AC-3 [local]: `doctor --fix` on that fixture leaves it byte-equal to a fresh scaffold of the current version (same kit, same project name), and `doctor` then reports `ok`. proof: `__tests__/doctor-fix.spec.ts` tree diff — Evidence: case "leaves an older game byte-equal to a fresh scaffold, and the status then reads current": 3 files written, the dropped `agent-docs/old.md` deleted, every stamped file and the stamp byte-equal to a fresh scaffold. Red (2026-11-06): the 8 new cases failed with `ENOENT ... .threenative/agent-files.json` and `doctor: unknown option '--fix'`. Green: `doctor-fix.spec.ts` 6 passed, 9 with AC-7's cases. Real check on the 0.2.15 `minimal` scaffold: `--fix` wrote 1 and kept 8 (no stamp, so every differing file counts as edited), `--fix --force` wrote 8. Then 24 of 24 layer files and the stamp equal a fresh 0.2.17 scaffold, and the status reads `stamped 0.2.17`, 0 stale. `diff -rq` shows changes only in the authoring layer, the MCP host configs and `.gitignore`.
- [x] AC-4 [local]: an edited `AGENTS.md` survives `--fix` unchanged, is listed as kept, and the run exits 1; `--force` overwrites it. proof: same spec, two cases — Evidence: cases "keeps an AGENTS.md the game edited and lists it; --force overwrites it" and "exits 1 with TN_AUTHORING_LAYER_EDITED when a file was kept" (stderr `kept AGENTS.md`, exit 1 through `runDoctorCommand`). Red (2026-11-06): the 8 new cases failed with `ENOENT ... .threenative/agent-files.json` and `doctor: unknown option '--fix'`. Green: 6 passed, 9 with AC-7's cases.
- [x] AC-5 [local]: `--fix` on Starlance (0.2.15, no stamp) through the packed tarball installs the PRD-827 hooks and `enabledMcpjsonServers`, the 120-line router, and changes no file outside the authoring layer. proof: `git -C sandbox/starlance diff --stat` after `pnpm exec threenative doctor --fix --force`, plus `claude mcp get threenative-engine` in that folder shows no pending approval — Evidence: 2026-11-06, the file refresh only. Tarball `create-threenative-0.2.17-prd829-830-cac8cea91486.tgz` (an earlier `-6e465d796eb5` was replaced after a plugin fix). Only Starlance's `create-threenative` devDependency was repointed, then `pnpm install`. Before: `! authoring layer: stamp absent, installed create-threenative 0.2.17 (minimal kit): 11 stale files`. `pnpm exec threenative doctor --fix --force --text` wrote 11 files: three skills, `.claude/hooks/discovery-gate.mjs`, `.claude/hooks/ponytail-context.mjs`, `.claude/settings.json`, `.codex/hooks.json`, two `.threenative/agents/*.md`, `AGENTS.md` and `CLAUDE.md`. After: `✓ authoring layer: stamp matches installed create-threenative 0.2.17 (minimal kit)`. `.claude/settings.json` has `enabledMcpjsonServers` (6 servers) and the discovery gate on `UserPromptSubmit` and `PreToolUse`. `AGENTS.md` is 97 lines. `claude mcp get threenative-engine` in the folder reports `Status: ✔ Connected` with no approval prompt. `git diff --stat` touches only the authoring layer: the skills, `.codex/hooks.json`, the MCP host configs, `.gitignore` (+ `.threenative/discovery-gate.json`), `AGENTS.md` and `CLAUDE.md`, plus `package.json` and `pnpm-lock.yaml` from the repoint. The sandbox `.gitignore` ignores `.claude` and `.threenative/`, so those files change on disk and stay out of the commit. **Boot (2026-11-07):** proved once the 0.3.12 cohort published — Starlance on the packed tarball `create-threenative-0.2.17-prd829-830-0251de582fd0.tgz` beside `@threenative/{core,physics,playtest,runtime-native}` 0.3.12 and `@threenative/assets` 0.3.13: `doctor --fix --force --text` printed `authoring layer already current` and exited 0, and `threenative-playtest playtests/smoke.playtest.json --browser-recipe webgpu --headed` under `sh scripts/xvfb.sh` returned `pass: true` with `runtimeReady: true`, `consoleErrors: 0`, `runtimeDiagnostics: 0`, `distance` 91.4 against a minimum of 50, the full-viewport visual region non-blank at ratio 1.0, and adapter `webgpu:architecture=turing|vendor=nvidia`. The one diagnostic is the pre-existing `TN_PLAYTEST_STARTUP_OFFSCREEN_BYTES` warning. `TN_ABI_6` does not occur on this pair.
- [x] AC-6 [local]: after AC-5, a cold `claude -p` session in Starlance asked for a new gameplay file calls `engine_search_capabilities` through the loaded MCP tool (not `call.mjs`) before its first `src/` write. proof: `pnpm kit:loop record <dir>` counts on that transcript (the PRD-825 AC-1 counter) — Evidence: 2026-11-06. Cold `claude -p --model haiku --output-format stream-json` in Starlance after AC-5, prompt "Add a new gameplay file under src/: a fuel canister pickup ...". `discovery()` from `scripts/kit-loop.mjs` (the `record` counter) on its `events.jsonl`: `mcpCallsBeforeFirstSrcWrite: 4`, `capabilitySearchBeforeFirstSrcWrite: true`, `referenceSearchBeforeFirstSrcWrite: true`, `callMjsWhileLoaded: 0`, `firstSrcWrite: "src/entities/FuelCanister.ts"`. The calls in order: `engine_search_capabilities`, `engine_search_references`, `engine_search_capabilities`, `engine_reference_detail`. The discovery gate wrote `.threenative/discovery-gate.json` at the prompt. 25 turns, USD 0.03. The session files (`src/entities/FuelCanister.ts`, `.threenative/discovery-gate.json`) were deleted afterwards. The engine and reference tools answered; the `threenative-terrain` shim was absent on that pair, so that one server could not start. See Decisions for why no ledger row was recorded.
- [x] AC-7 [local]: `doctor --fix` writes nothing when the installed `@threenative/core` is not the release this `create-threenative` pairs with, and writes nothing when a required MCP shim is absent. It fails closed with `TN_AUTHORING_LAYER_PAIR` and names `pnpm up --latest create-threenative @threenative/*`. proof: `__tests__/doctor-fix.spec.ts`, cases "refuses a game on another core release, before it writes anything", "refuses a game with no installed core at all, and names the upgrade" and "refuses a core that does not ship an MCP shim, before a config names it" — Evidence: 2026-11-06. Red: three cases failed with `AssertionError: promise resolved "{ …(3) }" instead of rejecting`, and the fixture's `--force` run wrote `AGENTS.md` and `.claude/hooks/discovery-gate.mjs`. Green: `doctor-fix.spec.ts` 9 passed. The version is `CORE_PACKAGE_VERSION` in `src/mcp-servers.ts`, which the doctor's MCP table already used and `doctor.spec.ts` holds equal to `packages/core/package.json`. `assertMcpConfig` also fails closed on a missing shim (one implementation, `assertMcpShims`), and `--fix` calls it before `writeHostMcpConfigs`, so no host config names a file the project does not have. Real CLI on a scaffolded `minimal` kit, run from `node packages/create-threenative/dist/threenative.js doctor --fix --force --text`: with a `node_modules/@threenative/core/package.json` at 0.3.11 it printed `TN_AUTHORING_LAYER_PAIR: this create-threenative pairs with @threenative/core@0.3.12, and this game installs @threenative/core@0.3.11. Run 'pnpm up --latest create-threenative @threenative/*' first, then 'pnpm exec threenative doctor --fix'.` and exited 1. With core 0.3.12 and `mcp/terrain.mjs` removed it printed `MCP server 'threenative-terrain' launches './node_modules/@threenative/core/mcp/terrain.mjs', which this project does not have. Run 'pnpm install', or install one release of both: pnpm up --latest create-threenative @threenative/*` and exited 1. `md5sum -c` on `AGENTS.md` is unchanged in both runs. Positive control: core 0.3.12 with every shim printed `authoring layer already current` and wrote no pair error. **The command the message names had to change (2026-11-07):** the sandbox games pin exact versions (`"@threenative/core": "0.3.12"`), and `pnpm up @threenative/*` is a no-op on an exact range — measured on Starlance, `pnpm up create-threenative "@threenative/*"` answered `Already up to date` and left core at 0.3.11, so the guard sent the one population this PRD exists for into a loop. `--latest` moved it (`core` 0.3.11 → 0.3.12, `assets` 0.3.12 → 0.3.13). Red: the 4 spec cases matching the old wording failed (`AssertionError: expected [Function] to throw error matching /pnpm up --latest …/`, and `expected 'Usage: threenative doctor [--target w…' to contain 'pnpm up --latest create-threenative'`). Green: `doctor-fix`, `doctor`, `engine-catalog-plugin` 116 passed.

## Blocked on

Nothing. Both former blockers resolved on 2026-11-07: `@threenative/{core,physics,playtest,runtime-native}` 0.3.12 published, so the pair this `create-threenative` names exists, and the Starlance smoke playtest passes on it (AC-5). The upgrade needed `--latest` because the sandbox games pin exact versions — recorded in Decisions.

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
- 2026-11-06 (agent): the router names the flow as one Commands line, `npx threenative doctor --fix  # refresh agent files`, not a convention row. Reason: it is a command, not a convention with an override, and the `action-rpg` router is at 1,200 of 1,200 words after this line. `threenative doctor --help` names `pnpm up --latest create-threenative @threenative/*` first.
- 2026-11-06 (agent): no version bump. Reason: npm latest is 0.2.15 and the tree is at 0.2.17, which is not published, so this change rides the 0.2.17 cohort.
- 2026-11-06 (agent): `tsup` keeps `./index.js` external. Reason: `threenative.js` now imports the scaffolder, and an inlined copy would run the scaffolder's entry check against `threenative.js` and scaffold a project.
- 2026-11-06 (agent): `--fix` keeps writing every server in the package's MCP table. Reason: the documented flow upgrades `@threenative/*` with `create-threenative`, and core's postinstall writes the same table. (Superseded below: `--fix` now refuses that install before it writes.)
- 2026-11-06 (agent): `--fix` fails closed with `TN_AUTHORING_LAYER_PAIR` when the installed `@threenative/core` is not the release this `create-threenative` is built against, and `assertMcpConfig` fails closed when a required shim is absent. Reason (reviewer, 2026-11-06): the refresh on Starlance wrote a layer for `create-threenative` 0.2.17 beside core 0.3.11, a pair whose page throws `TN_ABI_6` and whose `threenative-terrain` entry named a `mcp/terrain.mjs` core 0.3.11 does not ship. A layer that cannot run is worse than a stale one. The pair is `CORE_PACKAGE_VERSION` in `mcp-servers.ts`, the constant the doctor's MCP table already used, so there is one source. The shim check runs only when the project has installed its packages, because the scaffold writes the configs before `pnpm install`.
- 2026-11-06 (agent): a game with no stamp cannot have dropped authoring-layer files deleted. Reason: without a stamp there is no record of the package bytes, so there is no proof the file is unedited. Deleting it would discard a file this game owns, and the run keeps it instead. `--force` still deletes it, because that flag means the package wins and git is the undo.
- 2026-11-07 (agent): every message that names the upgrade says `pnpm up --latest create-threenative @threenative/*`. Reason: the sandbox games pin exact versions (Starlance `"@threenative/core": "0.3.12"`, caravel `"0.3.3"`), and `pnpm up` only moves within the declared range, so the plain command answered `Already up to date` and left core behind — the guard refused, the named command did nothing, and the user looped. Measured on Starlance: plain `pnpm up create-threenative "@threenative/*"` → `Already up to date`, core still 0.3.11; `--latest` → core 0.3.12, assets 0.3.13. One constant (`ENGINE_PAIR_UPGRADE`) plus the catalog plugin's and the doctor's copy of the same sentence, so there is one wording. `--latest` replaces a `file:` pin with the registry release, which is what "install one release of both" means at the moment the pair already mismatches.
- 2026-11-06 (agent): AC-6 counts with `discovery(dir)` from `scripts/kit-loop.mjs` directly, not `pnpm kit:loop record`. Reason: `record` needs six files (gates, friction, play grade, retro) from a full kit-loop round and appends a row to the tracked `docs/kit-loop/ledger.json`. A one-file proof session has none of them, and a fake row would pollute the ledger. `discovery` is the function `record` calls for K1.

## Execution Phases

#### Phase 1: Stamp and report
**Status:** DONE
**Files:** `packages/create-threenative/src/index.ts` (write the stamp after the writers), `src/doctor.ts` (the row), tests.
**Implementation:** hash every authoring-layer path the scaffold wrote; the stamp lists paths, not globs. The doctor row reads the stamp, or renders the current layer into a temp dir to compare when there is none.
**Verification:** `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts packages/create-threenative/__tests__/doctor.spec.ts` — AC-1, AC-2.
- [x] Phase 1 done: stamp written by scaffold, `authoring layer` doctor row (AC-1, AC-2). proof: scaffold.spec.ts and doctor.spec.ts. Evidence: AC-1 and AC-2 above. The scaffold hash test now skips the stamp (it records bytes the test already hashes). The allowlist spec names `.threenative/agent-files.json`. All 16 tree hashes were re-measured for the new router line.

#### Phase 2: `doctor --fix`
**Status:** DONE
**Files:** `src/threenative.ts` (flag and help text), `src/index.ts` (export the writers as one `writeAuthoringLayer(target, kit)` used by both scaffold and fix), `src/doctor.ts`.
**Implementation:** scaffold calls `writeAuthoringLayer`; `--fix` renders it into a temp dir, then copies per the keep/overwrite/delete rules above. Fails closed with `TN_AUTHORING_LAYER_EDITED` on kept files.
**Verification:** `pnpm exec vitest run packages/create-threenative/__tests__/doctor-fix.spec.ts`, then `pnpm typecheck && pnpm lint && pnpm test` in the engine — AC-3, AC-4.
- [x] Phase 2 done: `doctor --fix` and `--force` through the shared writers, plus the engine-pair and MCP-shim guards (AC-3, AC-4, AC-7). proof: doctor-fix.spec.ts. Evidence: AC-3 and AC-4 above. Related specs: `doctor-fix`, `doctor`, `scaffold`, `cli`, `cli-bin`, `consumer-cli`, `scaffold-file-allowlist`, `scaffold-mcp`, `publication`, `discovery-gate`, `template`, `template-conventions`, `sync-agent-docs`, `kit-conventions`, `instruction-budget`: all pass. `pnpm typecheck` exit 0, `pnpm lint` exit 0. The built `dist/threenative.js` imports `./index.js` as its own module, and `threenative doctor --text` in an empty folder writes nothing.

#### Phase 3: Starlance proof
**Status:** DONE
**Files:** pack per sandbox `AGENTS.md` (content-hashed tarball name), Starlance `package.json` repoint, Starlance authoring files (generated).
**Implementation:** pack `create-threenative`, repoint Starlance, `pnpm install`, `pnpm exec threenative doctor --fix --force`, commit Starlance's regenerated files on their own.
**Verification:** AC-5 diff and MCP check; AC-6 cold session counted by `kit:loop`; the game boots after the refresh.
- [x] Phase 3 done: the game boots on the pair `--fix` leaves. proof: Starlance smoke playtest after the refresh. Evidence: 2026-11-07 — tarball `create-threenative-0.2.17-prd829-830-0251de582fd0.tgz` (sha256 `0251de582fd012128ef0314b2bb8e7bf3499854083eb748486d72a5179b1f2e0`) beside the published `@threenative/*` 0.3.12 cohort; `threenative doctor --fix --force --text` → `authoring layer already current`, exit 0; `smoke.playtest.json` → `pass: true`, `runtimeReady: true`, `consoleErrors: 0`, `runtimeDiagnostics: 0`, `distance` 91.4 (min 50), visual non-blank 1.0, adapter turing/nvidia, one `TN_PLAYTEST_STARTUP_OFFSCREEN_BYTES` warning. The refresh itself is recorded in AC-5: the packed tarball wrote 11 files, `claude mcp get` reports Connected, and AC-6 counts the cold session. The same run also needed `--latest` on the upgrade command, recorded in Decisions and AC-7.
