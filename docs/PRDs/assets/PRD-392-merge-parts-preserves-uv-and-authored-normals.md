# PRD-392 — Merge static meshes while keeping UVs and authored normals

**Status:** PARTIAL
**Priority:** P2 — Only open box remains: typecheck, lint, count-loc, budgets and vitest exit 0.
**Complexity:** 3 (LOW); risk override: none
**Owner:** Engine authoring
**Depends on:** None
**Progress:** 1/2 phases complete; 5/6 phase boxes; 3/3 acceptance boxes; Phase 1 partial — repo-root `pnpm test` exits 1 only in `packages/runtime-native` (see Open gaps); computed label `prd:75%`; awaiting parent acceptance
**Date:** 2026-09-16

Complexity counts ≤5 implementation files (1) plus the independent engine → game build/consumption
boundary (2). No schema, external API or new system.

## Context

Midway keeps three hand-written copies of the same "merge a group of static meshes into one buffer"
mechanic, each re-deriving attribute handling, indexing, transforms, missing-channel defaults and
bounding volumes:

| Site | Function | Reached from | Channels it keeps |
| --- | --- | --- | --- |
| `midway-open-pacific/src/render/assets.ts:99` | `consolidate(group)` | `assets.ts:217`, `assets.ts:295` | position+normal+uv; zero-fills a missing uv; authored normals kept; world transforms; per-material batch |
| `midway-open-pacific/src/render/airframe-lod.ts:101` | `mergeLod(parts)` | `airframe-lod.ts:88` | position+normal+uv, read component-wise (interleaved-safe); parts already placed; returns `null` on refusal |
| `midway-open-pacific/src/render/devastator.ts:165` | `batch(group)` | 12 call sites (`devastator.ts:265` … `:803`) | position+normal+uv; defaults normal `(0,1,0)` / uv `(0,0)`; local matrix; groups of ≥3 by material |

`@threenative/core` already exports [`mergeParts`](../../../packages/core/src/merge-parts.ts)
(public since its introduction; manifest entry exists) and it is the intended engine owner of this
mechanism: it de-indexes, bakes transforms, guarantees a shared attribute set before calling three's
`mergeGeometries`, throws with a label instead of returning `null`, and optionally writes per-part
flat colour. Its **only** gap for these three callers is that it strips every attribute but
position and recomputes normals, so UVs and authored normals are lost.

Capability discovery already missed this: the complete-request search and the focused mechanic query
*"Merge multiple static Three.js meshes into one mesh per material while preserving texture UV
coordinates and authored normals and baking object transforms."* returned `lightmapPass`,
`createThreeGeometry`, `adviseThreeRenderWorkload`, `ensureVelocityOutput` and
`readVelocityPreviousBoneMatrices` — none of which merge. The existing `mergeParts` situations only
cover primitives, per-piece colour and the `ExtrudeGeometry` index mismatch. The gaps are (a) the
missing channel capability and (b) discovery vocabulary, not a second capability.

Verified base facts (this pass): the game's three sites are its only merge implementations; no other
game module imports three's `mergeGeometries`; `packages/core/__tests__/merge-parts.spec.ts` already
exercises `mergeParts` (colour, indexing, morph, empty, refusal).

## Solution

### API — extend the existing entry, no new capability

Add one optional, named field to the existing `IMergePartsOptions`:

```ts
export interface IMergePartsOptions {
  readonly label: string;
  /** Channels to keep besides position. Absent/empty = today's position-only, recomputed normals. */
  readonly preserve?: readonly ("uv" | "normal")[];
}
```

Semantics (smallest set that fits all three real callers):

