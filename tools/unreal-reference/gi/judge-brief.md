# GI judge brief (PRD-647)

This round compares the global illumination (GI) of the ThreeNative engine with Unreal Engine 5.8.3 on one
calibration scene. Geometry, materials, lights, camera and exposure are the same in both engines. The
frames differ only in how the light bounces: indirect light, colour bleeding, ambient fill and contact
darkening. Judge those. The scene criteria below name where to look.

## What to look at

- **Colour bleeding.** A bright coloured surface tints the surfaces near it. Check the direction of the tint
  (red wall, red cast), its strength and how far it reaches before it fades to neutral.
- **Fill.** A surface that faces no lamp is lit by bounced light only. It is dim, never black and never as
  bright as a surface that faces the lamp.
- **Darkening.** Corners and creases are darker than open surfaces, and the dark fades out smoothly.
- **Faults.** Blotches, speckle, banding, tiling, halos, light leaking through a wall or a seam, a flat
  uniform ambient that ignores the geometry, and black patches where Unreal is lit.

## How to answer

- **verdict** (AFTER against BEFORE): IMPROVEMENT, NEUTRAL or REGRESSION by the scene criteria. One new
  fault in one region is a REGRESSION even when the rest got better. When BEFORE and AFTER are the same
  capture the verdict is NEUTRAL.
- **vsUnreal** (AFTER against UNREAL):
  - **MATCH**: a player who sees the two frames one after the other notices no difference in the
    bounced light.
  - **CLOSE**: the same lighting result with a named difference of degree, for example a weaker tint or a
    brighter corner. Name the region and the difference.
  - **FAR**: a different lighting result: missing or wrong-coloured bounce, a flat ambient, a leak, banding
    or blotches that Unreal lacks.
- Each arm has two runs of one capture. A difference between the two runs of one arm is capture noise.
  Judge what stays the same in both runs.
- The numbers table shows the regions where the measurements disagree. A number tells you where to look.
  The images decide the answer.
- Do not judge bloom, exposure adaptation, anti-aliasing, the sharpness of shadow edges, reflections or the
  shape of the lamp. Those belong to other layers and other PRDs.
