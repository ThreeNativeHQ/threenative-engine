---
prd_contract: v1
---

# PRD-119 — Alpha row 1: three of seven packages are 404, and the four that exist are six days behind the tree

**Status: COMPLETE, 2026-08-16.** All four phases executed. Seven packages are on
`registry.npmjs.org`, and a stranger can install ThreeNative and build a game. Evidence:
[`registry-install-2026-08-16.md`](../../verification/registry-install-2026-08-16.md) and
[`publish-state-2026-08-15.md`](../../verification/publish-state-2026-08-15.md).

| Criterion | Result |
|---|---|
| 1. Clean machine: create → install from the registry → a game that runs | **met.** `npx create-threenative@0.2.2` scaffolds; `npm install` resolves every package from `registry.npmjs.org`; `npm run build` succeeds; and the published `threenative-playtest` drives the project in a real browser to `"pass": true`, measuring the player moving 2.0 units |
| 2. The published `@threenative/playtest` fails closed | **met.** Against a page with a canvas and no bridge it reports `"pass": false` and exits `2` — the published artifact carries the fail-closed default, not just the repository |
| 3. `publish:check` red before, green only after every version moved | **met.** Red on four packages before the bump, green after |
| 4. Zero `file:` and zero `link:` in the generated lockfile | **met.** `grep -cE '"(file\|link):' package-lock.json` → `0` |
| 5. A dated verification file records the Phase 0 red and the Phase 3 green | **met**, in the two files named above |

**It took four publishes, not one, and the two extra were real defects the clean room caught:**
`create-threenative@0.2.0` was a no-op when installed (a `bin` symlink defeated its entry guard),
and `@threenative/physics@0.2.0`/`@threenative/ui@0.2.0` declared a peer range excluding the core
beside them, so `npm install` died with ERESOLVE. Both are fixed, both now have a gate —
`cli-bin.spec.ts` and a `publish:check` rule — and the four broken versions are deprecated on npm
with messages naming the good one. `pnpm release` exists so the sequence is one command.

**What this does not license.** `@threenative/runtime-native@0.2.0` is published but **zero GitHub
releases exist**, so its prebuilt binaries 404; it is an `optionalDependency`, so the web path
installs and the native path does not — PRD-078's lane. Publishing happened from a laptop, not
from CI, because the repository has no `NPM_TOKEN` secret. One playtest scenario was run, not the
whole suite. `starter` was the only template exercised. No mobile-readiness, physical-device or
iOS claim is made.

---

§1 is a read of the public registry, of `.github/workflows/`, and of the tree at `633adcd6`, taken
2026-08-15. Every number below was produced by a command that is pasted with it. No
mobile-readiness, physical-device or iOS claim is made.

**Complexity: 7 → HIGH mode.** Multi-package, a new release lane, an external registry, and a
version-of-record decision that cannot be un-published once wrong.

**Depends on:** nothing. **Unblocks:** PRD-080 (removed) — a stranger
cannot install a package that 404s — and the registry half of
[PRD-112](PRD-112-golden-path-from-packed-artifacts.md).

**Blast radius (candidate, phase-gated).**
Phase 0: `docs/verification/` only.
Phase 1: `scripts/check-publish-state.ts`, `scripts/__tests__/`, root `package.json`.
Phase 2: `.github/workflows/npm-release.yml`, `packages/*/package.json` version fields.
Phase 3: `packages/create-threenative/templates/*/package.json`, `README.md`.

---

## 1. What the registry actually holds

| Package | Local version | On registry.npmjs.org | Command |
|---|---|---|---|
| `@threenative/core` | 0.1.0 | **0.1.0** | `npm view @threenative/core version` |
| `@threenative/physics` | 0.1.0 | **0.1.0** | same |
| `@threenative/ui` | 0.1.12 | **0.1.12** | same |
| `@threenative/playtest` | 0.1.0 | **0.1.0** | same |
| `create-threenative` | 0.1.0 | **404** | `npm view create-threenative` → `npm error 404` |
| `@threenative/studio` | 0.1.0 | **404** | same |
| `@threenative/runtime-native` | 0.1.14 | **404** | same |

