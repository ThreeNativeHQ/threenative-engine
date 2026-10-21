# neon-corridor: what the judge looks for

Judge ENGINE against UNREAL per pose and layer. Answer MATCH, CLOSE or MISMATCH per item, then overall.
The scene has no sun and no sky: every photon comes from the lamp or the two strips and the 5 cm emitter.

## Pose `textured` (camera at the left wall, looking along the brick wall)

1. **Brick wall colour.** `Wall_Brick` reads red-brown, as the texels say. A white or grey wall means
   the engine bounced and shaded the white base colour factor and ignored the texture.
2. **Bounce tint on the floor.** The floor near the brick wall takes a faint warm red-brown cast.
   The cast stops at the same distance from the wall as Unreal's.
3. **Bounce tint on the plain wall.** `Wall_Left` is lit by the brick wall's bounce and the lamp. Its
   brightness and its warm cast match Unreal's within the PRD-631 thresholds. A neutral grey wall at
   the same brightness is a MISMATCH.
4. **Lamp.** The warm lamp's pool on the floor and the walls has the same size and falloff. A lamp
   that lights only what the camera sees directly (no light on the floor behind the lamp) is a MISMATCH.

## Pose `neon` (camera in the corridor mouth, looking down the strips)

5. **Strip glow.** The cyan strip tints the left wall and floor cyan, the magenta strip tints the right
   wall magenta. The tint reaches the same distance from each strip as Unreal's.
6. **5 cm emitter.** The amber emitter lights the floor and walls near it with a soft warm pool. A
   speckle, a hot spot of a few probe cells, or no pool at all is a MISMATCH.
7. **Ceiling.** The ceiling is lit by the strips and the lamp only. It is not black and not flat.
8. **No banding.** Walls and floor carry no stripes, grid cells or blotches that Unreal's frame lacks.

Not judged here: bloom and exposure (L9 only, informative), shadow softness (PRD-650), reflections.
