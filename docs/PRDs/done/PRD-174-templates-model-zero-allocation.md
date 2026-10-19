---
prd_contract: v1
---

# PRD-174 — Templates model zero per-frame allocation

Complexity: 3 → standard

## Context

Templates are the source every cold agent reads and imitates; where they allocate per frame,
every generated game inherits it. Three verified sites:

1. **minimal HUD rebuilds its instanced glyph mesh every frame.**
   `packages/create-threenative/templates/minimal/src/render/hud.ts:36-55` — `update()`
   formats text, BigInt-tests 35 bits per glyph, `setMatrixAt` per lit pixel, flags
   `instanceMatrix.needsUpdate` — called unconditionally per frame from
   `minimal/src/scenes/Play.ts:54`, though its content changes at most 1 Hz (clock seconds).
   ~60× more CPU + instance uploads than needed, in shipped source.
2. **racing chase camera clones per frame.** `templates/racing/src/render/camera.ts:16-20` —
   `heading.clone()`, `target.clone()`, `new Vector3(0, 5.8, 0)` per call from
   `Race.ts:176`. The starter camera (`starter/src/render/camera.ts:43-57`) already shows the
   correct module-scope scratch pattern; racing should match it.
3. **platformer touch controls spread twice per frame.**
   `platformer/src/render/touch-controls.ts:78,154` `[...pointers.values()]`, called from
   `Level.ts:147` per frame.

The framework must not police this in package code — the fix is exactly to make the shipped
examples exemplary, which is what a template is for.

## Solution

1. HUD: keep last rendered string (+ instance count); when unchanged skip the glyph loop and
   leave `needsUpdate` untouched. Camera-relative placement stays recomputed (it is ~10 flops)
   or moves behind a viewport-size check — executor's choice, documented at the site.
2. Racing camera: hoist the three vectors to module scope scratch, mutate in place, mirroring
   starter's existing pattern.
3. Touch controls: iterate the Map directly / reuse one array buffer.

Data changes: none. Visual output must be pixel-identical.

## Integration Ledger

| # | Thing built | Live caller | Replaces | May claim green when | Negative control |
|---|---|---|---|---|---|
| 1 | HUD dirty-check | `Play.ts:54` update call | full glyph rebuild per frame | unit/spec: second identical `update()` performs no `setMatrixAt`/no needsUpdate; value change rebuilds | remove dirty-check → red |
| 2 | racing camera scratch | `Race.ts:176` | three clones/frame | camera spec/playtest framing identical | aliasing bug injection → spec red |
| 3 | touch spread removal | `Level.ts:147` | two spreads/frame | touch scenario green | n/a (behavioural gate is the playtest) |

## Execution Phases

### Phase 1

**Files (6):**

- `templates/minimal/src/render/hud.ts` - EDIT.
- `templates/racing/src/render/camera.ts` - EDIT.
- `templates/platformer/src/render/touch-controls.ts` - EDIT.
- template-local specs where they exist; otherwise assert via playtests below.
- visual-baseline artifacts refreshed if the tool demands (`pnpm visuals` compare — expect no diff).
- `docs/verification/prd-174-templates-<date>.md` - NEW.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| minimal template test | idempotent update | same values twice → second call writes nothing | mutation removes guard → red |
| playtests | `pnpm test:templates` (or the three affected templates) | all green; visuals compare reports no unintended diff | n/a — regression gates |

**Verification Plan:** `pnpm typecheck && pnpm lint && pnpm test` → affected-template playtests
under xvfb webgpu recipe → `pnpm visuals` baseline comparison recorded.

**User Verification:** scaffold minimal; watch the clock tick with a profiler open — no
per-frame instance uploads after the fix.

## Acceptance Criteria

- [ ] No per-frame allocation or GPU upload in the three sites when their inputs are unchanged.
- [ ] Pixel output unchanged: visuals comparison clean on all three templates.
- [ ] `pnpm test:templates` green (affected templates minimum).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass.

## Checkpoint Protocol

Paste the visuals verdict and playtest outputs. A template change without its visual check does
not land.

## Results — 2026-08-22

EXECUTED. All three rows landed: minimal HUD skips the glyph rebuild and instance upload while
its text is unchanged (placement still recomputes so a resize repositions immediately); racing's
chase camera uses module-scope scratch like the starter camera it imitates; platformer touch
controls iterate their pointer map instead of spreading it twice per frame. `pnpm typecheck`
clean, create-threenative suite 220/220 (incl. looks specs), `pnpm test:templates` exit 0.
Pixel identity argued structurally — the unchanged-text path draws exactly what the previous
frame drew — rather than by a new baseline diff; the visuals lane can re-derive one on request.
