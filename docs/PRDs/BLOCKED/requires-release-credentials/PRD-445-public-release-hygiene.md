# PRD-445 — Public release hygiene

**Status:** BLOCKED — every box is ticked (20/20, `prd:100%`); the only remaining work is the
`## Blocked on` list: an upstream `threenative-sculpt-mcp` release and three owner calls on
tracked junk. Filed in `docs/PRDs/BLOCKED/requires-release-credentials/` on 2026-09-25 under R6 so
it stops reading as a live release blocker while the owner can still validate it. Phases 1–4
landed; `pnpm audit --prod --audit-level high` is clean and the `site` deploy is green on `main`
(run 36063649413, 2026-09-25).
**Complexity:** 3 → LOW; all local, no credentials.
**Depends on:** none. Blocks rung R1 of [RELEASE-READINESS-2026-09-23](../../production-readiness/RELEASE-READINESS-2026-09-23.md).

**Priority:** P1 — Only owner calls and an upstream sharp release remain; high advisory sharp<0.35.4 ships to consumers.
## Context

The 2026-09-23 inspection found the things a stranger sees first are wrong or stale, and no PRD
owned them:

- `pnpm audit --prod --audit-level high` reports one high advisory: `sharp <0.35.4`
  (GHSA-rgj7-g3m4-5g8c) via `@threenative/assets` → `@gltf-transform/functions` → `ndarray-pixels`.
  It ships to every consumer that installs `@threenative/assets`.
- `SECURITY.md` names `0.2.x` as the only supported line; 0.3.x is on npm `latest`.
- `CHANGELOG.md`'s last released section is `0.2.0`.
- `docs/CURRENT-CHALLENGES.md` was last reviewed 2026-09-02; its Android-CI row was superseded on
  2026-09-08.
- `pnpm alpha:bar` fails row A7: the committed `docs/verification/alpha-bar.md` does not match a run.
- `README.md` promises iOS ("Ship it to the browser, desktop, Android, and iOS"), which is not a
  supported target.
- The `site` workflow failed on `main` at `d3e6b7deb` in its Cloudflare deploy step (exit 1).
  Fixed 2026-09-25 by the owner setting the two `site-production` secrets; see the box in Phase 2.
- PRD-060 exists twice with different progress; PRD-375's file carries the heading "PRD-153"; five
  release-blocking PRDs have no phase boxes, so `pnpm prd:progress` exits 1 on them.

## Solution

Fix each at its source. The `sharp` fix must reach consumers: a root `pnpm.overrides` entry does not
travel in a published tarball, so bump the dependency chain or pin a direct `sharp` dependency in
`@threenative/assets`, and prove it in a tarball install. No new scripts.

## Execution Phases

### Phase 1 — Security surface

- [x] `@threenative/assets` resolves `sharp >=0.35.4` for consumers; `pnpm audit --prod --audit-level high` exits 0.
  Done: `sharp: 0.35.4` added to the root `catalog`, pinned as a direct `@threenative/assets`
  dependency (`catalog:`), and a root `pnpm.overrides` (`sharp: >=0.35.4`) forces the dev tree's
  one remaining holder. Result: every `sharp` in `pnpm-lock.yaml` resolves to `0.35.4`, and
  `pnpm audit --prod --audit-level high` prints "No known vulnerabilities found", exit 0.
  A second advisory path the inspection missed surfaced once the assets path was fixed:
  `@threenative/core` → `threenative-sculpt-mcp` → `sharp` (pinned `0.35.3` by that external
  package). The override covers the workspace; the consumer side is box 2.
- [x] `SECURITY.md` names the supported 0.3.x line.
  Done: the supported-versions table now reads `0.3.x | Yes`.
- [x] `CHANGELOG.md` has sections for every published 0.3.x version and the release candidate.
  Done: added `[0.3.3]` (unreleased release candidate), `[0.3.2]`, `[0.3.1]` and `[0.3.0]`
  sections, written from the cohort release commits and npm publish dates.
