# PRD-789: Material textures filter at Unreal's Epic anisotropy by default

**Status:** NOT STARTED — filed 2026-11-03 from PRD-539 (deferred, not declined).  
**Priority:** P2 — Phase 1 is open: unset texture anisotropy still differs from the Unreal Epic default.

## Problem

Stock Unreal 5.8.3 at Epic filters World-group textures at 8x anisotropy (`r.MaxAnisotropy=8`,
`Engine/Config/BaseScalability.ini` `[TextureQuality@3]`). ThreeNative keeps three's default `texture.anisotropy = 1`.
At grazing angles the ThreeNative texture is blurrier than Unreal's on the same scene. Measured on
`gi:neon-corridor` pose `textured`, far brick wall, mean absolute Laplacian at 100%: Unreal 14.63,
ThreeNative 12.51 at 1x, 13.72 at 8x ([PRD-539](../../done/PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md), judges 4 and 5). The owner rule is that the Unreal defaults are the engine default
look, each with a named override.

## Outcome

A material texture with no authored anisotropy filters at the tier's Unreal value (Epic 8, High 4, Medium 2, Low 1).
An authored `texture.anisotropy` overrides it, and the override is reported.

### Phase 1 — The default

- [ ] The engine resolves an unset anisotropy to the tier's Unreal value, the authored value overriding it. proof: a spec on the resolved sampler key per tier, and a native conformance row or `--target desktop` playtest.
- [ ] `gi:neon-corridor` at L7 moves toward Unreal on the brick wall with no knob. proof: `pnpm unreal-look:compare`
  on `Wall_Brick` and `compare --check` on every textured scene (neon-corridor, the shadow foliage scenes) with
  lock receipts, and a fresh visual judge, IMPROVEMENT required.
- [ ] The GPU cost is stated. proof: paired locked-clock GPU p50/p95 on one textured template.

## Acceptance criteria

- [ ] Unset anisotropy follows the Unreal tier value, overridable and reported. proof: Phase 1 boxes.
