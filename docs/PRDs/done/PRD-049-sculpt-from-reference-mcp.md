---
prd_contract: v1
---

# PRD-049 — Sculpt from reference: the scaffold hands the agent an image → `src/render/` tool

**Status:** **SHIPPED — owner accepted the recorded release evidence and directed closure
(2026-08-09).** `threenative-sculpt-mcp@0.1.0` is public on npm and its source is public at
`github.com/ThreeNativeHQ/threenative-sculpt-mcp`. All three starters install and launch it beside
the asset MCP; the generated docs route conventional assets, trivial geometry, bespoke objects,
landmarks, scenery, and environment set pieces to the correct path. A brand-new generated
starter installed both servers from npm, returned exactly five sculpt tools plus 31
technique-safe resources, typechecked, and built. The preserved A/B frames were accepted as
sufficient for closure; no directional human preference or per-arm token telemetry was supplied,
so this PRD records those measurements as unavailable rather than inventing them.

**Complexity: 6 → MEDIUM mode** (new mechanism from scratch — a second MCP server and its
recorded surface +2, touches 10+ files +3, external fork with its own license lane +1).

**Depends on:** PRD-032 (shipped) — this reuses its `.mcp.json`, pin, doc-test and
externality machinery wholesale, and is not worth attempting without it.
**Blocks:** nothing.

**Charter authority:** `CHARTER.md` §2 (models are worst at discovering novel API surfaces —
the reason the surface below is 5 tools and not 40), §5b (never own the look), §8 (an
external server on its own release lane is salvage, not a package), §9b (the scaffold is the
documentation), §10 (framework LOC trigger, template LOC hard cap).
`AGENTS.md` rules 1 (20-line rule), 3 (never own the look), 4 (borrowed vocabulary),
5 (a package exists only when it carries a dependency the others must not inherit), 6.

---

## 1. Context

### The gap is named in our own generated docs

`templates/starter/AGENTS.md:157` tells the agent, in bold: *"Anything specific to this game
— write it in `src/render/`."* Then it stops. That sentence is the entire guidance a model
gets for the hardest authoring task in the project, and the failure it is warning about —
"a downloaded model standing in for a bespoke design reads as a weird asset dropped into the
scene" — is only avoided by the agent hand-writing procedural geometry it has no reference
for.

PRD-032 solved *conventional*: a crate, a barrel, an HDRI, a click sound. It deliberately
did not solve *bespoke*, and said so. This PRD is the other half of that sentence.

### What img2threejs is, and why it lands exactly here

`github.com/img2threejs/img2threejs`, Apache-2.0. It converts a single reference image into
**procedural Three.js source** — not a mesh, not photogrammetry. Its output is an
`ObjectSculptSpec` JSON plus a TypeScript factory returning a `THREE.Group`, produced through
eight staged passes (blockout → structural → form → material → surface → lighting → interaction
→ optimization) where each pass renders, compares against the reference, and self-corrects.

That output artifact **is** a `src/render/` file. Not something we adapt into one.

This is the rare case where rule 3 argues *for* adoption rather than against it. "Never own
the look" forbids the framework shipping materials, shaders and lighting as package code. A
tool that writes those things as source into the user's `src/render/`, where the user then
owns and edits them, is the same shape as the template generator we already ship — and it is
the shape §5b explicitly blesses.

### What the repo actually contains, measured before committing to anything

Read off the tree, not the README:

| Area | Reality |
|---|---|
| `SKILL.md` | 48 KB of model instructions |
| `grimoire/` | ~40 markdown files, ~280 KB — geometry patterns, material reference, self-correction, review gates. **This is where the value density is** |
| `forge/` | 5 stages of Python, 80+ tests. `_shared/spec_search.py` alone is 63 KB; one `stage3_build` file is 164 KB |
| `integrations/vision/` | `pyproject.toml` + a 163 KB `uv.lock`. **The README's "no dependencies, stdlib only" claim does not survive contact with the tree** |
| `scripts/capture_threejs_playwright.py` | Its own Playwright capture harness |
| Invocation | A Claude Code skill (`/img2threejs`), not an MCP server |

