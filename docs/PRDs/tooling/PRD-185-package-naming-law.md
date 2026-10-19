---
prd_contract: v1
---

# PRD-185 — One naming law for the npm surface

**Status:** OPEN, 2026-08-22. Filed from the owner's audit request: five workspace packages are
scoped, the MCP layer runs on three more schemes, and no document states which is the standard.
Evidence verified at HEAD `8033dc50`.

**Priority:** P2 — Open boxes extend the manifests spec and publish the naming law with two waivers.
Complexity: 5 → MEDIUM mode (>10 touched files across packages/scripts/templates, every edit
mechanical; the decisions — which scheme wins, what is exempt — are the substance).

**Outcome:** an authoring agent reading this repo's docs, a template, or a generated project's
`.mcp.json` can predict every ThreeNative npm name from one stated law; the only deviations are
two externally-owned servers listed by name, owner, and unblock condition; the conformance gate
fails the suite when a fourth scheme appears.

## Context (verified evidence)

1. Five of seven workspace packages conform: `@threenative/core`, `physics`, `playtest`,
   `runtime-native`, `ui`. Two do not: `create-threenative`
   (`packages/create-threenative/package.json`) and `threenative-engine-mcp`
   (`packages/engine-mcp/package.json` — name **and** bin).
2. The MCP layer adds two more schemes. Server keys written into every generated project's
   `.mcp.json` are `threenative-assets` / `threenative-sculpt` / `threenative-engine`
   (`packages/core/mcp/servers.mjs:9-28`). The packages those keys launch are unscoped,
   `-mcp`-suffixed: `MCP_PACKAGES` pins `threenative-asset-mcp@0.4.0`,
   `threenative-sculpt-mcp@0.1.0`, `threenative-engine-mcp@0.2.0`
   (`servers.mjs:33-35`), reached through core's shims via npx fallback. Key vs package even
   disagree on number: `assets` ↔ `asset-mcp`.
3. `threenative-asset-mcp` and `threenative-sculpt-mcp` are **not built in this tree** — no
   manifest here declares those names. Their sources live elsewhere; only the pinned pointers
   and docs are ours.
4. Nothing prefers any scheme. The doc gate blesses all three at once —
   `scripts/__tests__/primary-docs.spec.ts:66` accepts `@threenative/*`, `threenative-*`, and
   `create-*` as equally shippable — so drift compounds silently.
5. Live consumers of the old names beyond the definitions themselves: template devDependencies
   (`templates/*/package.json`, e.g. minimal `:25,:30`), the scaffold CLI's server wiring
   (`packages/create-threenative/src/index.ts:33,:281,:458`, `src/doctor.ts:168`), and three
   gates (`scripts/check-budgets.ts:36-37`, `verify-golden-path.ts:604`, `visual-gate.ts:42`).
6. `examples/` mixes four dir-name patterns (`abyss-framework`/`abyss-vanilla`,
   `threenative-native-smoke`, `fps-friction`, `prd140-picking`). Nothing outside each example's
   own directory references them, so renaming buys nothing today.

## Direction decisions (made here, so the executor doesn't have to)

1. **The law:** every published package is `@threenative/<name>`. Stated once, in root
   `AGENTS.md`, enforced by the doc gate.
2. **`create-threenative` keeps its unscoped name — sanctioned exception.** npm initializer
   vocabulary is borrowed ecosystem norm (`create-vite`, `create-next-app`); renaming moves the
   documented onboarding line (`README.md:13`: `pnpm create threenative my-game`) to a scoped
   variant for zero gain. Scoped alternative `@threenative/create` was considered and rejected
   on the same borrowed-vocabulary rule.
3. **`threenative-engine-mcp` renames to `@threenative/engine-mcp`.** It is not an initializer;
   no ecosystem convention excuses it. The **bin** stays `threenative-engine-mcp` (commands are
   stable API — Studio and the golden-path script invoke it) and the **directory** stays
   `packages/engine-mcp` (already matches the scoped suffix). Version bumps to 0.3.0 with a
   BREAKING-rename changelog entry; the old registry name gets a deprecation notice pointing at
   the new one (registry commands take the local `.npmrc`; never print it).
4. **Asset/sculpt target names are declared, not flipped:** `@threenative/asset-mcp`,
   `@threenative/sculpt-mcp`. The rename lands in their owning repo — flipping our
   `MCP_PACKAGES` pointers before scoped versions exist would break the npx fallback in every
   installed project. Until then they are **listed waivers** in `AGENTS.md` (name, owner,
   unblock condition: scoped versions published), and a follow-up outside this PRD flips
   `servers.mjs:33-34` and drops the waivers in the same change.
5. **`.mcp.json` keys freeze.** They are runtime identifiers already written into users'
   projects; postinstall rewriting them under existing installs is hostile. The law covers them
   as `threenative-<server>`, no `-mcp` suffix — all three already comply. The plural/verb/noun
   grammar mix is accepted; keys are opaque identifiers, not prose.
