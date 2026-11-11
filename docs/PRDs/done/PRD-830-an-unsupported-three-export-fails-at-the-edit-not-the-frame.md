# PRD-830 — A Three.js export the Wasm engine refuses fails at the edit, not at the first frame

**Status:** DONE (2026-11-07)
**Priority:** P1 — until AC-1..AC-5 landed, every refused export on the default engine showed up as an aborted scene or a blank frame in a playtest, not as an error at the import line
**Complexity:** 3 (LOW) — 2 implementation files in `create-threenative` (one Vite plugin, one template `vite.config.ts` line per kit through the shared fragment); risk override: none
**Owner:** João Paulo Furtado
**Depends on:** None

## Context

The default engine is the owned Wasm engine. It binds every `three`, `three/webgpu` and `three/tsl`
export through `bindUpstreamExports` (`packages/three-native/src/browser-entry.ts:90-120`): a name
missing from `packages/three-native/api/catalog.json` becomes a refusal that throws
`TN_NATIVE_UNCATALOGUED_<NAME>` **when the game first calls it**; an `unsupported` entry throws its own
diagnostic. The catalog has 511 entries (134 `unsupported`); `three` exports far more names, and every
name outside the catalog is refused.

The engine already knows this at build time. `packages/three-native/scripts/generate.ts` writes
`generated/three.d.ts`, "an unsupported entry is a compile-time trap carrying its diagnostic code".
No game receives it: `@threenative/three-native` arrives only as a transitive dependency that ships
`src/**/*.ts` (`package.json` `files`), and no template `tsconfig.json` maps `three` to it. A game's typecheck reads
`@types/three`, where every refused name is valid.

What that cost Starlance (transcripts, 2026-11-05/06, approximate counts):

