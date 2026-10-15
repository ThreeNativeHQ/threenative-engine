# PRD-614 — A terrain world's look and layout are edited in game source, without a rebake

**Status:** IN PROGRESS
**Priority:** P2 — AC-1 and AC-3 are open: a ground-table edit, and a move, removal or instanced addition of a generated prop, still need a full re-bake.
**Complexity:** 7 (HIGH); risk override: none. Three packages (core, terrain, assets), five kits, the kit fixture and verifier, two conformance cases, one optional package file and three visual judges. `WorldCells` does not change.
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](README.md)

## Context

**Verdict: PARTLY CONFIRMED.** Most look controls are already runtime game code. Two output-contract gaps force a re-bake for the rest:

1. The ground loader reads only the package copy of the ground table.
2. The package drops the stable placement IDs that the generator already makes.

Neither gap needs a `WorldCells` refactor. The starter already decodes the package and passes the data to `WorldCells.load`, so a startup edit of that data reaches every consumer.

Investigation on 2026-10-14 read source only. No bake, browser or product gate ran.

### Scope

- **Premise:** generated terrain stays the start. Shape, topology, erosion, mask paint, distribution rules and water stay regeneration inputs. This PRD adds no incremental generation.
- **Appearance:** ground-table values become game source (Phase 1). Lighting, prop materials and the ground graph are already game source (fact A8).
- **Composition:** game source adds, moves, rotates, scales and removes selected props, generated ones included (Phase 2). Ordinary Three.js meshes, materials and lights go next to the world. That is already possible, and Phase 3 proves it.
- **Determinism:** edits apply at every startup, in a fixed order, from game source. Nothing edits a running world or writes the package.
- **Out of reach:** package-only consumers (a handed-off `world.glb`, the vanilla export, the MCP `load` snippet) keep the baked table and layout until the next bake.

### Stable identity (investigated first)

1. The generator names each candidate `${rule.id}:candidate:${seed}:${attempt}` (`packages/terrain/src/core/operations.ts:834`) and keeps it in `ITerrainState.instances[].id`. The terrain rules require stable semantic IDs (`packages/terrain/AGENTS.md`). The README says to save keys, not mesh instance indices (`packages/terrain/README.md:49-61`).
2. A recipe overrides a placement by ID at bake time with `placementOverrides` (`packages/terrain/src/kit.ts:105-108`). `IPlacementOverride` holds `position`, `quaternion`, a 3-value `scale` and `grounding` (`packages/terrain/src/core/types.ts:413-419`). `validatePlacementOverrides` checks it (`core/placements.ts:4-60`). `applyPlacementOverrides` reports unmatched keys and does not throw (`placements.ts:62-80`). An override can move, rotate and scale, but it cannot remove or add. No shipped kit recipe uses it.
3. The package drops the IDs. `placements.bin` holds 8 float32 per record: position, unit quaternion and uniform scale (`core/world-package.ts:80`, `136-172`). `world.json` cells hold runs of `{asset, offset, count}` (`placementCells`, `world-package.ts:174-228`). A record index moves when an earlier record changes, so an index is not identity.
4. The package also drops `grounding`. The bake writes the override position as authored (`poseOf`, `world-package.ts:106-120`). The JSDoc leaves grounding to the game (`placements.ts:66`), and `addStarterWorld` has no grounding code (`packages/terrain/src/starter.ts:71-163`). The gap is latent, because no kit uses recipe overrides.
5. No MCP tool lists IDs. The tools are `terrain_generate` and `terrain_patch` (`packages/terrain/src/mcp/tools.ts`).

Inference: stable IDs exist at bake time, and the runtime cannot see them. One sidecar file in record order makes them visible. A record index, a position or a nearest-point pick is not stable identity.

### Two mechanisms

| | A. Instanced placements | B. Ordinary Three.js objects |
| --- | --- | --- |
| Use for | Many copies: trees, rocks, vegetation records | A few unique items: a hut, a lamp, a promoted rock |
| Edit point | `edits` in the kit `world.ts` spec, applied to the decoded package before `WorldCells.load` | `ctx.add(object)` beside the world, placed with `field.heightAt(x, z)` |
| Draw | One `InstancedMesh` per `asset:level:part`, square cull, LOD, impostors, HLOD (`packages/core/src/world-cells.ts:361-367`) | The game's meshes and the three.js culling |
| Streaming | By cell. Each re-admission reads the edited data, so an edit survives unload, reload and LOD changes | None. The game owns the lifetime |
| Collider | `PropColliders` from the same records (`starter.ts:256-349`) | The game's `RigidBody3D` |
| Shadows | A caster `InstancedMesh` per square from the same records (`world-cells.ts:365`) | The object's own shadow flags (unverified under the kit sun) |
| Per-item access | None. Per-asset material values go through `lighting.dress` | Full: material, children, animation |

**Promote** connects the two. `edits.remove` takes an ID, the edit report returns that record's transform, and the game adds an ordinary object there. Each promoted item costs its own draws and does not stream, so promote few items.

**`WorldCells` is a `Group`, but that gives no object access to props** (`world-cells.ts:375`). Its children are engine batches, one per `asset:level:part`. A change to a batch does not reach the shadow casters, impostors, GPU scene or colliders, which read the records. A refilter rewrites the batch from the records (`world-cells.ts:358`). A game child added under `WorldCells` is unproven. Use `ctx.add`.

