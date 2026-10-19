# PRD-396 — Static-transform freeze and cached render lists

**Status:** Phase 1 landed, and **measurement has since argued against the rest of this PRD.**
The freeze works and is tested; in a running page it recovers **0.009 ms** on 1,561 objects,
because it deletes matrix arithmetic and not the walk. Meanwhile the engine already pays a much
larger static bonus for free: three skips per-object binding updates when nothing changed, worth
**7.35 ms** on the same scene — roughly 800x this PRD's Phase 1. Traversal is 0.87 µs/object and
14% of the render phase, so the entire prize Phases 2-3 chase is ~1.4 ms on the reference game.
**Phases 2-3 are not taken** and should be closed as not-worth-doing unless the reference game
contradicts the load-test scene's shape. They are a second render-list path and a second patch to
three's `RenderObjects.get` whose only safety net is a divergence harness that cannot run while
another tenant holds 6.2 GiB of VRAM. Where the mass actually is: `bindings.updateForRender`,
26% of the render phase.
**Complexity:** 5
**Owner:** unassigned
**Depends on:** PRD-395 Phases 1–2 (span mechanism must exist to measure this; the full
attribution table is not required to start, but is required before Acceptance).
**PR:** (open as draft before Phase 1) — label `prd:0`

**Priority:** P3 — Its own measurement argues against the remaining 37 boxes.
## Problem

Of the 5.22 ms of the render phase we can currently name, **3.71 ms is traversal**
(`_projectObject` 1.48, matrix walk 2.22) and **1.51 ms is per-draw bookkeeping keyed on JS
object identity** (`_objects.get`, `_nodes.needsRefresh`,
`_geometries`/`_bindings`/`_pipelines.updateForRender`).

The scene is 1,561 meshes. Cull considers 1,680 objects, culls 409, and exempts 856 as
shadow casters; the size threshold is already at 2 px, so there is nothing left to win by
tightening it. The shadow lane walks the graph a second time for 364 of the 573 draws.

Almost none of this work changes between consecutive frames. Island geometry, deck fittings,
static props and the terrain do not move; their world matrices are recomputed every frame,
re-projected every frame, and their geometry/binding/pipeline handles are re-resolved
through identity-keyed maps every frame. The camera moves, so the *visible set* can change —
but the *candidate set* and its world bounds do not.

Ranked estimate: **0.8–1.5 ms, ~zero risk, ~1 day, helps browser equally.** It is first
because it is the only lever that is both cheap and portable, and because it is the correct
place to build the divergence harness that any future line-crossing work will need.

## Scope / Non-goals

**In scope**
- Engine mechanism: a per-subtree transform version counter; `static` subtrees skip the
  `updateMatrixWorld` walk while their version is unchanged.
- Engine mechanism: split render-list construction into (a) a flat candidate array with
  cached world bounds, invalidated by graph/visibility/material version, and (b) a per-frame
  visibility filter over that flat array. The camera may move every frame without forcing
  a graph traversal.
- Engine mechanism: resolved `(geometry, bindings, pipeline)` handles cached on the render
  item and invalidated by version, replacing per-frame identity-map lookups.
- Reuse of the same cache for the **shadow** and **reflection** render lists.
- `TN_RENDERLIST_VALIDATE=1`: recompute the render list from scratch every frame and diff
  visible set, draw order, and per-object world matrices against the cached path; throw on
  first divergence. Runs in CI on a scripted scene.
- Game-side: `static` markers on midway's immobile subtrees, shipped as **generated game
  source**, not as engine heuristics.

**Non-goals — explicitly refused here**
- **Ranked option 3 (shadow lane) is not taken.** This PRD reuses the cache for shadow
  render lists because that is the same mechanism; it does **not** do per-light caster
  culling, cascade reduction, or update throttling for static lights. The 856
  shadow-caster-exempt objects stay exempt. That is a separate PRD after PRD-397, because
  its ms/risk ratio is worse and it interacts with whatever PRD-397 does to the object count.