| Runtime refusal or blank frame | Mentions | Effect |
|---|---|---|
| `TN_NATIVE_UNCATALOGUED_LIGHTS` (`lights` from `three/tsl`, catalogued in 0.3.12 by #618) | ~40 | `enter` aborted; cockpit lighting re-planned 4 sessions (`FRICTION.md` 2026-11-05) |
| `TN_POST_NORMAL_UNSUPPORTED` | ~15 | a late normal-mapped material stops the renderer |
| `TN_NATIVE_CLONE_UNSUPPORTED: InstancedMesh`, `TetrahedronGeometry` (absent from the catalog), blending modes | several | found one playtest at a time |

Each was found by a build (~1.2 h total in the window), a headed capture (~390 runs, ~3.5 h shared
with other causes) and a log grep. An import-level check finds the name-level ones in the editor
loop instead.

Scope: name-level refusals only (uncatalogued and `unsupported` exports, statically imported). Member-
and argument-level gaps (`partial` entries such as `InstancedMesh.clone`, `TN_POST_NORMAL_UNSUPPORTED`)
stay runtime diagnostics; they need the value, not the name.

## Solution

One Vite plugin in `create-threenative` (the package that already ships `createEngineFreshnessPlugin`
and `createWebBrandPlugin` to every kit's `vite.config.ts`):

1. On `transform` of a game source file, read its static `import { … } from` declarations whose
   source is in the catalog's upstream set (`three`, `three/webgpu`, `three/tsl`, and the catalogued
   `three/addons/*` paths). Skip `import type` and type-only specifiers.
2. Look each name up in the catalog that the installed engine ships. `unsupported` → error with the
   entry's own diagnostic; absent → error `TN_NATIVE_UNCATALOGUED_<NAME>`. Both carry `file:line:col`
   through Vite's `this.error`, so `pnpm dev` shows the overlay and `threenative build` / `pnpm test`
   fail on the same line. `supported`/`partial` pass.
3. Off when `threenative.config.ts` sets `engine: "threejs"` (upstream Three.js binds every name),
   and reported once: `TN_ENGINE_CATALOG: off (engine threejs)`. Named override:
   `createEngineCatalogPlugin({ mode: "warn" })` downgrades errors to warnings and says so in the same
   marker. Default `error`, because the scene would abort anyway.
4. The catalog is already inside the package: `create-threenative/dist/web-engine-runtime.js` inlines
   `catalog.json` (checked in Starlance's installed 0.2.15: 201 `"unsupported"` kinds). The plugin
   imports the same JSON at package build time, so the plugin and the runtime it guards read one
   catalog version.
5. Every kit's `vite.config.ts` adds the plugin; the router convention index gets one row
   (default, override, marker, reference page) per the charter's convention rule.

Gate: the game cannot write this portably (the catalog is engine knowledge that changes per
release) → the engine owns it. It decides no look. No closed-list item.

Risk: a false positive blocks a dev server. Mitigation: AC-3 runs the plugin over all 16 kits and
Starlance; any name that the runtime accepts but the plugin refuses is a catalog/binding mismatch and
fails that AC.

## Acceptance Criteria

- [x] AC-1 [local]: a kit file importing `TetrahedronGeometry` from `three` fails `threenative build --target web` with `TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY` at that file's import line, and the same import with `engine: "threejs"` builds and prints `TN_ENGINE_CATALOG: off (engine threejs)`. proof: red-green `packages/create-threenative/__tests__/engine-catalog-plugin.spec.ts` — Evidence: 2026-11-06. Spec cases "refuses an uncatalogued import at its line" and "fails a real Vite build at the import line, and the threejs build passes" (red `Cannot find module`, then green). Real CLI: a workspace-linked `minimal` scaffold with `import { TetrahedronGeometry } from "three"` at the top of `src/game.ts` ran `node packages/create-threenative/dist/threenative.js build --target web`. It exited 1 with `TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY: TetrahedronGeometry from "three" is not available on the Wasm engine (src/game.ts:1:10).` With `engine: "threejs"` the same build exited 0 and printed `TN_ENGINE_CATALOG: off (engine threejs)`. The run used a temporary `template.spec.ts` case, which is not committed.
- [x] AC-2 [local]: an `unsupported` catalog entry fails with the entry's own diagnostic; a `partial` entry and an `import type` of an uncatalogued name pass. proof: same spec — Evidence: 2026-11-06, `engine-catalog-plugin.spec.ts` cases "refuses an unsupported entry with that entry's own diagnostic" and "passes a partial entry, an import type, a type-only specifier and an aliased bound name". Red: `Cannot find module '/packages/create-threenative/src/engine-catalog.js'`. Green: 7 passed (7).
- [x] AC-3 [local]: all 16 kits and Starlance build with the plugin on and report zero refusals, so the plugin refuses no name the runtime binds. proof: `pnpm exec vitest run packages/create-threenative/__tests__/template.spec.ts` (kit builds) and `pnpm build:web` in Starlance through the packed tarball — Evidence (kits, 2026-11-06): a temporary `template.spec.ts` case (not committed) scaffolded each of the 16 kits and ran `vite build` with the workspace Wasm engine: 16 passed, 0 `TN_NATIVE_` refusals, 34 s. The committed case "should build a starter scaffold after pruning its optional effect sources" passes with the plugin on. The plugin transform with the real engine over every kit source file: 687 files, 420 import `three`, 0 refused. Cost of the check, measured: see Decisions — the boot is 113-118 ms at the first transform and the whole build delta is about 371 ms, under the 1 s cache threshold. Evidence (Starlance, 2026-11-07): Starlance's `vite.config.ts` gained `createEngineCatalogPlugin()` after `createWebBrandPlugin()`, and `pnpm build:web` on the packed tarball beside the published 0.3.12 cohort exits 0 with 0 refusals. The plugin proves it was on in the same build: the same tree with `import { TetrahedronGeometry } from "three";` prepended to `src/main.ts` fails `pnpm build:web` with `RolldownError: TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY: TetrahedronGeometry from "three" is not available on the Wasm engine (src/main.ts:1:10).` and exit 1; reverting the file builds green again. 54 files under `src/`, 43 of them import `three`. One caveat: the first `pnpm build:web` after the `vite.config.ts` edit failed with `ENOENT: no such file or directory, stat '.../public/crew/kestrel.ebf601f2.png'` — a hashed asset the earlier cook had written under a different hash — and the immediate retry was green; the asset cook's stale-output desync, not the plugin, and not this PRD's file.
- [x] AC-4 [local]: in `pnpm dev`, saving a file that adds a refused import shows the Vite error overlay naming the code and `file:line` within one reload, with no playtest run. proof: a `threenative-playtest` scenario against the dev server that asserts the overlay text, or the spec's Vite dev-server case — Evidence: 2026-11-06, the spec's Vite dev-server case "shows the dev overlay error with the code and file:line after one save (AC-4)". A real `createServer().listen()` serves `src/main.ts` (200). The case saves the file with an added `TetrahedronGeometry` import and waits for the server to fail it (500 with the overlay). and the overlay payload (`environments.client.hot.send({ type: "error" })`) carries `TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY ... (src/main.ts:2:10)` with `loc` line 2. No playtest runs. Negative control: the same case with the plugin removed fails (`expected 'Failed to resolve import "three" from…' to contain 'TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEO…'`). `engine-catalog-plugin.spec.ts`: 9 passed. 2026-11-07, two merge-group reds on `test-unit (3/4)` (42331690491, 42337527046) were this case, and neither was the plugin: the dev server never got the request. `port: 0` is not "any port" to Vite — it falls back to the default 5173 (measured: a probe server asked for 0 bound 5173, then 5175 while sibling lanes held 5173 and 5174), and the shard already runs servers on `127.0.0.1:5173` (the terrain editor prints that URL at 04:18:12 in 42337527046). The case addressed its server by `resolvedUrls.local[0]` → `localhost`, so run 1 reached a sibling and got `expected 200 to be 500`, and run 2 found `Connect ECONNREFUSED 127.0.0.1:5173`. It now reserves a free port, binds `127.0.0.1` and addresses it by that port. Second defect in the same case, fixed with it: the assertions ran off chokidar's raw `change` event while Vite's own handling of it is asynchronous — with a probe plugin whose `watchChange` yields 50 ms the old shape returns 200 with an empty overlay on every run, so the case now waits for `{ status: 500, overlay: true }` (20 s). 3/3 local runs of the file after both fixes: 9 passed. Negative control still fails: with the plugin's refusal check removed the message assertion reports `expected 'Failed to resolve import "three" from…' to contain 'TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEO…'`.
- [x] AC-5 [local]: the convention index row exists in every kit router and the template `AGENTS.md` names the `mode: "warn"` override. proof: `pnpm sync:agents --check` and `kit-conventions.spec.ts` — Evidence: 2026-11-06. Row `engine-catalog` in `conventions.json`, anchor in `agent-docs/references/conventions.md`. All 16 routers carry `- **Refused imports** #engine-catalog: ... Override: createEngineCatalogPlugin({ mode: "warn" })`. `pnpm sync:agents --check`: "agent docs in sync: 31 CLAUDE.md mirrors". `kit-conventions.spec.ts`, `template-conventions.spec.ts`, `instruction-budget.spec.ts`, `sync-agent-docs.spec.ts`: 60 passed. The first row text put `action-rpg` at 1,202 of 1,200 words (red), and the shorter text passes.

## Blocked on

Nothing. Both former blockers resolved on 2026-11-07: the published `@threenative/*` 0.3.12 cohort is the pair
this `create-threenative` names, and Starlance builds with the plugin on at zero refusals (AC-3).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Import-time refusal | kit `vite.config.ts` → `create-threenative` plugin `transform` → Vite error (dev overlay, build failure) | runtime-only refusal in `browser-entry.ts` stays as the backstop for dynamic access | AC-1, AC-4 |
| Catalog data in the game | installed `@threenative/core` (or packed copy) → plugin | `generated/three.d.ts` stays unshipped; this PRD does not map `three` types (decision below) | AC-3 |

## Decisions

- 2026-11-06 (agent): a Vite transform check, not shipping `generated/three.d.ts` through `tsconfig` `paths`. Reason: the generated declarations cover 511 names with looser signatures than `@types/three` (for example `struct(...): Function`), so mapping `three` to them would weaken every game's types to catch the refusals. One plugin covers dev, build and `pnpm test` with no type regression.
- 2026-11-06 (agent): the boot cost is measured, and no on-disk refusal cache is added (reviewer request). Numbers on this workstation, page cache warm: the first transform that imports `three` waits 118, 113 and 115 ms for the refusal map, measured inside a real `vite build` of the scaffolded `minimal` kit with the plugin from `dist`. From TypeScript source through `tsx` the same boot costs 306, 292 and 338 ms, an upper bound because `tsx` also transforms `three` and `web-engine.ts`. A cold `vite build` of that kit, alternating 5 runs per arm, takes 833/886/924/941/996 ms with the plugin (median 924) and 509/512/553/584/627 ms without (median 553): about 371 ms, which is the boot plus loading `typescript` and one parse per game file that imports `three`. The 1 s threshold is not met, so a cache under `node_modules/.cache/threenative/` keyed by the `.wasm` hash would add a file, a staleness rule and a spec for a cost a dev server pays once per start. Revisit when a measured boot passes 1 s. 36 builds exited 0; one earlier run printed `error during build:` with no message and did not reproduce.
- 2026-11-06 (agent): the plugin asks the installed runtime which names it refuses, not `catalog.json` directly. Reason: the catalog marks `WebGPURenderer`, `pass` and `uniform` `unsupported`, but `bindWebEngine` binds them, so a catalog lookup refuses names that every kit imports and AC-3 fails. `upstreamRefusals` boots the single-thread Wasm engine in Node once per Vite process and reads back each refusal and its code (331 ms measured from TypeScript source, 113-118 ms from the built plugin inside a Vite build; see the measurement decision below). The catalog that the runtime bundles is still the one source.
- 2026-11-06 (agent): the plugin checks `three`, `three/webgpu` and `three/tsl` only. Reason: these are the names `bindUpstreamExports` binds one by one. An addon path resolves to a whole module in `createWebEnginePlugin`, so it has no per-name refusal to match.
- 2026-11-06 (agent): the plugin checks only files inside the Vite root and outside `node_modules`. Reason: engine packages import refused names that they use only on some paths (`packages/core/dist/index.js` imports `CubeCamera` and `Points`), and a linked package resolves outside the root.
- 2026-11-06 (agent): the plugin is off for the native host bundle (`THREENATIVE_NATIVE_BUNDLE`) and prints `TN_ENGINE_CATALOG: off (native host bundle)`. Reason: that bundle does not bind through the Wasm page runtime, the same rule `createWebBrandPlugin` uses for the web engine.
- 2026-11-06 (agent): imports are parsed with `typescript`, an existing dependency, loaded on the first game file that imports `three`. Reason: the plugin runs with `enforce: "pre"` on the original TypeScript, so `import type` and the reported line stay exact. The plugin also adds itself to `worker.plugins`, because the kits run the game in a worker and Vite bundles a worker with those plugins only.
- 2026-11-06 (agent): when the installed Wasm engine does not boot in Node, the plugin fails with `TN_ENGINE_CATALOG: the installed Wasm engine did not boot ...` and names `pnpm up create-threenative @threenative/*`. In `mode: "warn"` it warns once and checks nothing. Reason: the page runs the same `bindWebEngine`, which spreads `tsl.exports` and so runs every TSL constant getter at boot (`browser-tsl.ts:808-813`). A pair that fails here also fails on the page. Found on Starlance: create-threenative 0.2.17 from this tree with runtime-native 0.3.11 throws `TN_ABI_6: TSL constant:modelViewProjection`. Red: `TypeError: .toMatch() expects to receive a string, but got undefined`, then green.

## Execution Phases

#### Phase 1: The plugin and its spec
**Status:** DONE
**Files:** `packages/create-threenative/src/engine-catalog.ts` (new plugin, exported beside the freshness plugin), `src/index.ts` export, `__tests__/engine-catalog-plugin.spec.ts`.
**Implementation:** parse imports with `es-module-lexer` or the parser Vite already exposes (`this.parse`) — no new dependency; read the catalog once per server; honour `engine` from the game config.
**Verification:** `pnpm exec vitest run packages/create-threenative/__tests__/engine-catalog-plugin.spec.ts` — AC-1, AC-2.
- [x] Phase 1 done: plugin and spec (AC-1, AC-2). proof: engine-catalog-plugin.spec.ts. Evidence: 2026-11-06. `pnpm exec vitest run packages/create-threenative/__tests__/engine-catalog-plugin.spec.ts`: red `Cannot find module '/packages/create-threenative/src/engine-catalog.js'`, then 7 passed (7). The spec includes a real Vite `build()` that fails with `TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY ... src/main.ts:1:10` and passes under `engine: "threejs"`. A second red came from a real starter build: the plugin refused `CubeCamera` inside the linked `packages/core/dist/index.js`. The case "checks only the game's own files" went red (`... (../engine/packages/core/dist/index.js:1:10)`) and then green. Real engine: `upstreamRefusals` on this tree's Wasm (`pnpm wasm:build`, emsdk 6.0.11) boots in 331 ms and refuses 788 names. `TetrahedronGeometry` is refused. `WebGPURenderer`, `pass`, `uniform` and `lights` are bound. `pnpm typecheck` exit 0, `pnpm lint` exit 0.

#### Phase 2: Every kit uses it
**Status:** DONE
**Files:** 16 `templates/*/vite.config.ts` (generated from the shared fragment if one exists), convention registry row, router regeneration.
**Verification:** `pnpm sync:agents --check`, kit build spec, `pnpm typecheck && pnpm lint && pnpm test` in the engine — AC-3 (kits), AC-5.
- [x] Phase 2 done: every kit uses the plugin, convention row (AC-3 kits, AC-5). proof: template-vite-plugins.spec.ts, kit builds and sync:agents --check. Evidence: 2026-11-06. No shared `vite.config.ts` fragment exists, so each of the 16 kit files adds `createEngineCatalogPlugin()` after `createWebBrandPlugin()`. New case "fails every template's refused three import at the edit (PRD-830)" in `template-vite-plugins.spec.ts`: red with `minimal` reverted (`+ "minimal: createEngineCatalogPlugin()"`), then green. `scaffold.spec.ts` scaffold hashes re-measured for all 16 trees: `scaffold.spec.ts` and `template-vite-plugins.spec.ts` 86 passed. Kit builds: see AC-3.

#### Phase 3: Starlance proof
**Status:** DONE
**Files:** pack per the sandbox `AGENTS.md` (content-hashed tarball), Starlance `vite.config.ts`.
**Verification:** Starlance `pnpm build:web` green with zero refusals (AC-3); dev-server overlay case (AC-4).
- [x] Phase 3 done: Starlance builds with zero refusals, dev overlay case (AC-3 Starlance, AC-4). proof: Starlance pnpm build:web and dev-server overlay case. Evidence: 2026-11-07 — Starlance `vite.config.ts` adds `createEngineCatalogPlugin()`; `pnpm build:web` exits 0 with 0 refusals on the packed tarball beside `@threenative/*` 0.3.12; the positive control (a `TetrahedronGeometry` import in `src/main.ts`) fails the same build at `src/main.ts:1:10` with `TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY`, so the pass is the plugin running, not the plugin absent. The dev-server overlay case passes in `engine-catalog-plugin.spec.ts` (AC-4).