```
$ npm view @threenative/core dist.tarball time.created
dist.tarball = 'https://registry.npmjs.org/@threenative/core/-/core-0.1.0.tgz'
time.created = '2026-08-09T07:32:33.145Z'
```

**The published set is six days old.** Between that timestamp and `HEAD`:

```
$ git log --oneline --since=2026-08-09 -- packages/ | wc -l
83
$ git diff <pre-publish> HEAD -- packages/ --shortstat
 649 files changed, 52830 insertions(+), 2709 deletions(-)
```

Everything landed since is invisible to anyone outside this machine: PRD-110's fail-closed
diagnostics default, PRD-111's generic proof scenario, PRD-115's slimmer scaffold, and PRD-116's
native physics actuation. A user who installs today gets the framework as it was *before* the batch
that exists to make it trustworthy.

### The three that 404 are not private — they are unshipped

`packages/create-threenative/package.json:21` declares `publishConfig: { access: "public" }`. So
does `runtime-native`. Neither is marked `private`. They are intended to be published and have not
been.

**`create-threenative` is the first command in the documented golden path.**
PRD-106 diagrams the whole scaffold flow starting at
`npx create-threenative my-game`, and the architecture docs describe what
`pnpm create threenative my-game` generates. That command 404s for every person on earth.

This is already on the record and was only half-fixed.
[`adopter-pilot-2026-08-14.md`](../../verification/adopter-pilot-2026-08-14.md) hit both 404s and
says so plainly:

> Blast radius today is the sandbox lane only — nothing is published, so there is no user in the
> wild hitting it — but … it will become the first thing a real adopter hits the moment
> `create-threenative` is published.

The sandbox half was fixed the same day: `make-sandbox.ts` packs `studio` and the CLI as local
tarballs. **That fix makes the repo's own harness stop noticing the problem.** Every sweep, every
sandbox, every consumer proof to date resolves `file:` tarballs, so no gate in this repository has
ever exercised the registry path.

### Nothing publishes to npm

```
$ grep -rn "npm publish" .github/workflows/
(no matches)
```

`.github/workflows/native-release.yml` has a job named `publish` (`:218`), and it publishes
**GitHub release binaries** — `gh release create "$TAG" release/*` at `:259`. There is no npm
lane, no changesets directory, and no version-bump script. The four packages on the registry were
pushed by hand once and have not been touched since.

### The version numbers cannot express what changed

Local versions equal published versions for all four live packages. Publishing the current tree
requires a bump, nothing computes one, and nothing fails when a package is edited without one. The
`0.1.0` on the registry and the `0.1.0` on disk are different software with the same name.

**Measured, 2026-08-15.** The published `@threenative/core@0.1.0` declares two dependencies; the
local one declares three:

```
$ npm view @threenative/core dependencies
{ "three": "0.185.1", "zustand": "5.x" }
$ grep -A3 '"dependencies"' packages/core/package.json
  "three": "catalog:", "three-mesh-bvh": "catalog:", "zustand": "catalog:"
```

Two useful facts fall out of that comparison. `three-mesh-bvh` is missing from the published
package, so this is different software under the same version string — not merely an older build.
And the published manifest carries **resolved** versions rather than `catalog:` specifiers, which
proves the 2026-08-09 publish went through `pnpm publish`. The specifier rewriting works; a raw
`npm publish` would leak `catalog:` into the manifest and break every install. Phase 2 uses
`pnpm publish`.

### Overwriting is not available, and the account is not the obstacle

Checked 2026-08-15 with the repository-local `.npmrc` (byte-identical to
`~/projects/threejs-to-bevy/.npmrc`; never printed, always passed as `--userconfig`):

| Question | Answer | Command |
|---|---|---|
| Does the token authenticate? | yes, as `jonit-dev` | `npm --userconfig .npmrc whoami` |
| Who owns the four live packages? | `jonit-dev`, all four | `npm --userconfig .npmrc owner ls @threenative/core` |
| Are the three missing names taken? | no — never registered | `npm view create-threenative` → 404 |

**So the blocker is not permission, and it is not name availability. It is that npm does not permit
republishing a version that exists.** Unpublishing is allowed only within 72 hours of the original
publish; `0.1.0` went up 2026-08-09, so that window closed 2026-08-12. There is no overwrite path,
only a bump.

