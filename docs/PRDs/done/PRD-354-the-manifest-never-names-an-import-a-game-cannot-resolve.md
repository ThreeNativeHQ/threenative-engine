---
prd_contract: v1
---

# PRD-354 — the manifest never names an import a scaffolded game cannot resolve

**Status: DONE, 2026-10-08.** Proposed 2026-09-04. Filed in `agent-leverage/`, measured at `dae30759`.

**Priority:** P1 — 27 manifest entries still name imports a scaffolded game cannot resolve; resolvers unlanded.
**Complexity:** +3 for 10+ files (ten templates, the generator, the scaffolder, the reference
doc, the gate and its spec), +2 for multi-package (`create-threenative`, `engine-mcp`,
`scripts/`) = **5 → MEDIUM mode.**

## 1. Context

**Problem.** The capability manifest is the framework's answer to *"an LLM's greatest weakness is
discovering bespoke API surfaces"*. Every entry carries an `importPath` and an `example`, and the
root `AGENTS.md` instructs every agent to search the manifest and obey what it returns. **Twenty-
seven of its 272 entries hand back an import a scaffolded game cannot resolve.**

```
$ node -e "const a=require('./packages/create-threenative/capabilities.json').entries;
  const u=a.filter(e=>/raw-unreal|ueformat/.test(e.importPath));
  console.log(a.length, u.length,
    u.filter(e=>/raw-unreal/.test(e.importPath)).length,
    u.filter(e=>/ueformat/.test(e.importPath)).length)"
272 27 21 6
```

**Current behaviour.** All ten templates in `packages/create-threenative/templates/` were read at
`dae30759`:

| Package | Installed by | As |
| --- | --- | --- |
| `@threenative/core` | 10 / 10 | dependency |
| `@threenative/physics` | 10 / 10 | dependency |
| `@threenative/ui` | 9 / 10 (not `minimal`) | dependency |
| `@threenative/assets` | 10 / 10 | devDependency |
| `@threenative/playtest` | 10 / 10 | devDependency |
| **`@threenative/raw-unreal`** | **0 / 10** | — |
| **`@threenative/ueformat`** | **0 / 10** | — |

Both unlisted packages are public and published at `0.1.0`. This is a scaffold gap, not the
unpublished-workspace-dependency failure the repository has hit before — the packages install fine
if a project asks for them. **Nothing asks, and nothing tells the agent to ask.**

The 27 symbols include `createThreeObject`, `createThreeGeometry`, `decompressBulkData`,
`decompressCompressedBuffer`, `findBulkDataHeaders`, `findCompressedBufferOffsets`. An agent that
follows the instruction it was given — search, read the detail, obey the constraints, use the
`importPath` — writes an import that does not resolve, and then discovers this at build time with
no hint that the fix is an install rather than a typo.

**Why this outranks ordinary manifest hygiene.** A manifest miss (PRD-301, PRD-324) costs an agent
a rewrite of something that exists — bad, and measured. A manifest entry that *cannot be used*
costs something worse: it teaches the agent that the manifest is unreliable, on the first import it
tries. The repository's whole discovery strategy is one trust relationship, and 27 entries are
spending it.

**Files analyzed.** `packages/create-threenative/capabilities.json` (272 entries),
`packages/core/capabilities.json` (mirror), `scripts/build-capability-manifest.ts` (615),
`scripts/generate-capability-reference.ts`, `packages/engine-mcp/src/index.ts`,
`packages/create-threenative/templates/*/package.json` (10),
`packages/create-threenative/src/index.ts`, `packages/raw-unreal/package.json`,
`packages/ueformat/package.json`.

**Overlap check.** Every open PRD was surveyed on 2026-09-04.

- **PRD-301** ([`authoring/PRD-301`](../authoring/PRD-301-manifest-covers-every-shipped-package.md)) — *manifest covers every shipped package*. The exact inverse: 301 adds
  packages the manifest omits, this adds a resolvability contract to what it already names. **Both
  edit `scripts/build-capability-manifest.ts`; land them in one commit** or the second rebases onto
  a generator that no longer matches its Phase 0 measurement.