Two consequences that shape everything below. **First: most of the value is prose, not code.**
MCP has a `resources` primitive for exactly that, and a `prompts` primitive for the pass loop.
A fork that serves the grimoire as resources and the gates as tools keeps the valuable 90% and
drops the mass. **Second: it already has a Playwright capture loop, and so do we.** Shipping a
second one into every generated project is the thing this PRD must not do.

---

## 2. Solution

Fork img2threejs into a **separate repository**, publish it to npm as
`threenative-sculpt-mcp`, pin it in every template's `package.json`, and add it as a second
server in the `.mcp.json` PRD-032 already writes. Zero packages, zero framework LOC, and the
agent's authoring flow gains one branch it does not have today.

### It is a fork in the license sense and a rewrite in the code sense

State this plainly rather than discovering it in Phase 2. The fork keeps:

- **`grimoire/` verbatim in the source and npm distribution.** The MCP resource catalog serves
  the 31 technique-safe entries and rejects three pages containing paste-ready shader/material
  recipes. This preserves the licensed payload without handing the model a game-owned look.
- **The pass ordering and the gate thresholds** — the sequencing knowledge.
- **The procedural `ObjectSculptSpec` contract**, represented by a documented MCP runtime JSON
  Schema. Upstream does not ship a standalone schema, so the new file is not described as one.
- **The comparison math** — `_shared/color_metrics.py`, `image_hash.py`, `jpeg.py`
  (~24 KB total), ported to TypeScript.

The fork drops the stage1–stage3 codegen Python entirely. **In ThreeNative the model writes
`src/render/`** — that is rule 3 and it is not negotiable for a tool either. Keeping upstream's
generator would put a second author in that directory.

Result: a pure-Node server with no Python on the user's machine. That is the load-bearing
reason for the rewrite, not tidiness — a Python + `uv` + Playwright toolchain as a transitive
requirement of `pnpm create threenative` is a scaffold that fails on most machines.

### The tool surface — 5 tools

`CHARTER.md` §2 calls a novel API surface the founding constraint, and PRD-032 had to eat 32
tool schemas per turn because the bounded profile was unpublished. This one ships bounded from
the first release, and the fork is ours, so there is no upstream to wait on.

| Tool | Does | Fails closed on |
|---|---|---|
| `sculpt_plan` | Takes a reference image path + a one-line intent. Returns the ordered pass list and the grimoire resource URIs relevant to this subject | an unreadable image path → error, never an empty plan |
| `sculpt_spec_gate` | Validates an `ObjectSculptSpec` against the depth thresholds before any code is written | a spec missing required regions → **error naming the region**, not a warning |
| `sculpt_compare` | Perceptual delta between a captured frame and the reference, per region, with a confidence figure | a missing or zero-byte capture → error. A comparison that cannot run is never a pass |
| `sculpt_pass_gate` | Given a compare result, returns advance / retry-with-this-correction / stop | ambiguity → retry, never advance |
| `sculpt_grimoire` | Fetches a grimoire page by topic (also exposed as MCP resources for hosts that list them) | unknown topic → error listing valid topics |

There is no `sculpt_generate`. The model writes the code; these five tell it what to write
next and whether it worked.

### Capture is `@threenative/playtest`, not a second Playwright

`sculpt_compare` takes a **path to an already-captured frame**. It never launches a browser.
The generated project already has playtest's screenshot path, already knows the WebGPU browser
recipe, and already knows that headless Linux needs `xvfb-run`. The `AGENTS.md` loop routes
capture through the CLI the project already installs.

This is the single largest deletion from upstream and the reason the fork stays small.

### §5b compliance — the sharpest question in this PRD

**Does this own the look?** No, and the test is: after the loop finishes, delete the MCP
server and the game is unchanged. The output is a file in `src/render/` that the user edits
like any other. Nothing is imported from a package at runtime, no `defineGame` option selects
a look, and no material or shader ships in `packages/`.