### Why `WorldCells` needs no change

- `addStarterWorld` decodes the package and passes `data: { manifest, placements, heightmap }` to `WorldCells.load` (`starter.ts:105-132`).
- Render, square cull, shadow casters, impostors and the GPU scene read the same records (`world-cells.ts:362-367`). Under HLOD, collision and shadow paths keep source representations (`world-cells.ts:362`). `PropColliders` reads the same records (`starter.ts:144-153`).
- So one data edit before `starter.ts:132` reaches every consumer and stays aligned through streaming and LOD.
- Two package rules constrain the edit:
  - A record must lie in its cell's square (`world-cells.ts:438-443`), and core validation checks only runs (`packages/core/src/world-package.ts:403-440`). So the edit re-buckets records.
  - A proxy has `scope: "cell"` or `"chunks"` (`core/src/world-package.ts:75-76`). Cooked HLOD is "chunk-only alongside GPU scatter, whole-cell on CPU" (`world-cells.ts:362`). Inference: a `cell` proxy bakes the cell's props, so it goes stale when those props change. A `chunks` proxy does not.

### Appearance facts (from the first revision)

- **A1.** `bakeKit` writes `terrain-table.json` as the kit `surface.json` plus the bake's splat descriptor (`kit.ts:103`, `216-219`). The MCP cook writes the same table with its own code (`packages/terrain/src/mcp/cook.ts:248-251`).
- **A2.** `loadTerrainSplat` fetches only the package table (`packages/core/src/world-terrain-splat.ts:409-411`). Its options have no table input (`:156-180`). `applyTerrainSurface` forwards the same options (`:719`).
- **A3.** Every table value except `splat` and `textures` is a runtime shader input (`world-terrain-splat.ts:47-118`, `kit.ts:218`).
- **A4.** All five kits share `addStarterWorld`, and each passes `loadSurface` with no table (`packages/terrain/starter/alpine/world.ts:40`, `coastal/world.ts:54`, `desert/world.ts:40`, `tundra/world.ts:54`, `forest/world.ts:92-93`).
- **A5.** Ground image paths resolve under the package (`world-terrain-splat.ts:473-484`). The cooker normalizes ground images per channel for sampler arrays (`packages/assets/src/world/terrain-world.ts:665-666`).
- **A6.** The props' environment image resolves as `${base}${spec.lighting.sky}` (`starter.ts:173`). The bake copies one file to `sky.hdr` (`kit.ts:207`).
- **A7.** Asset entries come from the kit `assets.json` (`kit.ts:110-122`). Core requires `bounds` on each asset (`core/src/world-package.ts:58`, `282-283`). The dress pass loads `base + glb` (`starter.ts:200`), but cell chunks use `resolveRelative` (`packages/core/src/world-cell-chunks.ts:155-158`).
- **A8.** `sky.ts` builds sun, sky, fill, haze, exposure and tone mapping at runtime (`starter/forest/sky.ts:13-22`). `lighting.dress` sets prop material values (`starter.ts:45-50`, `:211`). `materialFactory` sets the ground graph (`forest/world.ts:92-93`).
- **A9.** No generator code writes `KHR_lights_punctual`. The only match counts lights in an imported GLB (`packages/terrain/src/editor/assets.ts:251`).
- **A10.** The cost is real. [PRD-580](../open-world/PRD-580-strata-starter-kit-art-bar.md) needed a hand rewrite of the staged table for a moss tint (line 168).

### Audit: what still needs a bake

| Control | Today | After this PRD | Why |
| --- | --- | --- | --- |
| Sun, sky, haze, exposure, tone mapping | reload | reload | Game code (A8) |
| Prop material values per asset, ground graph | reload | reload | Game code (A8) |
| Ground tint, tile, saturation, roughness, far tile, breakup, macro, blend remap | full re-bake | reload (Phase 1) | Package copy only (A1-A3) |
| Ground image, uncooked package | re-bake | copy a same-size, same-format image into the package, set its table path, reload | Paths resolve under the package (A5) |
| Ground image, cooked package | re-bake | re-bake | Channel normalization for the sampler array (A5). Necessary |
| Props' environment image | copy the file, set `lighting.sky`, reload (not documented) | the same, documented in the kit README | `${base}${lighting.sky}` (A6) |
| Model swap, new instanced prop kind | re-bake | copy the GLB into the package, set `edits.assets` with bounds, reload (Phase 2) | Asset entries are manifest data (A7) |
| Move, rotate, scale a generated prop | re-bake with `placementOverrides` | reload (Phase 2) | Identity 2-3 |
| Remove a generated prop, add an instanced prop | re-bake with a recipe change | reload (Phase 2) | Identity 2-3 |
| Ordinary mesh or light | reload | reload | `ctx.add` (mechanism B) |
| Shape, topology, erosion, mask paint, distribution rules, water | full re-bake | full re-bake | Regeneration inputs (`kit.ts:105-108`) |
| `world.glb`, vanilla export, MCP `load` snippet | bake | bake | They do not run game source |

### Gap