- No runtime auto-detection of staticness ("this object hasn't moved in 60 frames, freeze
  it"). Staticness is authored, generated, and checkable. A heuristic that guesses wrong is
  a correctness bug with no reproduction.
- **Ranked option 2 (content pipeline)** is not touched. Object and draw counts are
  unchanged by this PRD: 1,561 meshes and 573 draws in, 1,561 and 573 out.
- **Ranked options 4, 5, 6, 7** are not taken and not prepared for. Nothing here creates a
  second renderer path.
- No web-only helper. Every cache path ships with a native number in the same commit.

## Phases

### Phase 1 — Transform version + static freeze + the divergence harness

- [x] Files wired: `packages/core/src/static-transform.ts` — `markStatic(root)` composes a
      subtree once and freezes it, returning a monotonic **version**; `invalidateStatic(object)`
      re-arms the root that owns any object; `refreshStaticTransforms()` re-arms a root whose own
      authored transform changed, by comparing 26 numbers per frozen root per frame — O(roots),
      not O(objects). `resetStaticTransforms()` drops the registry with the scene.
- [x] Files wired: the freeze is honoured by the matrix walk, and the size of what it deletes is
      stated rather than implied. Three 0.185's `updateMatrixWorld` recurses into **every** child
      unconditionally (`three.core.js:12928-12936`); `matrixWorldAutoUpdate` only suppresses the
      compose. So a frozen subtree stops composing its local and world matrices — the
      `multiplyMatrices` and `updateMatrix` work the profile named — and still gets visited. This
      PRD's claim is therefore "the arithmetic is deleted", not "the subtree is skipped entirely",
      and the test counts the composes rather than timing them.
- [x] Files wired: `packages/core/src/profiling/render-list-validate.ts` behind
      `TN_RENDERLIST_VALIDATE=1` (and `?tnRenderListValidate=1` for a browser page) — recomputes
      every `matrixWorld` from the authored transforms each frame and compares elementwise at
      1e-6, throwing on the first divergence with the object and the element named.
      **The reference matters and was wrong once:** the validator composes from
      `position`/`quaternion`/`scale` for exactly those objects whose compose the freeze silenced,
      because a frozen object's own `matrix` *is* the cache under test. Composing from the frozen
      matrix made the check pass vacuously.
- [x] Required test passing: `freeze.moving-static-object` — an object marked static whose
      transform is written still updates, and the version is what says so. Two ways in: the root's
      own transform (caught by the engine's per-frame check, no announcement needed) and a write
      deeper inside (announced with `invalidateStatic`); both end with the validator clean.
      Result: `npx vitest run packages/core/__tests__/static-transform.spec.ts` → 0 (9 tests)
- [x] Required test passing: `validate.detects-divergence` — a frozen root whose position is
      changed with nothing re-arming it throws
      `TN_RENDERLIST_VALIDATE: island (id N) has a stale world matrix at element 14`.
      Result: `npx vitest run packages/core/__tests__/static-transform.spec.ts` → 0
- [x] Observed red: the divergence test **did** pass vacuously first, exactly as this box
      predicted — `AssertionError: expected [Function] to throw an error`, because the validator
      was recomputing from the same frozen matrix the freeze had written. Fixed by giving the
      validator the authored transform for freeze-silenced objects; the test is red again if that
      reference is taken away.
- [x] Required test passing (added, not in the original plan): the freeze deletes exactly one
      local compose per object per walk and no more — counted with a wrapped `updateMatrix`, since
      a wall-clock pair is the wrong instrument for a claim about removed work and this record has
      been burned by that before.
      Result: `npx vitest run packages/core/__tests__/static-transform.spec.ts` → 0
- [x] The safety net is exercised **on the native host, red and green**, on a synthetic scene
      rather than the reference game. 200 meshes frozen under one `markStatic` root, projection
      off so the authored scene is what draws, 600 frames:

      **Green** — the freeze is honest:
      ```
      TN_RENDERLIST_VALIDATE:{"checked":203,"frames":600,"gameOwned":0,"divergences":0}
      ```

      **Red** — one frozen mesh's `position.x` written at frame 120 without calling
      `invalidateStatic`, which is precisely the mistake the freeze makes possible:
      ```
      TN_RENDERLIST_VALIDATE: Mesh (id 24) has a stale world matrix at element 12:
      drawing -6 where a full recompute gives …
      ```
      Element 12 is a `Matrix4`'s translation X, so the report names the object, the element and
      both values rather than saying something diverged. The run continued after reporting; the
      diagnostic is what was observed, not a halt.

      **One thing this run corrected about the instrument's reach:** with the engine's projection
      left on, the same scene reports `"checked":3`. That is correct — the validator checks what
      is actually drawn, and what is drawn is the collapsed mirror, not the authored 200. It also
      means a game relying on the collapse gets no per-object validation of its frozen subtree,
      which is worth knowing before trusting this net on a real scene.
- [ ] User verification: reference game, native, `TN_RENDERLIST_VALIDATE=1`, 1800 frames,
      zero divergences.
      Blocked on the reference game: it cannot reach a steady window on this box (PRD-395 Phase 1
      carries the VRAM evidence and the control arm that proves it is the machine).

      **The harness is proven on native, and running it found three defects the unit tests had
      all passed.** `examples/native-smoke` fits in the free VRAM:
      `TN_RENDERLIST_VALIDATE=1 mystral run examples/native-smoke/dist/native-smoke.js --headless`
      → **`{"checked":5,"frames":3900,"gameOwned":0,"divergences":0}`**. 3,900 frames, zero
      divergences, on a real host with the real renderer.

      What it took to get there, because each one would have made the oracle useless:
      1. **The flag never reached the game.** The native host publishes named launch flags into
         `process.env`, and `TN_RENDERLIST_VALIDATE` was not one of them, so the validator was
         never constructed and the run was silent. The host now forwards a listed set rather than
         a single flag.
      2. **It called every projection-owned object stale.** `matrixWorldAutoUpdate === false` is
         three's "I maintain this myself", and the engine's own projection sets it across its
         mirror; recomputing those from the parent chain reported each as a divergence
         (`Mesh (id 19) ... drawing 1 where a full recompute gives 0.5695`). Objects that own
         their world matrix are skipped and counted as `gameOwned` — except a subtree the freeze
         silenced, which is exactly what must still be checked.
      3. **It ran before the walk it was checking.** Three updates world matrices *inside*
         `render()`, and the check sat before it, so every object that moved this frame read as
         stale: `Mesh (id 20) ... drawing 0 where a full recompute gives -1`, with
         `matrixAutoUpdate=true` and `position=[-1,0,0]` — a walk that had not happened yet, not
         a cache that went wrong. It now runs immediately after `renderer.render(...)`, where the
         matrices are the ones that were drawn.

      The third was only diagnosable because the message carries the object's flags, position and
      parent. An oracle that reports an element index and nothing else sends its reader to a
      debugger, and the first thing anybody does with an oracle they cannot explain is switch it
      off.

### Phase 2 — Flat candidate array + per-frame visibility filter

**Not taken.** Building a second render-list constructor means replacing three's `_projectObject`
with an engine-owned flat array and keeping the two in agreement forever. The PRD already names the
instrument that would make that safe — a visible-set, draw-order and matrix diff running on the
reference game — and that game cannot present a frame on this machine. Landing the cache without it
would be a change whose correctness rests on the scenes that happened to be tested. The transform
version and the matrix oracle this PRD's Phase 1 landed are the two pieces that work needs, and
they exist now.

- [ ] Files wired: candidate array built once per invalidation, holding object ref, cached
      world bounding sphere, material/geometry handles, and shadow-caster flag.
- [ ] Files wired: per-frame filter is a linear pass over the flat array; no graph descent.
- [ ] Files wired: invalidation on add/remove/visibility-change/material-swap/geometry-swap.
- [ ] Required test passing: `npm test -- renderlist.invalidate-on-add` — adding a mesh
      mid-frame appears in the next frame's list. Result: `<command>` → `<exit code>`
- [ ] Required test passing: `npm test -- renderlist.churn-stress` — a scene adding and
      removing 200 meshes/frame is never slower than the uncached path by more than 5%.
      Result: `<command>` → `<exit code>`
- [ ] Observed red: `renderlist.invalidate-on-add` failed at `<sha>` with `<msg>`.
- [ ] User verification: `_projectObject` span on native desktop.
      Baseline 1.48 ms → result `<n>` ms
- [ ] User verification: matrix-walk span on native desktop.
      Baseline 2.22 ms → result `<n>` ms

### Phase 3 — Cached per-draw handles; shadow and reflection lists reuse the cache

**Not taken**, same reason, plus one of its own: the 1.51 ms of per-draw bookkeeping is inside
three's `RenderObjects.get`, keyed on JavaScript object identity, and this repository already
patches that function once (`patches/three@0.185.1.patch`, for the override-material version gate).
A second, larger patch to the same function — caching resolved geometry, binding and pipeline
handles on the render item — is exactly the kind of change that needs a measured before and after
on the scene it is for. PRD-395 was supposed to publish that number and has not been able to.

- [ ] Files wired: resolved `(geometry, bindings, pipeline)` handles stored on the render
      item, invalidated by version; identity-map lookups removed from the per-frame path.
- [ ] Files wired: shadow render list and reflection render list built from the same
      candidate array.
- [ ] Required test passing: `npm test -- bookkeeping.invalidate-on-material-change` —
      swapping a material re-resolves the pipeline. Result: `<command>` → `<exit code>`
- [ ] Observed red: that test failed at `<sha>` with a stale pipeline and `<msg>`.
- [ ] User verification: per-draw bookkeeping span on native desktop.
      Baseline 1.51 ms → result `<n>` ms
- [ ] User verification: shadow-pass span on native desktop.
      Baseline from PRD-395 Phase 4 `<n>` ms → result `<n>` ms
- [ ] User verification: draw counts unchanged.
      Expected main 158 / shadow 364 / reflection 51 = 573. Result: `<n>`/`<n>`/`<n>`

### Phase 4 — Game-side static marking (generated source) and measurement

**Not taken.** The convention it needs now exists and is documented where a game's agent will find
it — the capability manifest, the shipped performance skill, and every template's `AGENTS.md`. What
is missing is the marking itself, and marking midway's subtrees is a change to a game whose source
this campaign's own contract freezes without a game-owned reason, made on a machine that cannot
measure whether it helped. Both halves of that are reasons to wait.

- [ ] Files wired: midway's generator emits `static` on terrain, island, deck fittings and
      other immobile subtrees; the marking is in generated game source, not in `packages/`.
- [ ] Files wired: count of objects marked static is printed by the generator.
      Result: `<n>` of 1,561 meshes marked static.
- [ ] Required test passing: `npm test -- midway.static-markers-golden` — the generated
      marker set is byte-stable across two runs. Result: `<command>` → `<exit code>`
- [ ] Observed red: golden test failed at `<sha>` due to nondeterministic ordering; `<msg>`.
- [ ] User verification: native desktop, 1280x720, 1800 frames, frame p50.
      Baseline 20.2 ms → result `<n>` ms
- [ ] User verification: native desktop render-phase p50.
      Baseline 16.1 ms → result `<n>` ms
- [ ] User verification: browser WebGPU render-phase p50 (same scene).
      Baseline `<record at Phase 1>` → result `<n>` ms
- [ ] User verification: CI runs `TN_RENDERLIST_VALIDATE=1` on the scripted scene and fails
      on divergence. Result: `<workflow>` → `<exit code>`
- [ ] User verification: Android hardware, render-phase p50.
      Blocker: Android hardware rows open on PR #275. Does not gate Acceptance.
- [ ] User verification: iOS hardware, render-phase p50.
      Blocker: same as Android.

## Acceptance criteria

- [ ] Native desktop render-phase p50 improves by **≥0.8 ms** against the 16.1 ms baseline.
- [ ] Browser WebGPU render-phase p50 improves by ≥0.8 ms against its own recorded baseline.
- [ ] Combined traversal spans (`_projectObject` + matrix walk) fall from 3.71 ms to ≤2.0 ms
      on native desktop.
- [ ] Per-draw bookkeeping span falls from 1.51 ms to ≤0.8 ms on native desktop.
- [ ] Draw counts are unchanged: main 158, shadow 364, reflection 51.
- [ ] Triangle count is unchanged at 1.04M.
- [ ] 1800 frames of the reference game with `TN_RENDERLIST_VALIDATE=1` report zero
      divergences in visible set.
- [ ] 1800 frames with `TN_RENDERLIST_VALIDATE=1` report zero divergences in draw order.
- [ ] 1800 frames with `TN_RENDERLIST_VALIDATE=1` report zero divergences in `matrixWorld`.
- [ ] The churn-stress scene is within 5% of the uncached path.
- [ ] Static markers ship as generated game source; no staticness heuristic exists in
      `packages/`.

## Verification boundary

**Proven here:** that repeated per-frame graph traversal and identity-keyed per-draw lookups
can be removed without changing the visible set, the draw order, or a single world matrix,
on native desktop and in the browser, over 1800 frames of the reference game.

**Not proven here:** that the cache is correct for scenes the reference game does not
contain — skinned hierarchies under a static root, LOD swaps, instanced attribute churn.
`TN_RENDERLIST_VALIDATE=1` is the instrument for those; it is a validation mode, not a proof.

**The engine already pays the static bonus, and it is ~800x larger than this PRD's.** Measured on
the packaged native host, 1,561 objects, projection off, no shadows, the only difference being
whether the game writes to the transforms each frame:

| | `bindings.updateForRender` calls/frame | `renderScene` |
|---|---|---|
| nothing moves | 2 | **10.10 ms** |
| every object rotates | 1,534 | **17.45 ms** |

three skips the per-object binding update entirely when nothing changes, so **a static object is
already worth ~7.35 ms across this scene with no API, no authoring and no freeze.** This PRD's
`markStatic` removes matrix composition on top of that and is worth **0.009 ms** (below).

That is the honest framing for the whole PRD: the expensive part of "this object did not move" is
already free, and what remained for a freeze to take was the cheap part. A game gets the large win
by not writing to a transform, which is a thing it does by doing nothing.

**The freeze does delete the work it claims to, including under the shipped default.** Counted
rather than timed, on the native host, 500 meshes under one root, `Object3D.prototype.updateMatrix`
wrapped and tallied over 300 measured frames:

| | composes/frame |
|---|---|
| collapse on (the default), no freeze | 510 |
| collapse on, `markStatic(island)` | **9** |
| collapse off, no freeze | 508 |
| collapse off, `markStatic(island)` | **7** |

**98% of matrix composes removed, and the engine's projection does not negate it.** That last
point was a live suspicion worth killing: the projection runs a whole-scene matrix pass on any
frame it projects, and the obvious worry was that a game using the shipped default would get
nothing from a freeze. Measured, it gets the same 98%.

So Phase 1 is correct and does what it says. It is simply that the work it deletes is cheap —
0.009 ms, below — which is a statement about matrix composition, not about the implementation.

**Phase 1 measured in a running page, and it recovers almost nothing.** Until now the freeze had
only unit-test evidence — compose counts, not time. A 1,561-mesh scene in a three-deep hierarchy
(4,685 objects total, 3,163 of them frozen under one root), `scene.updateMatrixWorld()` timed in
batches of 100 to clear Chrome's 100 µs clock granularity, three alternating pairs:

| arm | p50 per call |
|---|---|
| no freeze | 0.137 / 0.141 / 0.148 ms |
| `markStatic(island)` | 0.132 / 0.131 / 0.133 ms |

Every unfrozen run is slower than every frozen run, so the effect is real and not noise. It is
also **0.009 ms — a 6.4% reduction, 2.8 ns per frozen object, 0.06% of a 16.1 ms render phase.**

The reason is the one this PRD and the shipped docs already state, now with a number against it:
the freeze removes matrix arithmetic and **not** the walk, because three recurses into every child
regardless. The whole matrix-compose cost of a midway-sized hierarchy is only 0.14 ms to begin
with, so there was never more than that on the table, and the freeze takes 6% of it.

**Two measurement errors were made getting here and are worth recording**, since both would have
produced a confident wrong answer. The first probe called `scene.updateMatrixWorld(true)` — with
`force`, which recomposes everything regardless of any freeze, so it measured the freeze doing
nothing and would have "proved" it useless. The second read per-frame samples against a clock
Chrome coarsens to 100 µs, larger than the entire effect, and reported both arms as an identical
0.1 ms. The batching and the dropped `force` are what made the difference visible.

**Now priced, and the price argues against this PRD.** PRD-395 Phase 4 published the two unit
costs on a deterministic load-test scene: **0.87 µs per object of traversal** and **8.9 µs per
draw**. Traversal is honestly linear — 0.92 µs/object at 1,024 objects, 0.87 at 4,096 — and it is
only **14% of the render phase** against 87% for the per-draw loop.

Applied to the reference game's 1,561 meshes, **the entire traversal this PRD exists to avoid is
about 1.4 ms**. Phase 1's freeze is worth a fraction of that (it removes matrix composition, not
the walk), and Phases 2-3 propose a second render-list path, a flat candidate array and a larger
patch to three's `RenderObjects.get` to chase a term that cannot exceed 1.4 ms of a 16.1 ms
render phase. That is a poor trade at any implementation quality, and it is now a measured
statement rather than a cautious one. **Phases 2-4 should be closed as not-worth-doing unless the
reference game's own measurement contradicts the load-test scene's shape**, which is a much
narrower question than "is this worth building".

Where the mass actually is, from the same table: `bindings.updateForRender` at 26% of the render
phase, 2.64 µs/draw. A PRD aimed at *that* would be the one worth writing next.

**Not proven here:** anything about the 10.9 ms PRD-395 is chasing. If PRD-395 finds the
mass is per-draw encode cost, this PRD's ≥0.8 ms is real but small, and PRD-397 is the
answer. If PRD-395 finds it is per-object, this PRD's target is too conservative and should
be raised before Acceptance is ticked.

**Inherited obligation:** the visible-set / draw-order / matrix diff built in Phase 1 **is**
the parity oracle named by the review. Any future PRD that introduces a second path for
render-list construction (ranked options 4, 5, 7) must extend this harness to diff across
paths and must fail CI on divergence. No such path is introduced here.
