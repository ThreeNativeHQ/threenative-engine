<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — @threenative/three-native

Read `/AGENTS.md` first. This package owns the Three.js-compatible bridge, browser renderer and
machine-readable native API registry. Core owns the common frame-budget reporting window;
runtime-native owns the C++ producers.

## Debug telemetry

- Set `TN_DEBUG=1`, `?tnDebug=1` or `globalThis.__THREENATIVE_DEBUG__ = true` before boot.
  Debug adds bridge crossing/name/caller, typed-array encoding/overflow, hierarchy/lifetime and
  renderer/query observations to the existing engine counters. Keep the debug-off crossing and
  allocation census unchanged; diagnostic instrumentation must not add bridge traffic.
- `TN_FRAME_BUDGET.counters.engine` is the numeric consumer surface; core emits one
  `TN_DEBUG_REPORT` per window. Keep counts and byte totals in their own units. A calibrated
  crossing estimate is getter-equivalent time, not a measured duration for each invoke or write.
  `TN_BRIDGE_WARNING` prices all crossings against the observed interval, not only repeated reads.
- GPU resolves arrive asynchronously. Preserve requested, resolved and delivered sample identity;
  a callback delivery delay is not GPU execution time. Missing timing stays absent.
- Register public C++ counter names and ABI members in `api/native-registry.json` alongside their
  producers. Shared counter snapshots prove serialization, not desktop or Android execution;
  report each executed target separately.
