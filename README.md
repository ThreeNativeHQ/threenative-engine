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
