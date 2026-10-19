---
prd_contract: v1
---

# PRD-224 — WebGPU binding tables install once per class

**Status:** PARTIAL — **measured 2026-08-27, and the measurement changes what this PRD is worth.**
Phases 2 and 4 are done; Phase 1 is done and **refutes this PRD's own ≥2 ms prediction**; Phase 3 is
NOT STARTED and is now bounded at roughly 0.3 ms before anyone writes it. Evidence:
[`docs/verification/runtime-perf-state.md`](../../verification/runtime-perf-state.md).

**Priority:** P3 — Its own A/B prices the remaining work at about 0.3 ms of a 24 ms frame.
| Phase | State | What the executable said |
| --- | --- | --- |
| 1 — frame pricing | **DONE** | Paired desktop arms, three runs each: class tables ON **24.0207 ms** work/frame against OFF **24.0426 ms**. **Flat.** |
| 2 — `GPURenderPassEncoder` | **DONE** | Landed `47d1adb3`, contract-proven (red 3 failure(s)/exit 1, green exit 0). Priced 2026-08-27: `beginRenderPass`+`end` 80,977 → 8,168 ns (**~9.7×**); `createCommandEncoder` 30,746 → 928 ns (**~33×**, Chrome parity at 919 ns). |
| 3 — the remaining 37 classes | **NOT STARTED, and now questionable** | `writeBuffer` is the highest-frequency crossing at ~428 calls/frame and costs 1,130 ns against Chrome's 431 ns — ~0.3 ms of excess in total. Converting the rest cannot recover the ~14 ms render excess by this mechanism. |
| 4 — device arm | **DONE (unpaired)** | Physical Pixel 8, fresh install, cold launch, cool phone: **20.44 fps median**, render.p50 33.56 ms. Against a 30 fps floor and a 58 fps target — **the Android FPS defect is not solved.** |

The conversion is correct, keeps its contract, and buys a real per-call win worth keeping. It is
**not** the lever that closes PRD-222, because Bayview calls these two classes about three times each
per frame: the whole conversion is worth ≈0.3 ms of a 24 ms frame. The claim inherited from the
2026-08-26 root-cause section — that the binding tax accounts for roughly half the render excess —
is **not supported** by the ON/OFF A/B.

Step 1 of the staged plan (`c9941d0a`, GPUCommandEncoder only, measured 78 835 → ~3 820 ns for
`createCommandEncoder`) was PARTIAL BY INHERITANCE at filing time. Filed 2026-08-26 for the night
batch; live at the PRD root since 2026-08-27. **Stays live** — the open question is no longer
"finish Phase 3" but "is Phase 3 worth writing", which the numbers above now inform.

**Complexity:** +2 for the receiver-identity contract change across three engines, +1 for
multi-class surface, +1 for design decisions per class = **HIGH mode**.

## Why this is the highest-value item tonight

The root cause of the parity defect ([PRD-222 reassessment](../../verification/runtime-perf-state.md),
ROOT CAUSE section): every WebGPU object handed to JavaScript installs its whole method table on
**every call that creates it**, through transactional machinery designed for one-time installation.
Measured per call against Chrome on the same machine:

| Call | Native (red) | Native (after step 1) | Chrome |
| --- | ---: | ---: | ---: |
| `createCommandEncoder` | 78 835 ns | **~3 820 ns** | 919 ns |
| `queue.writeBuffer` (16 B) | 3 249 ns | 2 830 ns | 431 ns |
| `buffer.size` — control | 11 ns | 11 ns | 21 ns |

The frame issues ~3 200 crossings costing 8.16 ms of bridge time; at Chrome's per-call price the
same stream costs ≈1.4 ms. The predicted win crosses the resume criterion's ≥2 ms bar with the
exact caller path named — this is the resume ticket.

**Step 1 proved the falsifier false:** the cost was binding installation, not object construction.
`ensureCommandEncoderClassTable` exists at HEAD; no other class has one (`grep ensure.*ClassTable`
returns one hit).

## Solution (decision recorded here)

Same mechanism as step 1, widened on evidence: one shared prototype per WebGPU class, methods
installed once through the SAME transactional `installBindingTable` (snapshot/verify/rollback run
per class, never per instance), native handles resolved from the receiver's private data.
Engines without method support fall back to the legacy per-call path behind the same entry point —
each conversion is one commit to revert.

Rejected alternative, on the record: wrapper pooling (Lever A) — flat result, removed under the
kill switch. The cost is inside what binding bodies do after entry, not how many wrappers exist.

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Per-class tables for ≥1 further class | runtime WebGPU bindings | per-call `installBindingTable` on those classes | disable fast path → `threenative-command-encoder-class-table-test`-style executable red, legacy fallback asserts fire |
| 2 | Receiver-aware dispatch through V8/QuickJS/JSC `newMethod()` | all converted handlers | captured-C++-argument closures (`makeCapturedHandler`) | shared-engine contract test with a detached/misresolved receiver fails |
| 3 | Priced widening order | this PRD's verification record | guess-based class order | a class whose measured tax is <2× Chrome's rate is refused conversion |