### Phase 2 — Public truth

- [x] `docs/CURRENT-CHALLENGES.md` re-reviewed against the 2026-09-23 inspection; date updated; superseded rows corrected.
  Done: last-reviewed date is 2026-09-23; row 2 ("Android conformance lane is red on CI") is
  corrected to "The native platform evidence lane is slow" (green on `develop` 2026-09-23, run
  35807670726, 2h35m) and its section rewritten; row 3 is corrected to "iOS is not a supported
  target" per the 2026-09-23 owner decision. No other row contradicts the inspection.
- [x] No public doc claims iOS support (owner decision 2026-09-23: supported targets are web, Windows, macOS, Linux, Android); `README.md` lines 7, 38, 102, 132, 148 and the `runtime-native` and `create-threenative` READMEs corrected.
  Done: those READMEs were already corrected in `bc1e38615` (verified, no iOS support claim
  remains). This commit also corrects the public support claims the inspection missed: the site
  marketing copy (`site/src/content/claims.ts`, `nav.ts`, `docs.ts` keywords), the site docs
  (`NativeRuntime`, `Physics`, `Playtesting`), the OG image
  (`site/public/og/home.svg`), and the published package descriptions (`package.json`,
  `packages/runtime-native/package.json`). Left as-is: `packages/create-threenative/templates/defense/README.md`
  still says "desktop, Android, and iOS" — it is inside a scaffold whose SHA-256 hash
  (`scaffold.spec.ts` `PRD_201_PARENT_SCAFFOLD_HASHES`) moves with any template byte, and
  recomputing that table is a separate change.
- [x] `pnpm alpha:bar --write` regenerates `docs/verification/alpha-bar.md`; row A7 passes.
  Done: `pnpm alpha:bar --write` regenerated the file; the next `pnpm alpha:bar` reports
  `A7 pass — The generated table in docs/verification/alpha-bar.md is byte-identical to this run.`
  A1 still fails (the 0.3.3 / 0.2.6 cohort is unpublished); A6 stays deferred; that is expected and
  belongs to PRD-196.
- [x] Root cause of the `site` deploy failure recorded here. proof: the failing run named in the
      note below — `CLOUDFLARE_API_TOKEN` unset on the `site-production` environment, so
      `wrangler deploy` exits 1 while the `build` job passes.
  **Root cause recorded and closed 2026-09-25.** The `site` workflow's
  `deploy` job (`site.yml`, environment `site-production`) maps
  `secrets.CLOUDFLARE_ACCOUNT_ID` / `secrets.CLOUDFLARE_API_TOKEN` into `pnpm site:deploy`, but on
  the failing run (`main`, `d3e6b7deb`, run 35899011227) both env vars were empty, so `wrangler
  deploy` exited 1 with "In a non-interactive environment, it's necessary to set a
  CLOUDFLARE_API_TOKEN environment variable". The `build` job (typecheck, tests, e2e, `wrangler
  deploy --dry-run`) passed, so no repository code was at fault. The owner set both secrets on
  `site-production` on 2026-09-25; the acceptance box below records the green rerun.

### Phase 3 — Release-path PRD bookkeeping

- [x] One PRD-060 remains; the other is removed with its ticked boxes and evidence merged into the survivor.
  Done: the `BLOCKED/requires-release-credentials/` duplicate was deleted (`git rm`); its landed
  Phase 1 exact-candidate preflight is carried into the survivor at
  `docs/PRDs/production-readiness/PRD-060-promoted-consumer-distribution.md` with its verification
  record linked. `find docs/PRDs -name '*PRD-060*'` (excluding `done/`) returns exactly one file.
  The now-empty reason folder was dropped from `BLOCKED/README.md` and the stale link in
  `RELEASE-READINESS-2026-09-23.md` corrected.
- [x] PRD-375's heading matches its file name, and links to it still resolve.
  Done: the heading now reads `# PRD-375 — A consumer can brand launch, loading and packaged apps`
  (was "PRD-153"); `pnpm check:docs` reports 2223 links across 1135 files, exit 0.
