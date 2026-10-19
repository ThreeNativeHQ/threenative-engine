---
prd_contract: v1
---

# PRD-272 — velocity is opt-in through a flag nobody sets, and nothing reports whether it was on

**Status:** PROPOSED — filed 2026-08-30, measured at `1eeecf1e`. Depends on
PRD-266 — this is the
velocity row of that PRD's honest-tier report. Lands with or before
[PRD-271](./PRD-271-batchedmesh-reports-its-whole-batching-transform-as-velocity.md), which needs
the same guard to prove it did not regress. Batch:
[docs/PRDs/realism-effects](./README.md).

**Goal: a temporal stage running without velocity is a reported failure, not a silent one.**
Today the difference between "reprojection is working" and "reprojection is differencing raw
geometry positions" is invisible from outside the frame.

**Complexity:** one probe, one report field, one negative-control spec = **LOW**. It is small
because PRD-266 builds
the marker it reports through; filed separately because it is the criterion that keeps
PRD-271's fix from silently rotting.

## The problem, measured at `1eeecf1e`

### 1. Every previous-frame path in three is behind one unadvertised predicate

`three@0.185.1`'s `src/nodes/core/NodeBuilder.js:3449`:

```js
needsPreviousData() {
	const mrt = this.renderer.getMRT();
	return ( mrt && mrt.has( 'velocity' ) ) || getDataFromObject( this.object ).useVelocity === true;
}
```

Every accessor that must displace the previous-frame position is guarded by it —
`Skinning.js:162`, `Instance.js:215`. When it returns `false`, those assignments do not happen and
`positionPrevious` keeps its default of the raw geometry position
(`Position.js:54`). `VelocityNode` still runs. It still produces a number. The number is the
difference between a correctly transformed current position and an untransformed previous one.

So the failure is not an exception, a warning, or a black buffer. It is a plausible-looking
velocity buffer that is wrong on exactly the animated and instanced geometry temporal filters exist
to stabilise — and correct on the static rigid meshes a smoke test is most likely to contain.

### 2. The consumer picks a fallback silently too

`TRAANode.js:472`:

```js
if ( builder.context.velocity !== undefined ) {
	this._velocityNode = builder.context.velocity;
} else {
	this._velocityNode = velocity;
}
```

A chain that never wired a velocity output gets the bare `velocity` immutable, which reads only
`object.matrixWorld` deltas. TRAA then runs, converges, and produces a stable image that ghosts
every skinned, instanced and batched thing in the scene. Nothing in the frame, the console or the
report distinguishes it from a correctly fed chain.

### 3. This is the charter rule, applied to the one stage that cannot be seen

The root charter: turning a convention off must not turn its measurement off, and
`docs/PRDs/lighting/PRD-266`'s section 3 already names the general case — *a dropped effect is
indistinguishable from a disabled one*. Velocity is the sharpest instance of it, because unlike a
dropped bloom or a dropped AO pass, a mis-fed temporal stage produces **more** apparent stability,
not less. It looks better in a still screenshot and worse in motion, which is the one axis a
screenshot gate cannot see.

`packages/playtest` grades in motion and could assert this, but there is no field to assert
against.

## What ships

A velocity provisioning report, emitted through the PRD-266 chain marker:

- **A provisioning probe.** Before installing any stage that consumes velocity, the chain
  determines whether the running configuration actually satisfies `needsPreviousData()` for the
  objects in the scene — the MRT carries a `velocity` output, or the objects carry `useVelocity`.
  Fail closed: a temporal stage requested without a velocity source is **dropped and named**, never
  installed against a fallback.
- **`chain.applied.velocity`** — whether velocity was provisioned, by which route (MRT output or
  per-object flag), and when a temporal stage was dropped, the reason. Carried under the same
  `TN_RENDER_CHAIN` marker PRD-266 defines, so the playtest bridge and `doctor --url` both read it
  without a second path.
- **A history-rejection fraction** — the share of pixels whose history the temporal stage
  discarded this frame, published on the same marker. This is the number that makes
  [PRD-271](./PRD-271-batchedmesh-reports-its-whole-batching-transform-as-velocity.md)'s
  criterion 5 assertable, and the number that catches a future regression in the skinned or
  instanced paths that upstream currently handles correctly and could stop handling.
- **A per-geometry-class conformance spec** — rigid, skinned, instanced and batched, each asserting
  a static object reports zero velocity and a moving one reports non-zero. Upstream handles three
  of the four today; the spec exists so that stays true, and so PRD-271's fourth row has a
  sibling to be compared against rather than a bespoke fixture.

No appearance decision is involved: the chain reports what ran, and the game decides nothing
differently about how it looks.

## Acceptance criteria

1. **A temporal stage requested without a velocity source is dropped and named.** A chain
   requesting TRAA against a configuration whose MRT has no `velocity` output produces
   `chain.applied` with the temporal stage absent and a reason naming the missing velocity output,
   and emits `TN_RENDER_CHAIN`. *Mutation:* let the stage install against `TRAANode`'s default
   `velocity` fallback and the negative-control spec goes green on a chain that would ghost.

2. **The provisioning route is reported, not inferred.** With velocity provisioned via the MRT
   output, `chain.applied.velocity.source` names that route; via the per-object flag, it names
   that one. *Mutation:* hard-code the field to a constant and the two-route spec fails because
   both configurations report the same source.

3. **Each geometry class reports zero velocity when static and non-zero when moving.** One spec
   table over rigid, skinned, `InstancedMesh` and `BatchedMesh` fixtures. *Mutation:* revert
   `Skinning.js`'s or `Instance.js`'s `positionPrevious` assignment in a local patch fixture and
   the corresponding row fails — proving the spec observes the mechanism rather than restating
   that upstream currently works. The `BatchedMesh` row is expected **red** until
   [PRD-271](./PRD-271-batchedmesh-reports-its-whole-batching-transform-as-velocity.md) lands and
   is pinned as a known failure with its measured magnitude, not skipped.

4. **The rejection fraction is observable from a playtest, and its absence fails.** A scenario
   asserts `renderChain.velocity.rejectionFraction` below a pinned threshold, and reports
   unobservable — not green — when the marker is absent entirely, per the PRD-265 rule.
   *Mutation:* drop the marker emission and the scenario must report unobservable.

5. **No temporal stage requested, no velocity cost.** With every temporal stage off, no velocity
   output is added to the MRT, no previous-matrix storage is allocated, and the `render` phase is
   unchanged within noise. *Mutation:* provision unconditionally and the allocation spec fails
   naming the output.

## Out of scope

Fixing the `BatchedMesh` path — that is
[PRD-271](./PRD-271-batchedmesh-reports-its-whole-batching-transform-as-velocity.md); this PRD only
has to make its absence visible. Which temporal stages a template turns on, which is
[PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md). Deciding the rejection
threshold per template, which is a look-adjacent tuning decision and belongs beside the template's
other render settings.

## Verification

`pnpm typecheck && pnpm lint && pnpm test`; a playtest scenario against a template build pasting
`TN_RENDER_CHAIN` with the velocity block populated; the criterion-3 table pasted in full including
the pinned `BatchedMesh` red. `pnpm build` regenerates
`packages/create-threenative/capabilities.json` in the same commit — a report field absent from the
manifest does not exist to the agents that would assert on it. Native parity follows
[PRD-270](../../useful-defaults/PRD-270-no-lighting-node-ships-web-only.md).
