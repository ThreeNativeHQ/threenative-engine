// PRD-645: a GI probe trace in hardware must return what the GPUSceneBVH compute trace returns.
//
// One static room, a grid of probes, 64 rays per probe. The same rays go through the upstream TSL
// `bvhIntersectFirstHit` (software) and through `mystralRT.traceRayBatch` (Vulkan ray query). Hit
// distances must agree within 1 mm. Where the two paths name different triangles, a double
// precision trace over every triangle decides who is right. The row then times both paths on this
// adapter and prints the numbers the PRD gate reads. A host without hardware ray tracing skips with
// its reason, and the web never claims the trace.
import * as THREE from "three/webgpu";
import { Fn, instanceIndex, instancedArray, wgslFn } from "three/tsl";
import { GPUSceneBVH, bvhIntersectFirstHit, rayStruct } from "../../../../core/src/gpu-scene-bvh.ts";
import { assertCondition, startVisualScene } from "./scene-support.js";

const RAYS_PER_PROBE = 64;
const TOLERANCE_METRES = 0.001;
const FAR = 1e6;
// The referee runs only for rays the two paths disagree on. More than this many means a real fault.
const MAX_REFEREED = 64;
const WARMUP = 5;
const REPEATS = 50;
const BATCHES = 5;
const WARM_MS = 250;
const VENDOR_IDS = { amd: 0x1002, intel: 0x8086, nvidia: 0x10de };

// The small room is the shape of the shipped GI scenes. The dense and heavy rooms show how the
// ratio moves with triangle count. Each probe grid is one refresh batch.
const TRACE_SCENES = [
  { name: "room", props: 12, icosahedronDetail: 2, knot: [32, 6], grids: [[4, 1, 4], [10, 1, 10], [16, 4, 16], [32, 8, 32]] },
  { name: "dense", props: 48, icosahedronDetail: 6, knot: [96, 10], grids: [[16, 4, 16]] },
  { name: "heavy", props: 150, icosahedronDetail: 8, knot: [128, 14], grids: [[16, 4, 16]] },
];

const sceneHit = wgslFn(
  `
    fn tnProbeTrace(
      bvh_index: ptr<storage, array<vec3u>, read>,
      bvh_position: ptr<storage, array<vec3f>, read>,
      bvh: ptr<storage, array<BVHNode>, read>,
      ray: Ray,
    ) -> vec4f {
      let hit = bvhIntersectFirstHit(bvh_index, bvh_position, bvh, ray);
      if (!hit.didHit) {
        return vec4f(-1.0, -1.0, 0.0, 0.0);
      }
      return vec4f(hit.dist, f32(hit.indices.w), hit.barycoord.y, hit.barycoord.z);
    }
  `,
  [bvhIntersectFirstHit],
);

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTraceRoot({ props, icosahedronDetail, knot }) {
  const random = mulberry32(645);
  const root = new THREE.Group();
  const room = new THREE.Mesh(new THREE.BoxGeometry(12, 4, 12, 6, 2, 6));
  room.position.y = 2;
  root.add(room);
  for (let index = 0; index < props; index += 1) {
    const size = 0.4 + random() * 0.8;
    const kind = index % 3;
    const geometry =
      kind === 0
        ? new THREE.BoxGeometry(size, size * 2, size)
        : kind === 1
          ? new THREE.IcosahedronGeometry(size, icosahedronDetail)
          : new THREE.TorusKnotGeometry(size, size * 0.3, knot[0], knot[1]);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set((random() - 0.5) * 10, 0.6 + random() * 2.4, (random() - 0.5) * 10);
    mesh.rotation.set(random() * 6.28, random() * 6.28, random() * 6.28);
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  return root;
}

/** One ray is 8 floats: origin.xyz, tMin, direction.xyz, tMax. A probe is 64 of them. */
function buildProbeRays([nx, ny, nz]) {
  const rays = new Float32Array(nx * ny * nz * RAYS_PER_PROBE * 8);
  const random = mulberry32(2080);
  let cursor = 0;
  for (let ix = 0; ix < nx; ix += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        const spin = random() * Math.PI * 2;
        for (let k = 0; k < RAYS_PER_PROBE; k += 1) {
          const y = 1 - (2 * (k + 0.5)) / RAYS_PER_PROBE;
          const radius = Math.sqrt(1 - y * y);
          const phi = k * 2.399963229728653 + spin;
          rays.set(
            [
              -5.5 + (11 * (ix + 0.5)) / nx, 0.4 + (3.2 * (iy + 0.5)) / ny, -5.5 + (11 * (iz + 0.5)) / nz, 0,
              radius * Math.cos(phi), y, radius * Math.sin(phi), FAR,
            ],
            cursor,
          );
          cursor += 8;
        }
      }
    }
  }
  return rays;
}

