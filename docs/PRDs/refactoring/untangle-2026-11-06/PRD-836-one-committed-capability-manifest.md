# PRD-836 — One committed capability manifest

**Status:** PARTIAL — Phase 1 box 2 landed; the second manifest and the derived docs are still tracked.
**Priority:** P2 — open Phase 1 deletes the second 556 KB `capabilities.json` that 82 of 117 `core/src/index.ts` commits had to carry, and Phase 2 moves the other derived files out of commits.
**Complexity:** 4 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — R4

## Context

Report id A1. One export added to `packages/core/src/index.ts` regenerates 8 committed artifacts.
The median `index.ts` commit touched 34 files in 90 days.

| Problem | Where |
| --- | --- |
| Two byte-identical manifests, 556 006 bytes each | `packages/core/capabilities.json`, `packages/create-threenative/capabilities.json`, writer `scripts/build-capability-manifest.ts:17,20` |
| The pre-commit hook silently stages 5 regenerated files into the author's commit | `githooks/pre-commit:37-44` |
| Derived docs committed beside the manifest | `packages/create-threenative/agent-docs/references/capability-reference.md`, `SKILL.md`, `api-surface.json` |
| Two worktrees editing different exports conflict in a 556 KB blob | — |

## Solution

`packages/core/capabilities.json` is the one committed manifest. `create-threenative` already depends
on core (`workspace:*`). It reads core's copy at build and pack time, and copies it into its tarball.
`capability-reference.md`, `SKILL.md` and `api-surface.json` become build output that `prepack`
writes, so they are not tracked. The pre-commit hook regenerates and checks the one manifest. It no
longer stages files the author did not touch.

## Acceptance Criteria

- [ ] AC-1 [local]: An installed project still finds capabilities through the engine MCP. proof: `pnpm sandbox` scaffold, then `engine_search_capabilities` returns hits for `WorldEnvironment`
- [ ] AC-2 [local]: The tarball ships the manifest and the derived docs. proof: `pnpm --filter create-threenative pack` plus `tar -tzf` lists them

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Capability search | `threenative-engine-mcp` → manifest path in the installed project | Second copy deleted | AC-1 |

## Execution Phases

#### Phase 1: One manifest
**Status:** PARTIAL — the hook no longer stages on its own; the second copy is still tracked
**Files:** `scripts/build-capability-manifest.ts`, `packages/create-threenative/package.json`, `packages/engine-mcp/src/index.ts`, `githooks/pre-commit`.

- [ ] `packages/create-threenative/capabilities.json` is untracked and produced at pack time from core's copy, and the MCP resolves it in a scaffolded project. proof: `pnpm exec vitest run scripts/__tests__/capability-manifest.spec.ts` plus AC-1
- [x] The pre-commit hook stages nothing the author did not add. It used to regenerate five artifacts and `git add` all of them, so one export edit arrived carrying files nobody chose and a shared worktree collected changes nobody wrote. `packages/core/capabilities.json` stays staged — it is the artifact a commit that adds an export must carry — and the four derived files are regenerated, then the hook **fails closed and names them** when they change, so staging them is the author's call. Demonstrated here: a one-line edit to `debugFlag`'s doc made the hook refuse with `packages/create-threenative/capabilities.json` and `capability-reference.md` named; staging those two and committing carries exactly them plus the source. The box's literal stat — only `index.ts` and `packages/core/capabilities.json` — needs the derived docs untracked, which is the next box. proof: the refusal above, and `git show --stat HEAD` on the following commit listing the two staged files, two sources and the core manifest.

#### Phase 2: Derived docs are build output
**Status:** NOT STARTED
**Files:** `scripts/build-capability-manifest.ts`, `packages/create-threenative/package.json`, `.gitignore`, `scripts/prepare-release.ts`.

- [ ] `capability-reference.md`, `SKILL.md` and `api-surface.json` are written by `prepack` and are untracked. proof: AC-2 plus `git ls-files packages/create-threenative/agent-docs/references/capability-reference.md` returns nothing