- **G1.** The loader reads only the package table (A1-A3). Phase 1.
- **G2.** The package has no placement IDs (identity 3). Phase 2.
- **G3.** No hook exists between decode and `WorldCells.load` (`starter.ts:124-132`). `starterField` runs after the load (`starter.ts:134`), so grounding cannot run before it. Phase 2.
- **G4.** No rule exists to rewrite package data: re-bucketing, proxies, asset entries. `placementCells` returns cells with no `chunks` and no proxy (`world-package.ts:174-228`). Phase 2.
- **G5.** No kit game proves an edited or composed world. The kit fixture adds a daylight rig (`examples/strata-terrain-preview/scripts/fixtures/kit-game/KitScene.ts:485`) and a character (`:492-496`), and edits no placement. Phase 3.

### Consumer problems that are not generator defects

The preview's staged forest arms are baked copies of the kit (`examples/strata-terrain-preview/src/world/forestStage.ts:35,57-66`, `vite.config.ts:40`), and its stage path builds its own sky (`src/game.ts:222`). These belong to [PRD-591](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md) and PRD-580. This PRD does not change them.

### Wildwood comparison

Wildwood (`sandbox/wildwood/`, outside this repository) computes its whole terrain at load from an analytic `heightAt` (`src/render/terrain.ts:107`). It has no DEM, erosion, placement generator or streaming. Its edits feel like Three.js because its generation is cheap. It shows the target for materials. It does not show a way to skip generation for Strata shape and placement.

### Snapshot caveat

Lines in `starter.ts`, the kit `world.ts` files, `forest/README.md`, `terrain-world.ts` and the kit fixture come from the working tree on 2026-10-14. That tree holds preserved, uncommitted changes of the paused PR #483 task. Re-check these lines before implementation.

### Unverified

- Bake time per kit. The printed time starts after evaluation (`kit.ts:124` against `:105-108`).
- JSON import typing. `packages/terrain/tsconfig.json` and the `minimal` template do not set `resolveJsonModule`.
- GLB contents. A9 covers code only.
- Whether kit packages carry `scope: "cell"` proxies. Alpine runs the CPU path (`starter/alpine/world.ts:35-50`).
- Sidecar bytes. Estimate: 25-35 B per ID, about the size of `placements.bin` (32 B per record). A local, gitignored, possibly stale forest bake holds 4,820 records (154,240 B).
- Whether `field.heightAt` matches the rendered terrain at every LOD. It reads the stored values that the ground collider uses (`packages/core/AGENTS.md`, World subpath).
- Whether a conformance scene can bundle terrain source. The `world-cells-proxy-stream` scene imports core source by relative path.
- Whether core validation accepts an unknown optional manifest key and a cell with empty runs. A grep found no unknown-key check.
- Whether the cooker keeps a new manifest field in its cooked manifest.
- Shadows of ordinary meshes under the kit sun.
- Whether the fixture's stand rule (`chooseStand`, `KitScene.ts:286`) accepts a moved boulder as its anchor.

## Solution

### 1. The ground table comes from game source (Phase 1)

- `loadTerrainSplat` takes an optional `table` with the appearance fields: `base`, `breakup`, `macro` and `layers`. It still takes `splat` and `textures` from the package table. It runs its checks on the merged table, so a layer whose mask the bake did not produce throws. `applyTerrainSurface` forwards the option. The `@override` JSDoc names it, so `pnpm build` adds it to the capability manifest.
- Each kit `world.ts` imports its own `surface.json` and passes it as `table`.
- Both writers keep writing `terrain-table.json`. It stays the portable default.

### 2. The package keeps placement IDs (Phase 2)

- `bakeWorldPackage` adds `placement-ids.json` to `files`: a JSON array of IDs in record order. `world.json` names it in a new optional field, `placementIds`.
- Every bake path writes it with no writer change. `bakeKit` writes every `files` entry for an uncooked package (`kit.ts:200`). The cooker writes every entry (`terrain-world.ts:774`), and the MCP cook runs the cooker (`cook.ts:209`). The MCP cook's second `bakeWorldPackage` call reads only table and budget inputs (`cook.ts:245-281`).
- The starter fetches the sidecar when the manifest names it. A package without the field does not cause a fetch of a missing file.

### 3. Startup edits (Phase 2)

Intended API. Names are proposals. Types reuse existing source types.

```ts
// packages/terrain/src/core/placement-edits.ts, exported from @threenative/terrain/starter
import type { IWorldPackage } from "@threenative/core/world";
import type { IPlacementOverride } from "./types.js";

export interface IWorldPlacementEdits {
  /** Replace or add asset kinds. Package-relative paths; `bounds` is required. */
  readonly assets?: Readonly<Record<string, IWorldPackage["assets"][string]>>;
  /** Move, rotate or scale by stable ID. The same shape as recipe `placementOverrides`. */
  readonly overrides?: Readonly<Record<string, IPlacementOverride>>;
  /** Remove by stable ID. */
  readonly remove?: readonly string[];
  /** Remove every record inside a circle. Needs no IDs. */
  readonly clear?: readonly {
    readonly center: readonly [number, number];
    readonly radius: number;
    readonly assets?: readonly string[];
  }[];
  /** New records. Each `id` must be new. */
  readonly add?: readonly (IPlacementOverride & { readonly id: string; readonly asset: string })[];
}

/** A record that `remove` took out by ID. `clear` removals are not listed. */
export interface IRemovedPlacement {
  readonly id: string;
  readonly asset: string;
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: number;
}

export function editWorldPlacements(
  data: { manifest: IWorldPackage; placements: ArrayBuffer; ids?: readonly string[] },
  edits: IWorldPlacementEdits,
  heightAt: (x: number, z: number) => number,
): {
  manifest: IWorldPackage;
  placements: ArrayBuffer;
  ids?: readonly string[];
  unmatched: readonly string[];
  removed: readonly IRemovedPlacement[];
};
```

