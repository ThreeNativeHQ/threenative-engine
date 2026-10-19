---
prd_contract: v1
---

# PRD-237 — Objects answer their own pointer events

**Status: DONE (web), 2026-08-29.** `PointerEvents3D` ships and `ctx.pointer` is on the public
surface. Evidence: [prd-237-pointer-events.md](../../verification/prd-237-pointer-events.md) and
[its continuation](../../verification/prd-237-pointer-events-continuation.md) — web and unit
gates PASS. **Physical Android is UNVERIFIED**: no device lane ran, and that criterion is not
closed by this archive.

Source of the borrowed technique: [`agargaro/three.ez`](https://github.com/agargaro/three.ez), MIT,
cloned at depth 1 on 2026-08-28. Every claim in "What the source actually contains" was read from
that clone and is cited by file and line. **No source is copied** — the licence would permit it, the
design below deliberately does not.

Parent batch: feature-mining.

**Complexity:** +1 new module, +2 complex state logic (per-pointer, per-object hover/press/drag
across frames), +1 touches 4 files in core, +1 template edit = **5 → MEDIUM mode.**

## The question

A game that wants "the player taps a tile and a tower goes there" writes this today, in the
`defense` template, at `templates/defense/src/scenes/Defense.ts:112-115` and `:132`:

```ts
const attemptPointerPlacement = (): void => {
  const hit = ctx.raycast({ targets: board.surface });
  if (hit !== undefined) place(hit.point.clone().setY(SAFE_BUILD_HEIGHT));
};
// …
if (frameCtx.input.justPressed("build")) attemptPointerPlacement();
```

That works, and it is **blind**: nothing is highlighted before the tap lands, because highlighting
needs hover, hover needs last-frame state, and last-frame state is a per-object state machine the
game has to write. No template writes one. The result is a tower-defense game where you cannot see
where the tower will go until it is there.

Two questions, per the charter:

- **(a) Could the game write this portably itself?** Only by re-deriving pointer identity, press
  ordering, enter/leave edges and capture from `ctx.input.raw` in every game. The raw material is
  there; the state machine is 400 lines and every game writes the same one. It is also exactly the
  kind of thing that quietly diverges between mouse and touch.
- **(b) Does it decide how anything looks?** No. It reports *that* an object was entered, pressed,
  tapped or dragged. What the game does about it — a highlight colour, an outline, a sound — is
  entirely the game's, and this PRD ships no material, no colour and no shader.

## What the source actually contains

Read before proposing anything, because it changes the shape of the answer:

| Claim | Evidence |
| --- | --- |
| The events subsystem is **1 258 lines**, and only one file of it touches the DOM | `src/events/*.ts`; `src/events/InteractionManager.ts:39-57` holds all 12 `addEventListener` calls |
| The portable half is the state machine: dispatch and bubbling, the event vocabulary, the raycast bookkeeping, drag/drop, hitboxes | `EventsDispatcher.ts` (113), `Events.ts` (399), `RaycasterManager.ts` (85), `DragAndDropManager.ts` (154), `Hitbox.ts` (12) |
| Listeners live **on the object**, which is why three.ez must patch `Object3D` — and `Vector3`, `Quaternion`, `Euler`, `Matrix4`, `Scene` and `Material` besides | `src/events/EventsDispatcher.ts:19-23` calls `applyObject3DVector3Patch`; `src/patch/*.ts` |
| Its event names are DOM names — `pointerdown`, `click`, `dragstart` | `src/events/Events.ts` |

**The borrow is the ~700 portable lines. The 324 DOM lines are the part this repository already
owns** — `InputMap` (`packages/core/src/input.ts:135`) already normalises keys, buttons, pointer
capture, relative motion and **a map of live pointers by id** (`IRawInputState.pointers`,
`input.ts:82-95`), on web and inside the native host. Taking three.ez's DOM half would be taking a
second, worse copy of something that already works on four targets.

**Refused from the source, on the record:** patching upstream `Object3D`. Listeners go in a side
table keyed by object, so that deleting this feature leaves a stock Three.js scene behind, and so
that `assertPortableState` and the native shim manifest keep meaning what they mean.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `ScenePicker` — `packages/core/src/picking.ts:52`, BVH-accelerated, exclusion and target lists | **Used, not replaced.** The pointer layer is a consumer of it. |
| `ctx.raycast` / `ctx.raycastAll` — `packages/core/src/game.ts:726-727` | **Stays.** A game that wants a raw ray keeps calling it; this adds a tier above, it does not remove one. |
| `InputMap` — `packages/core/src/input.ts:135` | **Used, not replaced.** Sole source of pointer state. |
| `publishHitRegions` / `ui-hit-regions.ts` | **Different problem, deliberately.** That routes taps between the *UI overlay* and the game surface. This routes a tap that already reached the game surface to a 3D object. Neither should learn about the other. |
| `templates/defense/src/scenes/Defense.ts:112-115` | **Replaced in Phase 3**, by the new path, in the same commit. |

## Design

```ts
// ctx.pointer — new on ICtx, alongside ctx.raycast
ctx.pointer.on(tile, "pointerEntered", () => tile.material.emissive.setHex(0x224466));
ctx.pointer.on(tile, "pointerExited",  () => tile.material.emissive.setHex(0x000000));
ctx.pointer.on(tile, "tapped", (event) => place(event.point));

const grip = ctx.pointer.drag(crate);   // returns a handle; cancel() releases it
```

- **One raycast per pointer per frame, not one per listener.** The layer walks the registered
  objects once, using the existing `ScenePicker` with a `targets` list built from the registration
  table, and dispatches from that single result.
- **Bubbling up the parent chain**, because a game adds one listener to a loaded GLTF root rather
  than 40 to its meshes. `event.stopPropagation()` ends the walk. This is three.ez's model and it
  is the right one.
- **Nothing is registered by default**, so a game that never calls `ctx.pointer.on` pays one
  branch per frame and no raycast. This is what keeps it out of the frame budget of the six
  templates that will not use it.
- **Touch and mouse are the same code path**, driven from `IRawInputState.pointers`. A second
  finger is a second pointer id with its own hover and press state, which is why `enter`/`leave`
  cannot be a single global "hovered object" variable.

### The one open decision

Event names. Rule 4 says vocabulary is borrowed from Godot for nodes, and Godot's are
`mouse_entered`, `mouse_exited`, `input_event` on `CollisionObject3D` — mouse-shaped names for
something that is mostly touch here. three.ez uses DOM names. **Recommendation, pending owner
sign-off before Phase 1:** `pointerEntered`, `pointerExited`, `pointerPressed`, `pointerReleased`,
`tapped`, `dragStarted`, `dragged`, `dragEnded` — Godot's `_entered`/`_exited` shape, with
`pointer` replacing `mouse` because half the targets have no mouse. Changing this after Phase 2
is a breaking change to a published surface, so it is decided first.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `PointerEvents3D` — `packages/core/src/pointer-events.ts` | `packages/core/src/game.ts` frame update, after `scheduler.tick(dt)` at `:867` | nothing (new tier) | n/a | unregister every object → the defense hover test goes red |
| 2 | `ctx.pointer` on `ICtx` | `packages/core/src/game.ts` ctx literal, beside `raycast` at `:726` | nothing | n/a | remove the field → the template stops compiling |
| 3 | Export + capability docs | `packages/core/src/index.ts`; `capabilities.json` regenerated by `pnpm build` | nothing | n/a | drop `@situation` → `pnpm budgets` fails via `scripts/check-capability-docs.ts` |
| 4 | Hover-then-place in `defense` | `templates/defense/src/scenes/Defense.ts:132` | `attemptPointerPlacement` at `:112-115` | **deleted in Phase 3** | delete the listener registration → `defense` playtest hover assertion goes red |

## Execution Phases

### Phase 1 — one object, one event, on the real input stream

**Files (4):** `packages/core/src/pointer-events.ts` (NEW), `packages/core/src/game.ts` (EDIT —
construct and tick it, expose `ctx.pointer`), `packages/core/src/index.ts` (EDIT — export),
`packages/core/__tests__/pointer-events.spec.ts` (NEW).

- [ ] Names decided with the owner (see "The one open decision"). Nothing is written first.
- [ ] `PointerEvents3D` holds a `Map<Object3D, listeners>` side table, a per-pointer-id hover
      record, and a `tick(pointers, picker)` that does at most one `raycastAll` per active pointer.
- [ ] `pointerEntered` / `pointerExited` / `pointerPressed` / `pointerReleased` / `tapped` only.
      Drag is Phase 2 — a phase that ships every event ships none of them provably.
- [ ] Zero registrations ⇒ zero raycasts. Asserted, not asserted-about.

**Wiring:** `game.ts:~867` calls `pointerEvents.tick(...)` inside the same update the scheduler
ticks in; `ctx.pointer` is added to the ctx literal at `game.ts:~726`.

| Test file | Test name | Assertion | Negative control (must be observed red) |
| --- | --- | --- | --- |
| `pointer-events.spec.ts` | `should emit pointerEntered once when the pointer moves onto an object` | one call, not one per frame | delete the "was hovered last frame" record → fires every frame, test reds |
| `pointer-events.spec.ts` | `should emit pointerExited when the pointer leaves without a new hit` | called with the previously hovered object | return early on `hit === undefined` → no exit fires, test reds |
| `pointer-events.spec.ts` | `should track two touch pointers independently` | two ids, two hover records, no cross-talk | collapse the record to a single field → the second finger clears the first's hover, test reds |
| `pointer-events.spec.ts` | `should raycast zero times when nothing is registered` | picker call count is 0 | tick unconditionally → count is 1, test reds |

**Revert check:** remove `ctx.pointer` from the ctx literal → `game.spec.ts`'s ctx-surface
assertion and `documented-contract.spec.ts` both fail.

### Phase 2 — bubbling, capture and drag

**Files (3):** `pointer-events.ts` (EDIT), `pointer-events.spec.ts` (EDIT),
`packages/core/__tests__/documented-contract.spec.ts` (EDIT — the new surface is documented).

- [ ] Dispatch walks `object.parent` until the scene root or `stopPropagation()`.
- [ ] `drag(object)` captures the pointer id at press and keeps delivering `dragged` until release,
      **including when the ray leaves the object** — the failure mode that makes hand-rolled drag
      feel broken.
- [ ] A pointer that is released outside the object emits `dragEnded`, never a stray `tapped`.

| Test file | Test name | Assertion | Negative control |
| --- | --- | --- | --- |
| `pointer-events.spec.ts` | `should deliver a tap on a child to a listener on the loaded root` | root listener called once | stop walking parents → 0 calls, reds |
| `pointer-events.spec.ts` | `should keep dragging when the ray leaves the dragged object` | `dragged` still fires | drop capture → stops at the boundary, reds |
| `pointer-events.spec.ts` | `should not emit tapped when release happens off the pressed object` | `tapped` count 0 | compare against the hit rather than the press record → 1, reds |

**Revert check:** revert the parent walk → the Phase 2 bubbling test fails; it passed before only
because the object under test was its own root.

### Phase 3 — the `defense` template sees where the tower will go

**Files (3):** `templates/defense/src/scenes/Defense.ts` (EDIT — delete
`attemptPointerPlacement`, register hover + tap), `templates/defense/src/render/*` (EDIT — the
highlight itself, because the highlight is look and lives in generated source),
`templates/defense/playtests/*.playtest.json` (EDIT/NEW — assert the hover).

- [ ] Hover highlights the buildable tile under the pointer, before any tap.
- [ ] `tapped` places the tower; the old `justPressed("build")` + manual raycast path is **deleted**,
      not left beside the new one.
- [ ] The `build: { pointer: true }` binding in `templates/defense/src/game.ts:13` either stays as
      the press source or is removed — one of the two, decided in the diff, not both.

**Verification:** the templates gate, run against `defense`:

```sh
pnpm --filter @threenative/playtest build
node packages/playtest/dist/runner/cli.js templates/defense/playtests/<hover>.playtest.json \
  --url http://127.0.0.1:5173 --server-command "<defense dev command>" --browser-recipe webgpu
```

**Negative control:** delete the `pointerEntered` registration → the hover assertion reds. Paste
both the red and the green.

### Phase 4 — it works on a touchscreen, or it is not done

**Files (2):** `templates/defense/playtests/*.playtest.json` (EDIT), verification record (NEW).

- [ ] The same scenario on `--target android`, driven by real touch batches, asserts the same
      hover and the same placement.
- [ ] Any divergence between the mouse and touch paths is fixed in `pointer-events.ts`, never in
      the template.

**This phase is what makes the feature finished.** A pointer layer proven only with a mouse is a
web feature wearing a portable name.

## Acceptance criteria (consumer-scoped)

- [ ] In the `defense` template, on web **and** on a physical Android device, the tile under the
      pointer is visibly highlighted before the tower is placed, and the tower lands on the
      highlighted tile.
- [ ] A game registers a tap listener on a loaded GLTF root and receives taps on its child meshes,
      without naming a single child.
- [ ] A drag started on an object keeps receiving `dragged` while the pointer is off the object,
      and ends with `dragEnded` rather than a spurious `tapped`.
- [ ] A game that registers nothing performs zero additional raycasts per frame, shown by a
      counter, not by argument.
- [ ] `pnpm budgets` passes with the new exports carrying `@situation` and `@example` tags, so the
      capability manifest can answer *"the player clicks on a thing in the world"*.
- [ ] Deleting `pointer-events.ts` breaks `defense`'s playtest and `game.spec.ts` — the revert check
      is pasted, not asserted.

## Kill switch

`pnpm tsx scripts/count-loc.ts` compares this against the plain-Three.js alternative, counting
**every** site: a game with 12 interactive objects, hover and drag, on both mouse and touch. If the
framework version is not smaller than what a competent author writes by hand across those sites, it
is deleted, however much work it took.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`agargaro/three.ez` @ `91e73f3c`**.

| To implement | Read |
| --- | --- |
| the per-object listener map, add/remove, and dispatch | `src/events/EventsDispatcher.ts:1-113` |
| the event vocabulary and its type map | `src/events/Events.ts` (399 lines) |
| per-pointer intersection bookkeeping | `src/events/RaycasterManager.ts:1-85` |
| event coalescing between frames | `src/events/InteractionEventsQueue.ts:1-38` |
| the drag / capture state machine | `src/events/DragAndDropManager.ts:1-154` |
| proxy hit volumes | `src/events/Hitbox.ts:1-12` |
| **do NOT borrow** — `InputMap` already owns this half | `src/events/InteractionManager.ts:39-57` (12 DOM listeners) |
| **do NOT borrow** — upstream-class patching is refused here | `src/patch/*.ts` |
