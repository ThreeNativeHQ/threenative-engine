# PRD-371 authoring verification — 2026-09-09

Scope: create [PRD-371](../PRDs/authoring/PRD-371-dream-loop-authoring.md) and mark overlapping
PRD-106 as superseded for execution.
This is an inert Markdown change, not implementation of the proposed workflow.

Inspected checkout: primary repository, branch `main`, initial HEAD `942402aa2`. No task worktree
was created, no other worktree was modified, and no cleanup is outstanding for this task.

Research: upstream Dream Loop commit `9bddb901f7d071cfefdd21e264267c757177a9df`, its MIT license,
both workflow variants and asset guidance; ThreeNative's generated visual/asset skills, shared
recipes, scaffold/package paths, verifier role, MCP registration, Blender tools, playtest and
blind comparison tooling. Sources and inspected line anchors are in the PRD.

Public read-only provider observations:

```text
GET /api/v1/images/models
meta/muse-image: input_modalities=[text,image], output_modalities=[image]
supported_parameters={}, supports_streaming=false

GET /api/v1/images/models/meta/muse-image/endpoints
{"id":"meta/muse-image","endpoints":[]}

GET /api/v1/models/meta/muse-image/endpoints
data.id=meta/muse-image; one Meta endpoint returned
supported_parameters=[max_tokens,repetition_penalty,top_k,temperature,top_p]
image pricing fields are token-oriented; no generation usage observed
```

No API credential was read or printed. No paid image request, game build, gameplay run, native
run or implementation phase checkpoint was performed. All implementation claims stay unverified.

## Documentation validation

Executed the repository's strict prose-only board after drafting and again after review
corrections. The suite exercises collected negative fixtures for links, missing evidence,
budget excess, generated-document drift and CI classification. An additional isolated link
control called the real `assertDocLinks` implementation with a missing target, then restored it:

```text
RED observed: Broken documentation links:
README.md -> proof.md
GREEN observed: {"filesChecked":1,"linksChecked":1,"missing":[]}
```

The isolated fixture was removed. No product file was broken to produce this control.

```sh
pnpm check:docs
pnpm exec vitest run scripts/__tests__/check-doc-links.spec.ts scripts/__tests__/evidence-budget.spec.ts scripts/__tests__/evidence-citations.spec.ts scripts/__tests__/sync-agent-docs.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts
git diff --cached --check
```

Observed suite output after the material corrections:

```text
scripts/__tests__/check-doc-links.spec.ts (12 tests)
scripts/__tests__/ci-needs.spec.ts (15 tests)
scripts/__tests__/sync-agent-docs.spec.ts (8 tests)
scripts/__tests__/evidence-citations.spec.ts (10 tests)
scripts/__tests__/evidence-budget.spec.ts (9 tests)
scripts/__tests__/ci-structure.spec.ts (83 tests)
Test Files  6 passed (6)
Tests       137 passed (137)
```

Final output with all three delivery files staged:

```text
Checked 1908 relative documentation links across 1043 Markdown files.
git diff --cached --check: exit 0, no output
```

Implementation typecheck/build/playtest/native gates are intentionally unrun for this inert
Markdown scope.

## Independent planning checkpoint

A separate read-only reviewer examined the PRD against the live source. Its initial verdict was
NEEDS CORRECTION: request accounting needed direct dispatch enforcement; phase 5 needed the
full-tree scaffold test file; the blind comparison needed enough frames for its duplicate count;
and uncapped FPS needed a positive acceptance bound. The PRD now includes all four fixes and
attributes the duplicate-POST negative control to the image script that enforces it.

Visual inspection also established that the sealed exploration reference is schematic. The
PRD now requires a detailed target before its first capability checkpoint and the same target
for both release-comparison arms; a schematic-only result cannot satisfy visual acceptance.

The primary checkout advanced independently to `5e88cf727` during this task. That unrelated
documentation commit was preserved. Only the three files named at the top belong to this task.

Final reviewer verdict: **PASS — independent planning review complete.** Implementation and
live-provider results remain explicitly unverified.