`@threenative/ui` is the exception that proves the lane works: 13 published versions up to
`0.1.12`, the most recent on 2026-08-09. The other three have never moved off `0.1.0`.

### Owner decision, 2026-08-15 — all seven publish as `0.2.0`

Recorded here because Phase 2 cannot run without it.

**Decision: every package publishes as `0.2.0` to the `latest` dist-tag.** One number across all
seven, including the jump for `ui` from `0.1.12`. It marks the line between the hand-published
`0.1.0` and the alpha, and it keeps `npm create threenative my-game` working with no extra flags.

**A prerelease tag was considered and rejected for one concrete reason:** publishing only as
`0.2.0-alpha.0` under an `alpha` tag does not set `latest`, so `npm create threenative` would still
fail and a stranger would have to know to type `npm create threenative@alpha`. That leaves alpha
row A1 red by construction, which defeats the PRD.

**Consequence for Phase 2:** the seven template manifests in
`packages/create-threenative/templates/*/package.json` pin exact versions — `"@threenative/core":
"0.1.0"`, `"create-threenative": "0.1.0"`, `"@threenative/runtime-native": "0.1.14"` — and every
one moves to `0.2.0` in the same commit. A template left pinned at `0.1.0` scaffolds a project that
installs the old packages, which is the current defect wearing a new number.

---

## 2. What alpha needs, and what it does not

Alpha does not need semver discipline, deprecation policy, or LTS. It needs one true sentence:
**the thing a stranger installs is the thing this repository proved.**

Out of scope, deliberately: changesets or any release-notes generator, a `latest`/`next` channel
split, provenance attestations, and publishing `@threenative/studio` as a product surface —
`studio` publishes because templates depend on it, not because the hosted product is ready.

---

## 3. Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `scripts/check-publish-state.ts` | root `package.json` `scripts.publish:check`; the workflow preflight in ledger row 2 | undocumented hand `npm publish` | n/a — there was no script | goes red when a package's local version equals its published version |
| 2 | `.github/workflows/npm-release.yml` | tag push `v*` / `workflow_dispatch` | the hand publish of 2026-08-09 | documented as removed in `README.md` | goes red when any of the seven packages is missing from the publish set |
| 3 | Clean-room install gate (`scripts/verify-registry-install.ts`) | `npm-release.yml` post-publish job; `pnpm alpha:bar` row A1 (PRD-120) | `scripts/verify-golden-path.ts`, which resolves `file:` tarballs | no — kept; it proves the packed path, this proves the registry path | **red today**: the command 404s at `create-threenative` |
| 4 | Version bump enforcement | `scripts/check-publish-state.ts` | nothing | n/a | goes red when `packages/core/src` is edited with no version change |

**Row 3 is the whole PRD.** Rows 1, 2 and 4 exist so row 3 can go green and stay green.

---

## 4. Reachability

**How is this reached?** A person types `npm create threenative@latest my-game` on a machine that
has never seen this repository. That is the entry point; there is no other.

**Full flow:**

1. A maintainer pushes a `v*` tag.
2. `npm-release.yml` runs `pnpm test`, then `scripts/check-publish-state.ts`, then publishes all
   seven packages.
3. A post-publish job installs from the registry in a clean container and runs the golden path.
4. The result is observable as: the tarball a stranger downloads boots a game.

**What does this replace?** The hand publish of 2026-08-09 — the only publish that has ever
happened. It is removed by being documented as forbidden and by the preflight failing a tree whose
versions do not move.

---

## 5. Phases

Every phase edits at least one pre-existing file.

### Phase 0 — record the red, change nothing

**Files:** `docs/verification/publish-state-2026-08-15.md` — NEW.

Run and paste, on a machine with no repo checkout in scope:

```sh
npm view create-threenative version            # expect: 404
npm view @threenative/studio version           # expect: 404
npm view @threenative/runtime-native version   # expect: 404
npm view @threenative/core version time.created
npm create threenative@latest /tmp/alpha-probe # expect: 404, no project created
```

**Done when:** all five outputs are in the verification file. **No fix in this phase.** If
`npm create threenative` unexpectedly succeeds, stop — the premise of this PRD is wrong and it is
rewritten before anything is published.

