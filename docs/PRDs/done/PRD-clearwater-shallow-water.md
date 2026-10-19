# Clearwater shallow-water integration

Status: DONE — implementation and review fixes complete; latest-head standard CI green.

## Goal and ownership

Expose `createClearwater(ctx, options)` as editable game source. Compose the existing
`SpectralOcean`, `RippleField`, and `WaterSurface3D` mechanisms. Keep materials, TSL, sunlight,
absorption and quality choices in `src/render/`; add no runtime dependency, core look,
renderer wrapper or CLI command. The default game must not silently change appearance.

Delivery is an opt-in source bundle in `packages/create-threenative/template-assets/clearwater/`,
which the existing package already includes in its published files. Its explicit installer copies
source into an existing game and refuses overwrites. No default template source or scaffold hash
changes.

Clearwater is a standalone WebGL2 demonstration, not an embeddable Three.js package. Adapt its
dielectric Fresnel, Beer–Lambert extinction and refracted-grid caustics to Three.js TSL rather than
embedding HTML or taking over the renderer. Reuse ThreeNative's FFT and preserve the upstream
MIT notice (Copyright 2026 Lumaris).

## Phase 1 — numerical and ownership contracts

- [x] Add bounded options, Fresnel/extinction expressions, disposal stack and scoped render-target state.
- [x] Execute regression assertions for invalid inputs, Fresnel endpoints/bounds, extinction,
  reverse/idempotent/error-tolerant cleanup and restoration after a failed draw.
  Evidence: 23/23 assertions passed; the renderer-state negative control failed before its helper
  was implemented.

## Phase 2 — source integration

- [x] Write the composed factory, FFT/ripple sampling, refractive material and RGB ray-grid caustics.
- [x] Add disturbance/follow/level/sun/height-query methods and scene-removal teardown.
  Review correction: CPU height queries now apply the renderer's two-texel ripple edge fade,
  including after `follow()`. Red/green regression: 5 failed/2 passed before; 7/7 passed after.
- [x] Include an opt-in demo, installation/usage/limitation instructions and full upstream MIT notice.
- [x] Verify installation and refusal to overwrite edited game files.
  Review correction: installer preflights directory parents and rejects symlinked/non-directory
  destinations before copying. Red/green regression: 3 failed/3 passed before; 6/6 passed after.

## Phase 3 — repository qualification

- [x] Run the repository's standard full CI on the latest head. proof: PR CI run 36231273808 on
  head `6682bd6add3eb23b9ddb3320779e5a236235f100` completed successfully.
  The bespoke Clearwater workflow and browser harness were removed during review: they duplicated
  normal typecheck/lint/unit setup and maintained a second CI path for one opt-in source bundle.
  The earlier one-time WebGPU smoke had already compiled and rendered the effect; it is not retained
  as a recurring feature-specific gate.

## Review focus and boundaries

Auxiliary passes must restore target/face/mip/MRT/clear/XR state. Foreground objects must not bleed
into refraction. Caustics and geometry must read the same wave/ripple fields. Local interaction
must not tile outside its finite patch. Disposal must stop callbacks and release resources.
WebGL2 is explicitly rejected instead of silently producing an empty effect.

This is an above-water finite horizontal surface. Refraction reads opaque screen-space scenery;
transparent/offscreen objects are not traced. Caustics focus on a representative planar receiver
and modulate captured colour, not per-light irradiance/shadow visibility. The game's terrain,
sky, lighting and postprocessing replace upstream's baked bed, headland, camera and lens-glare
pipeline. No underwater-camera system or pixel-identical reproduction is claimed.
