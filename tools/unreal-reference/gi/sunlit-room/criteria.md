# sunlit-room: what the judge looks at (PRD-647)

Reference: Unreal 5.8.3 `L7-Epic` (tier `high`), `L7-Medium` (tier `medium`) and `L7-Low` (tier `low`).
Frames: `tools/unreal-reference/captures/unreal/sunlit-room/<variant>/<pose>.png`. Regions and ID masks:
`reference-stats.json` and `id/`. Read `../judge-brief.md` first.

The room is a closed box with one window in the front wall and one door opening in the back wall. The only
direct light is the sun patch on the floor. Every other surface is lit by sky light through the window and by
the bounce of the patch. A pose is named `sun<elevation>-<view>`: sun60 is a high sun with a small patch and
neutral grey walls, sun15 is a low sun with a long patch and warm brown walls.

## What every pose must show

1. **Smooth surfaces.** Walls, ceiling and floor show no grain, speckle, streaks or blotches. Unreal is smooth
   at every tier. Grain on a flat wall is the first thing a player sees.
2. **Soft junctions.** Where two surfaces meet (wall and wall, wall and floor, wall and ceiling), Unreal shows a
   soft darkening a few centimetres wide. It shows no bright line, no black line and no seam where two wall
   pieces touch (for example at the sides of the wall above the window).
3. **Falloff.** Light fades smoothly with distance from the window and from the patch. No band, no step.
4. **Colour.** sun60 interiors are neutral grey. sun15 interiors are warm, from the low sun and its bounce.
5. **Patch.** The patch has a hard edge and no halo. The wall near it carries a soft glow from its bounce.

## Per pose

- **sun60-window.** The window wall from the far end of the room. A small patch on the floor below the window,
  a soft glow on the wall below the window, and a soft brightening of the ceiling above it. The wall above the
  window is one smooth surface with a gentle gradient from the ceiling. Side walls fall off smoothly.
- **sun60-leak.** The back-right corner. Light is indirect only. The corner and the floor line are soft and dark,
  with no bright or black line. Walls are smooth.
- **sun60-door.** The back wall with the door opening. The opening is near black. The walls beside it are smooth
  and the head above it joins the wall without a line.
- **sun15-window.** The window wall with a long warm patch on the floor at the lower right. Walls and ceiling are
  warm brown, brightest near the window, smooth, without grain. The left-wall base has no pale line.
- **sun15-leak.** The same corner as sun60-leak, warm brown. Soft corner, no line, no grain.
- **sun15-door.** The door wall with the patch on the floor and on the wall at the left of the door. The patch
  has a hard edge. The opening is near black. The walls are smooth and warm.

## Regions that matter most

`Front_Head`, `Front_Sill`, `Front_Left` and `Front_Right` (the window wall pieces), `Ceiling`, `Wall_Left`,
`Wall_Right` and `Floor`. A region p50 outside 10 percent of Unreal needs a named reason in the verdict.