**Where it would start owning the look, and the guard:** if `sculpt_grimoire` ever returns a
concrete material or shader the agent is told to paste verbatim. The grimoire is *technique*
("how spec-gap analysis works", "how to decompose a head") and must stay technique. Phase 4
adds the check.

### Explicitly rejected

| Option | Why not |
|---|---|
| **Vendor it into `packages/`** | `pnpm budgets` fails twice — package count and the 15,000 LOC trigger, which the forge alone would blow past. Phase 3 makes this a red CI job rather than a review opinion |
| **Ship it as a skill in the templates** | Skills are Claude-Code-only, and the premise is that *the user's agent* ships the gameplay. Also verified against `check-budgets.ts:264`: the template counter reads `.ts/.tsx/.js/.jsx/.css`, so markdown would not trip the 1,200 cap — the reason to reject is portability, not budget, and saying so keeps the real reason visible |
| **Port the whole forge to TypeScript** | `spec_search.py` is 63 KB and one build file is 164 KB. Porting it before a single sculpt has shipped is the speculative abstraction rule 2 forbids |
| **Ship the Python behind a Node shim** | Adds Python + `uv` + Playwright to `pnpm create threenative`. Scaffold friction is the one cost this project has never accepted |
| **Contribute an MCP mode upstream and pin it** | Cheapest to maintain, and we do not control the timeline. Reconsider once the fork has proven the surface — that is a better upstream contribution than a proposal |

### Flow

1. Agent needs a bespoke object. `AGENTS.md` routes it: conventional → PRD-032's asset tools;
   trivial → just write it; **bespoke with a reference image → here**.
2. `sculpt_plan(reference, intent)` → pass list + grimoire URIs.
3. Agent reads the grimoire pages, writes an `ObjectSculptSpec`.
4. `sculpt_spec_gate(spec)` → passes, or errors naming the missing region. Loop until it passes.
   **No code is written before this gate is green.**
5. Per pass: agent writes/extends the factory in `src/render/`, captures a frame with the
   playtest CLI, calls `sculpt_compare`, then `sculpt_pass_gate`.
6. Advance, retry with the named correction, or stop.
7. What remains is ordinary user source in `src/render/`, and the reference image's provenance
   is appended to `CREDITS.md` on the same rule PRD-032 established.

---

## 3. Integration Ledger

Filled with real `file:line` during implementation. A row still reading `TBD` at phase end
means the phase is incomplete.

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `threenative-sculpt-mcp` external package | `templates/*/.mcp.json` `args`, launched by the user's MCP host | nothing | n/a | local tarball is green; `npm view` remains red until authenticated publication |
| 2 | `mcpServers.threenative-sculpt` in each `.mcp.json` | `packages/create-threenative/src/index.ts:98,123-147` — integrity check requires both servers and installed local entries | a single-server config | n/a | deleting the sculpt block, naming an undeclared package, or using `npx -y` makes `scaffold.spec.ts` throw |
| 3 | `threenative-sculpt-mcp` in each template `package.json` | the three generated manifests, consumed by `pnpm install` | agents hand-writing bespoke geometry with no reference loop | n/a | add it to any `@threenative/*` package → `pnpm budgets` fails |
| 4 | `sculpt-mcp-tools.json` — the surface recorded off a live `tools/list` | `.github/workflows/ci.yml:95-188` scaffold-smoke, set-equality; `template.spec.ts:280-299` doc test | an unverified claim about the tool surface | n/a | a missing or sixth tool fails exact JSON set equality |
| 5 | "Building what you cannot download" in each `AGENTS.md`, placed immediately after "Finding assets" | generated `AGENTS.md`, mirrored `CLAUDE.md`; starter at `templates/starter/AGENTS.md:234-267` | the single unelaborated routing sentence | the routing rule remains and now has its decision procedure | `pnpm sync:agents --check` fails on drift; the doc test rejects tool names absent from the recorded surface |
| 6 | Externality assertion extended from one name to a set | `scripts/check-budgets.ts:40-43,196-221,319-322` | a check that names only the asset server | the single-constant form is deleted | package-name and workspace-dependency fixtures fail for both external MCP names |
| 7 | Grimoire-is-technique check | `.github/workflows/ci.yml:170-180`, reading every resource from the installed server | nothing — new guard for a new §5b risk | n/a | any served fenced concrete shader/material block fails scaffold-smoke |