/** Double precision closest hit of one ray over every triangle: the referee for a disagreement. */
function referenceHit(positions, indices, rays, ray) {
  const [ox, oy, oz, , dx, dy, dz] = rays.subarray(ray * 8, ray * 8 + 8);
  let best = { t: -1, primitive: -1 };
  for (let tri = 0; tri < indices.length / 3; tri += 1) {
    const [a, b, c] = [indices[tri * 3], indices[tri * 3 + 1], indices[tri * 3 + 2]].map((v) => v * 4);
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const p = [dy * e2[2] - dz * e2[1], dz * e2[0] - dx * e2[2], dx * e2[1] - dy * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-18) continue;
    const t0 = [ox - positions[a], oy - positions[a + 1], oz - positions[a + 2]];
    const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) / det;
    const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]];
    const v = (dx * q[0] + dy * q[1] + dz * q[2]) / det;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (Math.min(u, v, 1 - u - v) >= -1e-9 && t > 0 && (best.t < 0 || t < best.t)) best = { t, primitive: tri };
  }
  return best;
}

const sameHit = (software, hardware, primitives, at) => {
  const softwareHit = software[at] >= 0;
  const hardwareHit = hardware[at] >= 0;
  return softwareHit === hardwareHit && (!softwareHit || software[at + 1] === primitives[at + 1]);
};

const hardwareMatches = (exact, hardware, at) =>
  exact !== null &&
  (exact.t < 0 ? hardware[at] < 0 : hardware[at] >= 0 && Math.abs(hardware[at] - exact.t) <= TOLERANCE_METRES);

/**
 * Hit records are [t, primitive, b1, b2] per ray, t < 0 on a miss. A ray the paths disagree on is a
 * shared-edge tie, or a hit that the software test accepts just outside a triangle edge (its
 * epsilon). The referee decides: the hardware answer must match the exact one within the tolerance.
 */