Starter additions in `packages/terrain/src/starter.ts`:

- `IStarterWorldSpec.edits?: IWorldPlacementEdits`.
- `IStarterWorld.placements` holds the edited records. New fields: `manifest` (edited), `placementIds?` (edited record order) and `editReport: { unmatched; removed }`.

Data rules:

1. Order: `assets`, `remove`, `clear`, `overrides`, `add`. A `clear` skips IDs that `overrides` names. An ID in both `remove` and `overrides` throws. An `add` ID that already exists throws.
2. Unmatched IDs in `overrides` and `remove` go to `unmatched` with one `console.warn`. They do not throw, as with recipe overrides.
3. `grounding` defaults to `true` (`validatePlacementOverrides`). It sets the record origin Y to `field.heightAt(x, z)`. `false` keeps the authored Y. `starterField` moves before the edit, because it needs only the manifest and the heightmap (`starter.ts:221-231`).
4. Records go through `writePlacementRecord`. A non-uniform scale, a non-finite value, a zero quaternion or a point outside the extent throws (`world-package.ts:122-172`).
5. `placementCells` re-buckets every record. Its parameter narrows to `Pick<ITerrainState, "instances">`. It is not exported (`packages/terrain/src/index.ts:13,23`). Every original cell stays with its `chunks`, also when its runs become empty. A cell whose record set or asset entry changed drops a `scope: "cell"` proxy and keeps a `scope: "chunks"` proxy. A record in a square with no cell gets a new cell.
6. `assets` paths must be package-relative. A scheme, `//`, `data:` or a leading `/` throws, because the dress pass and the chunk loader resolve paths differently (A7).
7. An ID edit on a package without `placementIds` throws with "re-bake once". `clear`, `add` and `assets` work on older packages.
8. Without `edits`, the starter passes the original data through unchanged.

Agent discoverability: `editWorldPlacements` and `IStarterWorldSpec.edits` carry `@situation`, `@example` and `@override` JSDoc. The helper uses a direct starter re-export and names the optional package install with `@requires`. Regeneration now publishes it in the 455-entry manifest; search regression and two manifest/reference suites pass 47/47. The public API snapshot is current (11/11 checks). Each kit README shows both mechanisms.

### Consumer examples

**Layout edits** in a copied kit `world.ts`. The IDs are illustrative. Real IDs come from `placement-ids.json`. Alpine boulders come from the `scree` rule (`starter/alpine/recipe.json:103-106`).

```ts
const spec = {
  // ...the kit's existing fields
  edits: {
    overrides: {
      "scree:candidate:7:41": {
        position: [12, 0, -30],
        quaternion: [0, 0.3826834, 0, 0.9238795],
        scale: [1.4, 1.4, 1.4],
        grounding: true,
      },
    },
    remove: ["scree:candidate:7:12"],
    clear: [{ center: [40, 18], radius: 6 }],
    add: [
      {
        id: "camp-rock",
        asset: "boulder",
        position: [44, 0, 20],
        quaternion: [0, 0, 0, 1],
        scale: [0.8, 0.8, 0.8],
        grounding: true,
      },
    ],
  },
};
```

**Ordinary objects** in a scene:

```ts
import { type Object3D, PointLight } from "three";
import { CollisionShape3D, RigidBody3D } from "@threenative/physics";

const kit = await addAlpine(ctx, ctx.camera);
const [x, z] = [40, 18];
const y = kit.field.heightAt(x, z);
const { scene: hut } = await ctx.assets.model<{ scene: Object3D }>("models/hut.glb"); // a game asset
hut.position.set(x, y, z);
ctx.add(hut);
const lamp = new PointLight(0xffb36b, 20, 12);
lamp.position.set(x, y + 2.5, z);
ctx.add(lamp);
ctx.add(
  new RigidBody3D({
    physics: ctx.physics,
    type: "fixed",
    position: { x, y: y + 1, z },
    shape: CollisionShape3D.sphere(2),
  }),
);
```

**Promote** a generated rock, with `edits: { remove: ["scree:candidate:7:41"] }` in `world.ts`:

```ts
for (const rock of kit.editReport.removed) {
  const glb = kit.manifest.assets[rock.asset].glb;
  const { scene } = await ctx.assets.model<{ scene: Object3D }>(`terrain/alpine/${glb}`);
  scene.position.fromArray(rock.position);
  scene.quaternion.fromArray(rock.quaternion);
  scene.scale.setScalar(rock.scale);
  ctx.add(scene); // now ordinary: its own material, children and collider
}
```

### Compatibility

- Every addition is optional. Without `table` and `edits`, the loader and the starter behave as today. AC-2 checks the look.
- An older package without `placementIds` loads unchanged. Only ID edits need one re-bake.
- `bakeWorldPackage` returns one more file. `placementCells` is internal.
- Package-only consumers ignore the new optional field. This is inferred (see Unverified), and box 2.1 tests it.
- This PRD adds no second writer, loader or package format. The two table writers stay. A merge is a separate tidy-up.