### Reachability

**How will this feature be reached?**
- Entry point: **the user's MCP host reading `.mcp.json` in the generated project root**, and
  before that `pnpm create threenative my-game` followed by `pnpm install`.
- Pre-existing files EDITED to make it reachable: `packages/create-threenative/src/index.ts`,
  `packages/create-threenative/templates/*/.mcp.json`,
  `packages/create-threenative/templates/*/package.json`,
  `packages/create-threenative/templates/*/AGENTS.md`, `.github/workflows/ci.yml`,
  `scripts/check-budgets.ts`.
- Registration/wiring: `mcpServers.threenative-sculpt` in `.mcp.json`, plus the dependency in
  the generated `package.json` that makes `args[0]` resolve after `pnpm install`.

**Is this user-facing?** YES, and the user is an agent. The observable surface is the
`tools/list` response, the file that appears in `src/render/`, and the captured frame.

**Full flow:** §2 "Flow", steps 1–7.

**What does this replace?** The unelaborated instruction at `templates/starter/AGENTS.md:157`.
That sentence is the incumbent, it stays (the routing rule is still correct), and the new
section is what it was missing. Baseline for every gate below:
`grep -rn "sculpt" packages/ scripts/ .github/` returns nothing today.

---

## 4. Phases

Every phase edits at least one pre-existing file. Max 5 files each.

#### Phase 1: the go/no-go — a published server with exactly 5 tools

**Outcome:** `npm view threenative-sculpt-mcp version` returns a version whose `tools/list` is
exactly the 5 names in §2, or **this PRD is void in writing** and §8 records why.

PRD-032 shipped with its Phase 1 unmet and paid for it in tool-surface regression. This one
does not start Phase 2 until Phase 1 is green.

**Files:** out of tree, in the fork's own repository, with its own `NOTICE` and Apache-2.0
attribution to img2threejs. In tree: this PRD EDIT (record the published version).

**Implementation:**
- [x] Fork, retain `grimoire/`, derive the runtime spec contract, port comparison math to TypeScript
- [x] Apache-2.0 `NOTICE` naming img2threejs and the retained/adapted files
- [x] Implement the 5 tools, each **fail-closed** per the §2 table
- [x] Serve all 31 technique-safe grimoire entries as MCP resources; reject the unsafe three
- [x] Publish. Record `npm view` output verbatim in §8
- [x] Confirm the npm name is free

**Verification:** `npm view threenative-sculpt-mcp version`, then `tools/list` over stdio
against the **installed** package, output pasted.
**Negative control:** call `sculpt_compare` with a nonexistent capture path → error, not an
empty pass. Call `sculpt_spec_gate` with `{}` → error naming a missing region.

#### Phase 2: the starter scaffolds with both servers

**Outcome:** a project scaffolded from the packed tarball has a two-server `.mcp.json`, and
`pnpm install` resolves both from the registry.

**Files:** `templates/starter/.mcp.json` EDIT · `templates/starter/package.json` EDIT ·
`packages/create-threenative/src/index.ts` EDIT (extend the existing integrity check to
require both server names and assert both `args[0]` resolve to a declared dependency) ·
`packages/create-threenative/__tests__/scaffold.spec.ts` EDIT.

**Verification:** `scaffold.spec.ts`.
**Negative controls, each run at `HEAD~1` and observed red:** remove the sculpt block →
`createProject` throws; point its `args[0]` at an undeclared package → throws naming it; use
`npx -y` instead of `./node_modules/` → throws.

#### Phase 3: all three templates, and the externality is enforced

**Outcome:** `pnpm budgets` reports the **same** package count and framework LOC as before this
PRD, and fails if either external MCP is ever vendored.

