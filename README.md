# PRD-889 — woodland-floor judge evidence

**Round 3 (top level, the shipped look): OVERALL IMPROVEMENT.** Deadwood and litter read as a
forest floor under the old trees; nothing floats; no regression. AC-7 stays open on one clause only:
seams and LOD pops *at walking speed* need a per-frame capture, and the desktop target's
`artifacts.screenshots` is `before-after | after` only.

- `run-{before,after}-{1,2}.png`, `sheet-{before,after}.png` — 4 runs, same seed, camera and input.
- `ground-{before,after}.png` — ground band at 2×.
- `change-map.png` — after minus before, brightness ×5. Diagnostic only.

Round 3's change: one mask (`IVale.floorZone`) from the old trees paints bare soil and leaf litter
into the ground, thins the grass, and gathers the debris — so the props stand on ground painted for
them. Each prop is lifted by its own bake offset, and `mossBark`'s moss drops 0.55 → 0.18.

Rounds 1 and 2 (`round1-*`, `round2-*`) are the earlier NEUTRAL verdicts, kept as the record.

All frames are the packaged desktop host's own framebuffer readback. `page.screenshot` returns a pure
black WebGPU canvas on this machine, and the kit's pre-existing `grass.playtest.json` fails the
playtest's 5% capture guard with the identical ratio, so a frame screenshot is not a gate here.

**Round 4 (walking speed): NO SEAMS OR POPS OBSERVED.** `round4-approach-strip.png` stacks five
frames of one continuous approach 0.4 m apart (1.6 m of travel). The judge tracked the fallen log at
the right edge (persists, widens 100 → 120 px, keeps its sawn face and ring band, never swaps or
vanishes), the fern fans at bottom-left (grow monotonically, no discrete step), the mushroom cluster,
the sign post, the stone path and the mossy log at top right across every frame, and found no straight
or axis-aligned edge matching the 32 m tile pitch and no lattice-repeated instance.

The judge's own limits, kept rather than smoothed: five samples 0.4 m apart cannot see a pop that
resolves inside one window or a single-tick LOD swap; twigs, litter and individual tufts sit at or
below the resolving limit of a 1280×720 frame under grass; and 1.6 m of travel cannot cross a 32 m
tile boundary, so a tile-to-tile seam is structurally untestable in that clip.
