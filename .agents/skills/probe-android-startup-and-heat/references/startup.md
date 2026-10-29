# Startup measurement

Use repository-owned doctor/playtest tooling before writing a harness. For ThreeNative, read the
current playtest and runtime-native AGENTS instructions; runner flags and event contracts may evolve.
Keep raw samples and a compact parsed table. Capture first frame, readiness and input separately.

For each launch record: APK hash, device model/adapter, battery/charging and thermal status, app
process state, retained or reset cache, recording/profiler state and scene identity. Force-stop is a
new process, not a fresh installation or cleared driver cache. Do not call an already warm run a
qualified cold benchmark. Do not erase data to create one without authorization.

ThreeNative markers such as TN_FIRST_FRAME, TN_STARTUP_WARMUP, TN_WARMUP and TN_PUMP_SILENCE
are useful when present; discover the current schema in source. The maximum gap between two pumps
can be zero with one pump and a long blocked first draw. Calculate initial/trailing silence through
the endpoint as well. Keep asynchronous waits out of “unattributed CPU” subtraction. Compiler
instrumentation nested inside another phase can overlap; do not sum nested clocks twice.

For debuggable Android apps, shell simpleperf's supported app mode can work even when a run-as
recording fails trying to set debug.perf_event_max_sample_rate. Example, using an authorized device:

```sh
adb -s "$serial" shell simpleperf record --app "$package" -f 99 -g \
  --duration 12 -o /data/local/tmp/startup-probe.data
```

Start recording before launching the app from a separate invocation. Use a unique output path per
run, pull the data, and run the device's simpleperf report against that data by DSO and by symbol.
Check `simpleperf report --help` for supported sorting options. Preserve sample/lost counts,
duration, event type, command and symbols. If denied, retain the denial and use supported tooling;
do not change protected kernel properties. Sampling may perturb startup and may miss its end.
A 44% driver CPU-cycle share is not 44% of elapsed startup. Obtain a separate steady-state profile
before attributing ongoing heat to the compiler.

Inspect actual native compile_commands.json for optimization and host-loop defines. An assembleDebug
APK can contain optimized C++; build variant names are insufficient. Similarly, source-present
third-party libraries can be ignored by default search tools: inspect a named path before declaring
them absent.

For browser verification use the repository's GPU recipe and headed display if required. Inspect
capture adapter info, screenshot and diagnostics. Doctor observations on SwiftShader can diagnose a
bridge but cannot verify hardware performance. Do not allow software rendering just to make a gate
pass when the claim requires a GPU.
