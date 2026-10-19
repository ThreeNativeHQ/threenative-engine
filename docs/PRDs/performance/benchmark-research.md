Yes. For a **reproducible ThreeNative benchmark harness**, these are the repos I’d use.

| Priority | Benchmark/source                | Exact upstream                                                                                                                  | What we copy/port                     |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 🥇       | **Bevy 0.19**                   | [Bevy v0.19.0 source](https://github.com/bevyengine/bevy/tree/v0.19.0?utm_source=chatgpt.com)                                   | Main native renderer baseline         |
| ⭐⭐⭐⭐⭐    | **1.6M cubes**                  | [many_cubes.rs](https://github.com/bevyengine/bevy/blob/v0.19.0/examples/stress_tests/many_cubes.rs?utm_source=chatgpt.com)     | Object/draw/culling/batching stress   |
| ⭐⭐⭐⭐⭐    | **Bevy City**                   | [bevy_city source](https://github.com/bevyengine/bevy/tree/v0.19.0/examples/large_scenes/bevy_city?utm_source=chatgpt.com)      | 55k-object realistic scene            |
| ⭐⭐⭐⭐⭐    | **1,000 animated foxes**        | [many_foxes.rs](https://github.com/bevyengine/bevy/blob/v0.19.0/examples/stress_tests/many_foxes.rs?utm_source=chatgpt.com)     | Skinning/animation benchmark          |
| 🥇       | **Godot benchmark suite**       | [godotengine/godot-benchmarks](https://github.com/godotengine/godot-benchmarks?utm_source=chatgpt.com)                          | Full benchmark methodology + scenes   |
| ⭐⭐⭐⭐     | **Unity DOTS**                  | [Unity EntityComponentSystemSamples](https://github.com/Unity-Technologies/EntityComponentSystemSamples?utm_source=chatgpt.com) | ECS/Burst/rendering workloads         |
| ⭐⭐⭐⭐     | **Unity large-scale streaming** | [DOTS Streaming Samples](https://github.com/Unity-Technologies/DOTS-StreamingSamples?utm_source=chatgpt.com)                    | 30k continuously streamed instances   |
| ⭐⭐⭐⭐     | **Three.js**                    | [mrdoob/three.js](https://github.com/mrdoob/three.js?utm_source=chatgpt.com)                                                    | Browser/native compatibility baseline |

### 1. Start with Bevy `many_cubes`

This is the one I would implement **first** in ThreeNative.

Bevy explicitly describes it as a benchmark for **per-entity draw overhead** and tells you to run it in release mode. It defaults to **1,600,000 cubes** and exposes controls for disabling frustum culling, automatic batching and indirect drawing. ([GitHub][1])

Published Bevy 0.19 reference on a mobile RTX 4090:

```text
1,600,000 entities
~116,000 visible
1920×1080

Bevy 0.19:
18.77 ms     culling enabled
41.20 ms     all 1.6M rendered
```

([Bevy][2])

Importantly, **pin `v0.19.0`**, rather than `main`, so our source exactly corresponds to those published Bevy 0.19 results. The tag is still available upstream. ([GitHub][3])

---

### 2. Bevy City is even better for "actual game engine" performance

[Bevy City source](https://github.com/bevyengine/bevy/tree/v0.19.0/examples/large_scenes/bevy_city?utm_source=chatgpt.com)

Published workload:

```text
~55,000 rendered entities

Bevy 0.19
static:    11.8 ms
moving:    16.2 ms
```

([Bevy][4])

It's procedural, and the source is included directly in the repo. The current version generates buildings, roads, trees, cars, fences, ground tiles, etc., making it much closer to a game workload than cubes. ([GitHub][5])

So I'd port the **generator**, not the rendered output.

That lets:

```text
same seed
same entity count
same transforms
same meshes
same camera
same resolution

      ↓

Bevy
ThreeNative
Three.js
Godot
```

produce almost identical workloads.

---

### 3. Many Foxes

[Bevy many_foxes.rs](https://github.com/bevyengine/bevy/blob/main/examples/stress_tests/many_foxes.rs?utm_source=chatgpt.com)

It defaults to:

```text
1000 animated foxes
1920×1080
VSync OFF
```

and has switches for synchronized animation, motion blur and vertex compression. ([GitHub][6])

This gives us:

**TN-MANY-FOXES**

to benchmark:

* skeleton transforms
* animation sampling
* skinning
* GPU upload
* rendering
* scene traversal

That's extremely useful because ThreeNative could potentially move a lot of this work away from JS.

---

# 4. Godot's benchmark repo is basically a gift

[Official Godot benchmark repository](https://github.com/godotengine/godot-benchmarks?utm_source=chatgpt.com)

Unlike random engine benchmarks, this is an actual maintained test harness.

It already separates:

```text
Render CPU
Render GPU
Idle CPU
Physics CPU
```

and runs rendering benchmarks for five seconds before reporting averages. ([GitHub][7])

It includes tests around things like:

```text
rendering/
 ├ culling
 ├ meshes
 ├ lights
 ├ HLOD
 └ scenes

physics/
scripting/
nodes/
...
```

This is probably the best **benchmark structure to steal** while using Bevy's workloads as our high-end performance targets.

---

# 5. Three.js has a particularly relevant pathological benchmark

There's an open Three.js WebGPU performance issue with an amazingly relevant reproduction:

```text
20,000 independent cube Meshes

WebGL:
~60 FPS

WebGPU:
~15 FPS

M1 Pro
```

[Three.js WebGPU 20k-mesh reproduction #30560](https://github.com/mrdoob/three.js/issues/30560?utm_source=chatgpt.com)

([GitHub][8])

There are newer reports using **10,000 independent Mesh objects** too. ([GitHub][9])

This should absolutely become:

### `TN-THREE-20K`

```text
20,000 THREE.Mesh
same BoxGeometry
same material

Three.js WebGL
Three.js WebGPU
ThreeNative
```

Because ThreeNative promises API compatibility, this is perhaps the **most persuasive benchmark you could publish**.

Imagine:

```text
20,000 Three.js Mesh objects

Three.js WebGPU        22 ms
ThreeNative current    14 ms
ThreeNative GPU scene   2.1 ms
```

Same Three-style source code.

That's marketing gold if the architecture delivers it.

---

# What I'd actually put into the ThreeNative repo

```text
benchmarks/
│
├── synthetic/
│   ├── empty-frame/
│   ├── independent-draws/
│   ├── transforms/
│   └── materials/
│
├── bevy/
│   ├── many-cubes/
│   │   └── upstream: bevy v0.19 many_cubes
│   │
│   ├── many-foxes/
│   │   └── upstream: bevy many_foxes
│   │
│   └── bevy-city/
│       └── upstream: bevy_city
│
├── three/
│   ├── 20k-meshes/
│   └── 10k-meshes/
│
├── scenes/
│   └── sponza/
│
└── harness/
    ├── frame-timing.ts
    ├── gpu-timing.ts
    ├── percentiles.ts
    └── results.ts
```

And every benchmark spits out:

```json
{
  "engine": "threenative",
  "benchmark": "many-cubes",
  "objects": 1600000,
  "visibleObjects": 116000,
  "resolution": "1920x1080",

  "frameMedianMs": 0,
  "frameP95Ms": 0,
  "frameP99Ms": 0,

  "jsMs": 0,
  "nativeCpuMs": 0,
  "gpuMs": 0,

  "logicalDraws": 0,
  "physicalDraws": 0,

  "uploadBytes": 0,
  "commandEncodeMs": 0,
  "submitMs": 0
}
```

## The first four I would reproduce here

```text
1. Bevy many_cubes          ← render architecture
2. Three.js 20k meshes      ← ThreeNative's raison d'être
3. Bevy City                ← realistic large scene
4. Bevy many_foxes          ← animation/skinning
```

Those four together will tell us **far more about ThreeNative than Bayview alone**.

And yes: these are public enough that we can clone the upstream sources, port the workloads into a ThreeNative benchmark package, and compare identical workloads. Bevy is particularly friendly here: its code is dual MIT/Apache-2.0, and `bevy_city` itself declares MIT OR Apache-2.0. ([GitHub][3])

One caveat: I would **not use the Khronos Sponza currently in `glTF-Sample-Assets` as our canonical Sponza**. Its own metadata identifies the model files under the CryEngine license, and there is an open licensing issue recommending replacement with Intel's CC-BY version. ([GitHub][10]) Use the original Intel Sponza instead.

[1]: https://github.com/bevyengine/bevy/blob/main/examples/stress_tests/many_cubes.rs "bevy/examples/stress_tests/many_cubes.rs at main · bevyengine/bevy · GitHub"
[2]: https://bevy.org/news/bevy-0-19/ "Bevy 0.19"
[3]: https://github.com/bevyengine/bevy/tree/v0.19.0 "GitHub - bevyengine/bevy at v0.19.0 · GitHub"
[4]: https://bevy.org/news/bevy-0-19/?utm_source=chatgpt.com "Bevy 0.19"
[5]: https://github.com/bevyengine/bevy/blob/main/examples/large_scenes/bevy_city/src/generate_city.rs?utm_source=chatgpt.com "bevy/examples/large_scenes/bevy_city/src/generate_city.rs at main · bevyengine/bevy · GitHub"
[6]: https://github.com/bevyengine/bevy/blob/main/examples/stress_tests/many_foxes.rs "bevy/examples/stress_tests/many_foxes.rs at main · bevyengine/bevy · GitHub"
[7]: https://github.com/godotengine/godot-benchmarks/blob/main/README.md?utm_source=chatgpt.com "godot-benchmarks/README.md at main · godotengine/godot-benchmarks · GitHub"
[8]: https://github.com/mrdoob/three.js/issues/30560?utm_source=chatgpt.com "WebGPURenderer: Current UBO system has severe performance issues with many render items. · Issue #30560 · mrdoob/three.js · GitHub"
[9]: https://github.com/mrdoob/three.js/issues/32940?utm_source=chatgpt.com "For the WebGPU and WebGL rendering engines, when loading 10,000 Mesh objects (with the same data and materials), WebGPU's rendering is slower than WebGL's. What is the principle behind this? · Issue #32940 · mrdoob/three.js · GitHub"
[10]: https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Sponza/LICENSE.md?utm_source=chatgpt.com "glTF-Sample-Assets/Models/Sponza/LICENSE.md at main · KhronosGroup/glTF-Sample-Assets · GitHub"