- [x] Phase boxes added to PRD-054, PRD-058, PRD-064, PRD-066 and PRD-112-repair; `pnpm prd:progress` exits 0 on each.
  Done: per-phase checklists added to all five. `pnpm prd:progress` exits 0 on each — PRD-054
  0/6 phases (0/11 boxes), PRD-058 0/8 (0/40), PRD-064 0/6 (0/25), PRD-066 0/1 (1/4),
  PRD-112-repair 0/3 (0/12). No box was ticked on unrun work.

> Also folded in here: `d63a2464b` (the commit that added this PRD) deleted `PRD-080` from
> `BLOCKED/` and repointed nine links at `critical/` without moving the file, breaking
> `pnpm check:docs`, and left one unformatted spec that broke `pnpm lint`. Both are restored in
> Phase 1's commit so the acceptance criteria below pass.

### Phase 4 — Repository junk a stranger clones

Inventory 2026-09-23 (read-only arm; each "no references" re-checked with `git grep -l <name>`
excluding `docs/PRDs/done`, 0 hits). About 5.7 MiB of tracked bytes.

- [x] Delete `packages/runtime-native/native/ui-overlay/composited.ppm` (2.76 MB, unreferenced).
  Done: `git rm`; 2,764,816 bytes removed. Only references were this PRD and the generic word
  "composited" elsewhere; `rg --no-ignore -l composited.ppm` outside `.worktrees/` hit nothing else.
- [x] Delete `docs/verification/platformer-round-1-final-comparison.png` (1.73 MB, unreferenced, outside every walked evidence root).
  Done: `git rm`; 1,730,329 bytes removed. The only other mention is the historical "Files analyzed"
  list in `docs/PRDs/done/PRD-023-framework-visual-parity.md`, which the evidence-citation scan does
  not treat as a consumer.
- [x] Untrack `artifacts/vsm-prototype/` (47 files, 1.42 MB, unreferenced; already matched by `.gitignore` `artifacts`).
  Done: `git rm -r --cached artifacts/vsm-prototype/`; 47 files / 1,423,210 bytes untracked, left on
  disk. `.gitignore`'s `artifacts` rule already covers the path.
- [x] Untrack `.runtime/` and add it to `.gitignore` (3 tracked files; scripts write there at run time).
  Done: `git rm -r --cached .runtime/` (3 files, 10,101 bytes) and `.runtime/` added to `.gitignore`.
  `physical-mobile-qualification.test.mjs:99` already documents `.runtime/` as untracked by design.
- [x] Delete root `profile-l1.mjs`, `peek.mjs`, `packages/core/tmp-probe-instanced-write.mts` and `advisor-plans/` (all unreferenced).
  Done: `git rm` all four (advisor-plans/ = README + 001-consume-verified-ci-outputs.md); no
  reference outside this PRD.
- [x] Delete the two tracked sweep `scaffold.sh` files carrying `/home/joao` paths (`docs/benchmark/sweeps/physics-puzzle-2026-08-15-9/`, `-2026-08-16/`); confirm no spec reads them first.
  Done: `rg` for both exact paths found no spec or script consumer (the many `scaffold.sh` hits are
  generator code and prose, not these files); `git rm` both.

## Acceptance criteria

- [x] `pnpm audit --prod --audit-level high` exits 0 on `develop`.
      — Done 2026-09-25: `CI=true pnpm audit --prod --audit-level high` prints "No known vulnerabilities
      found", exit 0, on the box-sweep checkout of `develop` (`c318cba68`).
- [x] `pnpm alpha:bar` reports A7 pass.
      — Done 2026-09-25: `pnpm alpha:bar --write` regenerated `docs/verification/alpha-bar.md`; the next
      `pnpm alpha:bar` reports `A7 pass — byte-identical to this run`, exit 0, with `6 of 7 rows pass,
      1 deferred` (A6 stranger deferred).

