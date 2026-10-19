---
prd_contract: v1
---

# PRD-246 — `SpectralOcean`: the second ocean, with the contract the first one cannot offer

**Status: DONE, 2026-08-29 — web only, with named gaps.** `GPUReadback`, the `IRendererLike.readback`
seam and `SpectralOcean` are on the public surface and reached by a real consumer built outside this
repository: [`sandbox/spectral-sea`](https://github.com/ThreeNativeHQ/examples/tree/main/spectral-sea),
a game whose gate can only be cleared by a wave lifting the raft through it. Evidence:
[docs/verification/PRD-246-255-spectral-ocean-and-gpu-candidate-field.md](../../verification/PRD-246-255-spectral-ocean-and-gpu-candidate-field.md)
— unit tests with every red control, a headed WebGPU playtest on a named `nvidia / turing` adapter,
and a capture that was read.

**Still `UNVERIFIED`, and not claimed:** native desktop conformance (Phase 1's case was not added);
Android and iOS, so Phase 4's decision about whether the FFT fits a mobile frame is unmade and this
class claims **web only**; `pnpm budgets`, `pnpm quality` and `count-loc`; per-cascade cost at N=256
and N=512. **The A/B against `WaveField` required by the acceptance criteria cannot be run at all:**
`WaveField` does not exist, because PRD-236 has not been implemented. The two-contract argument this
document makes stands on its own; the "visibly better" comparison does not, and is not claimed.

Sources read at depth 1 on 2026-08-28, both MIT:
[`owenyuwono/poseidon`](https://github.com/owenyuwono/poseidon) and
[`reed-soul/SeedOcean`](https://github.com/reed-soul/SeedOcean).

Parent batch: feature-mining.
**Does not replace [PRD-236](./starter-kits/PRD-236-sailing-starter-kit.md).** Both ship, under
different names, because they make different promises — which is the whole point of this document.

**Complexity:** +2 new subsystem, +2 async GPU→CPU readback across four targets, +2 multi-package,
+1 ≤5 files per phase = **7 → HIGH mode.**

## The question: why two, and why not just the better-looking one

PRD-236's `WaveField` is **analytic** — a closed-form wave function evaluated twice, once in TSL on
the GPU and once in TypeScript on the CPU, with the framework guaranteeing the two agree. That
guarantee is the reason it exists: a boat that floats on a wave the shader is not drawing is the bug
the PRD was written to kill.

Poseidon is **spectral** — a Gaussian noise field, a wave spectrum, an inverse FFT per cascade, and
displacement, derivative and foam maps living in textures. It looks dramatically better. And it
**cannot make PRD-236's guarantee**, because there is no closed form to evaluate on the CPU: the
height at a point exists only as texels the GPU produced.

That is not a flaw to paper over with one class that does both. It is two different contracts:

| | `WaveField` (PRD-236, analytic) | `SpectralOcean` (this PRD) |
| --- | --- | --- |
| Height at `(x, z, t)` on the CPU | Closed form. Exact, free, any point, any time, this frame. | Async GPU readback into a CPU buffer, throttled. Bounded region, **N frames stale**. |
| Buoyancy | Exact by construction — the same function, twice. | Approximate. Agreement is a **measured tolerance**, not an identity. |
| Look | A sum of waves. Honest, limited. | Spectral cascades, derivative maps, foam history. Much better. |
| Cost | Negligible. | An FFT per cascade per frame, plus readback. |

A game picks by what it needs. A physics-heavy sailing game with a hundred floating crates wants the
analytic one. A game whose ocean is the view wants the spectral one. **Naming them the same thing
and switching internally would hide the staleness from the one caller that must not be surprised by
it.**

## The part that is the framework's, and it is not the ocean

Under the live test — *can the game change the appearance completely without editing framework
code?* — the ocean's **appearance** is emphatically the kit's:

- Poseidon's `src/ocean/oceanSurfaceMaterial.js` is **1 700+ lines of look** and does not enter a
  package. Nor do spectrum tuning, foam thresholds, the sky it reflects, or the colour of water.
- Even its physical constants are look decisions with research behind them: `Ocean.js:20`,
  `FOAM_DRIFT_FRACTION = 0.03`, justified against `docs/foam-research.md`. That belongs beside the
  material in a kit, where a game can disagree with it.

What a game **cannot** write portably is the readback:

> **Async GPU→CPU readback, throttled, with staleness reported rather than hidden — on browser,
> desktop, Android and iOS.**

SeedOcean shows both that this is the answer and that it is fiddly enough to be worth owning once:

| Claim | Evidence |
| --- | --- |
| FFT ocean buoyancy is solved by a **throttled** readback, not a per-frame one | `SeedOcean/src/core/buoyancy.js:1` — *"Throttled GPU readback for buoyancy and camera underwater state"*; `:12` — *"readback every N frames"* |
| The readback is fire-and-forget; the sample is local | `buoyancy.js:22` — *"Fire-and-forget readback; safe to call every frame"*; `:39-41` `getHeight(x, z)` → `sampleHeightFromBuffer(x, z, this.buffer)` |
| Poseidon has the readback primitive but exposes no height query | `fft.js:126` and `Ocean.js:140` use `renderer.getArrayBufferAsync`; there is no `getHeight` in `src/` |
| Poseidon's surface material deliberately avoids readback for *rendering* | `oceanSurfaceMaterial.js:1742` — *"no CPU readback, no async latency"* |
| Its architecture is already `three/webgpu` + `three/tsl` + `renderer.compute` | `Ocean.js:1-7`, `:113-135` |

**So the framework ships `GPUReadback` and `SpectralOcean`'s simulation core; the kit ships the
water.** And `SpectralOcean` is a class a game constructs or never mentions — if it never mentions
it, nothing about the game changes.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| PRD-236 `WaveField` | **Sibling, not incumbent.** Different contract, different name, both live. PRD-236 is not edited by this PRD beyond a cross-reference. |
| `IComputeDriven` (PRD-242) | Depended on: the FFT passes are ordered compute with buffers to release. |
| `IRendererLike` — `renderer.ts:104` | Extended with a readback seam, guarded to WebGPU the same way `compute` already is at `:267-270`. |
| `@threenative/physics` | Buoyancy forces are applied to bodies it already owns. No new body vocabulary. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `GPUReadback` — async, throttled, staleness-reporting | `SpectralOcean`; usable by any game | nothing | n/a | freeze the buffer → `staleFrames` climbs and the assertion catches it |
| 2 | `IRendererLike.readback` | `packages/core/src/renderer.ts` seam | nothing | n/a | call on a non-WebGPU renderer → throws, matching `compute`'s guard |
| 3 | `SpectralOcean` (cascades, FFT, maps) implementing `IComputeDriven` | a kit scene | nothing | n/a | remove it → the kit's ocean capture reverts to flat |
| 4 | `sampleHeight(x, z)` with a declared staleness | the kit's buoyancy body | nothing | n/a | compare against a GPU-side probe: divergence beyond tolerance fails |
| 5 | Ocean **look** — material, spectrum tuning, foam, sky | the kit's `src/render/` | nothing | n/a | edit the material in the kit → appearance changes with no package edit; this is the charter test, executable |

## Execution Phases

### Phase 1 — readback, alone, and honest about latency

**Files (4):** `packages/core/src/gpu-readback.ts` (NEW), `renderer.ts` (EDIT — the seam),
`__tests__/gpu-readback.spec.ts` (NEW), conformance case (EDIT).

- [ ] `request()` is fire-and-forget and never blocks a frame. A readback that stalls the frame is
      the failure this must not ship.
- [ ] Every sample carries `staleFrames`. **Staleness is reported, never hidden** — a game deciding
      whether 3 frames of lag matters must be able to ask.
- [ ] Proven on native in this phase, not later: conformance case, target named.

| Test | Assertion | Negative control |
| --- | --- | --- |
| `should never block the frame while a readback is pending` | frame time unchanged within tolerance | await it inline → frame time spikes, reds |
| `should report staleFrames growing while no new readback lands` | monotonic increase | hardcode 0 → reds |
| `should throw on a renderer without readback support` | throws, names it | return undefined → silent wrong height, reds |

### Phase 2 — the spectral core, measured against a reference

**Proof subject:** a multi-cascade ocean at a real wind speed, **not** a single-cascade toy — the
cascade join is where spectral oceans visibly fail.

**Files (4):** `packages/core/src/ocean/spectral.ts` + `fft.ts` (NEW), tests (NEW), verification
record (NEW).

- [ ] Gaussian noise → spectrum → time-dependent spectrum → IFFT → displacement and derivative maps.
- [ ] Determinism: same seed and params produce the same field. A stochastic ocean is untestable.
- [ ] Cost recorded per cascade at N=256 and N=512, desktop lane, `render.p50`.

### Phase 3 — a boat floats, and the tolerance is a number

**Files (4):** a kit scene (EDIT), the kit's `src/render/` ocean material (NEW — the look, in the
kit), a playtest (NEW), verification record (EDIT).

- [ ] Buoyancy from `sampleHeight`, with the staleness tolerance **stated in the kit** and asserted.
- [ ] The scenario asserts the hull's waterline stays within tolerance of the drawn surface over
      N seconds — the same class of guarantee PRD-236 makes exactly, made approximately and
      measured.
- [ ] Both oceans run in the same repository, and a doc names when to pick which.

### Phase 4 — mobile, with the authority to refuse

- [ ] Physical Pixel 8, cool, cold launch, paired arms.
- [ ] **If the FFT does not fit the frame on mobile, `SpectralOcean` ships desktop-and-web-marked**,
      with the number recorded, and `WaveField` remains the portable answer. That outcome is
      recorded here, not hidden behind a config default.

## Acceptance criteria (consumer-scoped)

- [ ] A game constructs `SpectralOcean` and gets a visibly better ocean than `WaveField` produces —
      A/B captures pasted, web and native.
- [ ] A boat floats on it, and the waterline error against the drawn surface is a measured number
      with a stated staleness, not an assertion of correctness.
- [ ] A game that never constructs it has identical frames and identical timing to HEAD.
- [ ] The ocean's material, spectrum tuning, foam constants and sky all live in the kit, and editing
      them changes the look with **no package file touched** — diff pasted.
- [ ] `WaveField` and PRD-236 still work unchanged, and the docs say which to pick and why.
- [ ] No `ocean:` config option, no preset list — grep pasted.
- [ ] `GPUReadback` is usable by a game for something that is not an ocean, shown by one test.

## Kill switch

`GPUReadback` survives on its own merits — it is portable plumbing with more than one caller.
`SpectralOcean` is measured against the kit writing it by hand on top of `IComputeDriven` and
`GPUReadback`. If the framework's version is not smaller, the simulation core moves to the kit and
only the readback stays.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`owenyuwono/poseidon @ `671053b8`, reed-soul/SeedOcean` @ `115e0ba0`**.

| To implement | Read |
| --- | --- |
| the wave spectrum and shared Gaussian noise | poseidon `src/ocean/spectrum.js`, `src/ocean/gaussianNoise.js` |
| cascade structure and the inverse FFT | poseidon `src/ocean/OceanCascade.js`, `src/ocean/fft.js` |
| displacement / derivative / foam map assembly | poseidon `src/ocean/maps.js` |
| per-frame dispatch order | poseidon `src/ocean/Ocean.js:113-135` |
| **the throttled readback that makes FFT buoyancy possible** — the core borrow | SeedOcean `src/core/buoyancy.js:1-60` (`getHeight` → `sampleHeightFromBuffer`, "readback every N frames") |
| applying it to a floating body | SeedOcean `src/core/buoyancy-body.js` |
| **do NOT borrow into a package** — this is the kit's, all of it | poseidon `src/ocean/oceanSurfaceMaterial.js` (1 700+ lines), `src/ocean/sky.js`, `src/ocean/atmosphere.js` |
