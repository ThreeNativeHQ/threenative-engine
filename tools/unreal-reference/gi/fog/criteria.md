# fog: what the judge looks at (PRD-647)

Reference: Unreal 5.8.3 `L7-Epic` (tier `high`). `L7-Low` is the same room with Lumen off. Compare TN L7 with
`L7-Epic` and TN L6 with `L7-Low`. Fog starts at layer L3, so L1 has none.
Frames: `tools/unreal-reference/captures/unreal/fog/<variant>/<pose>.png`. Regions and ID masks:
`reference-stats.json` and `id/`. Read `../judge-brief.md` first.

The room is a closed box, 6 x 3 x 6 m, empty. The left wall is red, the right wall is green, all other
surfaces are white. One lamp hangs under the ceiling. The whole room is full of volumetric fog (extinction
0.1 per metre). The fog is lit by the lamp and by the bounce light of the room. The bounce light gives the fog a
soft, wide glow. At L6 (Lumen off) only the lamp lights the fog, and the fog is black far from the lamp.

## What every pose must show

1. **A glow round the lamp that fades smoothly.** No ring, no band, no step, no bright disc on the ceiling.
2. **Fog far from the lamp is not black at L7.** The bounce light fills it. The fog in front of the red wall is
   tinted red and the fog in front of the green wall is tinted green, a little.
3. **The walls are veiled by the fog.** Far walls are lower in contrast and lighter than near walls. The veil
   grows smoothly with distance.
4. **Smooth fog.** No grain, speckle, streaks, banding or flicker. Unreal's volumetric fog is smooth.
5. **No fog outside the room.** The fog ends at the walls with no halo and no bright line.

## Per pose

- **fog.** The room from the front wall to the back wall. The lamp glows in the middle of the frame, the
  back wall is veiled, the red and green walls are visible at the sides.
- **fog-corner.** The red wall corner from the front-left. The far corner is veiled. The red wall is lit by
  the lamp and by the fog.

## Regions that matter most

`Back`, `Wall_Red`, `Wall_Green`, `Floor`, `Ceiling`. The fog has no mesh, so it lowers the contrast of the
region behind it. A region p50 outside 10 percent of Unreal needs a named reason in the verdict.