## Execution Phases

### Phase 1 — Price step 1 at the frame level on a quiet machine

**Files (2):** `verify-desktop-core.mjs` runbook invocation (none added), verification record (NEW).

- [x] `gpubench.js` rerun on the current build: `createCommandEncoder` ≈ 3.8 µs sustained;
      record current residuals for every class still on the legacy path.
      ([record](../../verification/runtime-perf-state.md) — measures **0.89–0.98 µs**
      on the private-Xvfb lane, below the expected 3.8 and at Chrome parity; residuals:
      `writeBuffer` ~1.1 µs flat, control 5 ns.)
- [x] Desktop `TN_FRAME_BUDGET` pair against the recorded native render.p50 pair (22.2 ms,
      Chrome 7.6–8.9 ms). Same display lane both arms — Xvfb and `:0` are different meters.
      Expect render.p50 to move materially below 22.2 ms. If it does NOT move, stop: the
      installed tax is real but off the critical path, and widening is refused until that is
      explained.
      ([record](../../verification/runtime-perf-state.md) — ran on the private-Xvfb
      lane against a sha256'd `af36d3f3` control host; **NO-MOVE**, +0.50/+0.59 ms across two
      update-matched pairs (head marginally slower; a third pair was excluded for phase
      confound per F7 — both its attempts are shown in the record); the stop rule's
      explanation is priced there. `97a4c808`'s mutation-OFF arm agrees: flat. The recorded
      22.2 ms itself no longer reproduces for non-PRD reasons — machine state ~2.3× plus
      game-bundle drift, both measured in the record, which also voids cross-day baselines as
      decision inputs. An earlier `:0` pass of this same pair was voided by the night lead —
      user-visible windows — and redone; the record retains those rows marked void and
      confirms the verdict holds on both lanes.)
- [x] Whole-run averages are banned (see the loading-screen bug's 3× startup swing); frames
      226–899 only. (Protocol followed throughout: per-window reporting only, w1 discarded,
      w2 mapped to the 226–899 band; the mapping is written down in the record.)

### Phase 2 — Widen `GPURenderPassEncoder`

`beginRenderPass` costs 154 748 ns per call doing 15 descriptor reads — the largest remaining
single-site tax. It also needs the paired-state ruling (encoder↔pass pairing must resolve from
receiver + argument, lifetime re-derived, not assumed).

- [x] `gpubench.js` extended to price `beginRenderPass`; green means an order-of-magnitude fall
      (≥10×), pasted. ([record](../../verification/runtime-perf-state.md) —
      extended and versioned at `ed1bb226`; same-file fall measures **8.5–9.9×** at matched
      load: close to an order of magnitude, **not clearly ≥10× on the minimal-descriptor
      probe**, and the record says so rather than rounding; `97a4c808`'s mutation-OFF rerun
      reads ~9.7×, agreeing. The recorded in-game 154 748 ns red is a different meter and is
      context, not evidence.)
- [ ] Paired-state rows migrate explicitly; `state->encoderRenderPassMap` ruling written down.
- [ ] Frame pair repeated; delta reported even when small.

### Phase 3 — Widen the rest, ordered by measured tax

- [ ] Every WebGPU class still taking the legacy path gets a per-call price in the verification
      record (constructor sites counted, taxed at measured ns/call).
- [ ] Convert descending by measured tax until the remaining classes are each worth <2 ms/frame
      combined; refuse any class whose tax is <2× Chrome's rate. One commit per class.
- [ ] Cross-engine: QuickJS/JSC lanes exercised, not just compile-checked — name which lane ran
      (preset test, iOS lane, or a stated machine limit; "compiled only" is not verification).

### Phase 4 — Device arm (last, conditional on Phase 1 moving)

By the four-cell table native render.p50 is ~22 ms desktop / ~23 ms phone — the device tracks
desktop here. One capture pair confirms; it does not lead.

- [ ] Cool, discharging Pixel 8 pair (`doctor --device` first); discards startup block.

## Verification

Record `docs/verification/prd-224-binding-tables-once-per-class-<date>.md`.

1. Paste of gpubench.js red→green for every converted class, same file and warm-up protocol.
2. Frame pair table; baseline citations name their revision.
3. Contract executables green (including the shared-prototype regression guard demonstrated red
   at step 1: disabling the fast path produced `2 failure(s)`, exit 1).
4. Known unrelated red left alone and still disclosed:
   `webgpu-bindings-contract.test.mjs`'s over-broad source slice predates this work.

## Acceptance Criteria

- [ ] No WebGPU class whose measured per-call tax exceeds 2× Chrome's rate installs bindings per
      call. (Mutation: remove `ensure…ClassTable` attachment → regression executable fails.)
- [ ] Snapshot/verify/rollback guarantees still execute at install time — at class level.
- [ ] All three engines share the receiver-aware contract or have an explicitly gated fallback;
      cross-engine coverage is named, not implied.
- [ ] Each conversion is independently revertible (one commit).