**Files:** `templates/minimal/*` and `templates/platformer/*` EDIT ·
`scripts/check-budgets.ts` EDIT (`vendoredAssetMcp` → `vendoredExternalMcp`, over a set) ·
`scripts/__tests__/budgets.spec.ts` EDIT.

**Verification:** `pnpm budgets`, output pasted and compared line-for-line against the
pre-PRD run.
**Negative control:** two fixtures — a `packages/sculpt-mcp/` directory, and `packages/core`
declaring the dependency. Both must error; the real tree must stay clean. Run both directions.

#### Phase 4: the agent knows when to use it — the authoring hook

**Outcome:** an agent given only the generated `AGENTS.md` picks the right branch — download,
sculpt, or just write it — and never sculpts a crate.

**Files:** `templates/*/AGENTS.md` EDIT (×3) · `packages/create-threenative/sculpt-mcp-tools.json`
NEW · `packages/create-threenative/__tests__/template.spec.ts` EDIT.

**The routing rule, which is the actual deliverable of this phase.** It goes immediately after
"Finding assets — you have an MCP server for this", because the two are one decision:

> **Conventional and downloadable** — a crate, an oak plank texture, a click. Use the asset
> tools. Sculpting one of these is slower and worse.
>
> **Trivial** — a platform, a wall, a pickup ring. Write it. If a competent developer would
> reach for `BoxGeometry` and be done in under 20 lines, that is the answer, and it is the same
> 20-line rule the framework holds itself to.
>
> **Bespoke, and you have a reference image** — this game's specific creature, vehicle, weapon,
> or character. Sculpt it. This is the case the asset tools make worse, because a downloaded
> model standing in for a bespoke design reads as a weird asset dropped into the scene.
>
> **Bespoke, and you have no reference image** — ask for one, or write it and accept it will be
> generic. Do not sculpt from an imagined reference: `sculpt_compare` has nothing to compare
> against and the loop degenerates into unguided iteration.

Then the loop, capture routed through the playtest CLI the project already has, and the
`CREDITS.md` rule for the reference image's provenance.

**Verification:** the existing doc test, extended — parse tool-shaped code spans out of all
three `AGENTS.md` and reject any `sculpt_*` name absent from `sculpt-mcp-tools.json`.
Plus the §5b guard: no grimoire resource may return a concrete material or shader block.
`pnpm sync:agents --check` clean.
**Negative control:** invent `sculpt_render` in one `AGENTS.md` → the doc test fails naming it.

#### Phase 5: the exit gate — a real agent, a real reference, a rendered frame

**Outcome:** the capability is proved on the real subject, or §6 stays unchecked. Plumbing
proved is not capability proved — PRD-032's §8 says so in its own words and this phase exists
because of it.

**Files:** `docs/verification/round-*.md` EDIT · this PRD EDIT (§8).

**Implementation:**
- [x] Scaffold from a packed tarball into a clean sandbox. Real `pnpm install`, both servers
- [x] Give an agent one reference image and one brief, and **nothing but the generated `AGENTS.md`**
- [x] Let the loop run. Capture the final frame
- [x] **Negative control arm:** the same brief, same image, same agent, `.mcp.json` with the
      sculpt server removed. Capture that frame too
- [ ] A person looks at both frames beside the reference and says which is closer
- [ ] Record token cost for both arms. A loop that wins on fidelity and loses 5× on tokens is a
      finding, not a failure, and it belongs in §8 either way

**Verification:** both frames, the reference, the human call, and both token counts in §8.
**Negative control:** the no-sculpt arm. If it wins or ties, this PRD failed and §8 says so.

---

## 5. Verification Strategy

The dangerous failure is a gate that reports green while the generated project has no working
sculpt loop, or while the loop runs and produces something worse than hand-written code.

