# AAA-visuals — what is worth borrowing from *The Long Silence*

Filed 2026-09-03, measured at `43d03e6a`. Source read in full:
[achimala/TheLongSilence](https://github.com/achimala/TheLongSilence) — a single-author procedural
space game, ~44k lines of JavaScript and hand-written GLSL, WebGL2, no downloaded assets, MIT.

It is not a framework and nothing here vendors code from it. What it has is a set of **mechanisms
with their failure modes already measured and written down**, which is the expensive part. Every PRD
below cites the file it came from and the number the reference paid to learn it.

## The batch, ranked

Land them in this order. 341 first: it is the cheapest, and it is what makes the other six judgeable
rather than arguable.

| # | PRD | Layer | Cost | Why it is here |
| --- | --- | --- | --- | --- |
| 1 | [341 — a frame's tone is a number, and the number is a gate](../done/PRD-341-a-frames-tone-is-a-number-and-the-number-is-a-gate.md) | `playtest` | LOW | `assert.tone`: mean, p1/p50/p99, clip%, black%. "It looks flat" stops being an opinion. |
| 2 | [339 — the frame sets its own exposure](../done/PRD-339-the-frame-sets-its-own-exposure.md) | `core` + templates | MEDIUM | Completed: shipped opt-in consumer, actual GPU/native proof and approved lossless preservation qualified. |
| 3 | [342 — where the frame goes: pass-cost ablation](../performance/PRD-342-where-the-frame-goes-pass-cost-ablation.md) | `playtest` | LOW-MED | Every `quality.ts` tier is currently an unmeasured guess. |
| 4 | [340 — evaluate a scatter once per instance](PRD-340-evaluate-a-scatter-once-per-instance.md) | `core` | MED-HIGH | Density is most of the AAA exterior, and the naive form is vertex-bound where the resolution scaler cannot reach it. |
| 5 | [344 — contact occlusion baked from the geometry it ships with](PRD-344-contact-occlusion-baked-from-the-geometry-it-ships-with.md) | `core` | MEDIUM | Free at runtime, tier-independent, and captures the scale screen-space AO never will. |
| 6 | [343 — a light smaller than a pixel is still a light](PRD-343-a-light-smaller-than-a-pixel-is-still-a-light.md) | `core` | LOW-MED | Distance-locked emissive points, plus the report that stops a game authoring emissive at 2% of its tonemapper's white point. |
| 7 | [345 — a backlit subject is not a hole in the sky](PRD-345-a-backlit-subject-is-not-a-hole-in-the-sky.md) | templates only | LOW-MED | Two silent lighting failures every generated game inherits today. |

## How the split was made

Every item went through the two questions in `/AGENTS.md`.

- **341, 342** are harness. Verification, not rendering.
- **339, 340, 343, 344** answer *no* to "could the game write this portably itself?" — they need
  render targets, a compute dispatch, a hook between the world pass and the tonemapper, or the same
  behaviour in a browser and in the C++ host. They answer *no* to "does it decide how anything
  looks?" only because each one is filed with its look-deciding numbers pushed out into
  `src/render/` as generated source. Where that split was not clean — the reference's shared
  weathering-and-plating law, its five base materials, its palette — the item is **not in this
  batch**, because that law *is* the look and a package that owned it would own how every game built
  here appears.
- **345** decides how things look and ships as generated source only. Rule 1(b) vetoes 1(a) at any
  size.

`GPUParticles3D` is the shape every core item here is held to: can the game change the appearance
completely without editing package code? If not, it does not ship in `packages/`.

## Read but deliberately not filed

Recorded so the survey is honest and nobody re-does it:

- **The greeble kit** (`src/gfx/greeble.js`, 2258 lines) — one plate-seam law, one weathering law,
  one rim term, five base materials, applied to every object in the game so the universe reads as
  one author's work. It is the reference's single biggest look win and it is the thing this
  framework must never own. Two mechanisms were extracted out of it into PRD-344 (the occupancy
  bake, and the bake-transforms-then-merge convention); the law itself stays where it belongs, and
  a template that wants one is welcome to grow one in `src/render/`.
- **Adaptive resolution** (`src/core/Engine.js`) — already here, and `resolution-scaler.ts` is
  better instrumented than the reference's. Two of the reference's lessons are worth checking
  against ours rather than filing: take a deferred resize at the *head* of a frame (taking it after
  `render()` presents a cleared buffer — one wholly black frame per resolution change, measured at
  five in twelve seconds during a pan), and ignore the first seconds entirely because shader
  compilation and bakes say nothing about steady state. If our scaler already does both, note it in
  `docs/verification/runtime-perf-state.md` and move on.
- **Bake-once, sample-forever** (`src/gfx/cubeBake.js`, and the planet cubemaps holding albedo in
  RGB and height in A, re-baked at 1024²/face for the nearest body and 256² for the rest). A general
  "render this expensive material into a cubemap and swap the runtime to three texture taps" is a
  real mechanism, but `render/probe-volume.ts` and PRD-268 already occupy most of that ground here.
  Revisit after PRD-268 lands, with an LOD-scheduling PRD if a gap survives.
- **Depth-encoding normalisation** (`PostFX.js` `LINEARIZE_FRAG`) — one full-screen blit inverting
  whichever depth encoding the frame's owning pass used, so every post stage downstream sees one
  buffer with one meaning. Real, and mostly moot for us: TSL exposes view-space Z directly. The part
  that is *not* moot is the two-scene overlay case (an interior drawn over an exterior with the
  depth buffer cleared between), where only one pass per frame can afford a multisampled depth
  resolve — the reference measured ~4 ms a frame for asking for both. If `world-passes.ts` ever
  grows a second scene pass, this is the finding to reread.
- **Analytic traffic** (`src/world/Fleet.js`) — craft on paths keyed to the clock rather than
  simulated, so they are exactly where they belong after a jump, a reload or a two-minute pause,
  with no integration drift and no wake-up cost. That is a gameplay pattern, not a framework
  capability: it belongs in a template or an example, and `path-follow.ts` already has the seam.
- **The boot-verified capture harness** (`tools/boot.mjs`) — clicks through the DOM rather than
  through actionability checks, verifies the loading overlay is actually gone, retries, and
  re-checks between shots, because a capture that starts before a hot reload finishes happily
  screenshots the title card with a plausible frame rate printed next to it. Our
  `startup-readiness.ts` and `TN_CAPTURE_BLANK` cover most of this; the specific gap worth checking
  is the reference's rule that a failure inside the *user's own setup expression* must be reported
  as such rather than as a reload, because reporting the wrong one sends the reader hunting for
  churn that never happened.
- **Turning phones away at the door.** The reference serves handsets a short message rather than a
  reduced build, on the grounds that every feature worth looking at is one a handset cannot afford.
  Directly contrary to this framework's charter and to the Android lane, and noted only so the
  contrast is on the record: the reference optimises one machine's frame, we optimise portability.

## The method worth copying, separately from any of the above

The reference's own verification story is closer to this repository's stated method than most:
`levels.mjs` for tone statistics, `passcost.mjs` for pass-by-pass ablation with the resolution
controller pinned first, `judgeset.mjs` rebuilding a review set into one directory so a judge reads
one place, and `boot.mjs` refusing to screenshot a page that is not actually running. PRDs 341 and
342 are that method, ported to the harness we already have. Everything else in this batch is
judged by them.