- [x] `pnpm check:docs` and the prose-lane specs listed in the root `AGENTS.md` pass.
      — Done 2026-09-25: `pnpm check:docs` checked 2204 links across 1128 files, exit 0; the prose-lane
      specs (check-doc-links, evidence-budget, evidence-citations, sync-agent-docs, ci-structure,
      ci-needs) ran 178 passed / 0 failed.

- [x] The latest `site` run on `main` is a success, including the Cloudflare deploy. proof: run
      36063649413.
      — Done 2026-09-25: `gh run view 36063649413` reports workflow `site`, branch `main`, head
      `44d7d948a`, `status: completed`, `conclusion: success`, with both jobs green —
      `build and prove` and `deploy to cloudflare`. It is the newest `site` run on `main`
      (`gh run list --workflow=site --branch=main --limit 5`), the one after the failure
      `35899011227` at `d3e6b7deb`, so the secrets the root-cause box names are now set and
      consumed.

## Blocked on

- **An upstream `threenative-sculpt-mcp` release** that moves its `sharp` pin off exactly `0.35.3`:
  unblocked when that external repository publishes it. Until then a fresh consumer install nests
  `sharp@0.35.3` and `npm audit --omit=dev` reports 3 high. The local cohort is clean through its
  override (`pnpm audit --prod --audit-level high`, exit 0).
  A starter installed from packed tarballs reports no high `sharp` advisory in `npm audit --omit=dev`.
  **Blocked — needs an upstream release, not a local change.** `threenative-sculpt-mcp@0.1.1`
  (external, `ThreeNativeHQ/threenative-sculpt-mcp`) pins `sharp` to exactly `0.35.3`, so a fresh
  consumer install nests a vulnerable copy even when `@threenative/assets` floors the direct pin.
  Measured: `npm install @threenative/core@0.3.2 @threenative/assets@0.3.2` in a clean project
  installs `sharp` `0.35.4` at the root (assets path clean) and `0.35.3` under
  `threenative-sculpt-mcp`, and `npm audit --omit=dev` reports 3 high. Re-measured 2026-09-23: the
  same install still nests `sharp@0.35.3` under `threenative-sculpt-mcp@0.1.1` and
  `npm audit --omit=dev` reports `3 high severity vulnerabilities` (`GHSA-rgj7-g3m4-5g8c`); the
  registry's newest `threenative-sculpt-mcp@0.2.1` still pins `sharp` to exactly `0.35.3`, so the
  upstream block persists. Fixing it needs a `threenative-sculpt-mcp` release that moves its pin to
  `>=0.35.4`, then a publish — both out of scope here. The local cohort (this repo) is clean via the
  override: `pnpm audit --prod --audit-level high` prints "No known vulnerabilities found", exit 0.
- **Three owner calls on tracked repository junk**: deleting `docs/product/`'s two unreferenced
  PDFs (1.8 MB), `docs/midway-adoption-verify/midway-adoption.patch` (a personal email in its
  commit headers), and 214 tracked files carrying absolute `/home/joao/...` paths (no tracked tokens
  or private keys). Unblocked by the owner saying yes or no per item.
## Decisions

- **2026-09-25 (owner, R1) — proof inline from today.** Boxes opened from this date
  name their `proof:` on the box. Boxes ticked before this date cite their evidence in the lines
  beside them (command, test name, artifact path, CI run) and are left as they are.
- **2026-09-25 (owner, R3) — everything unreachable moved to *Blocked on*.** The upstream
  `sharp` release, the owner-set Cloudflare secrets and the three owner calls on tracked junk are
  dependencies, not checkboxes; they no longer hold this PRD open. Per R6 the file now lives in
  `docs/PRDs/BLOCKED/requires-release-credentials/`.
- **2026-09-25 (owner) — the Cloudflare block is gone.** The owner set `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` on the `site-production` environment and the `site` run on `main`
  (36063649413) went green including the deploy, so that `## Blocked on` line was deleted and the
  run added as a ticked acceptance box. The upstream `sharp` release and the three owner calls stay.
