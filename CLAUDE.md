<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — ThreeNative

Rules for any agent here; the closest nested `AGENTS.md` wins for its subtree. **Every `CLAUDE.md` is generated**: edit `AGENTS.md`, then run `pnpm sync:agents` (CI runs `--check`). Diagrams are Mermaid, never ASCII.

## What this is

One source, two runtimes: browser WebGPU and an owned C++ host for desktop/Android/iOS. Godot vocabulary, React/Tailwind UI, vanilla `three` underneath, MIT. Studio, the paid editor, is a private repo this one knows nothing about. **Agents write the games, humans only play them**: framework quality is friction per cold-agent build; a human grades the templates.
**Conventions ship on by default** (feet meet the floor, a weapon stays in the hand that holds it, an agent walks around a wall, one metre is one metre), each with a named override on the same object, honest reporting when overridden, and measurement that survives the override. A convention missing from the templates' `AGENTS.md` does not exist. **Auto by default**: if the engine can measure a value where it is used, it decides; a constant the author must revisit later is a bug.

## How you work

1. **Search the manifest before you write — by rule, not judgement.** Run `engine_search_capabilities`, then `engine_capability_detail` on every hit, before any new file under `src/` or `packages/`, any helper longer than a screen, and any render stage you toggle. Skipping it has shipped 446 hand-written lines of an installed system at 9 FPS. The manifest (`packages/create-threenative/capabilities.json`, rebuilt by `pnpm build`) is the only complete public surface, including subpath exports like `@threenative/physics/navigation`. Both tools ship in `threenative-engine-mcp`, wired by the `.mcp.json` that installing `@threenative/core` writes; launch from the game-project root or the server is missing.
   Then be lazy (the `ponytail` skill, re-injected by the project hooks; `PONYTAIL=off` opts out): YAGNI, installed system, stdlib/platform, one line. Never simplify away validation, error handling, security, accessibility or requested behaviour.
2. **Name the layer before fixing a bug**: engine (`packages/`) or game (example/template), and why. An engine bug fixed in game code leaves every other game broken.
3. **Red-green for behaviour changes and bugfixes**: reproduce, fix, rerun. No manufactured failures for planning or prose.
4. **Never claim a gate you did not run.** Report the actual result in the PRD, PR or response; "unverified" is acceptable.
5. **Keep the PRD current as you work.** Tick each box the moment its work is done and verified, with the result beside it, in the same commit as the change. Never tick unrun, partial or unverified work — leave it open and say why. Run `pnpm prd:progress <prd file>` before starting and after each phase; it prints the PR label and exits 1 when the PRD lacks per-phase boxes — fix that first. Filing rules: `docs/PRDs/AGENTS.md`; lifecycle: the `prd-lifecycle` skill.
6. **Surgical.** Touch only what the task needs; tidying is its own change. Ask when the request is ambiguous.
7. **Primary docs follow the executables.** README, `docs/architecture/` and package AGENTS files name only shipped commands and packages (`scripts/__tests__/primary-docs.spec.ts`); fix the prose, not the code.

## Pull requests

- **Small changes skip the PR**: a tiny fix, a docs-only edit, a mirror regeneration — anything with no PRD — commits directly to local `develop` after its relevant checks pass.
- **One PR per PRD**, opened as a draft at the first commit — never one per phase, never several PRDs in one PR. Label it with the `prd:25/50/75/100` that `pnpm prd:progress` prints and update the label as phases land.
- Branch from `origin/develop` (not a local branch that may be ahead of it), target `develop`, squash-merge. Set `git config threenative.integrationBranch develop` per checkout.
- The commit that finishes a PRD also `git mv`s it to `docs/PRDs/done/`.
- `main` takes only the ordinary full-checked `develop -> main` PR, merged with a merge commit, never squash or rebase.
- **Push once per run**: while your PR's CI runs, commit locally; push to fix that run or after it finishes. A PRD tick rides with the next code push, never alone.
- **No workflow file per feature**: add its CI proof as a job in an existing workflow.
- Before retargeting, inventory `gh pr list` and `pnpm worktree:status`; retarget in-flight PRs one at a time and never rewrite another worktree.

## Where a change goes

| Adding | Where |
| --- | --- |
| Anything that **decides how it looks** — materials, shaders, TSL, lights, tonemapping, post, framing — and any preset or default picking one | `templates/*/src/render/`, as generated user source |
| The **mechanism** that puts it on screen — pooling, lifetime, billboarding, instancing, dispatch, culling — with every appearance parameter from the game; plumbing every game repeats | `packages/core/src/` |
| Physics or navigation (WASM dep) · React HUD/menu bindings · C++ host, platform bring-up, native systems · scenario harness and assertions | `packages/physics/` · `ui/` · `runtime-native/` · `playtest/` |
| Gameplay, never in a package · proof that any of it works | an example or template · `<package>/__tests__/*.spec.ts` **and** a playtest scenario |

