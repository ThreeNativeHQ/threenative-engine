# glass: what the judge looks at (PRD-647)

Reference: Unreal 5.8.3 `L7-Epic` (tier `high`). `L7-Low` is the same room with Lumen off. Compare TN L7 with
`L7-Epic` and TN L6 with `L7-Low`.
Frames: `tools/unreal-reference/captures/unreal/glass/<variant>/<pose>.png`. Regions and ID masks:
`reference-stats.json` and `id/`. Read `../judge-brief.md` first.

The room is a closed box, 6 x 3 x 6 m. The left wall is red, the right wall is green, all other surfaces are
white. One lamp hangs 1 m in front of a free-standing pane of frosted glass. The pane is white and 50 percent
opaque. A white block stands behind the pane, and the pane covers the left 40 percent of the block as seen from
the front. The only direct light is the lamp. Every other light is the bounce of the lamp in the room. The glass
is Unreal's default translucent material: it casts no shadow, and Lumen lights it from its translucency volume,
the same in every direction.

## What every pose must show

1. **No shadow from the pane.** The lamp light passes through the pane. The back wall and the floor behind the
   pane are as bright as they would be with no pane. A dark rectangle on the back wall behind the pane is the
   most noticeable fault.
2. **A pale sheet that shows the room through it.** The back wall, the block and the floor are visible through
   the pane at about half strength. The pane adds its own pale colour. It is not a mirror and not a grey film.
3. **The pane takes the bounce light.** At L7 the pane is brighter than at L6 by the room's bounce, and it
   shows no dark band at its edges. The red wall and the green wall tint the pane only a little.
4. **Smooth surfaces.** Walls, floor and pane show no grain, speckle or blotches.
5. **No leak.** The bounce light of the lamp does not cross the pane as a bright or dark line on the floor.

## Per pose

- **glass.** The pane from the front, 3.7 m away. The pane covers the middle of the frame. The block is
  visible at the right, 40 percent of it under the pane. The back wall is evenly lit behind the glass. The floor
  in front of the pane shows the lamp's pool of light.
- **glass-edge.** The pane edge from a front-right view. The 4 cm edge of the sheet is visible. The block
  shows both through the pane and bare. The step in brightness between the part behind the glass and the bare
  part is soft and the same size in both engines.

## Regions that matter most

`Pane`, `Box_White`, `Back`, `Floor`, `Wall_Red`, `Wall_Green`. A region p50 outside 10 percent of Unreal needs a
named reason in the verdict. For `Pane`, compare the part over the back wall and the part over the block.
