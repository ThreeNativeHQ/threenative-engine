# Contributing to ThreeNative

Thanks for being here. Issues, discussions, docs fixes and pull requests are all welcome, and a
first contribution does not have to be code.

- **Found a bug?** [Open an issue](https://github.com/ThreeNativeHQ/threenative-engine/issues/new/choose)
  with the reproduction — a scenario file or a scaffolded project beats a description.
- **Have a question or an idea?**
  [Start a discussion](https://github.com/ThreeNativeHQ/threenative-engine/discussions).
- **Wondering what needs doing?** [`docs/CURRENT-CHALLENGES.md`](docs/CURRENT-CHALLENGES.md) is
  the honest list of what the framework does not yet do well, and what the plan is for each.
- **Found a security issue?** Follow [`SECURITY.md`](SECURITY.md) instead of opening an issue.

## AI contributions welcome

We accept AI-written pull requests, including agent-led contributions. We prefer a current
frontier Claude or Codex model for implementation and review, but neither is required. The
same architecture rules, tests, runtime evidence and maintainer review apply to everyone;
AI authorship is not a reason to reject a useful, verified contribution.

Point your coding agent at the public, repository-shipped
[`contribute` skill](.agents/skills/contribute/SKILL.md). It checks live PRDs, code and open
pull requests, recommends the three best eligible tasks, and picks the highest-value one by
default. It does not treat an unchecked box as proof that work is missing or unclaimed.

Copy this prompt into your coding provider from an engine checkout:

```text
Read .agents/skills/contribute/SKILL.md and its linked discovery reference. Follow the
repository instructions, recommend the best three currently eligible open PRDs with
evidence, then implement the highest-value eligible task on an isolated branch from
upstream develop (origin/develop for an upstream checkout, upstream/develop for a
fork checkout). Keep one PR per PRD and target ThreeNativeHQ/threenative-engine:develop.
I authorize creating/using my fork if needed, pushing only the contribution branch
and opening/updating its draft PR at the first planning commit before implementation.
Do not push upstream develop/main, merge, deploy or publish a release.
Record actual test/playtest/platform results and leave unverified claims open.
```

For recommendations only, replace the last instructions with “Read-only: recommend tasks;
do not change files, push or open a PR.” Without explicit publication authorization, the
skill keeps work local and reports the draft-PR step as pending. Read
[`AGENTS.md`](AGENTS.md) and [`docs/PRDs/AGENTS.md`](docs/PRDs/AGENTS.md) for the live
branch, draft, progress and verification rules.

## Setup

Node 20.19+ and pnpm 10+:

```sh
pnpm install --frozen-lockfile
```

Native compilation is opt-in — the default gate needs no CMake, NDK, or Xcode. Third-party runtime
provenance is recorded in [`packages/runtime-native/NOTICE`](packages/runtime-native/NOTICE).

There is no root `pnpm dev`. Run an example by name: `pnpm --filter abyss-framework dev`.

## The gate

Before opening a pull request:

```sh
pnpm typecheck && pnpm lint && pnpm test
```

For an affected-only local run against a protected integration branch:

```sh
pnpm ci:local --affected --target develop --base origin/develop
pnpm ci:local --full                         # explicit full audit / rollback
```

Both local and hosted checks use `scripts/ci-change-scope.mjs`. It examines the entire merge-base
diff, not just the last commit. Unknown or uncommitted changes run the full board. A PR that changes
only Markdown the executable fixtures do not consume runs **no CI job** — docs links, evidence
budgets and secret scans are re-validated on the develop nightly run and at promotion. The fast
pre-push hook reports this decision but remains a bounded drift check, not native qualification.

The native platform matrix (desktop parity, Android emulator, iOS simulator, Windows/macOS) is
produced on full selections but is deliberately **not part of the merge verdict**: the required
`build` context asserts only the scope and the workspace artifacts. The release lane validates the
native rows for the exact candidate SHA, so a native red does not block a merge but does block a
release. This keeps ordinary merges off the 120-minute native build.

The integration flow is active: `develop` is protected and requires `ci-required`. Start feature
branches from develop and explicitly open their PRs against develop; merge features there with
squash. Promote by opening a plain `develop -> main` PR and merging it with a merge commit,
preserving ancestry; the head branch needs no special name. A changed head/base requires fresh
checks. Emergency `hotfix/` PRs use full main checks and must be merged back to develop. The repository default may remain main
for qualified workflow definitions; set `git config threenative.integrationBranch develop` in each
checkout. Do not retarget another person's PR or rewrite their worktree.

`pnpm lint` prints several hundred warnings on a clean tree; only errors fail the build, so read
the error count. If a package's types look stale against a change you did not make, rebuild it —
templates and examples typecheck against `dist/`.

## Versioning and deprecation

The **public surface** is every exported symbol, type, and export subpath of a published package
(`@threenative/core`, `@threenative/physics`, `@threenative/ui`, `@threenative/assets`,
`@threenative/playtest`, `@threenative/runtime-native`, `@threenative/raw-unreal`,
`@threenative/ueformat`, `create-threenative`, `threenative-engine-mcp`,
`threenative-blender-mcp`) — the API your game and its agents import. Everything else is internal
and may change in any release.

**Before 1.0** (`0.x.y`): `patch` is fixes only, `minor` may break. A break is always announced.
`pnpm api:surface:check` compares the live surface against the committed
`scripts/api-surface.json` and fails when a published package, an export subpath, an exported class
or function, or its signature disappears without a `Breaking` entry in the unreleased section of
`CHANGELOG.md` naming it. Type-only and other exports are public too; the snapshot does not yet
enumerate them, so the 1.0 acceptance gate remains open. "Minor may break" means *minor breaks in
the changelog*, never *minor breaks silently*.

**At and after 1.0**: semver exactly as written — `patch` fixes, `minor` adds, `major` breaks. A
`major` is the only version that may remove or re-sign a public symbol. The current surface check
requires a note for a break; release-version enforcement remains open in PRD-446.

**Every announced break carries a migration note** under `### Breaking`: the old name, the new
name, and the edit that upgrades a game. An agent follows that note verbatim, so a bullet that
does not say what to change is not a migration note.

**A deprecation window is one minor.** A deprecated symbol keeps working, signature intact, for one
more minor release; after that it may be removed and is announced like any other break. Marking
something deprecated is a two-part change in one commit:

1. a `@deprecated` JSDoc tag naming the replacement, plus a `console.warn` that fires **once** per
   process, not per call;
2. the capability-manifest entry (`packages/create-threenative/capabilities.json`) marked
   deprecated, so `engine_capability_detail` tells an agent the replacement before it writes the
   call.

Neither the one-time warning nor the manifest marker ships yet (PRD-446); until they do, the
changelog is the only deprecation signal a reader gets.

## Tests are not optional

Add a unit test in `<package>/__tests__/*.spec.ts` for every change, in the same commit. A change
with runtime behaviour also needs a playtest scenario, which drives the real build and asserts what
happened.

For a bug fix, write the failing test first and include both the red and the green in the pull
request. A fix with no test that would have caught it is not finished.

## Where a change goes

See [`AGENTS.md`](AGENTS.md) for the complete conventions. In short:

| What you are adding | Where it belongs |
| --- | --- |
| Anything that decides how it looks — materials, shaders, TSL, lights, tonemapping, post, camera framing | `packages/create-threenative/templates/*/src/render/`, as generated user source |
| Gameplay | an example or a template — never a package |
| Plumbing every game repeats and no game should write | `packages/core/src/` |
| Physics or navigation (carries the WASM dep) | `packages/physics/src/` |
| React HUD/menu bindings (carries the React dep) | `packages/ui/src/` |
| C++ host, platform bring-up, native systems | `packages/runtime-native/` |
| Scenario harness / assertions | `packages/playtest/` |
| Proof that any of it works | `<package>/__tests__/*.spec.ts` and a playtest scenario |

Two questions decide whether something belongs in the framework at all, and they are the
[Charter](docs/architecture/CHARTER.md)'s, not a size limit:

1. **Could a game write this portably itself?** If no — it needs a browser global, a platform seam,
   or a backend the game must not know it got — the framework can own it, at any size.
2. **Does it decide how anything looks?** If yes, it ships as generated source in `src/render/`, at
   any size. This one is a veto.

## Things that will close a pull request

- Anything that decides how a frame looks, added to package code or a framework option.
- A hand-edited `CLAUDE.md`. Those files are generated: edit `AGENTS.md`, then run
  `pnpm sync:agents`.
- An IR, a scene format, an editor, a preset/genre system, a code-first ECS, or a bespoke CLI
  vocabulary. These are closed with evidence and are not reopened in a pull request.

None of these are judgements about the code — they are boundaries the project has already paid to
learn. If you think one is wrong, open a discussion rather than a pull request; the Charter can be
amended, and [`docs/architecture/CHARTER-HISTORY.md`](docs/architecture/CHARTER-HISTORY.md) shows
that it has been.

## Code of Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

By contributing, you agree that your contribution is licensed under the MIT licence. There is no
CLA.
