# Trace a slow frame — finding the function, not the percentile

`TN_FRAME_BUDGET` and `npx @threenative/playtest perf` tell you a frame was slow. They cannot tell
you what ran inside it. **A percentile says a frame was slow; a trace says which function.** This
page is the second half.

## The rule

**Before you attribute a frame-rate or stutter complaint to any cause — and before you change one
line to fix one — run `npx @threenative/playtest trace --url <url> --text` and name the function
the trace blames.** Not "when performance looks bad": every time, before the first fix. If you
skipped it, you are guessing, and the report below is what guessing costs.

## Why the rule exists

A game came in as "performance is not good, and after a while everything becomes blurry". Two
hypotheses were formed from the frame meters and both were wrong. One trace overturned them:

- **96 frames per second on average, frame-interval p50 8.2 ms.** The game was never slow on
  average. Every statistic that reports a mean was hiding the complaint.
- **p99 50.3 ms, worst frame 267.9 ms, 28 main-thread tasks over 40 ms.** The pain was entirely in
  the tail. Optimising the median would have moved nothing a player could feel.
- **GPU 31.5% busy, main thread 46.9% idle.** Neither triangle-bound nor CPU-saturated. An hour of
  draw-call and triangle reduction was already underway and would have changed nothing.
- **Sampling inside the worst tasks named them**: TSL graph `build`, `analyze`, `_getChildren`,
  plus two stalls at 86% and 97% *idle* where the main thread sat waiting on GPU pipeline
  creation. That is shader compilation arriving during play — a completely different bug from any
  of the three the numbers above had been read as.

## Running it

```sh
npx @threenative/playtest trace --url http://127.0.0.1:5173 --text
npx @threenative/playtest trace --url http://127.0.0.1:5173 --seconds 45 --key KeyW --key KeyD
```

It launches the game headed with the WebGPU recipe, waits for the engine's startup-ready signal,
records for `--seconds` while holding the movement keys, writes the raw trace to disk, and prints
the summary. Defaults worth knowing:

| Flag | Default | Why it is there |
| --- | --- | --- |
| `--seconds <n>` | 20 | The traced window. Tail statistics need frames; under about 10 s a p99 is one sample. |
| `--key <KeyName>` | `KeyW` | Held for the whole window. Repeat for more keys. |
| `--no-input` | off | Traces a standing camera and warns. A parked viewpoint re-uses everything it drew last frame, which is how the first frame-rate number in this project came back nearly twice the truth. |
| `--wait-for <js>` | `globalThis.__TN_STARTUP_READY__ === true` | Trace the game, not the load. Point it at your own global if your game reveals its world later; `--no-wait` traces the load too and says so. |
| `--stall-ms <n>` | 40 | What counts as a blown frame in the task count. |
| `--out <path>` | `artifacts/traces/trace-<timestamp>.json` | Open this in Chrome DevTools' Performance panel when the summary points somewhere specific. |

Exit codes: **0** traced and quotable, **1** traced but part of the answer is missing or
untrustworthy (the reason is printed with a `TN_TRACE_` code), **2** no trace was recorded at all.

## Reading the summary

Read it in this order, because each line rules out a whole class of fix:

1. **Frame interval p50 / p90 / p99 / max.** If p50 is fine and p99 is not, the problem is hitches,
   not throughput — and nothing that lowers average cost will fix it.
2. **GPU busy %.** Low means the GPU is not the wall, so fewer triangles, fewer draws and cheaper
   materials are all the wrong lane.
3. **Main thread idle %.** High *and* a low GPU busy means the frame is waiting on something —
   pipeline creation, a texture upload, a network read — not computing.
4. **Tasks over the threshold.** The count and the worst few. This is the complaint, quantified.
5. **Top self time.** The functions. This is the answer; everything above it narrows which answer
   is plausible.

Only then open the raw trace file, and only if the summary points somewhere specific.

## Go deeper with the `threenative-devtools` MCP server

Every project wires Chrome DevTools as the `threenative-devtools` MCP server. Use it after
`playtest trace`, when the summary points at one place and you need to look inside it. It launches
Chrome with the same WebGPU recipe as a playtest, in a temporary profile. Chrome starts only on the
first tool call.

1. `navigate_page` to `http://127.0.0.1:<port>/?tnFrameSpans=1`, then hold the movement keys with
   `press_key`, because a parked camera hides the cost of a moving one.
2. `performance_start_trace`, play for at least 10 s, then `performance_stop_trace`.
3. `performance_analyze_insight` on the insight the trace names.
4. `list_console_messages` for `TN_FRAME_BUDGET`, `TN_FRAME_SPANS` and `TN_SCENE_WARNING`.

Use it for GPU timing, A/B deltas inside one page, the network and asset waterfall, heap snapshots
(`take_heapsnapshot`) and console output. **Do not quote its CPU times as absolute numbers.** Its
browser keeps async call stacks on, and the engine wraps every GPU callback in a promise. On one
game that read main render as 8.3 ms per frame against 1.3 ms in a clean browser, and a trace added
3.9 ms per frame. An absolute CPU number comes from `playtest trace`. A ratio between two arms in
the same DevTools page is fine. The server sees only the browser: a native or Android frame goes
through `npx @threenative/playtest perf --target <platform>`.

## The trap that produces a confident wrong number

**A frame rate measured on a virtual display is wrong, not missing.** Under a private Xvfb there
is no vsync and no compositor, so the present wait lands inside the engine's `update` phase.
Measured on one build, same 12 s window, only `DISPLAY` differing:

| | Xvfb | real display |
| --- | ---: | ---: |
| fps | 13.3 | 57.7 |
| frame p50 | 68.5 ms | 8.5 ms |
| `update` p50 | **66.1 ms** | 1.0 ms |
| `render` p50 | 2.0 ms | 7.3 ms |

Read as a report, that is 66 ms of game CPU per frame, and it sends you looking for an expensive
loop in a frame callback. There is not one: a CPU profile over the same window came back **84%
idle**.

So `trace` refuses to print a frame rate when it detects a virtual display, and exits 1 saying so.
Set `TN_PLAYTEST_HOST_DISPLAY=1` to run on the real display and get a quotable one; pass
`--allow-virtual-display` to accept the function attribution alone and exit 0. The frame rate stays
suppressed either way — acknowledging the trap does not give the display a vsync.

The same command also refuses when WebGPU came from SwiftShader, Chromium's CPU rasteriser
(`TN_TRACE_SOFTWARE_ADAPTER`): a trace of software rendering names software rendering's functions.
`node_modules/create-threenative/agent-docs/references/capture-the-frame.md` covers that adapter trap in full.

## After the trace

Say what the trace blamed, in the report, with the number beside it. "Tail, not throughput: p50
8.2 ms, p99 50.3 ms, 28 tasks over 40 ms; top self time is pipeline creation inside `build`" is a
finding. "Performance is better now" is not, and neither is a fix whose evidence is a mean.