`examples/abyss-vanilla/` is a frozen control — do not edit. `docs/architecture/CHARTER.md` outranks this file; open it only when changing what the framework *is*, and quote its rule in plain words, not a section number.

## Rules that get a change rejected

1. **The two questions.** (a) Could the game write this portably itself? If not — it needs a browser global, a platform seam, or a backend it must not know about — the framework owns it, at any size. (b) Does it decide how anything looks? Then it ships as generated source in `src/render/`, at any size. (b) vetoes (a).
2. **Kill switch.** An abstraction costing more code than plain Three.js is deleted; `scripts/count-loc.ts` scores every repetition.
3. **Never own the look.** Geometry, material, colour, texture, curve and timing come from the game; it must be able to change the appearance completely without editing package code. `GPUParticles3D` is the shape.
4. **Borrow vocabulary**: Godot for nodes (the only node source), Three.js for rendering, Rapier for physics, Tailwind for UI, in camelCase. **A package exists only when it carries a dependency the others must not inherit.**
5. **Closed, outranking rule 1**: an IR, a scene format, an editor, a preset/genre system, a code-first ECS, a bespoke CLI vocabulary. **Web-only is unfinished**: a helper admitted for being unportable ships native proof (a conformance case or a `--target` playtest) in the same commit, and no result claims a platform it did not run on. Contract: `packages/runtime-native/AGENTS.md`.

## Commands

```sh
pnpm typecheck && pnpm lint && pnpm test   # executable, config, generated-contract or unknown changes
pnpm check:docs && pnpm exec vitest run scripts/__tests__/check-doc-links.spec.ts scripts/__tests__/evidence-budget.spec.ts scripts/__tests__/evidence-citations.spec.ts scripts/__tests__/sync-agent-docs.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts  # prose-only lane
pnpm test:playtest                         # playtests against the in-repo example fixture
pnpm test:templates                        # playtests against each scaffolded template
pnpm budgets                               # hard invariants fail; LOC triggers only report
pnpm quality                               # file length, suppressions, lint holes; never fatal
pnpm sync:agents                           # regenerate CLAUDE.md mirrors
pnpm prd:progress <prd file>               # PRD boxes -> prd:25/50/75/100 label; exit 1 = no phase boxes
pnpm release:prepare                       # bump, build, preflight the release cohort
pnpm --filter <example> dev                # there is no root `pnpm dev`

# a gate fails for a non-game reason (no browser, blank screenshot, silent device): ask first
node packages/playtest/dist/runner/cli.js doctor --text
node packages/playtest/dist/runner/cli.js doctor --url <url> --text        # + the scene
node packages/playtest/dist/runner/cli.js doctor --device <serial> --text  # + device thermals
npx threenative doctor --text              # inside a generated project

# prove one game (flags, targets, exit codes: packages/playtest/AGENTS.md; brings its own Xvfb)
pnpm --filter @threenative/playtest build
node packages/playtest/dist/runner/cli.js <scenario>.playtest.json \
  --url http://127.0.0.1:5173 --server-command "<workspace dev command>" --browser-recipe webgpu

pnpm native:build                          # opt-in; downloads deps, compiles the C++ host
pnpm native:verify:desktop                 # 300 native frames + a non-blank screenshot
```

**CI.** The pre-push hook runs `pnpm ci:fast` drift checks only; it proves no runtime behaviour. `pnpm ci:local --full` runs the full board; `pnpm ci:local --affected --base origin/develop --target develop` runs what CI would select (dirty or unknown inputs fall back to full). A change touching only Markdown that no fixture consumes (not `AGENTS.md`/`CLAUDE.md`) runs no product CI job. Ordinary PRs into develop use the complete candidate diff: CI-only changes run CI contracts, exact template changes run scaffolder contracts and affected templates, and shared executable inputs keep the full safety board with starter as the default template smoke plus explicitly changed runtime/scenario kits. Template instruction and Markdown changes retain their contract lanes without adding runtime kits. Merge groups run the same selected gating board as the PR, so a change merges within 30 minutes (PRD-550). Develop pushes, explicit full runs, unknown inputs, main qualification and scheduled audits use fresh exhaustive qualification: all shipped templates, both golden journeys and the full supported native matrix. `ci-required` independently rejects a review plan for these events; Integration is a required reusable join on the same candidate, with each selected canonical job proven by a current-run/attempt receipt and independently checked completed-success API job; missing, skipped, cancelled, stale or unmapped receipts fail closed. Native per-leg authoritative completion and cold-path queue feasibility remain follow-ups before deferring any Android PR coverage. Template scenarios run once per selected kit; develop changes run one representative golden journey and full qualification retains both starter and platformer journeys. `ci-required` rejects missing or failed selected checks; retained contexts include `supply-chain`, `template-nonvisual`, `golden-path`, and native `desktop-parity` when applicable. Native host/platform tests run for native or shared runtime consumers, main qualification and unresolved scopes. Unsafe matrix/reusable verdict reuse stays disabled until authoritative complete coverage and per-leg routing exist. A new candidate runs fresh tests; only exact-run immutable build artifacts are shared. Details: `docs/PRDs/done/PRD-483-impact-driven-ci-without-repeated-template-setup.md` and `docs/PRDs/done/PRD-373-selective-ci-and-develop-promotion.md`.
Registry commands read auth from `~/.npmrc`; pass a checkout-local untracked `.npmrc` with `npm --userconfig .npmrc <command>`. Never print either file.