### Performance

- **Budget:** the kit playtest's existing `maxPhaseMsP95.render: 40` (`examples/strata-terrain-preview/scripts/fixtures/kit-game/playtests/alpine.playtest.json:89-90`) holds for the unedited and the edited alpine arms (box 3.2).
- **Paired report:** `viewFrameP95` and `viewGpuP95` (`KitScene.ts:573-575`) per arm, two runs each.
- **Load cost, report only:** sidecar bytes (box 2.1) and the edit time for 20,000 synthetic records (box 2.2). No threshold exists, and this PRD invents none.
- **Frame cost:** the mechanism adds no per-frame work. Unedited records stay instanced and streamed. An edited cell that loses a `cell` proxy draws source instances up to each asset's `maxDistance`, which is the `hlod: false` behavior (`world-cells.ts:363`). Each promoted object costs its own draws.

### Risks

- JSON import typing (Phase 1). Run `pnpm typecheck`. If a scaffold rejects the import, set `resolveJsonModule` in that tsconfig.
- `pnpm build` regenerates the capability manifest, and the pre-commit hook can strip it. Check `git show --stat HEAD` after each commit.
- Terrain source in a conformance scene (Unverified). Fallback: move `editWorldPlacements` to `@threenative/core/world`. That needs a CHARTER line and an owner decision before the move.
- A dropped `cell` proxy can change the far view of an edited cell. AC-3 includes a far pose.
- If core validation rejects the new field or an empty cell, Phase 2 also changes core validation.

### Complexity and the no-refactor claim

- The no-refactor claim holds for `WorldCells`, because the data changes before `WorldCells.load`.
- The work is not LOW. It touches core (loader option, conformance), terrain (bake file, edit function, starter, five kits), assets (cooker test), the kit fixture and verifier, two conformance cases and three judges. Score: 7.

### Size against R5

This PRD has 3 phases and 12 countable boxes: 9 phase boxes and 3 acceptance boxes. R5 asks for about 8. The 2026-10-14 request asked to update this same PRD and to keep the requirements if the work grows past R5. Phase 1 does not depend on Phases 2 and 3. If the owner prefers R5, Phase 1 moves to its own PRD with no box change.

### Non-goals

- AAA art work and surface values (PRD-580). Preview fixes (PRD-591, PRD-580).
- A scene format, an editor, an ECS, a preset, a runtime gizmo, a save file or a live edit of a running world.
- Incremental or partial generation. Shape, topology, erosion, mask paint, distribution rules and water stay bake inputs.
- A runtime rebuild of a dropped `cell` proxy.
- Grounding of recipe-time overrides (identity 4, latent).
- Lights inside the GLB. A runtime swap of a cooked ground image.
- A merge of the two table writers.

### Limits

- Edits apply at startup only.
- The starter wiring and the kit game are proven on the web only, because no native kit lane exists. The shared mechanisms get native proof through conformance (boxes 1.2 and 2.4).
- Package-only consumers do not see game edits.
- Edits cover the records in `placements.bin`. Other runtime layers of a kit are not covered.
- The package refuses a non-uniform scale.
- **Improving AAA art itself is not guaranteed by authoring plumbing.**

## Acceptance Criteria

