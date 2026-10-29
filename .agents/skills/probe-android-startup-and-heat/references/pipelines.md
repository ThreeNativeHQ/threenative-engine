# Native Three/WebGPU pipeline coverage

Inspect the actual game's renderer settings before choosing a probe. ACES/exposure alone does not
imply a custom RenderPipeline or setOutputNode chain. Keep lights, environment, shadows, sample
count and output conversion in the miniature scene; omission can erase the real first-use work.
Import the actual engine warm-up implementation, not a reimplementation.

Compare fresh renderer processes: no warm-up, scene warm-up, object warm-up. Tag warm-up and first,
second and third render phases. Hook both Three backend createRenderPipeline and device
createRenderPipeline/createRenderPipelineAsync; trace shader modules and beginRender contexts.
Record shader hashes, complete descriptor identities, cache keys, material/pass labels, target
formats/sizes/sample counts, invocation duration and async settlement. A Three promises-array seam
is useful but device calls expose synchronous nested renders during compileAsync.

A small desktop probe found two asynchronous main pipelines plus synchronous PMREM during warm-up,
then synchronous shadow and output-conversion pipelines on first render. This is an example to test,
not a permanent Three guarantee. A warm-up success report may count renderables instead of pipelines
and may omit passes. Read the installed implementation before trusting field names.

Distinguish undercoverage from duplication. Equal shader text alone does not prove a duplicate
pipeline: target/depth formats, sample counts and other descriptor fields matter. Count repeated
full identities within a process. Three compilation can await each queued object's promises serially;
confirm the installed version before proposing more native compiler workers. Bounded concurrency
must preserve object lifetime, determinism, error propagation and memory limits.

Capture all arms and compare pixels using an existing repository metric. A smaller first render
following a longer warm-up is not lower total startup. Present total and phase timings. Desktop
Vulkan findings establish mechanism only; repeat relevant descriptor tracing on Android before
assigning milliseconds to the phone. Avoid a wholesale render rewrite based on a tiny probe.