6. **Example dirs stay.** Renaming unreferenced fixture dirs churns screenshots and muscle
   memory for zero discoverability gain. `AGENTS.md` gains one sentence: example dirs are
   unpublished fixtures with no naming scheme; paired controls keep their shared prefix.

## Integration Ledger

| # | New thing | Live caller (`file:line` — fill during implementation) | Replaces | Old path removed? | Negative control |
|---|-----------|--------------------------------------------------------|----------|-------------------|------------------|
| 1 | Naming-law spec in the doc gate | vitest suite via `pnpm test` (CI chains lint→test) | the permissive blessing regex at `primary-docs.spec.ts:66` narrowed to the law | yes, regex tightened in same phase | spec is red at HEAD before Phase 2 (paste below) |
| 2 | `@threenative/engine-mcp` identity | workspace resolution (`pnpm-lock.yaml`), template devDeps (`templates/*/package.json:25`), scaffold CLI (`create-threenative/src/index.ts:33,:281,:458`), gates (`check-budgets.ts`, `verify-golden-path.ts:604`, `visual-gate.ts:42`), README Packages table | name `threenative-engine-mcp` | name deleted everywhere live; bin kept; registry name deprecated | reverting the manifest name re-reds ledger row 1 |
| 3 | Waiver ledger + vocabulary map (AGENTS.md § Package naming, AGENT-INTERFACE.md table) | agents reading docs; enforced bidirectionally by the doc gate | scattered implicit prose | n/a — consolidation | synthetic nonconformer → red; conforming a waived name without dropping its waiver → red |

## Phases

Phases 1 and 2 share a commit so `main` never carries a red gate; the red is reproduced and
pasted in the execution notes first (repo red-green rule).

#### Phase 1: The law becomes a failing gate - the suite names the offender before anything moves

**Files (3):**

- `scripts/__tests__/primary-docs.spec.ts` - EDIT: new test `should scope every workspace
  package except the declared initializer exception`; exception list `["create-threenative"]`
  lives beside the blessing regex it narrows
- `AGENTS.md` (root) - EDIT: new "Package naming" section stating the law and the two exception
  classes (initializer; frozen `.mcp.json` keys)
- `CLAUDE.md` (root) - REGENERATED via `pnpm sync:agents`

**Implementation:**

- [ ] Extend the shipped-manifests collection the spec already builds; assert every collected
      name matches `/^@threenative\//u` or is in the exception list, and that the exception list
      equals the set of observed nonconformers (bidirectional — Phase 3 tightens this further).
- [ ] Write the "Package naming" section including the Phase-3 waivers verbatim from Decision 4.

**Wiring:**