| Silent-pass mechanism | Control |
|---|---|
| `.mcp.json` ships but the dependency is missing, so `args[0]` never resolves and the host lists no tools | scaffold-smoke spawns the **installed** server and asserts set-equality against `sculpt-mcp-tools.json`. Zero tools fails; it cannot pass by being empty |
| The assertion is `tools.length > 0` or `includes("sculpt_plan")` | **Set equality against the sorted 5.** Any other shape is rejected in review — a sixth tool appearing silently is the thing being guarded |
| `sculpt_compare` returns a pass because the capture is missing or blank | A missing, zero-byte, or all-one-colour capture is an **error**. Asserted directly, and it is the specific shape the WebGPU-blank-canvas problem takes on headless Linux |
| `sculpt_spec_gate` warns instead of erroring, so shallow specs reach codegen | The gate returns an error naming the missing region. A spec of `{}` must fail; asserted |
| New tests pass at the previous commit | Every test in Phases 2–4 is run at `HEAD~1` before being recorded as passing. `grep -rn "sculpt" packages/ scripts/ .github/` is empty today, so each must be red there |
| Phase 5's frame "looks better" because of lighting noise or a lucky seed | Both arms use the same scaffold, same baseline capture path, same seed. A person looks at both |
| The loop wins the frame and quietly costs 10× the tokens | Token cost recorded for both arms in §8. Not optional |

**Integration proof commands (paste the output, do not summarize):**

```sh
# 1. Baseline — must return nothing before Phase 2
grep -rn "sculpt" packages/ scripts/ .github/ | grep -v node_modules

# 2. Caller census — the config is referenced by the scaffolder, not only by tests
grep -rn "threenative-sculpt" packages/create-threenative/src packages/create-threenative/templates

# 3. Externality — no workspace package may depend on it
grep -rn "threenative-sculpt-mcp" packages/*/package.json

# 4. The tool surface a model actually sees, from inside the generated project
cd "$TARGET" && node -e '…tools/list over stdio…' | jq -r '.result.tools[].name' | sort

# 5. Budgets unmoved
pnpm budgets
```

---

## 6. Acceptance Criteria — consumer-scoped

| Rejected (artifact-scoped) | Required (consumer-scoped) |
|---|---|
| "the server exposes 5 tools" | "an agent turns a reference image into a `src/render/` factory that a person judges closer to the reference than the same agent's hand-written attempt" |
| "`.mcp.json` lists two servers" | "a user's agent, given only the generated `AGENTS.md`, completes a sculpt loop without being told the pass order" |
| "`AGENTS.md` documents the tools" | "the same agent still downloads a crate instead of sculpting one — the routing rule works in both directions" |
| "the gates fail closed" | "a run that never captured a frame reports failure, not a finished model" |
| "the server is external" | "`pnpm budgets` reports the same package count and framework LOC as before this PRD" |

**Done checks:**
- [ ] All phases complete
- [x] All implemented package, scaffold, doc-surface, and budget tests pass
- [ ] `pnpm typecheck && pnpm lint && pnpm test` passes
- [x] `pnpm budgets` passes with **no cap raised** and **no cap moved**
- [x] Registry-backed scaffold-smoke probe green, including `tools/list` set equality
- [x] `pnpm sync:agents --check` clean
- [ ] All automated checkpoint reviews passed (`prd-work-reviewer` after each phase)

**Integration gates — any unchecked box means NOT done:**
- [x] Integration Ledger has zero `TBD` cells; every live caller is a real non-test `file:line`
- [x] Caller census pasted (proof command 2)
- [ ] Revert check: removing the sculpt block from a template breaks `scaffold.spec.ts` **and** scaffold-smoke
- [ ] Every gate has a negative control **observed failing** — every Phase 2–4 test run at `HEAD~1` and seen red
- [x] Proved on the real subject: a live agent run, not a mocked `tools/list`
- [ ] Phase 5's no-sculpt arm ran, a person compared both frames, and token cost for both is recorded

---

## 7. Budget accounting

Checked against `scripts/check-budgets.ts`, not against intent.

