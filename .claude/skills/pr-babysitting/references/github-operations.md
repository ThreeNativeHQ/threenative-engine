# GitHub operations

Read when forming GitHub calls. Use local `gh help` or the available connector schema to verify support. All values below are examples; replace the repository and PR with the user's actual selection. Keep structured output compact and paginate before making completeness claims. Do not print credentials.

## Inspect repository policy and candidates

```bash
pr_repo='OWNER/REPO'
pr_number=123
pr_base='main'

gh repo view "$pr_repo" --json defaultBranchRef,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,viewerPermission
gh api "repos/$pr_repo" --jq '{allow_auto_merge,default_branch}'
gh api --paginate "repos/$pr_repo/rules/branches/$pr_base"
gh api "repos/$pr_repo/branches/$pr_base/protection"
gh pr list --repo "$pr_repo" --state open --limit 100 --json number,title,headRefName,headRefOid,baseRefName,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr view "$pr_number" --repo "$pr_repo" --json number,url,body,headRefOid,headRefName,baseRefName,baseRefOid,headRepository,headRepositoryOwner,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,commits,files
gh pr diff "$pr_number" --repo "$pr_repo"
```

Derive the base from the PR, not the default branch assumption in this example. URL-encode branch names containing `/` when constructing REST paths. Active rulesets and classic protection are distinct sources; inspect both. An inaccessible endpoint is not evidence that no policy exists. If an expected check is absent, inspect workflow triggers, scope decisions, upstream jobs, and required source-app identity before deciding why. Do not remove the required context to unblock a PR.

If the list limit is reached, use paginated REST/GraphQL and hydrate the selected PRs. PR files and commits can also be truncated; paginate their dedicated endpoints when needed. Inspect review-thread resolution through GraphQL; ordinary review comments do not expose complete thread state:

```bash
pr_owner='OWNER'
pr_name='REPO'
gh api graphql --paginate \
  -F owner="$pr_owner" -F name="$pr_name" -F number="$pr_number" \
  -f query='query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $endCursor) {
          nodes { id isResolved isOutdated path line }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }'
gh api --paginate "repos/$pr_repo/pulls/$pr_number/reviews"
gh api --paginate "repos/$pr_repo/pulls/$pr_number/comments"
gh api --paginate "repos/$pr_repo/issues/$pr_number/comments"
```

An outdated thread is not automatically resolved. Read its comments and current diff before deciding whether its concern still applies.

## Diagnose runs before rerunning

```bash
gh pr checks "$pr_number" --repo "$pr_repo" --json name,state,bucket,workflow,event,link
gh pr checks "$pr_number" --repo "$pr_repo" --required
gh run view "$pr_run_id" --repo "$pr_repo" --json headSha,event,status,conclusion,attempt,jobs
gh run view "$pr_run_id" --repo "$pr_repo" --log-failed
```

Take `pr_run_id` from the candidate's check links and verify its event/revision. Do not substitute the latest branch run blindly. Exit code 8 from `gh pr checks` means pending. The required-check command is a convenience view, not proof that every expected job exists. For a failed job in an ongoing run, query that completed job's log if full-run logs are unavailable.

Once authorized and after confirming a transient failure and no equivalent active attempt, choose the narrowest supported rerun:

```bash
gh run rerun "$pr_run_id" --repo "$pr_repo" --failed
# Alternative: use a jobs[].databaseId returned by gh run view.
gh run rerun "$pr_run_id" --repo "$pr_repo" --job "$pr_job_id"
```

These alternatives can include dependencies; they are not commands to execute together. Use the CLI's job database ID rather than assuming a number in a browser URL is accepted. [GitHub CLI rerun reference](https://cli.github.com/manual/gh_run_rerun).

## Guarded merge and confirmation

Only after the skill's review, dependency, and verification conditions are satisfied:

```bash
# Select the authorized/repository-established method; squash is only an example.
gh pr merge "$pr_number" --repo "$pr_repo" --squash --match-head-commit "$pr_reviewed_sha"
gh pr view "$pr_number" --repo "$pr_repo" --json state,mergedAt,mergeCommit,headRefOid,baseRefName
```

For a required merge queue, use its supported entry command and monitor until merged; do not pass `--admin`. `--match-head-commit` guards the head accepted by the command. It does not permanently pin future auto-merge activity. Keep checking review validity after subsequent pushes. [GitHub CLI merge reference](https://cli.github.com/manual/gh_pr_merge).

`--auto` is useful only when enabled and enforced rules cover the remaining acceptance conditions. If unavailable, continue monitoring and merge directly when eligible rather than changing repository settings. [GitHub auto-merge documentation](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request).

Do not add `--delete-branch` unless branch deletion was authorized and ownership/stack checks are complete. For multiline PR descriptions or authorized comments, use structured tool arguments or a temporary body file with `--body-file`. Treat shell text as code: JSON encoding is not shell escaping.