- [ ] Caller edited: the spec runs in the default `pnpm test` chain — no new runner config
- [ ] Registration: n/a (vitest glob already collects `scripts/__tests__`)
- [ ] Old path: blessing regex at `primary-docs.spec.ts:66` narrowed in the same edit
- [ ] Ledger rows filled: [#1]

**Tests Required:**

| Test File | Test Name | Assertion | Negative control (must be observed red) |
|-----------|-----------|-----------|------------------------------------------|
| `scripts/__tests__/primary-docs.spec.ts` | `should scope every workspace package except the declared initializer exception` | every manifest name is `@threenative/*` or listed | red at HEAD: failure output names `threenative-engine-mcp` — paste before fixing |

**Revert check:** re-introducing any unscoped non-initializer name re-reds this test.

**User Verification:** `pnpm test -- primary-docs` prints exactly one named offender, not a count.

#### Phase 2: Rename threenative-engine-mcp - every live reference flips, the gate goes green

**Files (12, each a one-line mechanical edit; >5 because the rename is atomic):**

- `packages/engine-mcp/package.json` - EDIT: `name` → `@threenative/engine-mcp`, version 0.3.0;
  `bin` key unchanged
- `pnpm-lock.yaml` - REGENERATED via `pnpm install`
- `packages/create-threenative/templates/{minimal,defense,action-rpg,racing,shooter,platformer,starter}/package.json` - EDIT: devDep `threenative-engine-mcp` → `@threenative/engine-mcp` (asset/sculpt deps untouched — waived)
- `packages/create-threenative/src/index.ts` - EDIT: `:33` union member, `:281` comparison, `:458` flag mapping
- `packages/create-threenative/src/doctor.ts` - EDIT: `:168` fix message
- `scripts/check-budgets.ts` - EDIT: engine entry in the external-name list
- `scripts/verify-golden-path.ts` - EDIT: `:604`
- `scripts/visual-gate.ts` - EDIT: `:42`
- `README.md` - EDIT: Packages table row name
- `docs/architecture/AGENT-INTERFACE.md` - EDIT: package link/name
- `CHANGELOG.md` - EDIT: 0.3.0 entry, BREAKING rename
- `packages/engine-mcp/README.md` + affected specs (`scaffold.spec.ts`, `template.spec.ts`, `budgets.spec.ts`, `search.spec.ts`, `visual-gate.spec.ts`) - EDIT: name updates

**Implementation:**

- [ ] Grep first (`Incumbent census`): `grep -rn '"threenative-engine-mcp"' --include='*.ts' --include='*.json' --include='*.md' packages scripts README.md CHANGELOG.md docs/architecture docs/product | grep -v node_modules | grep -v '/dist/' | grep -v 'docs/PRDs/done' | grep -v 'docs/verification' | grep -v 'docs/benchmark'` — paste the hit list in the execution notes; every live hit flips, historical records (done PRDs, verification evidence, sweep snapshots) stay untouched.
- [ ] Registry follow-up recorded in the changelog entry: `npm deprecate threenative-engine-mcp "renamed to @threenative/engine-mcp"` using the local `.npmrc`, run at publish time.

**Wiring:**

- [ ] Caller edited: template devDeps + CLI mappings above are the live callers
- [ ] Registration: n/a — identity rename, no new registration point
- [ ] Old path: unscoped name gone from every live manifest/doc; bin preserved
- [ ] Ledger rows filled: [#2]

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|-----------|-----------|-----------|------------------|
| Phase 1 spec | same test, now green | zero nonconformers beyond `create-threenative` | revert `packages/engine-mcp/package.json` name → red again (observed at HEAD) |
| `packages/create-threenative/__tests__/scaffold.spec.ts` | scaffolded project declares the renamed devDep | generated package.json contains `@threenative/engine-mcp` | scaffolding with the old template state fails the assertion |

**Revert check:** `git revert` of the manifest name alone re-reds the Phase 1 spec — pre-existing gate breaks.

**User Verification:** fresh sandbox (`pnpm sandbox`), install, `npx threenative doctor --text` resolves the capability tools; `pnpm create threenative /tmp/law-check my-game` still scaffolds.

#### Phase 3: Every remaining deviation is a listed waiver - the map becomes the single source

**Files (4):**

- `scripts/__tests__/primary-docs.spec.ts` - EDIT: bidirectional waiver assertion — declared
  waivers (`threenative-asset-mcp`, `threenative-sculpt-mcp`, external owners pending scoped
  publishes) equal the set of actual off-law names found in manifests **and** in
  `MCP_PACKAGES`/template deps; a stray fourth scheme fails, and a name that conforms while
  still waived fails too
- `AGENTS.md` (root) - EDIT: waiver table (name · owner · unblock condition) under Package
  naming; `CLAUDE.md` regenerated
- `docs/architecture/AGENT-INTERFACE.md` - EDIT: one Mermaid-free table mapping server role →
  `.mcp.json` key → package → shim path → bin, replacing scattered prose
- `docs/product/ASSET-PIPELINE.md`, `docs/strategy/VALUE-PROPOSITION.md` - EDIT: prose aligned
  to the map's vocabulary where it names servers

**Implementation:**

- [ ] Waiver source of truth is the AGENTS.md table parsed by the spec (or a literal mirrored
  in the spec with a sync assertion — pick one owner, the other derives).

**Wiring:**

- [ ] Caller edited: the doc gate reads the waiver table every run
- [ ] Old path: the permissive three-scheme regex fully retired
- [ ] Ledger rows filled: [#3]

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|-----------|-----------|-----------|------------------|
| `scripts/__tests__/primary-docs.spec.ts` | `should list a waiver for every off-law name and only those` | sets equal, bidirectionally | add fake `foo-bar` manifest → red; rename asset-mcp in-place without touching the table → red |

**Revert check:** deleting the waiver table rows while `servers.mjs:33-34` still pins unscoped
names re-reds the suite.

**User Verification:** read `AGENTS.md` § Package naming top to bottom; every npm name you can
then find anywhere in the tree is predicted by it or sits in the waiver table.

## Acceptance criteria

Consumer-scoped; each checked with evidence or left open:

- [ ] A cold agent reading README, a template's AGENTS.md, and a generated `.mcp.json` predicts
      every ThreeNative npm name from one law; deviations exist only as listed waivers
- [ ] `pnpm create threenative my-game` scaffolds unchanged (scaffold-smoke green, output pasted)
- [ ] A fresh sandbox install resolves all three MCP servers; `npx threenative doctor --text` green
- [ ] `grep -rn '"threenative-engine-mcp"'` over live config returns only bin fields, the
      changelog, and historical records (done/, verification/, sweeps/) — hit list pasted
- [ ] Every ledger row filled with real non-test `file:line`; caller census pasted
- [ ] All negative controls observed red, recorded beside their passes
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green, output pasted

## Deliberately out of scope

- Renaming `threenative-asset-mcp` / `threenative-sculpt-mcp` themselves — owning repo's change;
  this PRD declares the targets and gates the pointers.
- Renaming example directories or `.mcp.json` keys — Decisions 5 and 6.
- Publishing alias shims for the old engine-mcp name — pre-1.0 hard break with a deprecation
  notice instead.