1. **`"uv"`** keeps each part's `uv` attribute, de-indexed like position but **retained verbatim** —
   UV values are not transformed by the object placement matrix (position and normal are; three's
   `applyMatrix4` leaves `uv` untouched). **`"normal"`** keeps each part's authored `normal`,
   transformed by the part matrix (three's `applyMatrix4` uses the inverse-transpose normal matrix)
   and **skips** `computeVertexNormals()`.
2. **Missing channel is refused.** If a listed channel is absent on any part the merge throws
   `mergeParts(<label>): part <i> has no <channel> to preserve…`. `flatten` guarantees every part
   ends with the same attribute set (position + the requested channels), so three's
   `mergeGeometries` cannot silently return `null` on divergence. A caller whose data genuinely
   lacks a channel makes its own data decision first (zeros, or `computeVertexNormals()`) — the
   engine does not invent appearance.
3. **Default is byte-equivalent to today**: no `preserve` ⇒ position-only, normals recomputed,
   colour handling, morph clearing, emptiness and refusal errors unchanged.
4. **Transforms and indexing**: unchanged `flatten` path — clone (never mutate the input), apply the
   part `Mesh`'s placement matrix or the supplied `matrix`, `toNonIndexed()` indexed inputs.
   This patched three's `mergeGeometries` already reads interleaved attributes via `getComponent`,
   so `mergeLod`'s component-wise rationale is satisfied without a game-local de-interleave.
5. **Negative-determinant (mirrored) transforms**: `applyMatrix4` transforms authored normals by the
   inverse-transpose and does not flip winding; the default path recomputes from the (possibly
   flipped) winding. This is the existing engine and game baseline, so `preserve: ["normal"]` keeps
   each site's current behaviour and no change is made here. Assessment recorded, not altered.
6. **No input mutation / ownership**: unchanged; every part geometry is cloned before edit.

### Discovery — make the existing entry findable

Update the `mergeParts` JSDoc on the re-export in `packages/core/src/index.ts` (the manifest reads
that site) with searchable situations for **static mesh batching**, **imported glTF models**,
**preserving texture UVs and authored normals**, and **baking object transforms**; extend the
`@constraint`, `@override` and `@example` lines to describe `preserve`, and correct the existing
"strips to position" wording so it distinguishes the position-only default from the `preserve`
override. Run `pnpm capabilities:sync` to regenerate `packages/create-threenative/capabilities.json`
(+ its `packages/core` mirror), `packages/create-threenative/agent-docs/references/capability-reference.md`
and the context surface table, then `pnpm sync:agents` for the `CLAUDE.md` mirrors. Add the
`mergeParts` entry to the consuming template's `AGENTS.md` (the starter builds its hero through it)
and let `pnpm sync:agents` write its generated `CLAUDE.md` mirror. Add one real query assertion to
`packages/engine-mcp/__tests__/search.spec.ts` that the batching query returns `mergeParts`. (The
recall corpus `source` pointers resolve briefs/templates only, so the engine-side search test — not
a corpus row — is the correct instrument.)

### Game integrations and ownership

Both sides stay where the charter puts them: `mergeParts` is portable mechanism the game cannot
avoid re-writing, and geometry, material, colour and per-material grouping remain the game's. Each
site calls `mergeParts(..., { label, preserve: ["uv", "normal"] })` and deletes its duplicate loop:

- `assets.ts` keeps its per-material `Map` and zero-fill *data* decision (applied before the call if
  real inputs lack uv), then merges each batch; `consolidate` returns the same `Group` of
  `castShadow`/`receiveShadow` meshes.
- `airframe-lod.ts` passes already-placed part geometries (identity matrix) and keeps its `null`
  contract by catching the labelled throw where it currently returns `null`.
- `devastator.ts` keeps its ≥3-per-material grouping and removes/reparents children; every
  procedural geometry it builds already carries normal+uv, so it passes them straight through with
  no game-side fallback.

Consumption is through the shipped package: build and pack `@threenative/core`, rename the tarball
to carry a content hash, repoint the game's `file:` dependency, `pnpm install`, and delete the
hand-written copies. Browser proof uses the existing captures from an isolated worktree.

### Rejected candidates (to be recorded in the game's `docs/abstraction-ideas-merge-attributes.md`)

- Flight-steering gains and mission decisions are gameplay — they stay in the game by the charter.
- Aircraft state *initialization values* are game data; they do not justify a new engine factory.
- The `AnimationPlayer` timeScale clobber is a pre-existing engine defect with a single local
  workaround; it is its own bug, not this extraction.
- Low-detail material/texture averaging and ship/ocean/effects look are appearance — game-owned.

### Task checkouts (ownership, base, cleanup)

| Task | Primary owner | Checkout path | Branch | Base SHA | State |
| --- | --- | --- | --- | --- | --- |
| Engine capability | `threenative-engine` | `/home/joao/projects/threenative/threenative-engine/.worktrees/midway-merge-attributes` | `feat/merge-parts-preserve-channels` | `166ac9ffb63a99045a6d4387d4bf2ecaff2aed7e` (local `develop`) | retained: 2.4G; local commit, unmerged; cleanup pending |
| Game integration | `sandbox` | `/home/joao/projects/threenative/sandbox/.worktrees/midway-merge-attributes` | `midway/merge-attributes` | `4404e626f65493c95a494cf86895c427b505c939` (base at task start) | retained: 1.7G; local commit, unmerged; captures retained |

Base-vs-primary note (safe `git fetch --no-tags origin develop`, 2026-09-16): engine `origin/develop`
is `488804465eaf2a0cb0fad99f832d51d2fc6fbd68`, an ancestor of local `develop`; local `develop`
carries 17 commits the remote does not, 0 the other way, so `develop` is the freshest correct base.
Sandbox local `develop` equalled `origin/develop` at task start; the remote advanced during this task. No primary tree was switched, reset or merged. Both task owners have finished, and the task Vite server on port 5399 was stopped and verified absent. Checkouts are retained because their commits are unmerged and contain required local evidence; no deletion or remote push was performed. The engine base includes 17 unrelated local commits ahead of remote `develop`, so publishing that history is outside this extraction.

## Acceptance criteria

- [x] AC-1 [local; actor: agent]: `mergeParts` keeps `uv` and/or authored `normal` when requested and refuses a listed-but-absent channel, while the unrequested default is unchanged — Evidence: E1a real red 6 failed/10 passed, then 16/16 green after implementation; remains 16/16 after the review simplification (`pnpm exec vitest run packages/core/__tests__/merge-parts.spec.ts`, exit 0).
- [x] AC-2 [local; actor: agent]: the three Midway merge sites run through `mergeParts`, their duplicate loops are deleted, and the game builds and renders the affected ships/aircraft/atoll with no visual regression — Evidence: E2a `pnpm typecheck` exit 0 and `vite build` exit 0 with final source; E2b capture-fleet PASS on baseline and final with the corrected hull contract; E2c hashed tarball + repointed install; Devastator position/normal/uv digest identical baseline=final=`7d919a23`.
- [x] AC-3 [local; actor: agent]: capability search returns `mergeParts` for the batching query, and the generated manifest/reference/mirrors expose the new situations, constraints, override and example — Evidence: E1b `engine-mcp` search 49/49 with the query asserted in both `mechanic` and `request` scope; `capabilities:sync`/`capabilities:check`/`check:docs`/`sync:agents` all exit 0.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `mergeParts` preserves requested channels | Public export `mergeParts` (`packages/core/src/index.ts`), live consumers `src/render/airframe-lod.ts` (`mergeLod`) and `src/render/devastator.ts` (`batch`); `src/render/assets.ts` (`consolidate`) also migrated but is exported-and-unused by the shipped game | Supersedes `consolidate`, `mergeLod` and `batch`; each local loop deleted | AC-2 / E2 |
| Capability discovery for the existing entry | `engine_search_capabilities` / `pnpm caps:recall` over generated `packages/create-threenative/capabilities.json` | Extends the existing `mergeParts` entry; no competing entry added | AC-3 / E1 |
| Packaged consumption | Game `package.json` `file:` dependency on the hashed `@threenative/core` tarball in `.packages/` | Game stops straddling a hand-written copy and a published package | AC-2 / E3 |

## Execution phases

#### Phase 1: `mergeParts` keeps requested UV/normal channels and discovery finds it
**Status:** DONE
**ACs:** AC-1, AC-3
**Files:** `packages/core/src/merge-parts.ts`, `packages/core/src/index.ts`,
`packages/core/__tests__/merge-parts.spec.ts`, `packages/engine-mcp/__tests__/search.spec.ts`, and
the regenerated `packages/create-threenative/capabilities.json`, `packages/core/capabilities.json`,
`packages/create-threenative/agent-docs/references/capability-reference.md`, context surface table
and `CLAUDE.md` mirrors; plus the starter template `packages/create-threenative/templates/starter/AGENTS.md`
entry and its generated `CLAUDE.md` mirror.
**Implementation:** Add `preserve` to `IMergePartsOptions`; teach `flatten` to keep each requested
channel (dense rebuild, interleaved-safe) and throw naming the label, channel and part index when
absent; skip `computeVertexNormals()` only when `"normal"` is preserved; leave the default path
untouched. Add the discovery JSDoc and regenerate. Post-review simplification: no `IFlattenOptions`
wrapper — `flatten(part, paint, preserve)` — and "welded" corrected to "merged" in the new prose.
**Verification:**
- [x] E1a — Red then green: `pnpm exec vitest run packages/core/__tests__/merge-parts.spec.ts`. Observed red first at 6 failed / 10 passed, then 16/16 green; still 16/16 (exit 0) after the review simplification.
- [x] E1b — `pnpm capabilities:check && pnpm check:docs && pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`: all exit 0; search 48/48 before the review, 49/49 after the batching query was asserted in both `mechanic` and `request` scope. `capabilities:sync` exit 0 (299 entries), `sync:agents` exit 0 (19 mirrors, 0 written).
- [ ] E1c — `pnpm typecheck` exit 0; `pnpm lint` exit 0 (warnings only); `pnpm tsx scripts/count-loc.ts` exit 0; `pnpm budgets` exit 0; `packages/core` + `packages/engine-mcp` vitest 126 files / 1471 tests pass. **Open:** repo-root `pnpm test` exits 1 solely in `packages/runtime-native` (21 failures; see Open gaps) — the required full-suite gate is not green.
**Checkpoint:** partial

#### Phase 2: three Midway merge paths run through the packaged engine, frames inspected
**Status:** DONE
**ACs:** AC-2
**Files:** `midway-open-pacific/src/render/assets.ts`, `src/render/airframe-lod.ts`,
`src/render/devastator.ts`; new `midway-open-pacific/docs/abstraction-ideas-merge-attributes.md`;
game `package.json` dependency repoint; game `tools/check-merge-parts.mjs` (new) and
`tools/capture-fleet.mjs` (stale LOD assertion repaired).
**Implementation:** Migrate the three call sites to `mergeParts` with `preserve: ["uv","normal"]`,
preparing any genuinely missing channel in game data before the call, and delete `consolidate`'s,
`mergeLod`'s and `batch`'s duplicated merge loops. Post-review: `assets.ts` batches through the
public `IMergePart[]` with the zero-uv clone tracked and disposed; `devastator.ts` keeps no
missing-channel fallback because every procedural geometry already carries normal+uv (trace +
digest below), so the old after-transform `(0,1,0)` fallback was dead code, not a semantic to
preserve. Build and pack `@threenative/core` into `.packages/` with a content-hash tarball name,
repoint the game's `file:` dependency, `pnpm install`, and remove the hand-written copies. Record
rejected candidates in the new game doc.
**Verification:**
- [x] E2a — In the isolated game worktree: `pnpm typecheck` exit 0 and `pnpm exec vite build` exit 0 (final source). The three migrated entry points are reached: hull/airframe LOD and Devastator batch in-world, `consolidate` directly (exported, unused — see scope note).
- [x] E2b — Baseline-vs-after: `tools/capture-fleet.mjs` under `tools/capture-lock.sh` against the served worktree. Baseline source run exit 0 → `screenshots/fleet-lod-baseline-20260916-145737`; final source run exit 0 → `screenshots/fleet-lod-final-20260916-145809`; both PASS the same corrected hull contract (`Arashi` imported, body+merged stand-in, position/normal/uv, radius 60.05, exactly one level visible). Existing `screenshots/baseline-merge-attrs-20260916-141843` and `screenshots/after-merge-attrs-20260916-142811` were previously inspected for fleet/deck frames; the procedural Devastator is proven numerically instead of by a new pixel baseline: `tools/check-merge-parts.mjs` reports Devastator merged position/normal/uv digest `7d919a23` identical baseline and final.
- [x] E2c — `pnpm --filter @threenative/core exec pnpm pack --pack-destination …` produced a tarball renamed with its SHA-256 prefix: `.packages/threenative-core-0.3.2-merge-attrs-7252ad0b7480.tgz` (sha256 `7252ad0b7480…`). The game dependency + override point at that exact file, `pnpm install` exit 0, and `tools/check-merge-parts.mjs` re-verified the hash and the resolved module's real `mergeParts` behaviour (refuses a listed missing channel; keeps a present one). No stale cache: the dev server re-optimised after the lockfile change.
**Checkpoint:** done

## Review corrections (2026-09-16 resumed arm)

Parent review of the first pass raised five items; all are applied and re-verified:

1. **Core API slimmed.** The internal `IFlattenOptions` wrapper was removed (`label`/`index` were
   never read); `flatten(part, paint, preserve)`, and the new prose says **merged**, not "welded"
   (no vertex welding happens). Engine typecheck exit 0, core spec 16/16.
2. **Discovery regression exercises the real scope.** The batching query is asserted in both
   `mechanic` (the original miss) and `request` with one parameterised test body; engine-mcp search
   49/49. Generated manifest/reference/mirrors and the starter `AGENTS.md` entry stay accurate.
3. **Game adapters simplified, dead fallback removed.** `assets.ts` batches through `IMergePart[]`
   and disposes the zero-uv clone after the merge. `devastator.ts`'s new missing-normal fallback was
   removed rather than reordered: every procedural geometry already carries normal+uv (`Box`,
   `Sphere`, `Cylinder`, `Tube`, `Torus`, `Extrude` generate both; `geometry()` calls
   `computeVertexNormals` and writes uv), so the old after-transform `(0,1,0)` fallback was dead
   code. Proof: `tools/check-merge-parts.mjs` bit-digests the merged Devastator position/normal/uv
   buffers for baseline and final source and both are `7d919a23`; 81 live `*_details` meshes carry
   uv+normal. Shared source geometry is no longer mutated.
4. **Honest cost.** Non-comment implementation LOC (additions minus deletions; the engine `index.ts`
   edit is comment-only, +0): `merge-parts.ts` +28/−7 (net +21), `assets.ts` +18/−16 (net +2),
   `airframe-lod.ts` +11/−28 (net −17), `devastator.ts` +11/−22 (net −11) → **net −5 LOC** for one
   mechanism replacing three divergent hand-written loops. `assets.ts` carries no wrapper: the
   missing-uv zero-fill is inline in the existing branch (numeric-length `Float32BufferAttribute`
   allocation), so the one-use helper it replaced is gone, not reworded. Engine default path unchanged.
5. **`check-merge-parts.mjs` claim corrected.** `assets.consolidate` is an exported **currently
   unused** builder path; its `makeIsland`/`makeCrew` output is verified by a direct call and
   explicitly not presented as live gameplay. The two live consumers are hull/airframe LOD and the
   Devastator batch. The weak "served bundle contains 'to preserve'" check is gone; provenance is
   now the game's hashed tarball (sha256 verified) plus the resolved package's real `mergeParts`
   behaviour.

## Verification repair: stale fleet LOD assertion

`tools/capture-fleet.mjs` asserted `THREE.LOD.levels`, a contract this game had already stopped
using on the base. It now asserts the current game-owned hull LOD contract with equal coverage.
Run under `tools/capture-lock.sh`: **baseline source exit 0**
(`screenshots/fleet-lod-baseline-20260916-145737`) and **final source exit 0**
(`screenshots/fleet-lod-final-20260916-145809`) both PASS, so the repaired check is proven against
the base it describes, not weakened after the fact.

## Open gaps

- **Root `pnpm test` gap (the one open Phase 1 box).** The repo-root suite exits 1 **only** in
  `packages/runtime-native` (6 files, 21 tests). 18 fail on the absent opt-in host build under
  `build/tn-linux{,-quickjs}` (`threenative-timestamp-query-test`, `-crash-handler-policy-test`,
  `-rg11b10-renderable-test`, `-canvas2d-dirty-test`, the `mystral` host for `pump-silence`); 3 fail
  on the missing host `zip` (`desktop-finalization`). Setup is `pnpm native:build` plus a distro
  `zip` install. No failure is in a package this change touches; `packages/core` +
  `packages/engine-mcp` vitest is 126 files / 1471 tests pass. No native platform is claimed.
- `capture-deck.mjs` was not re-run this pass; the affected render paths are covered by
  capture-fleet (hull LOD) and the Devastator digest. Baseline deck frames from the first pass
  remain at `screenshots/baseline-merge-attrs-20260916-141843`.
- `assets.consolidate` remains exported-but-unused; the extraction removed its loop but it is not
  live gameplay evidence. Nothing in this PRD claims otherwise.

## Risks and rollback

- Discovery relevance floor: new situations must clear `RELEVANCE_FLOOR` for the tested query; the
  search test fails if they do not.
- Missing-channel strictness could reject a real imported mesh whose uv is absent; each site's
  actual attribute presence is traced in Phase 2 and any needed fill stays a game data decision.
- Rollback is reverting the two lane branches; the engine default path is unchanged and the game
  change is local to three files.

## Closability

LOW budget is 8 required boxes; this PRD carries 9. The extra box is AC-3's discovery outcome — a
distinct failure mode from the behavior and integration boxes — so it is retained rather than
merged, and every other box is required. All boxes are `local`; no shared, owner or unreachable
gates. This PRD cannot be marked DONE with any required gate unrun.
