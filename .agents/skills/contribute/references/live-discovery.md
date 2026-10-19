# Live PRD discovery

Run this afresh for each contribution; this file deliberately contains no fixed
list of “good first” PRDs or model version names.

## 1. Establish the inventory

Confirm checkout, remote and revision with `git status --short`, `git remote -v`
and `git rev-parse HEAD`. Enumerate **tracked** Markdown PRDs using
`git ls-files 'docs/PRDs/*.md' 'docs/PRDs/**/*.md'`. Inspect the live status, priority,
phase boxes, acceptance criteria, `Depends on`, `Blocked on`, decisions and batch
execution instructions. Exclude `done/`, `BLOCKED/`, cancelled, declined,
superseded and absorbed work as new tasks. A pending file with no boxes needs
inspection, not automatic exclusion; directory and unchecked count are hints.

Read the current full open-PR inventory, including drafts:

```sh
gh pr list --repo ThreeNativeHQ/threenative-engine --state open --limit 1000 \
  --json number,title,body,headRefName,baseRefName,isDraft,url
```

If the result reaches the limit, paginate `gh api` until exhausted. Public GitHub
REST or the public pull-request page is a read-only fallback; authentication is
not permission to publish. If none works, report the failed lookup and stop at
provisional recommendations. Record the observation time and revision in the
response, not as a frozen shortlist in this skill.

Match PRD identifiers **and semantic scope** against titles, bodies, head branches,
linked plans and, for uncertain matches, changed-file inventories (`gh pr view
<number> --repo ThreeNativeHQ/threenative-engine --json files,body,commits`). A
mention of another PRD as a dependency is not a claim, but a batch/epic that owns
it is. Look for renamed identifiers and owner-authorized batch exceptions.
Inspect `git worktree list --porcelain` and `pnpm worktree:status` when available,
plus documented owner/branch claims; do not recursively inspect other agents'
worktrees. An active branch or explicit in-progress claim is a collision even if
no PR has yet been opened. Unresolved ownership means ineligible, not unclaimed.
Never reopen a completed PRD by deleting its historical evidence.

## 2. Verify the missing outcome

For each promising PRD, read the actual implementation, callers, focused tests
and cited landing commits on the chosen base. Check merged/closed PRs by exact
identifier when status is stale. Do not assume an absent exact-name PR means
absent implementation. Examples of decisive evidence:

- A claimed missing export already exists and its caller/test covers the behavior:
  exclude implementation work, or identify the precise remaining consumer gate.
- An unchecked platform claim is genuinely unrun: a verification task may qualify
  only if that platform and required assets/tools are available.
- A dependent's prerequisite is completed in code: cite its proof; if unresolved,
  choose the eligible prerequisite instead. Detect dependency cycles.

For scope still missing, name `file:line` anchors, the affected user workflow and
the existing test/playtest that can prove the outcome. Check available tools,
GPU/native host, emulator/device and needed assets without installing unknown
hooks, obtaining credentials or spending money. No support or performance claim
extends beyond the target actually exercised. Do not select blocked-only work;
a mixed PRD is eligible only for an independent meaningful phase whose blockers
do not invalidate its acceptance claims.

## 3. Rank and choose

Use evidence-based judgement, in this order:

1. Explicit maintainer direction and canonical priority of the **unfinished**
   outcome. P0 needs documented immediate-blocker evidence, not an old folder name.
2. Measurable user impact: correctness, fewer cold-agent failures, supported native
   parity, playable frame time, reliable startup or an actual release blocker.
3. Dependency unlock: indispensable prerequisites of urgent outcomes, not optional
   consumers. Cite the dependent's explicit dependency rather than inventing one.
4. Ability to produce decisive red/green and real consumer/platform proof in this
   checkout, balanced against scope, architecture risk and hardware availability.

Do not optimize for checkbox count, easy cosmetic edits or the biggest proposal.
The top three table includes PRD/path, priority, missing outcome/code evidence,
claim/PR check, dependency state, proof commands and risk. State exclusions of
particularly tempting already-shipped, blocked or in-flight work. When fewer than
three qualify, say so. Pick the best eligible task by default, bound its acceptance
scope, and refresh inventory at the handoff to implementation and again before
any authorized draft/publication. A completed discovery pass is not a lease.
