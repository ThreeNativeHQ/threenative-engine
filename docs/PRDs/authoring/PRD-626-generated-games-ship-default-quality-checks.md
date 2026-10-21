# PRD-626 — Generated games ship default quality checks

**Status:** PROPOSED
**Priority:** P2 — AC-1–3 add a default authoring gate that catches code mistakes before generated games accumulate them.
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers / implementing agent
**Depends on:** None
**Progress:** 0%

Proposal only. No lint configuration, rule, dependency, template or CI change is implemented by
this document. All implementation and acceptance evidence below is pending.

## Context and current behavior

Inspected against `origin/develop` at `d27bad825` on 2026-10-17:

| Boundary | Shipped behavior / gap |
|---|---|
| `packages/create-threenative/src/index.ts:721–767` | `createProject` copies a selected template, shared agent files and patches, substitutes project values and checks reference/config bundles. Defaults must reach this path, not only repository developers. |
| `packages/create-threenative/templates/starter/package.json` | Ships `typecheck` (`tsc --noEmit -p tsconfig.json`), target builds, browser `test` and `test:native`; no `lint` or aggregate static `check`. `pretest` installs Chromium. A cheap source gate must not launch a browser. |
| `templates/starter/tsconfig.json` | Already strict, with unchecked-index checks and TSX. Preserve it; typechecking is not a substitute for Promise-use or hook diagnostics. Its manifest pins TypeScript `7.0.2`; that is a repository value, not a claim about the latest compiler. |
| Root `package.json`, `biome.json`, `scripts/check-quality.ts` | Engine contributors have Biome and report-only repository quality checks. Generated projects do not inherit the root config or executable. Repository ignores/thresholds are not suitable game defaults. |
| `scripts/template-quality.ts`, `__tests__/template-quality.spec.ts` | Existing template quality checks protect render-tier wiring, costs and shared contracts, not arbitrary game-code lint. Do not apply their prescribed template shape to an author's rewritten render code. |
| `scripts/detect-capability-duplicates.ts:259–288,388–440` | Existing manifest-driven detector and justified `engine-override` convention; root `budgets` scans examples. This is not a shipped generated-project linter. Do not duplicate it. |
| `packages/create-threenative/src/doctor.ts:1026–1081`, `src/build.ts` | Doctor repeats recorded `TN_SCENE_WARNING`; build owns target/asset/native-CSS validation. Static lint must not report an unmeasured frame rate, reimplement target support or launch doctor on every edit. |
| `__tests__/template-runtime-cost.spec.ts`, `__tests__/rts-runtime-cost.spec.ts`, `__tests__/world-environment-lifetime.spec.ts` | Existing runtime allocation/lifetime regression subjects. Keep their observations; syntax diagnostics cannot replace them. |
| `.github/workflows/ci.yml` `template-nonvisual`, `golden-path`; `scripts/verify-golden-path.ts` | Existing packed-package scaffold/install/typecheck/build/game paths. Add cheap checks here rather than another workflow, package manager or scaffold test tree. |

Paths abbreviated to `templates/`, `src/` or `__tests__/` above are under
`packages/create-threenative/` unless a root prefix is present.

### Overlap and scope ownership

- [PRD-449 scaffold minimalism](PRD-449-scaffold-ships-only-what-a-new-game-needs.md)
  already removed copied references and engine-only scenarios. Preserve those cuts: one small
  lint config and one small formatter config at most; rules and recipes live in the installed package.
- [PRD-326 regression proof](../tech-debt-code-quality/PRD-326-high-churn-paths-fail-before-regressions-ship.md)
  owns live engine-path regressions. This PRD owns the generated consumer's default static gate;
  it adds no frame collector, startup policy or native conformance mechanism.
- [PRD-355 reinvention delivery](PRD-355-the-reinvention-gate-sees-one-capability-in-fifty.md)
  owns shipping/widening that detector; [PRD-356 scoring](PRD-356-reinvention-is-a-scored-row-in-the-paired-sweep.md)
  owns paired-sweep attribution. Neither becomes a dependency: this PRD does **not** deliver
  their unshipped scanner, widen supersessions or implement a second manifest scanner.
- [PRD-298 capability search](PRD-298-capability-search-fails-closed.md) and
  [PRD-324 export coverage](PRD-324-the-capability-manifest-cannot-forget-an-export.md)
  remain authoritative for discovery. Keep first-use capability search in generated instructions.

