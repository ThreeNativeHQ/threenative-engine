---
prd_contract: v1
---

# PRD-482 — The local agent loop costs only what it catches

**Status:** PARTIAL — phases 1 and 2 verified; AC-1 audits the 7 days after this lands
**Priority:** P2 — One open box: audit seven days of runner-minutes after phase 2 and cut useless steps.
**Complexity:** 2 (LOW)
**Owner:** CI tooling
**Depends on:** [PRD-480](../CI/PRD-480-linux-ci-runs-on-the-owner-machine.md) for the push rule's wording

## Context

Audit on 2026-10-02 of what an agent pays between starting a task and pushing it:

- **The pre-push hook is red on clean `develop`, so agents bypass it.** `scripts/ci-fast.sh` took 42 s
  and failed 3 of its 4 stages on `01bc7c687`:
  - `drift` (33 s of it): `template.spec.ts` typechecks scaffolds against the physics package's built
    `dist`, which is stale (`TS2305 VehicleBody3D`). The script's own header promises "nothing that
    needs a full workspace build".
  - `lint`: `biome check .` has no `vcs.useIgnoreFile`, so it lints git-ignored files such as
    `.leanpi/goal.json`.
  - `docs`: real broken links from `40919491b`.

  The stages run serially, and 22 of 368 pushes in the past week set `TN_SKIP_PREPUSH=1`.
- **Pushes cancel running boards.** From 2026-09-18 to 10-02, 349 PR runs were cancelled by a newer
  push, burning 43.1k runner-min, 37% of all CI time
  ([PRD-481](../CI/PRD-481-ci-does-each-piece-of-work-once.md) context). 56 of those pushes changed
  only Markdown, and 37 of them were PRD ticks.
- **Context injected on every turn.** `.claude/hooks/ponytail-context.mjs` runs on SessionStart,
  every UserPromptSubmit and every SubagentStart (`.claude/settings.json:8,20,31`), about 400 tokens
  per user turn. Root `AGENTS.md` adds 1,816 words, and `packages/playtest/AGENTS.md` adds 5,071 words
  whenever playtest work loads it. The `gate:*` commands named in root `AGENTS.md:91` were
  effectively never run in transcripts since 2026-09-25.

## Solution

- Make the hook what its header says: seconds, green on a clean tree, run in parallel. A hook that
  is red on `develop` teaches agents to skip it.
- Put the push rule in `AGENTS.md`: while your PR's CI is running, commit locally and push only to fix
  that run or once it finishes; a PRD tick rides with the next code push, never alone.
- Inject ponytail once per session and on compaction, not on every prompt.
- Move reference material out of the always-loaded files.

## Acceptance Criteria

- [ ] AC-1 [shared]: proof: the PRD-481 audit script over the 7 days after phase 2 lands. Runner-minutes
  lost to PR runs cancelled by a newer push drop below 10k a week, from 21.5k. Evidence: pending.

## Decisions

- 2026-10-02 (João): cut any step that costs time or tokens without catching problems; speed and
  reliability are the only criteria.

## Execution Phases

#### Phase 1: The pre-push hook is green and fast

**Status:** COMPLETE
**Files:** EDIT `scripts/ci-fast.sh` (stages in parallel; scaffold typecheck moves to `ci:local` and CI),
`biome.json` (`vcs.useIgnoreFile`), `docs/PRDs/UI/PRD-native-overlay-utility-styling.md` (broken links).

- [x] `pnpm ci:fast` passes on a clean `develop` checkout in under 15 s wall. proof: `time pnpm ci:fast`.
  Evidence: 2026-10-02 on `af7e25333` plus this branch, all four stages pass, 9.2 s wall (was 42 s and
  3 of 4 red). The biome and link fixes landed directly on `develop` in `af7e25333` to unblock the
  backlog push. A never-built checkout still needs one workspace build: three drift specs import
  packages' `dist`.
- [x] The scaffold typecheck still runs before merge. proof: the `test` job log of one CI run lists
  `template.spec.ts`. Evidence: CI run 37049488719 (2026-10-02), job `test-unit (1/3)` 110991025981:
  `✓ packages/create-threenative/__tests__/template.spec.ts (38 tests) 102118ms`. The unit shards run
  plain `vitest run`, which this PR does not touch.

#### Phase 2: Instructions and injections carry only what agents use

**Status:** COMPLETE
**Files:** EDIT `AGENTS.md` (push rule; `gate:*` lines move to `docs/architecture/` or the scripts' `--help`),
`.claude/settings.json` (ponytail hook on SessionStart and compact only), `packages/playtest/AGENTS.md`
(reference sections move to a linked doc), the `CLAUDE.md` mirrors.

- [x] `AGENTS.md` states the push rule. proof: `pnpm sync:agents --check` and
  `pnpm exec vitest run scripts/__tests__/sync-agent-docs.spec.ts scripts/__tests__/primary-docs.spec.ts`.
  Evidence: 2026-10-02, "Push once per run" in the Pull requests list; `pnpm sync:agents` wrote the mirror;
  sync-agent-docs, primary-docs and instruction-budget specs 24 passed.
- [x] The ponytail hook fires only on SessionStart and compaction. proof: `jq '.hooks | keys' .claude/settings.json`
  lists neither `UserPromptSubmit` nor `SubagentStart` for it.
  Evidence: 2026-10-02, `jq '.hooks | keys'` prints `["SessionStart"]`; SessionStart has no matcher, so it
  also fires on compaction.
- [x] `packages/playtest/AGENTS.md` is under 2,000 words. proof: `wc -w packages/playtest/AGENTS.md`, and
  `pnpm check:docs` passes with every moved section linked.
  Evidence: 2026-10-02, 5,256 → 1,113 words. Twelve reference sections (flags and exit codes, the
  private-Xvfb frame rate, `assert.tone[]`, the four targets, `perf`, `audio`, startup
  observations, `deviceMetrics`, the room and the feet, `assert.causedBy`, `setup`/`aimAt`, tick
  semantics and the startup wait) moved verbatim into `packages/playtest/docs/reference.md` and
  `docs/determinism.md`, each linked from the section it left; a coverage diff over every line of
  the 5,256-word file finds no paragraph missing. `pnpm check:docs` 2,504 links / 1,223 files
  clean, `pnpm sync:agents --check` 22 mirrors in sync, sync-agent-docs + primary-docs +
  instruction-budget + check-doc-links 36 passed, `packages/playtest/__tests__/doc-drift.spec.ts`
  2 passed, `pnpm lint` exit 0.