### Phase 1 — the preflight that makes a stale publish impossible

**Files:** `scripts/check-publish-state.ts` NEW · `scripts/__tests__/check-publish-state.spec.ts`
NEW · `package.json` EDIT (adds `publish:check`) · `docs/PRDs/alpha-readiness/README.md` EDIT.

The script reads every non-private `packages/*/package.json`, queries the registry once per
package, and exits non-zero when: a package is absent from the publish set, a local version equals
the published version while its `src/` has commits since that version's publish time, or a
`catalog:` specifier survives into a template manifest.

**Tests:** `should fail when a local version equals the published version`, `should fail when a
package is missing from the publish set`, `should pass when every version moved`. Each is observed
red against a fixture with the condition removed.

**Wiring:** `package.json` gains `"publish:check": "tsx scripts/check-publish-state.ts"`.

### Phase 2 — publish all seven, from CI, once

**Files:** `.github/workflows/npm-release.yml` NEW · `packages/*/package.json` EDIT (all seven to
`0.2.0`) · `packages/create-threenative/templates/*/package.json` EDIT (every pinned version to
`0.2.0`) · `README.md` EDIT (the install command becomes true).

The workflow runs `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test`,
then `pnpm publish:check`, then publishes with **`pnpm publish`** — never raw `npm publish`, which
would leak `catalog:` and `workspace:*` specifiers into the manifests — with the credentials passed
explicitly and never printed.

**This is the one irreversible step in the batch.** A published version cannot be recalled, only
deprecated. Phase 2 does not run until Phase 1 is green and an owner has approved the version
numbers in the PRD.

### Phase 3 — the clean-room gate that proves it worked

**Files:** `scripts/verify-registry-install.ts` NEW · `.github/workflows/npm-release.yml` EDIT ·
`scripts/__tests__/verify-registry-install.spec.ts` NEW.

In a directory with no workspace above it and an empty npm cache:

```sh
npm create threenative@latest my-game -- --template starter
cd my-game && npm install && npm run build && npm test
```

The gate asserts no `file:` specifier and no `link:` specifier appears in the resulting lockfile —
that is what separates this from `verify-golden-path.ts`, which is *designed* to resolve tarballs.

---

## 6. Acceptance criteria — consumer-scoped

1. On a machine that has never seen this repository, `npm create threenative@latest my-game`
   creates a project, `npm install` resolves every dependency from `registry.npmjs.org`, and
   `npm run dev` serves a game that renders a non-blank frame.
2. The published `@threenative/playtest` tarball, extracted and run against PRD-110's seeded
   negative fixture, **fails closed** — proving the published artifact carries the repaired
   default, not just the repository.
3. `pnpm publish:check` exits non-zero on the tree as it stands today, and exits zero only after
   every package's version has moved past what the registry holds.
4. The generated project's lockfile contains zero `file:` and zero `link:` specifiers.
5. `docs/verification/publish-state-<date>.md` records the Phase 0 red and the Phase 3 green with
   both command outputs pasted.

Rejected wordings, for the record: *"the packages are published"* (satisfiable by publishing
nothing anyone can use), *"the release workflow succeeds"* (satisfiable with zero packages in the
publish set), *"install works in the sandbox"* (the sandbox resolves tarballs by design).

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | A bad publish cannot be undone | Phase 2 is gated on Phase 1 green plus owner approval of the exact versions; the clean-room gate runs post-publish and a failure is fixed forward with a new version, never a force-push |
| 2 | The registry token leaks through a log | `.npmrc` is passed with `--userconfig`, never printed, and stays untracked. Publishing uses a repository secret, never a checked-in file |
| 3 | Publishing `@threenative/studio` reads as shipping the hosted product | `README.md` states it publishes because templates depend on it; the hosted lane stays owned by `docs/PRDs/studio-hosting/` |
| 4 | The clean-room gate quietly falls back to the workspace | Row 3's assertion is the absence of `file:`/`link:` in the lockfile, checked in a temp directory with no parent workspace |
| 5 | CI minutes | The clean-room gate runs on tag pushes only, not on every commit |
</content>
</invoke>
