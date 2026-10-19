---
prd_contract: v1
---

# PRD-343 — a light smaller than a pixel is still a light

**Status:** PROPOSED — filed 2026-09-03, measured at `43d03e6a`. Batch:
[docs/PRDs/AAA-visuals](aaa-visuals-notes.md). Judged with
[PRD-341](../done/PRD-341-a-frames-tone-is-a-number-and-the-number-is-a-gate.md). Source studied:
[TheLongSilence](https://github.com/achimala/TheLongSilence) `src/world/Fleet.js:57-140`, the
`BEACON_VERT` / `BEACON_FRAG` pair and the `BEACON_HDR` note.

**Priority:** P2 — Proposed pixel-floor point lights with a 10 m-to-10 km playtest and two scaler rungs.
**Goal: a distant object still reads as a working machine, and an emissive authored by a game
arrives at the tonemapper with the value it needs.** Two small mechanisms, one of which is a trap
this repository has the ingredients to fall into.

**Complexity:** a merged quad mesh with a depth-driven vertex size, plus an authoring-scale seam and
its report = **LOW-MEDIUM**.

## The problem, measured at `43d03e6a`

### 1. Nothing in the framework holds a small bright thing at a minimum pixel size

`Billboard3D` orients an object toward the camera; it does not size it.

```
grep -n 'minPixel\|pixelSize\|minPx' packages/core/src/billboard.ts packages/core/src/particles.ts
(no matches)
```

So every running light, muzzle glow, distant window, tracer tip and beacon in every game built here
shrinks below one pixel and vanishes — or is scaled by hand with a distance curve the game had to
derive. The reference's number: sixty metres of hull at four million kilometres is far below a
pixel, and *the moving spark is what makes the scene read as inhabited*, not the hull it is attached
to. The same is true of a city at night, a convoy on a horizon, or a fleet in a strategy view.

The mechanism is one line of vertex maths — size the quad from its own view depth so it lands at a
constant pixel count, never below the physical size — and it is exactly the kind of thing that is
too small for a game to bother getting right and too repeated for every game to write.

### 2. Emissive authoring has no scale, and the tonemapper's white point is invisible

This is the trap. Under AgX a pixel needs radiance in the region of 120 before it returns white. A
game authoring emissive intensities in the 1–3 range — the range that looks right in an editor, and
the range Three.js examples use — is authoring at about **two per cent** of what its own tonemapper
needs. The reference wrote this trap down and then fell into it anyway: every navigation light,
strobe and docking lamp in its fleet was authored at 1.2–2.6 against a requirement near 120, and a
courier framed against a lit planet came back as "a pale lump with a single faint green speck". The
fix was not to re-author the lights — the *relative* weights were right — but one shared multiplier
(`BEACON_HDR = 44.0`) putting the whole set into real HDR.

Every template here now ships a tonemapper and a bloom stage. Nothing reports the white point, so
nothing tells a cold agent that its emissive is two orders of magnitude short. That is a framework
reporting gap, not a game bug.

### 3. The split

Depth-driven sizing, merging a set of lamps into one draw, and reporting the tonemapper's white
point are mechanism — rule 1(a). Colour, gain, flash pattern, placement and count are the game's and
must stay in the game's source; the framework picks none of them, so 1(b) is not triggered.

## What ships

### `packages/core/src/emissive-points.ts`, exported from `@threenative/core`

- **`EmissivePoints3D`** — a game adds points with `{ position, colour, gain, worldSize, minPixels,
  mode }` and calls `build()`. One mesh, one material, one draw for the whole set: centre, tint,
  gain, physical size, pixel floor and mode are per-vertex attributes. The reference's freighter
  carries eleven lamps in one draw and one material instead of eleven of each.
- **Depth-driven size, in the vertex stage.** `size = max(worldSize, minPixels * pixelScale *
  viewDepth)`, with `pixelScale` derived from the camera and the *drawing buffer* — which means it
  has to be re-derived when `ResolutionScaler` moves a rung, or a scatter of lamps changes apparent
  size every time the frame rate wobbles. That coupling is the framework's job precisely because a
  game will not know to do it.
- **Modes.** `steady`, plus game-parameterised periodic gain: period, duty, gain multiplier, and a
  per-instance phase. The framework supplies the clock and the phase seam; the game supplies the
  numbers. No named "strobe" or "hazard" presets — a preset system is closed with evidence.
- **`hdrScale`** — one multiplier over the whole set, separate from the per-point gains, so relative
  weights survive a re-scale. Defaults to `1`; the framework never guesses it.

### The white-point report — `packages/core/src/renderer-config.ts`

`TN_TONEMAP` naming the active tonemapper and **the scene-referred radiance at which it returns
display white**, printed once at startup on every platform. That single line is what turns "my
lights look grey" from a day into a minute. Any game, not just one using `EmissivePoints3D`, reads
it.

## What does not ship

- No colour, no gain, no flash pattern, no preset. A game changes the entire appearance of its
  lights without editing package code — the rule-3 test.
- No lens flare, no bloom coupling, no occlusion query. The chain already owns bloom.
- No automatic re-scaling of a game's emissive to match the white point. Reporting it is the
  framework's job; deciding is the game's.

## Acceptance criteria

1. **A point holds its pixel floor.** A playtest scenario pulls the camera from 10 m to 10 km from a
   point with `worldSize` far below a pixel at range, and asserts the lit pixel count stays within a
   band at every distance.
   *Red-green:* delete the `max(worldSize, …)` term; the far samples report zero lit pixels and the
   assertion fails. Paste both.
2. **The pixel floor survives a resolution change.** The same scenario at two pinned scaler rungs
   reports the same apparent size in *CSS* pixels.
   *Red-green:* derive `pixelScale` from the CSS size rather than the drawing buffer; the two-rung
   comparison goes red.
3. **The set is one draw.** A scenario with 24 points asserts the drawn-object count for the set is
   one. (Assert objects and triangles, not `drawCalls` — the repository's own `BatchedMesh` finding
   is that WebGPU reports per sub-draw.)
4. **The white point is reported everywhere.** `TN_TONEMAP` appears in browser console output, in
   desktop stdout and in Android logcat, naming the same value.
   *Red-green:* gate the print on `import.meta.env.DEV`; the native contract test goes red — the
   marker is device-lane evidence, not a dev convenience.
5. **`hdrScale` is honest.** With `hdrScale` at its default of 1, a scenario authoring gains of
   ~2 against an AgX white point asserts, via PRD-341's `assert.tone`, that the points do **not**
   reach display white; with `hdrScale` set to the reported white point over the mean gain, they do.
   This is the trap, encoded as a test, so no game here has to rediscover it.

## Out of scope

Volumetric light shafts from these points, shadow casting, and any clustered-lighting work.
