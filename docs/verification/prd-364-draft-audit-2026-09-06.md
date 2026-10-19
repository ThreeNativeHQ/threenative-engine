# PRD-364 drafting audit — 2026-09-06

Scope: planning only at checkout `713ca111`. The [PRD](../PRDs/done/PRD-364-remove-development-gate-bloat.md) records inspected callers and read-only GitHub run observations. No runtime or workflow implementation changed.

## Executed commands

`gh run list --workflow ci.yml --limit 8 --json databaseId,conclusion,createdAt,updatedAt,headSha,event` and `gh run view 34068539162 --json jobs` exited 0. Eight sampled PR runs took 396–726 seconds from createdAt to updatedAt. Latest green had 32 jobs; its budget job lasted 57 seconds. No before/after speedup measurement exists.

`pnpm check:docs` exited 0 before and after this record was added (same tracked-file count). A separate direct path check covered both new untracked documents:

```text
Checked 1467 relative documentation links across 947 Markdown files.
```

`pnpm lint` exited 0:

```text
Checked 1967 files in 4s. No fixes applied.
Found 602 warnings.
```

`pnpm typecheck` exited 0; root and recursive package/example typechecks completed. Final output:

```text
examples/abyss-framework typecheck: Done
```

`pnpm test` exited 2 before executing the suite:

```text
TN_WORKTREE_OWNED: worktree is already owned by joao@joao-cachyos (pid 4073017)
```

`pnpm gate:status` and `pnpm gate:doctor` exited 0 and identified an active run:

```text
run: tn-20260907022332679-4073017
phase: parity
state: running
command: pnpm parity
```

A read-only process check confirmed PID 4073017 was running the conformance runner. No lease was cleared and no other run was interrupted. Full test validation remains UNVERIFIED; this is a concurrency guard working as designed, not evidence that it should be deleted. Implementation phase controls, hosted scope proof and performance comparisons are NOT RUN. Draft checks report command exits only, not mutation-proven implementation gates.
