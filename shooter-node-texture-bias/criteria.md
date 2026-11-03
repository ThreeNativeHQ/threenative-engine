# PRD-539 lever 7 follow-up (node material texture() mip bias) — visual criteria (written before judging, 2026-11-03)

Game: the shooter starter kit, 1920x1080, browser WebGPU on an RTX 2080, fixed-step clock, same pose per frame.
Frames: `still` (90 ticks after spawn) and `strafe` (12 ticks into a held strafe right).
Columns, 2 runs each:
- A: SHIPPED 4x MSAA, scale 1.0 (full-resolution reference; this change does not touch it).
- B: TRAA 0.667 BEFORE: the view mip bias applies to the material's own maps, but the kit's surface detail
  texture, read through a TSL `texture()` node (`src/render/surface.ts:94`), samples at the implicit LOD.
- C: TRAA 0.667 AFTER: that node texture also reads at the view mip bias (-0.88 mips at 66.7%).

Intended effect: C keeps more fine surface detail than B where the kit's surface detail texture shows
(floor, walls, stucco, plaster or concrete grain), closer to A, with no new artifact.

Judge each frame and overall:
1. C against B: the change promises more detail, so IMPROVEMENT is required. NEUTRAL means no visible effect.
   REGRESSION if C adds sparkle, moire, aliasing or shimmer-prone noise on textured surfaces, a colour or exposure
   shift, ghosting or trails.
2. C against A: IMPROVEMENT, NEUTRAL or REGRESSION with the visible cause; rate any remaining softness against A as
   none, slight, moderate or severe, and name every artifact.
3. Do not count a difference that also appears between run 1 and run 2 of the same column.
