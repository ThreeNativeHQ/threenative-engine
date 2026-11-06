# PRD-830 — A Three.js export the Wasm engine refuses fails at the edit, not at the first frame

**Status:** PROPOSED
**Priority:** P1 — AC-1..AC-5 are open; until they land, every refused export on the default engine shows up as an aborted scene or a blank frame in a playtest, not as an error at the import line
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

- [ ] AC-1 [local]: a kit file importing `TetrahedronGeometry` from `three` fails `threenative build --target web` with `TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY` at that file's import line, and the same import with `engine: "threejs"` builds and prints `TN_ENGINE_CATALOG: off (engine threejs)`. proof: red-green `packages/create-threenative/__tests__/engine-catalog-plugin.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: an `unsupported` catalog entry fails with the entry's own diagnostic; a `partial` entry and an `import type` of an uncatalogued name pass. proof: same spec — Evidence: pending.
- [ ] AC-3 [local]: all 16 kits and Starlance build with the plugin on and report zero refusals, so the plugin refuses no name the runtime binds. proof: `pnpm exec vitest run packages/create-threenative/__tests__/template.spec.ts` (kit builds) and `pnpm build:web` in Starlance through the packed tarball — Evidence: pending.
- [ ] AC-4 [local]: in `pnpm dev`, saving a file that adds a refused import shows the Vite error overlay naming the code and `file:line` within one reload, with no playtest run. proof: a `threenative-playtest` scenario against the dev server that asserts the overlay text, or the spec's Vite dev-server case — Evidence: pending.
- [ ] AC-5 [local]: the convention index row exists in every kit router and the template `AGENTS.md` names the `mode: "warn"` override. proof: `pnpm sync:agents --check` and `kit-conventions.spec.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Import-time refusal | kit `vite.config.ts` → `create-threenative` plugin `transform` → Vite error (dev overlay, build failure) | runtime-only refusal in `browser-entry.ts` stays as the backstop for dynamic access | AC-1, AC-4 |
| Catalog data in the game | installed `@threenative/core` (or packed copy) → plugin | `generated/three.d.ts` stays unshipped; this PRD does not map `three` types (decision below) | AC-3 |

## Decisions

- 2026-11-06 (agent): a Vite transform check, not shipping `generated/three.d.ts` through `tsconfig` `paths`. Reason: the generated declarations cover 511 names with looser signatures than `@types/three` (for example `struct(...): Function`), so mapping `three` to them would weaken every game's types to catch the refusals. One plugin covers dev, build and `pnpm test` with no type regression.

## Execution Phases

#### Phase 1: The plugin and its spec
**Status:** NOT STARTED
**Files:** `packages/create-threenative/src/engine-catalog.ts` (new plugin, exported beside the freshness plugin), `src/index.ts` export, `__tests__/engine-catalog-plugin.spec.ts`.
**Implementation:** parse imports with `es-module-lexer` or the parser Vite already exposes (`this.parse`) — no new dependency; read the catalog once per server; honour `engine` from the game config.
**Verification:** `pnpm exec vitest run packages/create-threenative/__tests__/engine-catalog-plugin.spec.ts` — AC-1, AC-2.
- [ ] Phase 1 done: plugin and spec (AC-1, AC-2). proof: engine-catalog-plugin.spec.ts. Evidence: pending.

#### Phase 2: Every kit uses it
**Status:** NOT STARTED
**Files:** 16 `templates/*/vite.config.ts` (generated from the shared fragment if one exists), convention registry row, router regeneration.
**Verification:** `pnpm sync:agents --check`, kit build spec, `pnpm typecheck && pnpm lint && pnpm test` in the engine — AC-3 (kits), AC-5.
- [ ] Phase 2 done: every kit uses the plugin, convention row (AC-3 kits, AC-5). proof: template-vite-plugins.spec.ts, kit builds and sync:agents --check. Evidence: pending.

#### Phase 3: Starlance proof
**Status:** NOT STARTED
**Files:** pack per the sandbox `AGENTS.md` (content-hashed tarball), Starlance `vite.config.ts`.
**Verification:** Starlance `pnpm build:web` green with zero refusals (AC-3); dev-server overlay case (AC-4).
- [ ] Phase 3 done: Starlance builds with zero refusals, dev overlay case (AC-3 Starlance, AC-4). proof: Starlance pnpm build:web and dev-server overlay case. Evidence: pending.