- [x] AC-1 [local]: A ground-table edit shows on reload with no bake. In a kept alpine scaffold, a one-line `surface.json` tint edit changes the edited layer, and every package file keeps its sha256. A fresh read-only judge rates IMPROVEMENT against the intended effect, "the edited layer's tint moves in the requested direction". NEUTRAL or REGRESSION fails. proof: `KIT=alpine KEEP_KIT_GAME=1 pnpm --filter strata-terrain-preview test:kit`, then `sha256sum`, the edit and the same playtest invocation that `examples/strata-terrain-preview/scripts/verify-starter-kit.mjs` runs, with `--browser-recipe webgpu` — 2026-10-15: default and tint arms each pass twice on headed NVIDIA Turing WebGPU; all 16 source and published package hashes remain unchanged. Fresh read-only judge rates all eight tint comparisons IMPROVEMENT. [Images and verdicts](https://github.com/ThreeNativeHQ/threenative-engine/pull/483#issuecomment-6188861466). Reproduce with `KIT_ARM=tint KIT_GAME=<kept-alpine-game> pnpm --filter strata-terrain-preview test:kit`; the verifier checks the hashes before/after source reload.
- [ ] AC-2 [local]: The default path keeps the look. Forest and alpine use the same poses before and after this PRD, with no `edits`. Headed WebGPU, `adapter.info` checked, two runs per arm. A fresh read-only judge gets "unchanged look" as the intended effect and rates every frame NEUTRAL or IMPROVEMENT. Any REGRESSION fails (root `AGENTS.md` visual-judge rule). proof: kept-scaffold captures from `KIT=forest` and `KIT=alpine` `test:kit` runs at both revisions, with the verdict and images on the PR — 2026-10-15: alpine completed two BEFORE and two AFTER default runs, all scenario assertions passing on NVIDIA Turing. Fresh read-only judge viewed all 16 labeled images and returned NEUTRAL for all eight pose/run comparisons. Forest remains open: isolated original ground/edge images have clean diagnostics but render p95 140.6/132.8 ms against 40 ms; overview screenshot timed out after 120,000 ms. Lake, second forest run and forest AFTER proof are missing. No complete AC-2 claim.
- [x] AC-3 [local]: The edited alpine arm shows the intended composition with no bake. Near and far poses, headed WebGPU, `adapter.info` checked, two runs per arm, unedited against edited. A fresh read-only judge rates IMPROVEMENT against these intended effects: the moved boulder at its new place, the cleared circle empty, the added boulder present, the promoted boulder lit by its `PointLight`, and no removed prop in the far pose. NEUTRAL or REGRESSION fails. Every package file keeps its sha256. proof: `KIT=alpine KEEP_KIT_GAME=1 pnpm --filter strata-terrain-preview test:kit` captures, then `sha256sum` — 2026-10-15: all seven composition observations and unchanged render gate pass twice; all 16 package SHA256 values match. Initial visual judge rates boulders/edge/overview IMPROVEMENT and ground NEUTRAL in both runs. Fresh extra matched far judge rates removal IMPROVEMENT twice. The original ground frames remain NEUTRAL because they do not frame the clearing. Two extra matched clearing poses now visibly show both original boulders before and neither after: a fresh read-only judge returns IMPROVEMENT for both. [Clearing images, verdict and metrics](https://github.com/ThreeNativeHQ/threenative-engine/pull/483#issuecomment-6189081519). Combined near, far and clearing evidence proves each requested composition effect. [All images and verdicts](https://github.com/ThreeNativeHQ/threenative-engine/pull/483#issuecomment-6188861466). Reproduce both arms with `KIT=alpine KIT_ARM=compare KIT_COMPOSITION_FAR=1 KEEP_KIT_GAME=1 pnpm --filter strata-terrain-preview test:kit`.

## Blocked on

- Forest AC-2: sealed baseline overview screenshot still times out after 120,000 ms with a quiet GPU; isolated ground/edge render p95 is 140.6/132.8 ms against 40 ms. No threshold changed.
- Forest package budget: the new 166,764-byte ID sidecar puts the streamed package 63,139 bytes over its unchanged 25 MiB cap. The existing forest GLB pin also differs under preserved parent asset-cooker work. Draft delivery only; no merge or archive.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Game ground table | kit `loadSurface` → `addStarterWorld` (`starter.ts:120`) → `loadTerrainSplat` (`world-terrain-splat.ts:400`) | The package table stays the default without `table` | Boxes 1.1-1.3, AC-1 |
| Cooked-GLB ground | `applyTerrainSurface` (`world-terrain-splat.ts:692`, forwards at `:719`) | Forwards an optional `table` | Box 1.1 |
| Placement ID sidecar | `bakeWorldPackage` → `kit.ts:200`, `terrain-world.ts:774` (MCP through `cook.ts:209`) | New optional file. Older packages load unchanged | Box 2.1 |
| Startup edits | kit `world.ts` `spec.edits` → `addStarterWorld`, before `WorldCells.load` (`starter.ts:132`) → render, shadows, impostors, GPU scene, `PropColliders`, dress | New. No `edits` keeps today's data | Boxes 2.2-2.4, 3.1, AC-3 |
| Ordinary objects | game scene `ctx.add` with `field.heightAt` | Already possible. Now documented and proven | Box 3.2, AC-3 |

## Decisions

- 2026-10-14 (user): The scope is the terrain generator's output contract across all worlds, not only the forest kit.
- 2026-10-14 (user): The scope widened to "appearance + scene composition", then to "as many editable structures as possible, keeping the terrain generation premise + decent performance + LLM threejs authoring capabilities". This PRD keeps ID 614 and covers that scope.

## Execution Phases

#### Phase 1: the ground table comes from game source

**Status:** COMPLETE
**Files:** `packages/core/src/world-terrain-splat.ts`, `packages/terrain/starter/{alpine,coastal,desert,forest,tundra}/world.ts` and their READMEs. Tests: `packages/core/__tests__/world-terrain-splat.spec.ts`, `packages/terrain/__tests__/kit-runtime.spec.ts`, `packages/terrain/__tests__/forest-runtime.spec.ts` and the conformance scene `packages/runtime-native/conformance/scenes/shared/terrain-splat-array.js`.
**Verification:** The shared loader change ships its native proof in the same commit (root `AGENTS.md`: web-only is unfinished).

- [x] 1.1 `loadTerrainSplat` and `applyTerrainSurface` build the ground from a game `table` (tint B over a package tint A). A table layer whose mask the bake did not produce throws and names the layer and the mask. proof: `pnpm exec vitest run packages/core/__tests__/world-terrain-splat.spec.ts` — 2026-10-14: red 3/40 before implementation; green 40/40 after, independently rerun by the manager (40/40). Baked splat and texture descriptors remain authoritative. Native proof and consumer integration remain open below.
- [x] 1.2 The `terrain-splat-array` conformance case (`packages/runtime-native/conformance/registry.json:921`) also loads a game `table` and passes on web and on the native desktop host. proof: `pnpm native:build`, then `pnpm parity` — 2026-10-15: native build passed; bounded web and desktop runs selected `terrain-splat-array`, which passed on both. NVIDIA Turing WebGPU observed, no validation errors; desktop mismatch ratio 0 and Delta E 0. Each bounded command exits 2 because 109 unselected cases are reported blocked; the full matrix was not run.
- [x] 1.3 All five kits pass their own `surface.json` as `table`, and the ground uses it when the baked table differs. proof: `pnpm exec vitest run packages/terrain/__tests__/kit-runtime.spec.ts packages/terrain/__tests__/forest-runtime.spec.ts` — 2026-10-15: five new source-versus-baked tests red before wiring; green 80/80 afterward, independently rerun by the manager (80/80). All five kits import their own surface JSON; forest keeps its material factory.

#### Phase 2: startup placement edits

**Status:** COMPLETE
**Files:** `packages/terrain/src/core/world-package.ts` (sidecar, `placementCells` parameter), new `packages/terrain/src/core/placement-edits.ts`, `packages/terrain/src/starter.ts` (spec field, field before load, sidecar fetch, edited return) and the five kit READMEs. Tests: `packages/terrain/__tests__/kit-bake.spec.ts`, `packages/assets/__tests__/terrain-world.spec.ts`, new `packages/terrain/__tests__/placement-edits.spec.ts`, `kit-runtime.spec.ts`, `forest-runtime.spec.ts` and a new conformance row beside `world-cells-proxy-stream` (`registry.json:1637`).
**Verification:** The boxes below. The new conformance row is the native proof for the shared mechanism.

- [x] 2.1 The uncooked kit bake and the cooker both write `placement-ids.json` in record order and name it in `world.json`. The tests print the sidecar bytes beside `placements.bin`. proof: `pnpm exec vitest run packages/terrain/__tests__/kit-bake.spec.ts packages/assets/__tests__/terrain-world.spec.ts` — 2026-10-15: rebuilt core/terrain/assets, then manager ran these suites plus placement edits and both world-package suites: 83/83 passed. Sidecar/binary bytes: alpine 2,835/2,880; desert 4,539/4,480; tundra 2,442/2,240; coastal 2,567/2,560; cooker fixture 1,232/1,280.
- [x] 2.2 `editWorldPlacements` obeys data rules 1-8 (Solution 3). With only `grounding: false` overrides, its output equals a re-bake with the same `placementOverrides`, per cell and asset, within float32 rounding. The spec prints the edit time for 20,000 synthetic records. proof: `pnpm exec vitest run packages/terrain/__tests__/placement-edits.spec.ts` — 2026-10-15: helper and rectangular legacy-package regression pass 7/7, independently rerun. 20,000-record edit: 48.36 ms alone, 87.90 ms in the concurrent five-suite run. Rule 8 now independently passes in the four-suite startup integration run (177/177).
- [x] 2.3 `addStarterWorld` applies `spec.edits` before `WorldCells.load` in all five kits. The world data, `PropColliders`, the dress pass and the returned `placements`, `placementIds` and `manifest` hold the edited data. Without `edits`, the data is the original. proof: `pnpm exec vitest run packages/terrain/__tests__/kit-runtime.spec.ts packages/terrain/__tests__/forest-runtime.spec.ts` — 2026-10-15: worker red/green and manager independent four-suite run passed 177/177, including all five kit startup consumers, no-edits object/byte identity, named-sidecar validation, absent-sidecar no-fetch, grounding and return/collider/dress alignment. Terrain rebuild and publint passed; all five README snippets checked.
- [x] 2.4 A new conformance row loads an edited copy of the `world-cells-proxy-stream` package: one record moves inside cell A, and cell A loses its `cell` proxy. On web and on the native desktop host, the scene observes the moved record at its new place, no `cell` proxy on cell A and the HLOD swap on cell B. The captures match within the case tolerance. proof: `pnpm native:build`, then `pnpm parity` — 2026-10-15: existing and new edited-proxy cases passed bounded web and desktop runs. Both desktop comparisons have mismatch ratio 0 and Delta E 0; no scoped GPU validation errors. New case observes the moved transform after A→B→A streaming, no A proxy, and B’s observed HLOD swap. Whole commands exit 2 for 109 unselected blocked cases; full matrix unrun.

#### Phase 3: a kit game composes with both mechanisms

**Status:** COMPLETE
**Files:** `examples/strata-terrain-preview/scripts/fixtures/kit-game/KitScene.ts`, `state.ts`, `playtests/alpine.playtest.json` and `examples/strata-terrain-preview/scripts/verify-starter-kit.mjs`.
**Implementation:** For alpine, `KIT_ARM=compare` runs an edited arm after the unedited arm in the same `test:kit` invocation; the default invocation runs one unedited arm. The edited arm's edits live in one game module that the kit `world.ts` and the scene both import, as an agent would write them. The edits move one boulder by ID, clear one circle, add one boulder and promote one boulder to an ordinary mesh with a `PointLight` and a fixed `RigidBody3D`.
**Verification:** The boxes below and AC-3.

- [x] 3.1 In the edited alpine arm, `chooseStand` (`KitScene.ts:286`) anchors on the moved boulder. The drive stops at its collider at the new place: `closestToBoulder` stays inside the scenario's existing bounds. The scenario's existing `boulderInstances` and `propColliders` assertions pass. proof: `KIT=alpine KIT_ARM=compare pnpm --filter strata-terrain-preview test:kit` — 2026-10-15: edited run 1 passed all original and seven composition observations on NVIDIA Turing. Moved anchor drive stops at closestToBoulder 0.9393 (existing bounds), boulderInstances 76, propColliders 5; moved/clear/add/ordinary mesh/light/collider/far removal observations each equal 1. All package hashes match the default arm.
- [x] 3.2 The unedited and the edited alpine arms both pass the existing `maxPhaseMsP95.render: 40` budget. The PR reports `viewFrameP95` and `viewGpuP95` per arm, two runs each. proof: `KIT=alpine KIT_ARM=compare pnpm --filter strata-terrain-preview test:kit` — 2026-10-15: default and edited arms pass the unchanged 40 ms render-p95 gate twice each. All 16 package-file hashes remain identical across all six default/edited/tint runs. Edited run 2 also passes all seven composition observations, closestToBoulder 0.9393, boulderInstances 76, propColliders 5. Frame/GPU p95 (ms), edited run 1 / run 2: ground 8.6/2.50 / 8.3/1.20; edge 1.3/0.62 / 1.3/0.77; boulders 3.9/2.76 / 1.0/0.82; overview 6.1/0.69 / 1.0/0.76. Default metrics are recorded in the delivery checkpoint. Visual AC-1 and AC-3 pass with the extra matched far and clearing views; original unframed ground images remain NEUTRAL. Images and verdicts are linked in the acceptance criteria.

## Delivery checkpoint — 2026-10-15

- All nine phase boxes verified; AC-1 and AC-3 pass; AC-2 remains open. Images and verdicts are published on PR483. Fresh HIGH readiness audit: **CHANGES NEEDED** (forest acceptance/package budget, initial unframed clearing evidence, reproducibility wording and committed-worker review exception). Proof commands now name `KIT_ARM=compare`; two extra matched clearing poses resolve the visual gap with IMPROVEMENT in both runs. Forest blockers and the review-precondition exception remain. No acceptance criterion or threshold changed.
- Final root typecheck, lint and doc-link checks exit 0. Lint reports 1,486 warnings; docs checks 3,130 links across 1,375 Markdown files. Independent verifier/clear review repairs pass 51/51, far-fixture/lifecycle tests 45/45, capture provenance/negative fixtures 15/15 after contention clears. Two precommit code reviews ran; this does not satisfy the committed-worker review precondition. No third review loop.
- Native unit suite passes with `--maxWorkers=4`: 139 files, 1,593 passes, 62 skips; native physics parity/publint pass. Final selected conformance refresh passes three cases each on web/desktop, zero desktop mismatch/Delta E and no validation errors. CLI exits 2 for 108 unselected cases; full matrix unrun. Laptop units: 4,622 passes and two Git-context failures subsequently passing locally (34-test MCP suite). Desktop partition: 6,416 passes, 12 failures followed by focused passing repairs. **No full-board green claim.**
- **Forest blockers:** streamed package 26,277,539 bytes against unchanged 26,214,400-byte cap, 63,139 over after adding the 166,764-byte ID sidecar. Forest GLB pin separately differs under retained parent asset-cooker work; old heightmap/placements/splat hashes match. Starter-kit suite: 17 passes, two forest failures. Baseline overview screenshot times out after 120,000 ms even with quiet GPU; isolated ground/edge render p95 140.6/132.8 ms against 40 ms. No repeated identical retry, no complete forest BEFORE/AFTER proof.
- Alpine default/edited/tint each pass two runs with identical 16-file package hashes. Frame/GPU p95 (ms), run 1 / run 2: default ground 7.5/0.78 / 1.6/0.54, edge 1.9/0.76 / 1.1/0.74, boulders 1.5/0.88 / 1.1/0.73, overview 1.7/0.67 / 0.9/0.69; edited ground 8.6/2.50 / 8.3/1.20, edge 1.3/0.62 / 1.3/0.77, boulders 3.9/2.76 / 1.0/0.82, overview 6.1/0.69 / 1.0/0.76. Extra far default 1.1/1.32 / 1.4/1.42; edited 1.4/1.45 / 1.2/1.48. Alpine AFTER scaffold retained at `/tmp/threenative-kit-qEz1eS/kit-game`; sealed BEFORE games untouched. Draft checkpoint only; no archive or merge.

### Matched clearing follow-up

- Parent independently passes 46 fixture/lifecycle tests, including strict generated default/edited source. Scoped Biome passes with five warnings. Four new headed NVIDIA Turing runs pass every original assertion and the unchanged render gate; all 16 source/published package hashes match earlier controls.
- The existing opt-in `KIT_COMPOSITION_FAR=1` appends `composition-clear` (Digit6) after `composition-far`; original four views and far framing stay unchanged. Target is the actual original clear-circle center with the shared terrain height, identical in both arms. Frame/GPU p95 (ms), run 1 / run 2: default 1.6/1.46 / 1.1/1.51; edited 1.0/1.40 / 1.0/1.42.
- Fresh read-only judge: IMPROVEMENT in both pairs; two original boulders visible before and absent after, surrounding terrain/light intact. [Published images and verdict](https://github.com/ThreeNativeHQ/threenative-engine/pull/483#issuecomment-6189081519). This closes the specifically missing clearing effect without changing a criterion.