| Budget | Counter | This PRD's contribution |
|---|---|---|
| **Framework packages** | `packageCount` over `packages/` and `examples/` | **0.** `threenative-sculpt-mcp` is an npm dependency of the *generated user project*. No directory under `packages/` or `examples/` |
| **15,000 framework LOC** (trigger) | `collectBudgets` sums `.ts/.tsx/.js/.jsx` under `packages/<name>/src`, skipping salvage | **Under 20 lines.** The fork lives in another repository. The only in-tree source change is extending the existing `.mcp.json` integrity check in `create-threenative/src/index.ts` from one server to two |
| **1,200 LOC per template** (hard) | `check-budgets.ts:264` counts `.ts/.tsx/.js/.jsx/.css` under each template | **0.** Everything this PRD adds to a template is `.md` and `.json`. Verified against the file filter, not assumed |
| **PRD files in `docs/PRDs/`** | non-recursive `.md` count, **reported not capped** | +1 (this file). Moves to `docs/PRDs/done/` on completion |
| **50,000 native runtime LOC** | — | **0.** Untouched |

**The one place this goes wrong:** a future change vendors the fork, and both the package count
and the LOC trigger break at once. Phase 3's `check-budgets.ts` edit turns that from a review
opinion into a red CI job — and generalising the check from one name to a set is what stops the
next external server from arriving unguarded.

---

## 8. Verification Evidence

Phase 1 source discovery ran against upstream commit
`d6673386f89673a58736f8d398dd16ece67874f5b` (2026-08-06). It identified amendments required
for a truthful implementation; those amendments are reflected in the released package.

### Phase 1 registry gate

The initial negative control proved the name was free and publication required authentication:

```text
$ npm view threenative-sculpt-mcp version --json
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/threenative-sculpt-mcp - Not found

$ npm whoami
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in.
```

After authentication, publication and registry lookup passed:

```text
$ npm publish --access public
+ threenative-sculpt-mcp@0.1.0

$ npm view threenative-sculpt-mcp version dist.tarball dist.shasum --json
{
  "version": "0.1.0",
  "dist.tarball": "https://registry.npmjs.org/threenative-sculpt-mcp/-/threenative-sculpt-mcp-0.1.0.tgz",
  "dist.shasum": "6bc4b45dc0e2a43d763aaa5eed249efc6803fb24"
}
```

The separate public source repository is
`https://github.com/ThreeNativeHQ/threenative-sculpt-mcp`; verified HEAD is `bcb9ec2`. The local
packed tarball SHA-256 is
`cad6082d09fc2db69f8bb849654fc0b942884fc3b84c11d88a94add5d47bf614`.

### Phase 1 source audit

1. **The retained payload is not the measured payload in §1.** Current upstream has 34
   grimoire resources (33 Markdown and one JSON), totalling 244,993 bytes, not about 40
   Markdown files / 280 KB.
2. **There is no standalone spec schema to retain.** The 2.1 document is assembled by
   `forge/stage2_spec/new_sculpt_spec.py` and checked procedurally by
   `validate_sculpt_spec.py`. A search for a sculpt-spec schema file returns no result.
   Defining a new MCP schema could be a valid later design, but it is not the retained
   contract claimed here.
3. **The retained pass order is eight passes.** `orchestrate_passes.py:18` defines
   `blockout`, `structural-pass`, `form-refinement`, `material-pass`, `surface-pass`,
   `lighting-pass`, `interaction-pass`, and `optimization-pass`. The six-pass surface in §1
   silently drops interaction and optimization.
4. **The resource and §5b requirements conflict directly.** The retained
   `grimoire/character/structure_decomposition.md` contains a concrete GLSL block beginning
   `float g = smoothstep(...)` and a concrete `MeshPhysicalMaterial` recipe with numeric
   roughness, clearcoat, sheen, and colour values. Serving `grimoire/` verbatim therefore
   fails Phase 4's required check that no resource return a concrete material or shader
   block. Filtering or deleting that content would fail Phase 1's verbatim-retention premise.
5. **The advertised per-region comparison does not operate on the proposed inputs.**
   `forge/stage4_review/compare_region_passes.py:5` says per-region scores are keyed by a GLB
   semantic-ID pass and reports them unavailable without it. `sculpt_compare(reference,
   capturedFrame)` has neither a semantic-ID reference pass nor explicit region masks. A
   generic per-region result would therefore be new, unvalidated comparison logic rather
   than a TypeScript port of upstream math.