Tracked PRDs, including `done/` and `BLOCKED/`, primary PRD filenames, branch names and open PRs
were inspected before allocating 626; 624 is the ocean draft and 625 is referenced by PR #503.
Recheck allocation before committing because other agents may reserve IDs concurrently.

## Decision: standard tools first, one bounded engine-specific warning

**Complexity: 5 → MEDIUM; risk override: none.** Estimate 11+ non-test implementation/config
files across template variants (+3), and one new shipped lint configuration/rule module (+2).
There is no independent release boundary, state machine, schema or external service. Changing
several template directories is not itself a release boundary. One substantive independent review
of the implemented consumer contract is appropriate; no owner acceptance gate is required.

Use **ESLint flat config** for correctness and React hooks, **typescript-eslint** for TypeScript
rules and typed Promise diagnostics, and **Biome for formatting only**. This reuses ecosystem
parsers, severities, rule IDs, ignores, disable comments and fix machinery. Do not turn on two
linters for the same source or layer style/complexity rules into the correctness gate. No new
standalone quality package or bespoke `threenative` command. Prefer a lightweight, side-effect-free
`create-threenative/quality` config export, containing at most the bounded custom warning below;
importing it must not load scaffold/build, asset encoders, Blender or native code.

Compatibility is a real design constraint, not an implementation assumption:
[typescript-eslint's supported dependency ranges](https://typescript-eslint.io/users/dependency-versions/)
retrieved during planning list TypeScript `<6.1.0`, whereas the scaffold pins 7.0.2. Phase 1 must
resolve and exercise a supported analyzer/compiler pairing before enabling typed rules. A
lint-only compatible compiler may be isolated in the installed tooling scope, as this repository
already uses a TypeScript compatibility API for AST tools, **only if package-manager resolution,
TSX, declarations and actual game syntax are demonstrated in the packed consumer**. Do not
silence an unsupported-version warning, downgrade the game's compiler, promise TS7 compatibility
from parsing alone, or silently skip typed rules. If no supported arrangement works without a
new release boundary, revise this proposal explicitly before implementation proceeds.

Primary design references: [ESLint shareable configs](https://eslint.org/docs/latest/extend/shareable-configs),
[flat configuration](https://eslint.org/docs/latest/use/configure/configuration-files),
[no-floating-promises](https://typescript-eslint.io/rules/no-floating-promises) and
[no-misused-promises](https://typescript-eslint.io/rules/no-misused-promises).
Select exact compatible tool versions during implementation and pin them consistently; this PRD
names no newly recommended version as current.

### Consumer contract and command disposition

`pnpm create threenative my-game` → existing `createProject` → thin generated configs plus explicit
local devDependencies → author edits TS/TSX → proposed `pnpm check` → typecheck, ESLint and Biome
check → actionable file/line/rule diagnostics and a nonzero result for errors or tool failures.

| Surface | Current | Proposed behavior, not shipped |
|---|---|---|
| Generated `pnpm typecheck` | Shipped | Unchanged strict game compiler. |
| Generated `pnpm lint` | Absent | ESLint over authored `src/**/*.ts` and `src/**/*.tsx`; no writes. Errors fail, warnings report without failing. |
| Generated `pnpm format:check` | Absent | Biome formatter check only; formatting drift fails this check, separately identified from correctness. |
| Generated `pnpm check` | Absent | `pnpm typecheck && pnpm lint && pnpm format:check`; no network, browser, GPU, SDK, cook or asset download after installation. |
| Generated `pnpm test` | Existing browser/game proof | Prefix existing test execution with `pnpm check`; retain `pretest`, browser recipe and scenarios. Do not replace game tests with lint. |
| Generated target `build*` scripts / `threenative build` | Shipped | Remain usable independently; no hidden lint step or new CLI grammar. Release/CI instructions explicitly run `pnpm check` before build. |
| Generated `pnpm test:native` | Shipped | Keep existing runtime proof; static checks remain target-independent and separately invocable. |
| `threenative doctor` | Shipped | No new scanner here; retain environment/recorded-performance diagnosis and link its existing use in remediation guidance. |

Scripts must use local tools, never `npx` auto-downloads. These are package scripts, not new
`threenative` subcommands. Do not install machine-wide hooks or require an editor/MCP session.

### Severity, supported source and rule budget

Use a **small explicit rule set**, not moving `all`, `strict` or stylistic presets. Disable duplicate
core rules where TypeScript-aware replacements apply. Default behavior is identical locally and
in CI; do not apply blanket `--max-warnings 0` to heuristic findings.

| Family | Default and bounded behavior | Consumer example / limit |
|---|---|---|
| Basic correctness | Error: undefined names where the compiler does not own them, unreachable code, duplicate keys, debugger; TS-aware unused bindings/imports. Permit deliberately unused parameters named `_...`, not arbitrary unused locals. | An unused imported constructor fails with a rule/location; type-only imports and intentionally unused interface callback parameters do not manufacture errors. |
| Async misuse | Error: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`; use `ignoreVoid: false` so bare `void task()` is not presented as rejection handling. | `ctx.assets.model(...)` discarded in a typed fixture fails; awaited/returned Promise and explicit `.catch(handler)` pass. Async callbacks supplied to synchronous lifecycle contracts fail; valid async load hooks pass. Unknown/any types are a documented coverage limit, not guaranteed detection. |
| React hooks | Error: standard `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps`, applied only to TSX/UI where React is installed. | Conditional hooks and a missing captured dependency fail; a valid ref/effect cleanup passes. `minimal` must neither install React nor resolve a React-only plugin unconditionally. No React Three Fiber-specific rules for vanilla Three.js. |
| Hot callback allocation | Warning: at most one new ESLint rule for directly evident allocation in known frame callbacks. | Import-resolved Three.js math constructors (`Vector2`, `Vector3`, `Quaternion`, `Matrix4`) directly inside `Scene.update`, `Scene.render` or a directly registered `ctx.beforeRender` callback warn. Recognize imported aliases/namespaces; do not flag unrelated same-named classes. Explain reuse/measurement, not “this leaks” or “FPS will improve”. |
| Lifetime and portability | Existing runtime/build checks plus concise installed guidance, not a new static ownership/target engine. | Resource disposal, event/subscription/timer teardown and async cancellation require an explicit owner; borrowed/shared assets must not be blindly disposed. Target build validators retain their existing severity. |

The custom warning is deliberately syntactic: no interprocedural call graph, inference that every
`update` method is hot, detection of all `.clone()`/array allocations, resource-leak proof, or ban
on one-time loading allocations. Recognize a scene through its imported base/type or the actual
scene registration shape; include positive and non-scene counterexamples. A callback hidden in an
unresolved helper is outside coverage, not green evidence that it allocates nothing. Warn on the
recognized directly executed body, excluding deferred nested function declarations. Startup/load,
constructor/enter, dispose and one-off asset processing remain valid. No automatic hoisting fix:
shared scratch state can break reentrancy or ownership.

Keep `src/render/**` fully editable vanilla Three.js, with no `@threenative/*` imports introduced
by this work. The linter may inspect it, never prescribe materials, lighting, resolution or stage
budgets. Distinguish portable `src/game.ts` and game logic from permitted browser bootstrap/UI:
`window`/DOM in `src/main.ts` or React UI is not automatically a portability error. Reuse existing
native build validation for reachable game code; blanket DOM bans and a second dependency-graph
walker are outside scope. Tooling runs on the host Node process, never in the owned C++ runtime.

### Suppressions, fixes and operational cost

- Scoped `eslint-disable-next-line <rule> -- <specific reason>` is the normal escape hatch. Enable
  ESLint's unused-disable reporting as an error and require descriptions using an established
  ecosystem directive-comment rule, not another comment parser. No generated file-wide disables,
  `src/render` ignores, empty reasons or default “disable everything” switch. Existing
  `engine-override: <reason>` remains the reinvention detector's contract, not an alias for ESLint.
- Local config overrides stay possible and visible; lint is authoring assistance, not a security
  boundary. A deliberate project policy change must be documented rather than disguised as a pass
  under the original defaults. Tool/config/type-program failures and zero matched source files
  fail nonzero with a useful remediation, never silently skip.
- `check`, `lint` and tests are read-only with respect to authored files. Optional direct ecosystem
  fix commands are documented separately: safe formatting only by default; no unsafe fixes,
  automatic disposal, Promise swallowing, hook-dependency insertion or lifetime-changing hoists.
- Ignore dependencies, build/cook/cache output, patches and vendored asset output; do not ignore
  authored TS/TSX or silently add a broad baseline of suppressions. Pristine templates must pass
  error and formatting checks; any existing advisory needs a narrow reason, not mass disabling.
- Add at most two root config files and 80 nonblank config/script lines to each generated project;
  no generated plugin source, fixture corpus, CI workflow, lockfile template or reference copy.
  Extend the installed reference bundle for recipes. Keep template AGENTS under 100 lines and
  regenerate mirrors only when implementation changes their instructions.
- Phase 3 records cold/warm `pnpm check` duration and installed dependency delta on the same
  pristine starter and minimal candidates versus baseline (same Node, manager and lock state).
  Proposed usability budget: each no-cache static check completes within 15 seconds on the
  existing Linux CI runner after install; warm repeat within 10 seconds. Investigate or revise
  the budget explicitly if missed, never drop typed checks to hit it. This is tool latency, not
  a game performance claim; no new benchmark collector is needed.

## Acceptance Criteria

- [ ] AC-1 [local; actor: implementing agent]: A tarball-scaffolded starter rejects a seeded typed async mistake through its own proposed `pnpm check`, naming file, rule and nonzero exit, then passes after repair without rewriting source. proof: extend `packages/create-threenative/__tests__/scaffold.spec.ts` consumer process integration and run `pnpm exec vitest run packages/create-threenative/__tests__/scaffold.spec.ts` after build/pack prerequisites — Evidence: pending.
- [ ] AC-2 [local; actor: implementing agent]: A representative generated project's actual ESLint invocation reports the hot-callback fixture as advisory and exits successfully with no errors; its initialization/non-scene counterexamples report no hot-callback finding. proof: proposed collected `packages/create-threenative/__tests__/authoring-quality.spec.ts`, run with `pnpm exec vitest run packages/create-threenative/__tests__/authoring-quality.spec.ts` — Evidence: pending.
- [ ] AC-3 [shared; actor: PR author triggers existing GitHub Actions `ci.yml`]: Every shipped template's packed consumer executes the proposed static gate with installed dependencies, with pristine sources passing. proof: extend existing `template-nonvisual` scaffold/install/typecheck step to call `pnpm check`; exhaustive template matrix on a full qualification run, attach matching run URL and per-template results — Evidence: pending. Selected-template PR runs alone cannot close this all-template claim.

## Integration Ledger

| Capability | Reachable consumer / owning entry | Replaces / disposition | Proof |
|---|---|---|---|
| Default source-quality gate | `createProject` (`src/index.ts:721`) → generated manifests/configs → proposed `pnpm check` | Fills missing generated lint/format path; strict typecheck stays. Proposed `create-threenative/quality` export must be built and packed, not a source-tree deep import. | Phase 1, AC-1 |
| Actionable diagnostics | Generated ESLint config → ecosystem rules plus one bounded callback warning | No parallel validator framework; existing capability, doctor, build and measured allocation/lifetime paths retain ownership. | Phase 2, AC-2 |
| Gate used before game tests / CI builds | Generated `test` → check → existing runner; `.github/workflows/ci.yml` `template-nonvisual` and `golden-path` → packed project scripts | Replace the existing CI typecheck-only step with aggregate check without running typecheck twice; retain runtime/scenario proof and CI selection. | Phase 3, AC-3 |

## Execution Phases

### Phase 1: A generated project has an executable ecosystem gate

**Status:** NOT STARTED
**Files:** `packages/create-threenative/package.json`, `tsup.config.ts`, proposed lightweight
quality config export; `templates/*/package.json` and thin configs;
`__tests__/scaffold.spec.ts` and existing publication/build specs.
**Implementation:** Establish supported Node/compiler/parser/plugin resolution first, then ship
explicit devDependencies and the source/ignore scopes above. Keep React optional by template;
include `minimal`, `starter` and a representative non-physics kit in consumer fixtures. No
`catalog:`, `workspace:`, absolute worktree paths or undeclared transitive tool dependencies in
rendered manifests/config imports. Extend existing `STARTER_PATHS` for added config files.

- [ ] P1.1 [local; actor: implementing agent]: Packed consumers resolve the proposed quality export and required ecosystem binaries using a supported analyzer/compiler pairing. proof: extend `__tests__/publication.spec.ts`, `__tests__/build.spec.ts`, `__tests__/scaffold.spec.ts`; run `pnpm exec vitest run packages/create-threenative/__tests__/publication.spec.ts packages/create-threenative/__tests__/build.spec.ts packages/create-threenative/__tests__/scaffold.spec.ts` after build — Evidence: pending.
- [ ] P1.2 [local; actor: implementing agent]: The generated aggregate static gate enforces the declared error/format policy independently of browser and native tooling. proof: AC-1's process harness additionally covers missing config/tool, zero matched source, unused binding, formatting drift, valid TSX/type-only imports and minimal without React — Evidence: pending.

### Phase 2: Bounded diagnostics give safe remediation

**Status:** NOT STARTED
**Files:** proposed installed quality rule/config module, proposed collected
`__tests__/authoring-quality.spec.ts`, installed `agent-docs/references/performance-basics.md`,
existing template instruction lines and mirrors as needed.
**Implementation:** Use ecosystem async/hook/directive checks; add only the bounded ESLint callback
warning. Lifecycle guidance points to existing runtime observations and resource-owner teardown.
No copied template-specific render-tier policy, custom scanner, default mass suppressions or unsafe
fixer. Consumer tests run the public config, not only ESLint RuleTester against a private helper.

- [ ] P2.1 [local; actor: implementing agent]: The installed default config enforces the declared diagnostic and scoped-suppression policy on representative TS/TSX game edits. proof: proposed `pnpm exec vitest run packages/create-threenative/__tests__/authoring-quality.spec.ts` covers AC-2 plus Promise/React pairs, alias/namespace math imports, lifecycle exclusions, empty/unused suppressions and unchanged authored bytes — Evidence: pending.

### Phase 3: The packed path runs the gate by default without scaffold bloat

**Status:** NOT STARTED
**Files:** generated `test` scripts and concise instructions; existing
`.github/workflows/ci.yml`, `scripts/verify-golden-path.ts`, existing scaffold/publication tests,
`__tests__/template-runtime-cost.spec.ts`, `__tests__/world-environment-lifetime.spec.ts` as needed.
**Implementation:** Connect the existing test and CI consumer paths only after Phase 1. Reuse
existing scaffold-from-tarballs and template enumeration. After online dependency acquisition,
run static checks network-denied from a standalone packed install outside the workspace, with no
parent `node_modules`; do not promise an empty package cache can install offline. Missing native
SDK/GPU/browser must not block static checks. A supported host runs the tooling; unsupported game
targets continue to fail their owning build validator. No new workflow or target-qualification claim.

- [ ] P3.1 [local; actor: implementing agent]: Standalone packed consumer checks require no network or workspace fallback after dependencies are installed. proof: extend the existing packed scaffold harness behind `__tests__/scaffold.spec.ts` to invoke check under network denial, assert file/line limits and record latency/dependency delta for starter/minimal; run the Phase 1 focused command — Evidence: pending.
- [ ] P3.2 [shared; actor: PR author triggers existing GitHub Actions `ci.yml`]: The aggregate gate is reached before existing generated game-test/build CI flows without replacing measured game regression evidence. proof: `template-nonvisual` for AC-3 plus existing `golden-path` packed consumer run; focused `ci-structure.spec.ts` asserts caller order, while existing template allocation/lifetime specs retain their observations — Evidence: pending.

## Rollout and remaining risks

Only new scaffolds adopt the defaults. Existing games opt in by installing the compatible pinned
tooling and copying the two thin configs/scripts from the installed recipe; never overwrite their
render code or install hooks automatically. A config dependency update is observable policy change
and reruns the packed matrix. Rollback removes the new scripts/config imports/dependencies while
retaining existing typecheck, builds and game tests; no runtime state migration is involved.

The unsupported TS7/analyzer pairing is the leading implementation risk and gates Phase 1.
Default lint adds install size and latency; measurements must report both, including minimal's
React-free result. Hook/async rules can expose legitimate existing template defects: repair the
owning code narrowly, do not relax checks globally. Any repair that changes runtime behavior
requires its own collected game proof under repository rules; this planning PR authorizes none.
Static hot-path warnings miss indirect allocations and cannot prove resource cleanup, absence of
leaks, FPS, GPU cost or native portability. Continue using existing playtests, allocation/lifetime
subjects, `TN_FRAME_BUDGET`, `TN_SCENE_WARNING`, doctor and target builds for those claims.
Native hardware qualification and artistic/performance tuning are not scope or closure gates here.