- **PRD-324** ([`authoring/PRD-324`](../authoring/PRD-324-the-capability-manifest-cannot-forget-an-export.md)) — *the manifest cannot forget an export*. Authoring-side drift,
  not consumer-side resolvability. Complementary; its gate is the natural host for §2's check.
- **PRD-297 / PRD-298 / PRD-300** (all in `authoring/`) — recall quality. Orthogonal: all three are about
  whether the right entry is *returned*, this is about whether a returned entry *works*.
- **PRD-185** (`package-naming/`) — naming law. Touches the same package list and must not be
  resolved by renaming; if it lands first, re-run §1's table before pasting a red.

## 2. Solution

**One rule: every `importPath` in the manifest is resolvable from a scaffolded project, or the
entry says how to make it resolvable.**

Three ways to satisfy it, decided per package in Phase 0 rather than assumed here:

- **(a) the scaffold installs it** — right when a template's own code needs it, or when the
  capability is one a game reaches for often enough that the dependency is the honest default;
- **(b) the entry declares its install** — a new `requires` field the MCP search result and
  `agent-docs/capability-reference.md` print verbatim (`npm i @threenative/raw-unreal`), which is
  the honest answer for a capability a game reaches only when it is importing Unreal content;
- **(c) the entry leaves the manifest** — right if the symbol is tooling the MCP server calls on
  the agent's behalf and no game should import at all.

My reading of the six sampled symbols is that **(b)** fits `raw-unreal` and `ueformat`: they are
real, published, game-reachable APIs for a job most games never do. But that is a call Phase 0
makes with the importer's actual call sites in front of it, not a decision this PRD pre-empts.

**The trap that makes a naive gate useless.** The workspace resolves everything. A check that
`import()`s each `importPath` from the repository root passes on all 272 entries today and proves
nothing — it is measuring pnpm's workspace linking, not a user's `node_modules`. The gate must
compute resolvability from **the dependency closure a scaffolded project actually gets**: the
chosen template's `dependencies` + `devDependencies` + whatever `create-threenative/src/index.ts`
writes, and nothing else. Phase 0 pastes both readings side by side so the difference is on record.

## 3. Integration Ledger

| # | New thing | Live caller | Replaces | Negative control |
|---|---|---|---|---|
| 1 | Resolvability check over every distinct `importPath` | `scripts/build-capability-manifest.ts` → `pnpm budgets` | nothing — no bound exists | Add a fake entry importing `@threenative/nope`; the gate names it |
| 2 | `requires` field on an entry, emitted from a doc tag | the generator; consumed by `engine-mcp` search results and `generate-capability-reference.ts` | the silent unresolvable import | Strip the tag from one `raw-unreal` export; the gate fails naming that symbol |
| 3 | Scaffold-closure resolver (not the workspace) | the same gate | a root-relative `import()` that always passes | Run the old root-relative form against the same manifest; it reports 0 problems where the new one reports 27 |
| 4 | `requires` reaches the agent | `packages/engine-mcp/src/index.ts` search + detail output | a bare `importPath` | Search for `createThreeObject` via the MCP tool; the install line is in the result text |

## 4. Phases

### Phase 0 — the red, and the per-package ruling

Paste the 27-entry count. Paste the
root-relative resolver reporting zero, beside the scaffold-closure resolver reporting 27 — that
pair *is* the red, and it is also the proof the instrument is not measuring pnpm. Then read the
importer's call sites and rule (a) / (b) / (c) for `raw-unreal` and for `ueformat` separately;
record the ruling and its reversal condition in this file.

- [x] Red pair pasted, same manifest (`origin/develop` at `f7dd08621`), measured 2026-10-08. proof:
      `root-relative resolver: 31 unresolvable of 36 specifiers` beside `scaffold-closure resolver, with
      every @requires stripped (the dae30759 shape): 64 distinct entries (27 raw-unreal/ueformat)`.
      The prediction of 0 from the root was wrong: the repository root links no `@threenative`
      package, so a root resolve is a false red, not a false green. Either way it measures the
      workspace layout, not a user's install, which is the point of the pair.
