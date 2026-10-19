---
prd_contract: v1
---

# PRD-335 — The bundle is not parsed as source twice

**Status:** PROPOSED, filed 2026-09-03 by PRD-328 Phase 3's pre-registered rule. Planning only.

**Priority:** P2 — Three open boxes: repair the Bayview build, measure the compile segment, or close it.
**Complexity:** +1 (1–5 files) + 1 (external API: V8's code-cache entry points) + 1 (device lane)
= **3 → MEDIUM mode**.

**Owner:** unassigned

**Source:** [PRD-328](../done/PRD-328-launch-is-measured-on-the-engine-that-ships.md)
Phase 3, and the measured launch table in `docs/verification/runtime-perf-state.md` §5b.

**Outcome:** a V8 code cache is written after the first compile and consumed on later launches, or
the attempt is buried with its number. Acceptance is §5b's phone table re-run with the cache warm.

---

## 1. Context

**This PRD is filed by a rule, and the rule may not be moved after the numbers arrive.** PRD-328
pre-registered it before any measurement existed:

> If `compile + execute` on the phone is **≥ 300 ms median** or **≥ 10 % of launch**, file
> `PRD-33X — the bundle is not parsed as source twice` […] Otherwise write the graveyard row.

Measured on a physical Pixel 8 on 2026-09-03, `examples/native-smoke` under V8, five process-cold
launches:

| limb | measured | trips? |
| --- | --- | --- |
| `compile + execute` ≥ 300 ms median | 54.1 + 182.9 = 237.0 ms | no |
| `compile + execute` ≥ 10 % of launch | 237.0 / 519 = 45.7 % | **yes** |

and on the genuinely cold first launch, 108.7 + 208.7 = 317.4 ms, which trips the first limb too.

**Read the ranking before starting this.** The rule adds compile and execute together, and a code
cache saves only the first of them:

| term, median process-cold launch | ms | share | does a code cache touch it? |
| --- | ---: | ---: | --- |
| runtime creation (cold launch) | 1,635 | 69.1 % | **no** |
| bundle top-level execution | 182.9 | 35.2 % | no |
| **JavaScript parse and compile** | **54.1** | **10.4 %** | **yes** |
| first rendered frame | 202 | 38.9 % | no |

So the honest ceiling on this work is roughly **54 ms of a 519 ms launch**, and there is a term an
order of magnitude larger sitting above it that nobody has opened: **runtime creation, 1,635 ms of
a 2,365 ms cold launch, 69.1 %**. That term should be attributed before this one is built. This PRD
exists because a pre-registered rule tripped, and it is filed *ranked below* that question rather
than ahead of it.

**Files analyzed:**

- `packages/runtime-native/src/js/v8_engine.cpp` — three `ScriptCompiler::CompileModule` sites and
  a `Script::Compile` site; no `ScriptCompiler::CachedData` anywhere, so the bundle is compiled
  from source on every launch on every platform.
- `packages/runtime-native/include/mystral/cold_start.h` — `ColdStartEvalScope`, which is what
  makes the before/after measurable at all.
- `packages/runtime-native/scripts/measure-cold-start.mjs` — the reader, with both lanes.

## 2. Solution

`ScriptCompiler::CreateCodeCache` after the first successful compile, written to the app's storage
root; `ScriptCompiler::kConsumeCodeCache` on later launches. The cache is rejected — and the launch
falls back to compiling from source — on any of: a V8 version mismatch, a V8 flags-hash mismatch,
or a bundle-hash mismatch. Fail closed to source, never to a stale cache.

**Key decisions (pre-registered here, before the work):**

- A rejected cache must be *observable*, not silent: one marker naming which check rejected it.
  A code cache that silently stops being consumed is a performance regression nothing can see.
- No startup snapshot. That is a separate, larger change and is not in scope.
- The cache is per-ABI and per-engine-build, because the blobs are.

## 3. Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| ---: | --- | --- | --- | --- | --- |
| 1 | code-cache write after first compile | `v8_engine.cpp` entry-module compile (TBD) | nothing | n/a | delete the write → later launches show no `compile` improvement |
| 2 | code-cache consume on later launches | same site (TBD) | source compile | kept as the fallback | corrupt the cache file → the launch still succeeds and the marker names the rejection |
| 3 | rejection marker | `v8_engine.cpp` (TBD), read by `measure-cold-start.mjs` | nothing | n/a | version-mismatch arm → marker names `version` |
| 4 | before/after table | `docs/verification/runtime-perf-state.md` §5b (TBD) | n/a | n/a | n/a — a record |

## 4. Reachability

Every native launch reaches this. Observable in `TN_COLD_START`'s "JavaScript parse and compile"
segment, which PRD-328 built and which is the only reason this can be measured rather than
asserted. **User-facing?** Only as launch time.

## 5. Execution phases

#### Phase 0: The ceiling is confirmed on a real game, not on a smoke scene

**Outcome:** the compile segment measured on a Bayview-class bundle, because `native-smoke` is not
one and parse time scales with bytes.

- [ ] Repair or rebuild a Bayview-class game (PRD-310 notes its engine symlinks broke 2026-08-31;
      it currently never reaches a first frame).
- [ ] `measure-cold-start.mjs --device <serial> --launches 5`, and record the compile segment.
- [ ] **Stop here if compile is below 10 % on that bundle too** — write the graveyard row and close.
      A 54 ms ceiling on a smoke scene is not a mandate to build a cache for a 4 MB one.

#### Phase 1: Write and consume, with the rejection observable

**Files (max 5):** `v8_engine.cpp`, `cold_start.h` (marker only if a new segment is needed),
`measure-cold-start.mjs`, `docs/verification/runtime-perf-state.md`, and the engine contract test.

**Tests required:** a contract case per rejection reason (version, flags hash, bundle hash), each
asserting the launch still succeeds and the marker names the cause.

#### Phase 2: The number, or the graveyard row

Re-run §5b's phone table with the cache warm. If the compile segment does not drop by at least
half, bury it with the measurement.

## 6. Acceptance criteria

1. **The cache is consumed**, proven by the compile segment dropping on the second launch of the
   same bundle, on the phone, five launches each side.
2. **Every rejection path is observable and safe** — the launch succeeds from source and the marker
   names which check rejected the cache.
3. **The record carries the before and after**, and the ranking note above survives into it: this
   is the 10 % term, not the 69 % one.

## 7. Out of scope

- A V8 startup snapshot.
- Runtime creation — the 1,635 ms term. It is larger and it is not this.
- Top-level execution, which no code cache touches.
