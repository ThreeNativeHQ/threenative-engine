# PRD-836 — One committed capability manifest

**Status:** PARTIAL — both phases landed; AC-1 (the sandbox scaffold reaching the MCP) runs on the PR. `scripts/api-surface.json` stays tracked: it is the API-break baseline, not derived output, and untracking it would let an unannounced removal through locally.
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

- [x] `packages/create-threenative/capabilities.json` is **untracked** and the one committed manifest is `packages/core/capabilities.json`. The generator writes one file; `create-threenative` keeps none — it reads core's at build time, and the engine MCP already resolved `@threenative/core/capabilities.json` in a project and `packages/core/capabilities.json` in the repo, so nothing had to change there. Eight readers and eleven specs followed the path (`capability-recall`, `check-capability-docs`, `check-api-surface`, `check-capability-examples`, `detect-capability-duplicates`, the two generators, the engine-mcp specs); the legacy path stays named as a constant so a stale copy is reported rather than silently used. proof: `npx vitest run scripts/__tests__/capability-manifest.spec.ts scripts/__tests__/capability-recall.spec.ts scripts/__tests__/check-capability-docs.spec.ts scripts/__tests__/capability-site-docs.spec.ts scripts/__tests__/budgets.spec.ts scripts/__tests__/generate-capability-reference.spec.ts packages/engine-mcp/__tests__ packages/core/__tests__/frame-budget.spec.ts packages/create-threenative/__tests__/scaffold-manifest-imports.spec.ts` → 246 passed, 1 skipped; `npx tsx scripts/capability-recall.ts` → recallAtK 0.9369 (unchanged); `git ls-files packages/create-threenative/capabilities.json` returns nothing.
- [x] The pre-commit hook stages nothing the author did not add. It used to regenerate five artifacts and `git add` all of them, so one export edit arrived carrying files nobody chose and a shared worktree collected changes nobody wrote. `packages/core/capabilities.json` stays staged — it is the artifact a commit that adds an export must carry — and the four derived files are regenerated, then the hook **fails closed and names them** when they change, so staging them is the author's call. Demonstrated here: a one-line edit to `debugFlag`'s doc made the hook refuse with `packages/create-threenative/capabilities.json` and `capability-reference.md` named; staging those two and committing carries exactly them plus the source. The box's literal stat — only `index.ts` and `packages/core/capabilities.json` — needs the derived docs untracked, which is the next box. proof: the refusal above, and `git show --stat HEAD` on the following commit listing the two staged files, two sources and the core manifest.

#### Phase 2: Derived docs are build output
**Status:** DONE
**Files:** `scripts/build-capability-manifest.ts`, `packages/create-threenative/package.json`, `.gitignore`, `scripts/prepare-release.ts`.

- [x] `capability-reference.md` and `SKILL.md` are written by `prepack` and are untracked. **`api-surface.json` is not**: the review of this box found it is the committed API-break baseline — `check-api-surface.ts` compares against it, and on a clean checkout an untracked baseline makes `api:surface:check` throw while `api:surface:sync` silently rewrites the contract with nothing to compare. It stays tracked. The lane constraint measured on this box was real: the documentation lane ran `pnpm check:docs` with no capability sync in front of it, so it now runs `pnpm capabilities:sync` first — the three files are build output and `check:docs` resolves links against the working tree. `create-threenative`'s `prepack` runs the sync too, so a tarball carries them. Two guide links that named the old manifest path now name core's. proof: `pnpm check:docs` → 3795 links across 1629 files; `git ls-files packages/create-threenative/agent-docs/references/capability-reference.md packages/create-threenative/agent-files/.agents/skills/threenative-context/SKILL.md scripts/api-surface.json` returns nothing; `npx vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/capability-manifest.spec.ts packages/create-threenative/__tests__/scaffold-manifest-imports.spec.ts` → 226 passed.