function compareHits(software, hardware, referee) {
  const primitives = new Uint32Array(hardware.buffer, hardware.byteOffset, hardware.length);
  const result = { rayCount: software.length / 4, hits: 0, maxDistanceError: 0, disagreements: 0, mismatchCount: 0, mismatches: [] };
  for (let ray = 0; ray < result.rayCount; ray += 1) {
    const at = ray * 4;
    if (software[at] >= 0) result.hits += 1;
    if (sameHit(software, hardware, primitives, at)) {
      if (software[at] >= 0) result.maxDistanceError = Math.max(result.maxDistanceError, Math.abs(software[at] - hardware[at]));
      continue;
    }
    result.disagreements += 1;
    const exact = result.disagreements <= MAX_REFEREED ? referee(ray) : null;
    if (hardwareMatches(exact, hardware, at)) continue;
    result.mismatchCount += 1;
    if (result.mismatches.length < 4) {
      result.mismatches.push({ ray, software: [...software.slice(at, at + 4)], hardware: [...hardware.slice(at, at + 4)], exact });
    }
  }
  return result;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const spread = (values) => ({ min: Math.min(...values), median: median(values), max: Math.max(...values) });

async function repeat(work) {
  for (let index = 0; index < WARMUP; index += 1) await work();
  const samples = [];
  for (let index = 0; index < REPEATS; index += 1) {
    const start = performance.now();
    await work();
    samples.push(performance.now() - start);
  }
  return samples;
}

// Runs the arms one after another in every round, so clock and load drift reach each arm alike.
async function pair(arms) {
  const names = Object.keys(arms);
  for (let index = 0; index < WARMUP; index += 1) for (const name of names) await arms[name]();
  const samples = Object.fromEntries(names.map((name) => [name, []]));
  for (let index = 0; index < REPEATS; index += 1) {
    for (const name of names) {
      const start = performance.now();
      await arms[name]();
      samples[name].push(performance.now() - start);
    }
  }
  return samples;
}

// Mean GPU time of one software dispatch from the adapter's timestamp queries. A queue.onSubmittedWorkDone
// wait is no barrier here: the host replays recorded passes on its own schedule, so the queries are
// resolved instead, and every batch of dispatches ends in that resolve.
async function softwareKernelMs(renderer, node) {
  const backend = renderer.backend;
  if (!backend.hasFeature("timestamp-query")) return null;
  backend.trackTimestamp = true;
  for (let index = 0; index < WARMUP * 4; index += 1) renderer.compute(node);
  await renderer.resolveTimestampsAsync("compute");
  const batches = [];
  for (let batch = 0; batch < BATCHES; batch += 1) {
    for (let index = 0; index < REPEATS; index += 1) renderer.compute(node);
    batches.push((await renderer.resolveTimestampsAsync("compute")) / REPEATS);
  }
  backend.trackTimestamp = false;
  return spread(batches);
}

// The GPU idles at a low clock between jobs. Spin the software kernel until the clock is up, so the
// first rows are not timed at the idle clock.
async function warmGpu(renderer, node, barrier) {
  for (const end = performance.now() + WARM_MS; performance.now() < end; ) {
    for (let index = 0; index < 20; index += 1) renderer.compute(node);
    await barrier();
  }
}

async function describeAdapter(renderer) {
  const adapter = renderer.backend.adapter;
  const info = adapter?.info ?? (await adapter?.requestAdapterInfo?.()) ?? {};
  return {
    architecture: info.architecture ?? "",
    description: info.description ?? "",
    device: info.device ?? "",
    vendor: info.vendor ?? "",
  };
}

const gpuBufferOf = (renderer, node) => renderer.backend.get(node.value).buffer;

// One GPU transport call on zeroed hits, so a record the transport never wrote stays zero. The hits are
// read back and compared with the exact trace.
async function gpuTransportParity(renderer, rt, c) {
  c.hardwareNode.value.array.fill(0);
  c.hardwareNode.value.needsUpdate = true;
  renderer.compute(c.consumeNode);
  await c.barrier();
  rt.traceRayBatchGpu({
    tlas: c.tlas,
    rays: gpuBufferOf(renderer, c.raysNode),
    hits: gpuBufferOf(renderer, c.hardwareNode),
    rayCount: c.rayCount,
  });
  const hits = new Float32Array(await renderer.getArrayBufferAsync(c.hardwareNode.value));
  return compareHits(c.softwareHits, hits, (ray) => referenceHit(c.positions, c.indices, c.rays, ray));
}

// The other arms still run when the transport fails, so a failing transport leaves the rest of the numbers.
async function checkGpuTransport(renderer, rt, context) {
  try {
    return { parity: await gpuTransportParity(renderer, rt, context) };
  } catch (error) {
    const message = String(error?.message ?? error);
    console.log(`TN_RT_GPU_TRANSPORT_ERROR ${JSON.stringify({ message })}`);
    return { error: message };
  }
}

async function runBatch(renderer, rt, tlas, bvh, { positions, indices }, grid, capabilities, adapter) {
  const rays = buildProbeRays(grid);
  const rayCount = rays.length / 8;
  const probes = rayCount / RAYS_PER_PROBE;

  const raysNode = instancedArray(rays, "vec4");
  const softwareNode = instancedArray(rayCount, "vec4");
  const hardwareNode = instancedArray(rayCount, "vec4");
  const sinkNode = instancedArray(1, "vec4");
  const traceNode = Fn(() => {
    const origin = raysNode.element(instanceIndex.mul(2));
    const direction = raysNode.element(instanceIndex.mul(2).add(1));
    const ray = new THREE.StructNode(rayStruct, { origin: origin.xyz, direction: direction.xyz });
    softwareNode.element(instanceIndex).assign(sceneHit(bvh.indices, bvh.positions, bvh.nodes, ray));
  })().compute(rayCount);
  // Reads the uploaded hit records, so the host-to-device copy is inside the timed work.
  const consumeNode = Fn(() => {
    sinkNode.element(0).assign(hardwareNode.element(0).add(hardwareNode.element(rayCount - 1)));
  })().compute(1);
  const consumeSoftwareNode = Fn(() => {
    sinkNode.element(0).assign(softwareNode.element(0).add(softwareNode.element(rayCount - 1)));
  })().compute(1);
  // Reading 16 bytes back is the only barrier that covers both paths: it drains the host's
  // recorded passes and waits for the queue. Both loops pay it once per iteration.
  const barrier = () => renderer.getArrayBufferAsync(sinkNode.value);

  const hardwareHits = hardwareNode.value.array;
  renderer.compute(traceNode);
  const softwareHits = new Float32Array(await renderer.getArrayBufferAsync(softwareNode.value));
  rt.traceRayBatch({ tlas, rays, hits: hardwareHits });
  const parity = compareHits(softwareHits, hardwareHits, (ray) => referenceHit(positions, indices, rays, ray));
  renderer.compute(consumeNode); // creates the sink buffer the barrier reads
  renderer.compute(consumeSoftwareNode);
  await warmGpu(renderer, traceNode, barrier);

  // The GPU transport: the rays stay in the WebGPU buffer, the hits land in another one, and no
  // step reads CPU memory.
  const gpuContext = {
    tlas, rayCount, rays, raysNode, hardwareNode, consumeNode, barrier, softwareHits, positions, indices,
  };
  const gpuAvailable = capabilities.sharedTransport === true && typeof rt.traceRayBatchGpu === "function";
  const gpuFirst = gpuAvailable ? await checkGpuTransport(renderer, rt, gpuContext) : null;
  const gpuTransport = gpuFirst !== null && gpuFirst.error === undefined;

  const barrierSamples = await repeat(barrier);
  const hardwareKernel = [];
  const hardwareBatch = [];
  const gpuCall = [];
  const gpuCallCpu = [];
  const arms = {
    // The rays are uploaded from the CPU before the software trace, and the hits cross the CPU.
    softwareUpload: async () => {
      raysNode.value.needsUpdate = true; // the attribute wraps `rays`, so this is the host-to-device copy
      renderer.compute(traceNode);
      await barrier();
    },
    hardwareCpu: async () => {
      const traced = rt.traceRayBatch({ tlas, rays, hits: hardwareHits });
      hardwareKernel.push(traced.gpuMs);
      hardwareBatch.push(traced.totalMs);
      hardwareNode.value.needsUpdate = true;
      renderer.compute(consumeNode);
      await barrier();
    },
    // The rays are already on the GPU, as they are when a compute pass wrote them.
    softwareResident: async () => {
      renderer.compute(traceNode);
      renderer.compute(consumeSoftwareNode);
      await barrier();
    },
  };
  if (gpuTransport) {
    const raysBuffer = gpuBufferOf(renderer, raysNode);
    const hitsBuffer = gpuBufferOf(renderer, hardwareNode);
    arms.hardwareGpu = async () => {
      const traced = rt.traceRayBatchGpu({ tlas, rays: raysBuffer, hits: hitsBuffer, rayCount });
      gpuCall.push(traced.totalMs);
      gpuCallCpu.push(traced.cpuMs);
      renderer.compute(consumeNode);
      await barrier();
    };
  }
  const samples = await pair(arms);
  const softwareSamples = samples.softwareUpload;
  const hardwareSamples = samples.hardwareCpu;
  const gpuKernelMs = gpuTransport ? rt.sharedBatchGpuMs() : null;
  // The timed calls reused the same fences hundreds of times, so the last answer is checked again.
  const gpuLate = gpuTransport ? await checkGpuTransport(renderer, rt, gpuContext) : null;
  const gpuError = gpuFirst?.error ?? gpuLate?.error;
  const softwareKernel = await softwareKernelMs(renderer, traceNode);

  const barrierMs = median(barrierSamples);
  const perMs = (ms) => (ms > 0 ? probes / ms : null);
  const softwareEndToEnd = median(softwareSamples) - barrierMs;
  const hardwareEndToEnd = median(hardwareSamples) - barrierMs;
  const hardwareKernelMs = median(hardwareKernel.slice(-REPEATS));
  const report = {
    probes,
    raysPerProbe: RAYS_PER_PROBE,
    rays: rayCount,
    sameGpu: (VENDOR_IDS[adapter.vendor] ?? -1) === capabilities.vendorId,
    parity: { ...parity, toleranceMetres: TOLERANCE_METRES },
    barrierMs,
    kernel: {
      softwareMs: softwareKernel,
      hardwareMs: hardwareKernelMs,
      softwareProbesPerMs: softwareKernel === null ? null : perMs(softwareKernel.median),
      hardwareProbesPerMs: perMs(hardwareKernelMs),
    },
    endToEnd: {
      softwareMs: softwareEndToEnd,
      hardwareMs: hardwareEndToEnd,
      hardwareBatchCallMs: median(hardwareBatch.slice(-REPEATS)),
      softwareProbesPerMs: perMs(softwareEndToEnd),
      hardwareProbesPerMs: perMs(hardwareEndToEnd),
    },
  };
  if (gpuError !== undefined) {
    report.gpuTransport = { error: gpuError };
  } else if (gpuFirst !== null) {
    const residentMs = median(samples.softwareResident) - barrierMs;
    const gpuMs = median(samples.hardwareGpu) - barrierMs;
    report.gpuTransport = {
      parity: { ...gpuFirst.parity, toleranceMetres: TOLERANCE_METRES },
      parityAfterTimedCalls: gpuLate.parity,
      kernelMs: gpuKernelMs,
      callMs: median(gpuCall),
      callCpuMs: median(gpuCallCpu),
      softwareResidentMs: residentMs,
      hardwareGpuMs: gpuMs,
      softwareProbesPerMs: perMs(residentMs),
      hardwareProbesPerMs: perMs(gpuMs),
      speedup: residentMs / gpuMs,
      samples: { softwareResident: spread(samples.softwareResident), hardwareGpu: spread(samples.hardwareGpu) },
    };
  }
  report.kernel.speedup =
    softwareKernel === null ? null : report.kernel.hardwareProbesPerMs / report.kernel.softwareProbesPerMs;
  report.endToEnd.speedup = report.endToEnd.hardwareProbesPerMs / report.endToEnd.softwareProbesPerMs;
  return report;
}

async function runScene(renderer, rt, spec, capabilities, adapter) {
  const bvh = new GPUSceneBVH(buildTraceRoot(spec));
  const positions = bvh.positions.value.array;
  const indices = bvh.indices.value.array;
  assertCondition(positions instanceof Float32Array && indices instanceof Uint32Array, "GPUSceneBVH arrays moved.");
  // Three swaps a uvec3 storage array for a four word padded copy on first GPU use. The hardware
  // geometry and the referee need the flat triples, so both arrays are read before any dispatch.
  assertCondition(indices.length === bvh.triangleCount * 3, "GPUSceneBVH indices are not flat triples.");
  const buildStart = performance.now();
  const geometry = rt.createGeometry({ vertices: positions, indices, vertexStride: 16 });
  const blas = geometry && rt.createBLAS([geometry]);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const tlas = blas && rt.createTLAS([{ blas, transform: identity, instanceId: 0 }]);
  assertCondition(tlas, `hardware acceleration structure build failed for the ${spec.name} scene.`);
  const hardwareBuildMs = performance.now() - buildStart;
  try {
    const batches = [];
    for (const grid of spec.grids) {
      const batch = await runBatch(renderer, rt, tlas, bvh, { positions, indices }, grid, capabilities, adapter);
      const report = { scene: spec.name, triangles: bvh.triangleCount, bvhBuildMs: bvh.buildMs, hardwareBuildMs, ...batch };
      console.log(`TN_RT_PROBE_TRACE ${JSON.stringify(report)}`);
      batches.push(report);
    }
    return batches;
  } finally {
    rt.destroyTLAS(tlas);
    rt.destroyBLAS(blas);
    rt.destroyGeometry(geometry);
    bvh.detach();
  }
}

async function proveProbeTrace(renderer) {
  // The native host marker is the target boundary. The browser has no mystralRT and no ray query.
  if (globalThis.__THREENATIVE_NATIVE__ === undefined) return { target: "web", hardwareTrace: "not claimed" };
  const rt = globalThis.mystralRT;
  if (typeof rt?.capabilities !== "function" || typeof rt?.traceRayBatch !== "function") {
    const reason = "this host predates mystralRT.traceRayBatch";
    console.log(`TN_RT_PROBE_TRACE ${JSON.stringify({ skipped: true, reason })}`);
    return { target: "native", skipped: true, reason };
  }
  const capabilities = rt.capabilities();
  const adapter = await describeAdapter(renderer);
  console.log(`TN_RT_CAPABILITIES ${JSON.stringify({ ...capabilities, adapter })}`);
  if (!capabilities.rayBatch) {
    console.log(`TN_RT_PROBE_TRACE ${JSON.stringify({ skipped: true, reason: capabilities.reason })}`);
    return { target: "native", skipped: true, reason: capabilities.reason };
  }
  const batches = [];
  for (const spec of TRACE_SCENES) batches.push(...(await runScene(renderer, rt, spec, capabilities, adapter)));
  // Every row is printed first, so a failing run still shows its numbers.
  for (const { scene, probes, parity, gpuTransport } of batches) {
    if (gpuTransport) {
      assertCondition(!gpuTransport.error, `${scene} ${probes} probes: the GPU transport failed: ${gpuTransport.error}`);
      assertCondition(
        gpuTransport.parity.mismatchCount === 0,
        `${scene} ${probes} probes: ${gpuTransport.parity.mismatchCount} rays where the GPU transport differs from the exact trace, first ${JSON.stringify(gpuTransport.parity.mismatches[0])}.`,
      );
      assertCondition(
        gpuTransport.parity.maxDistanceError <= TOLERANCE_METRES,
        `${scene} ${probes} probes: GPU transport hit distances differ by ${gpuTransport.parity.maxDistanceError} m, limit ${TOLERANCE_METRES} m.`,
      );
      const late = gpuTransport.parityAfterTimedCalls;
      assertCondition(
        late.mismatchCount === 0 && late.maxDistanceError <= TOLERANCE_METRES,
        `${scene} ${probes} probes: after the timed calls the GPU transport differs from the exact trace (${late.mismatchCount} rays, ${late.maxDistanceError} m).`,
      );
    }
    assertCondition(
      parity.mismatchCount === 0,
      `${scene} ${probes} probes: ${parity.mismatchCount} rays where the hardware trace differs from the exact trace, first ${JSON.stringify(parity.mismatches[0])}.`,
    );
    assertCondition(
      parity.maxDistanceError <= TOLERANCE_METRES,
      `${scene} ${probes} probes: hit distances differ by ${parity.maxDistanceError} m, limit ${TOLERANCE_METRES} m.`,
    );
  }
  return { target: "native", skipped: false, device: capabilities.device, batches: batches.length };
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "raytracing-probe-trace", async ({ renderer, scene }) => {
    const detail = await proveProbeTrace(renderer);
    const card = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.95, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x1e3a5f }),
    );
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.24, 0.08, 12, 32),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24 }),
    );
    marker.position.set(0.42, 0.08, 0.15);
    card.add(marker);
    scene.add(card);
    return { card, detail, marker };
  });
}