TypeScript 7 `strict` (the native `tsc`); `typescript` imports use the official TypeScript 6 compatibility API for AST scripts and tsup declarations, **ESM only**; relative imports end in `.js`. Versions come from the `catalog:` in `pnpm-workspace.yaml`, templates excepted. Biome formats — never hand-format. Interfaces are `I`-prefixed; classes and type aliases are not. Unit tests: `<package>/__tests__/*.spec.ts`, vitest, node environment, DOM and GPU stubbed.

**Existing harnesses — use them, don't rebuild them.** Capability lookup: `capabilities.json`, `packages/engine-mcp`. Behaviour on browser/Android/desktop/iOS: `packages/playtest --target <platform>`. User-like install and agent-friction arms: `pnpm sandbox`, `pnpm sweep:capture|judge|pair`, `scripts/score-blind.ts`. Visual baselines and LOC vs plain Three.js: `pnpm visuals`, `visuals:ab`, `visuals:baseline`, `pnpm tsx scripts/count-loc.ts`. Web-vs-native, profiling, frame meters: `pnpm parity` (`packages/runtime-native/conformance/registry.json`), `profile:native-cpu`, `bench:engines`, playtest `perf --file|--executable|--logcat`. What to verify next: `pnpm round:next`, `round:deletions`, `alpha:bar`.

## Verification

Results go in the existing PRD, PR or response; a separate evidence file only when the user asks or a workflow consumes it. Prose edits need only the doc checks and mirror regeneration — no implementation checkpoints or artificial negative controls.

**Fail closed**: malformed input throws, a missing observation fails, an empty assertion set fails. `pnpm test` proves units; **a playtest scenario proves the game** — every runtime-behaviour change gets one, rerun on each later change to that behaviour.
**Nearest lane first, CI last.** A CI round trip costs over an hour; prove it locally (unit test, playtest, emulator, attached device) and push once green. While `TN_RUNNER` is set, run only the focused checks for what you changed and push: the full board runs once, on `tn-local`. **Prefer an emulator over hardware** when it can hold the claim; a stopped emulator means start it, not "blocked". Never call `xvfb-run` (its exit status is its own cleanup kill; `sh scripts/xvfb.sh <cmd>` is the wrapper). An unnamed WebGPU adapter may be SwiftShader: pass `--browser-recipe webgpu` and check `adapter.info`. Free a port with `lsof -ti tcp:<port> | xargs -r kill`; `pkill -f vite` kills your own shell.
Long gates write `artifacts/gates/status.json`: read it with `pnpm gate:status`, probe a stale phase with `pnpm gate:doctor`; `pnpm gate:resume` continues only while worktree, branch, HEAD, lease and artifact still match. None of them repair or remove a worktree.

## Working outside the repo

`pnpm sandbox` builds a user-like machine: tarball installs, no workspace, no `AGENTS.md` chain. Sandbox games live outside this repo, one per folder; engine fixes go into `packages/` and are reinstalled, never patched into the copy. Device lanes: `packages/runtime-native/AGENTS.md`; PRD filing and round ledger: `docs/PRDs/AGENTS.md`. Other agents share this tree — commit as you go, or uncommitted edits get overwritten.
`.worktrees/` and `.claude/worktrees/` hold other agents' lanes, so never search them and never read their AGENTS.md. Generated sweep arm sources and scaffold instruction files are untracked; their benchmark records (`proof.json`, `proof-artifacts/`, captures) stay tracked. A tracked `.ignore` hides `docs/PRDs/done/` and the `CLAUDE.md` mirrors from default search only; reach them with `rg --no-ignore <pattern>` or by naming the directory.