These findings became implementation inputs rather than a stop decision. The server retains
all 34 upstream grimoire files in its source/distribution, serves 31 safe resources, rejects
the three concrete-recipe pages, uses the canonical eight passes, and labels its schema as a
new runtime contract.

| Phase | Gate | Result | Negative control |
|---|---|---|---|
| 1 | published server, exactly 5 tools | PASS — npm `0.1.0`, installed registry server returned exact five | `{}` spec, missing/zero-byte/single-colour capture, unknown/unsafe resource all fail closed |
| 2 | starter scaffolds with both servers | PASS — packed CLI plus real registry install of both MCPs | Missing block, undeclared package, and `npx -y` controls pass |
| 3 | all templates; externality enforced | PASS; 6 framework packages, 3 example workspaces, largest template 1,200 LOC | Both package-identity and dependency directions pass |
| 4 | routing rule works in both directions | PASS in all three generated guides, including scenery/environment routing | Installed-resource scan rejects concrete shader/material blocks; doc test rejects invented names |
| 5 | real reference, real frame, both arms | AUTOMATED PASS; human/token gates pending | No-sculpt frame captured and preserved |

### Installed starter proof

A brand-new `starter-registry-proof` generated from the packed CLI installed
`threenative-asset-mcp@0.4.0` and `threenative-sculpt-mcp@0.1.0` from npm, typechecked, built,
and ran the exact CI probe extracted from `.github/workflows/ci.yml`:

```text
threenative-assets ok: 32 tools from 0.4.0
threenative-sculpt ok: 5 tools from 0.1.0

configEntry: ./node_modules/threenative-sculpt-mcp/dist/server.js
safeResources: 31
tools: sculpt_compare, sculpt_grimoire, sculpt_pass_gate, sculpt_plan, sculpt_spec_gate

pnpm typecheck: exit 0
pnpm build: exit 0, 104 modules transformed
```

Caller census:

```text
packages/create-threenative/src/index.ts:98: REQUIRED_MCP_SERVERS includes threenative-sculpt
packages/create-threenative/templates/{starter,minimal,platformer}/.mcp.json: threenative-sculpt
packages/create-threenative/templates/{starter,minimal,platformer}/package.json: threenative-sculpt-mcp@0.1.0
```

### Sandbox behavior proof

The final comparison returned finite diagnostic evidence (`score: 0.417777`,
`confidence: 0.843147`, `ambiguous: false`). Semantic review met every critical threshold, so
`sculpt_pass_gate` returned `advance` while preserving low pixel/region scores as corrections.
The packaged example spec passed; empty specs and missing, zero-byte, and decoded single-colour
captures returned MCP errors.

- [Reference](../../benchmark/genres/exploration/reference.png)
- [Sculpt arm](../../verification/prd-049-sculpt-frame.png)
- [No-sculpt control](../../verification/prd-049-sculpt-control.png)

The sculpt arm contains the central tower, four canopy masses, cyan beacons, and dark approach;
the control contains the starter floor, player, and crate. This descriptive inventory is not
the required human preference call. The executing MCP transport also exposed no token
telemetry, so both final acceptance cells remain unchecked.

### Repository gates (2026-08-09)

```text
external MCP: typecheck PASS; build PASS; 6 files / 27 tests PASS
targeted main tests: 3 files / 48 tests PASS
pnpm typecheck: PASS
pnpm test: 164 files / 1,248 tests PASS (package pass), then 164 files / 1,248 tests PASS (root pass)
pnpm sync:agents --check: PASS
pnpm budgets: PASS — 6 framework packages, 3 examples, 5,944/15,000 framework LOC,
  51,778/50,000 native runtime LOC, largest template 1,200 LOC
```

`pnpm lint` is not green in the shared dirty worktree: Biome reports only the unrelated
`packages/physics/tsup.config.ts:4` formatting change. No physics file was changed for this PRD.
The native runtime LOC review trigger is likewise pre-existing/concurrent and non-fatal; this
PRD adds no native source.