- [x] Ruling recorded. proof: **(b) for both packages.** `raw-unreal` and `ueformat` parse
      `.uasset`/`.uemodel` in the game at run time (`parseUAssetStaticMesh`, `createThreeObject`,
      `parseUEModel`); the importer MCP's offline route converts to GLB and never asks a game to
      import them, so (c) would hide a real runtime API, and no template's code imports them, so
      (a) would install them in every game for a job most never do. Reversal: (a) when any
      template's own source imports either package; (c) when the runtime path is retired and
      only MCP tooling calls them. The same ruling covers the per-template gaps below: `physics`
      in `rain` and `rts`, and `ui` in `minimal`.

### Phase 1 — the resolver

Compute the scaffold dependency closure per template. It must be
derived from the template manifests and the scaffolder, never hard-coded, or it becomes the
sixth hand-maintained package enumeration in this repository.

- [x] Closure derived from each template's `package.json` and source imports, never a typed list.
      proof: AC4 red below; `scaffoldDependencyClosures` reads `templates/*/package.json` (landed
      in #142, `baa1adc62`).
- [x] Closure checked per template, not as the union of all templates. proof: new spec
      `checks each template closure on its own` fails on the union gate (`promise resolved
      "{ checkedEntries: 19, …(4) }" instead of rejecting`) and passes on the per-template gate
      (27/27 in `capability-manifest.spec.ts`). The tightened gate found 42 unresolved template
      imports on `origin/develop`: `{"minimal":6,"rain":18,"rts":18}`.

### Phase 2 — the gate

Wire it through `pnpm budgets` beside the existing capability checks. Fail
closed: an entry whose `importPath` is neither in the closure nor carrying `requires` fails.

- [x] Gate runs in `pnpm budgets` (via `scripts/check-budgets.ts` → `checkCapabilityManifest`)
      and `pnpm capabilities:check`. proof: both green on this branch, `380 of 380 package-backed
      entries resolvable or documented across 13 template closures (65 require install
      instructions, 0 unresolved template imports)`.
- [x] A fabricated `@threenative/nope` entry fails naming the symbol and the package. proof:
      AC2 red below; the spec `fails when a manifest import has no scaffold dependency` keeps it.

### Phase 3 — the ruling, applied

Whichever of (a)/(b)/(c) Phase 0 chose, for both packages.
If (b): the doc tag, the generator field, both manifest copies, the MCP output and
`capability-reference.md`.

- [x] The 27 `raw-unreal`/`ueformat` entries carry `requires`; both manifest copies agree.
      proof: tags landed in #142; `cmp` of both copies identical; `pnpm capabilities:check` green.
- [x] Every per-template gap is resolved by ruling (b), not a suppression list. proof: 18
      `@requires npm i @threenative/physics` and 6 `@requires npm i @threenative/ui` doc tags on the
      re-export blocks; gate 42 → 0; `capability-reference.md` regenerated.

### Phase 4 — the agent actually sees it

An `engine_capability_detail` call on one affected
symbol prints the install line. Paste the tool output, not the JSON.

- [x] `engine_capability_detail` on `createThreeObject` prints the install line. proof: AC5
      output below.
- [x] A scaffolded-game test scaffolds every template and resolves every manifest import with
      Node. proof: `packages/create-threenative/__tests__/scaffold-manifest-imports.spec.ts` runs
      `createProject` for all 13 templates, links only the declared dependencies into
      `node_modules`, and calls `import.meta.resolve` on every package import. It passes on this
      branch and fails on the `origin/develop` manifest: `AssertionError: minimal: expected [
      …(6) ] to deeply equal []`. Its control asserts that every undeclared package stays
      unresolvable, so the resolver cannot pass trivially.
- [x] AC7 and AC8 gates run, output pasted. proof: AC7 and AC8 results below.

## Acceptance criteria

- [x] **AC1 — the red is a pair.** Root-relative resolver: 0 problems. Scaffold-closure resolver:
      27. Both pasted, same manifest, same commit. Without this pair the gate is unfalsifiable.
      Result: the pair differs as required, but the root reading is 31 of 36, not 0 (see Phase 0).
- [x] **AC2 — a fabricated bad entry fails.** An entry importing `@threenative/nope` → `pnpm
      budgets` fails naming the symbol and the package. Red pasted.
      Result: a throwaway `packages/nope` → `tsx scripts/check-budgets.ts` exit 1:
      `- minimal: NopeCapability -> @threenative/nope (@threenative/nope); this template's
      dependency closure does not install this package and the capability has no @requires
      install instruction` (one line per template, 13).
- [x] **AC3 — the 27 are resolved.** After Phase 3, the gate reports zero unresolvable entries, and
      the resolution is the one Phase 0 ruled — not a suppression list. A suppression list fails
      this criterion. Result: `0 unresolved template imports`; resolution is the (b) tag, no list.
- [x] **AC4 — the closure is derived.** Deleting `@threenative/ui` from one template's
      `dependencies` makes the gate fail on that template's UI capabilities. Red pasted. This is the
      control that proves the closure is read, not typed. Result: `@threenative/ui` removed from
      `templates/starter/package.json` → `CAPABILITY_SCAFFOLD_IMPORT_UNRESOLVED: 6 manifest imports
      are unusable from scaffolded projects`, `- starter: UiLayer -> @threenative/ui` and five more.
- [x] **AC5 — the agent-visible path.** `engine_capability_detail` on `createThreeObject` returns
      text containing the install instruction. Output pasted. Result (MCP `tools/call` through
      `handleLine`): `"package": "@threenative/raw-unreal", "requires": [ "npm i
      @threenative/raw-unreal" ]`; `CharacterBody3D` returns `"requires": [ "npm i
      @threenative/physics" ]`.
- [x] **AC6 — both manifest copies agree.** `packages/create-threenative/capabilities.json` and
      `packages/core/capabilities.json` carry the same fields; `pnpm capabilities:check` green.
      Result: `cmp` reports the files identical; `capability manifest fresh: 392 entries`.
- [x] **AC7 — sealed corpus untouched.** No `docs/benchmark/genres/*/brief.md` text enters either
      manifest copy. `git diff --stat` on `docs/benchmark/` is empty. Result: empty against
      `origin/develop`.
- [x] **AC8 — gates.** `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets`, output pasted.
      Result: local `typecheck=0`, `lint=0`, `budgets=0`. Local `pnpm test` exit 1. Cause 1:
      `runtime-native` 22 reds, `TN_ADAPTER_POLICY_NO_BINARY: build the desktop host first`, because
      this fresh worktree has no native build and the diff touches no `runtime-native` file. Cause 2:
      the root vitest suite at load 33–50 reported 15 reds in 9 files. One was real:
      `budgets.spec.ts` pinned the union attribution and now expects per-template lines (38/38).
      Seven files passed in isolation. `generated-shooter-input.spec.ts` stayed red in isolation
      at load 46 (`playerYaw.atSteps must be evaluated`: the steps never ran). CI run
      `37871605353` on `88a1009fb` is the authority: `completed success`, 69 jobs passed, 1
      skipped, including `test`, `test-native`, `test-playtest`, `typecheck` and
      `golden-path-template (starter)`.

## 6. Decline conditions

Close as DECLINED if Phase 0 finds that `raw-unreal` and `ueformat` symbols are only ever called by
the MCP server on the agent's behalf and no game should import them — in which case the correct
change is **(c)**, deleting 27 entries, which is a five-line generator filter and does not need a
PRD. Record the finding, make the deletion, and close this file citing it.

Close as DECLINED if the scaffold closure cannot be derived without hard-coding a package list. A
sixth hand-maintained enumeration costs more than the 27 entries do.
