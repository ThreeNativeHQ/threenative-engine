# Engine KPIs that pay in every game

These KPIs are the scoreboard of every campaign, whatever its workload. Each one measures an
engine cost that every game pays when it draws. A lever that moves one of them helps all
templates. A lever that moves only one game's frame time is suspect.

Record each KPI for both arms (the engine under test and its control, such as stock three on the
web or the incumbent build) at the frozen pose or route. Where a meter is
missing, add the smallest meter with a check as a separate harness change, then re-baseline. Do
not estimate a value.

## GPU (rank first when the game is GPU-bound)

| KPI | Definition | Target | Meter |
| --- | --- | --- | --- |
| G1 GPU cost ratio | Engine GPU ms ÷ control GPU ms (stock three on the web), same pose, size and tier | ≤ 1.0, then lower | playtest `assert.performance` window `gpuMs`, both arms |
| G2 Shader cost per material | Instructions, texture samples and loop trip counts in the emitted WGSL, against three's WGSL for the same node graph | ≤ three on every program | WGSL dump from both engines; diff per program |
| G3 Full-screen passes per frame | Passes that touch every pixel, plus MSAA resolves and target-to-target copies | ≤ three; 0 redundant copies | pass list from the render graph; Dawn capture if needed |
| G4 Render-target bytes | Sum of live color, depth and MSAA target memory | ≤ three | renderer target census |
| G5 Load/store waste | Clears and stores of targets that the next pass overwrites or never reads | 0 | pass descriptors (loadOp/storeOp) |

## CPU and the JS/Wasm boundary

| KPI | Definition | Target | Meter |
| --- | --- | --- | --- |
| C1 Render CPU ms | CPU time from `render()` entry to submit | ≤ three | window `cpuMs` |
| C2 Boundary calls per frame | JS→Wasm and Wasm→JS calls in one steady frame | falls as levers land | call counter in `packages/three-native` glue |
| C3 Steady GPU object churn | Bind groups, buffers, textures and pipelines created per steady frame | 0 | create counters in the renderer |
| C4 Upload bytes per frame | `writeBuffer`/`writeTexture` bytes in a steady frame | only data that changed | upload counter |

## Startup and hitches

| KPI | Definition | Target | Meter |
| --- | --- | --- | --- |
| S1 Pipeline count and compile time | Distinct render pipelines at the pose, and `compileMs` / `compileSettledMs` | ≤ three | `pipelineCensus`, compile fields |
| S2 First-use hitch | Worst frame in the first 5 s after the pose is ready | ≤ 2x budget | presented intervals after the ready mark |
| S3 Time to first frame | Navigation start to the first presented world frame | ≤ three | loading scenario marks |

## Pacing and memory

| KPI | Definition | Target | Meter |
| --- | --- | --- | --- |
| P1 Presented interval | p50, p95 and p99 of the real presented interval (not rAF and not fps) | p95 ≤ budget | presentation samples |
| P2 Frames in flight | Frames submitted and not yet complete | ≤ 2 (backpressure) | `framesOnGpu` in `web_host.cpp` |
| M1 Steady memory growth | JS heap and Wasm memory growth per minute at the pose | 0 after warmup | `performance.memory`, `WebAssembly.Memory` byte length |

## Guard KPIs (must not move)

| KPI | Definition | Limit |
| --- | --- | --- |
| V1 Visual parity | Mean absolute diff against the control at the pose, 0–255 | ≤ 0.01 and judge NEUTRAL or IMPROVEMENT |
| V2 Behavior | The workload's playtest set and the sentinel game's set | No new red |
| V3 Workload identity | Draw calls, triangles and active stages | Same as the baseline, unless the lever deletes provably redundant work and the judge passes |

## Reading the scoreboard

- Report each KPI as baseline, incumbent and absolute delta, with a percent only for a positive
  baseline. Do not blend KPIs into one score.
- Show a KPI that is not yet metered as `unavailable: <reason>`.
- A drop in G3, G5, C3 or C4 with no GPU or CPU ms change is still a kept maintenance win only if
  it is proven on the sentinel. Label it as such. Do not label it a speedup.
